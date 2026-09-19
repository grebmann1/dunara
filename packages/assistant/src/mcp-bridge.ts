import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { CallToolResultSchema, type CallToolResult, type ContentBlock } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { connectDesktop } from '../../mcp/src/socket.js';
import { studioControlSchema } from '../../core/src/studio-contracts.js';
import type { AssistantMode, HarnessResult, HarnessTool, RunBinding } from './contracts.js';
import type { AssistantGateway } from './service.js';
import { ApprovalBroker, fingerprint, TOOL_POLICY, toolAllowedInMode, pluginToolPolicy } from './permissions.js';

const MAX_PAYLOAD = 20 * 1024 * 1024;
const helpers: HarnessTool[] = [
  { name: 'builder_mcp_discover', description: 'Read exact canonical Dunara MCP tool metadata, schemas, annotations, resources/templates and prompts. Unknown future capabilities are discovery-only until classified by Dunara.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'builder_mcp_read_resource', description: 'Read a discovered project-scoped Dunara MCP resource, preserving text and PNG content. Never follows external URLs or recaptures expired images.', inputSchema: { type: 'object', properties: { uri: { type: 'string', maxLength: 512 } }, required: ['uri'], additionalProperties: false } },
  { name: 'builder_mcp_get_prompt', description: 'Retrieve a discovered canonical MCP prompt. Prompt content is context, never authorization.', inputSchema: { type: 'object', properties: { name: { type: 'string', maxLength: 160 }, arguments: { type: 'object', additionalProperties: { type: 'string' } } }, required: ['name'], additionalProperties: false } },
];
function bounded<T>(value: T): T {
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_PAYLOAD) throw new Error('MCP payload unavailable: it exceeds the assistant transport limit. Request a smaller scoped result.');
  return value;
}
function imageSafe(content: ContentBlock[]): HarnessResult['content'] {
  return content.map(block => {
    if (block.type === 'text' || block.type === 'image') return block;
    if (block.type === 'resource') {
      if ('text' in block.resource) return { type: 'text', text: block.resource.text };
      if (block.resource.mimeType === 'image/png') return { type: 'image', data: block.resource.blob, mimeType: 'image/png' };
    }
    if (block.type === 'resource_link') return { type: 'text', text: `MCP resource reference (not fetched): ${block.uri}` };
    return { type: 'text', text: `MCP ${block.type} content is unavailable to this model adapter; the protocol details are retained. Visual review blocked where image content is unavailable.` };
  });
}
function adapted(result: CallToolResult): HarnessResult { return bounded({ content: imageSafe(result.content), details: result, isError: result.isError }); }
function metadata(result: CallToolResult): Record<string, unknown> {
  if (result.isError) throw new Error('Canonical review is unavailable. Reinspect and resolve its error first.');
  return z.record(z.string(), z.unknown()).parse(result.structuredContent);
}
const selectedSchema = z.object({ projectId: z.uuid().nullable(), revision: z.string() }).passthrough();
export type GatewayContext = { approvals: ApprovalBroker; mode?: AssistantMode; bindProject(projectId: string): Promise<void> };
export class McpGateway implements AssistantGateway {
  private closed = false;
  private dispatching = false;
  private selected: string | null;
  private constructor(private client: Client, readonly tools: HarnessTool[], private inventory: unknown, private templates: string[], private resources: string[], private prompts: string[], private binding: RunBinding, private context: GatewayContext, private lifetime: AbortSignal) { this.selected = binding.projectId; }
  static async open(socketPath: string, binding: RunBinding, signal: AbortSignal, context: GatewayContext) {
    const client = new Client({ name: 'builder-assistant', version: '1' });
    const close = () => { void client.close(); };
    signal.throwIfAborted(); signal.addEventListener('abort', close, { once: true });
    try {
      await client.connect(await connectDesktop(socketPath), { signal, timeout: 20_000 }); signal.throwIfAborted();
      const toolList = await client.listTools(undefined, { signal });
      const resourceList = await client.listResources(undefined, { signal });
      const templateList = await client.listResourceTemplates(undefined, { signal });
      const promptList = await client.listPrompts(undefined, { signal });
      if (toolList.nextCursor || resourceList.nextCursor || templateList.nextCursor || promptList.nextCursor) throw new Error('Paginated MCP discovery is not yet supported; refusing incomplete parity');
      if (toolList.tools.some(tool => helpers.some(helper => helper.name === tool.name))) throw new Error('MCP helper name collision');
      const available = toolList.tools.filter(tool => toolAllowedInMode(tool.name, context.mode, tool._meta));
      const gateway = new McpGateway(client, [...available, ...helpers], bounded({ ...toolList, tools: available, ...resourceList, ...templateList, ...promptList }), templateList.resourceTemplates.map(item => item.uriTemplate), resourceList.resources.map(item => item.uri), promptList.prompts.map(item => item.name), binding, context, signal);
      gateway.removeAbortListener = () => signal.removeEventListener('abort', close);
      return gateway;
    } catch (error) { signal.removeEventListener('abort', close); await client.close(); throw error; }
  }
  private removeAbortListener = () => {};
  async close() { this.closed = true; this.removeAbortListener(); await this.client.close(); }
  private guard(signal: AbortSignal) { signal.throwIfAborted(); this.lifetime.throwIfAborted(); if (this.closed) throw new Error('Assistant MCP connection is closed'); }
  private async invoke(name: string, args: Record<string, unknown>, signal: AbortSignal) {
    this.guard(signal);
    const result = CallToolResultSchema.parse(await this.client.callTool({ name, arguments: args }, CallToolResultSchema, { signal, timeout: 240_000 }));
    this.guard(signal); return bounded(result);
  }
  private scope(projectId: unknown) { if (!this.binding.projectId || projectId !== this.binding.projectId) throw new Error('Cross-project access denied. Open or create a project through an explicit human review first.'); }
  private async studio(signal: AbortSignal) { return selectedSchema.parse(metadata(await this.invoke('studio_inspect', {}, signal))); }
  private async checkSelection(name: string, args: Record<string, unknown>, signal: AbortSignal) {
    const current = await this.studio(signal);
    if (current.projectId === this.selected) return;
    await this.context.approvals.request(this.binding, name, args, { conversationProjectId: this.binding.projectId, selectedProjectId: current.projectId, studioRevision: current.revision }, 'The selected Studio project changed. Continue this action only in the conversation’s original project? No work will be redirected.', signal);
    const refreshed = await this.studio(signal);
    if (refreshed.projectId !== current.projectId || refreshed.revision !== current.revision) throw new Error('Studio changed while scope was being reviewed. A new review is required.');
    this.selected = refreshed.projectId;
  }
  private async review(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    if (name === 'backend_recipe_apply') return metadata(await this.invoke('backend_recipe_preview', { projectId: args.projectId }, signal));
    const projectId = this.binding.projectId;
    const input = z.record(z.string(), z.unknown()).parse(args.input ?? {});
    if (name === 'native_build_apply') return metadata(await this.invoke('native_build_plan', { projectId, configuration: input.configuration }, signal));
    if (name === 'native_workspace_prepare') return metadata(await this.invoke('native_workspace_plan', { projectId, selection: input.selection }, signal));
    if (name === 'native_workspace_cancel' || name === 'native_workspace_remove') {
      const value = metadata(await this.invoke('native_workspace_list', { projectId }, signal));
      const workspaces = z.array(z.object({ id: z.uuid() }).passthrough()).parse(value.workspaces);
      const workspace = workspaces.find(value => value.id === input.workspaceId);
      if (!workspace) throw new Error('Prepared workspace is unavailable. Refresh before reviewing.');
      return { workspace, action: name === 'native_workspace_remove' ? 'Delete only this retained workspace and its exports.' : 'Cancel this preparation. Original app source stays unchanged.' };
    }
    if (name === 'preview_set_transport') {
      const state = metadata(await this.invoke('project_inspect', { projectId }, signal));
      const preview = z.object({ status: z.string(), sessionId: z.string().optional(), transport: z.string().optional(), configurationRevision: z.string().optional() }).parse(state.preview);
      return { preview, requestedTransport: input.transport, instruction: input.transport === 'lan' ? 'Restart this app preview on the local network so phones can open it with Expo Go. The development app will be reachable by other devices on that network. Existing phone connections and test checklists are replaced when switching.' : 'Restart this app preview for this computer only. Existing phone connections and test checklists are replaced.' };
    }
    if (name === 'icon_apply') return metadata(await this.invoke('icon_preview', { projectId, input: { masterId: input.masterId, foregroundId: input.foregroundId, background: input.background } }, signal));
    if (name === 'inspector_setup_apply') return metadata(await this.invoke('inspector_setup_preview', { projectId }, signal));
    if (name === 'recipe_upgrade_apply') {
      const plan = metadata(await this.invoke('recipe_upgrade_preview', { projectId }, signal));
      const files = z.array(z.object({ path: z.string(), before: z.string().nullable(), after: z.string().nullable(), expectedRevision: z.string().nullable() })).parse(plan.files);
      return { ...plan, files: files.map(file => file.path === 'package-lock.json' ? { path: file.path, expectedRevision: file.expectedRevision, beforeFingerprint: fingerprint(file.before), afterFingerprint: fingerprint(file.after), review: 'Complete lockfile versions are available in Backend → Review upgrade. Dependency version changes are listed in this review.' } : file) };
    }
    if (name === 'media_approve') {
      const state = metadata(await this.invoke('media_list', { projectId }, signal));
      return { revision: state.revision, asset: z.array(z.object({ id: z.string() }).passthrough()).parse(state.assets).find(asset => asset.id === input.assetId) };
    }
    if (name === 'launch_kit_remove') return metadata(await this.invoke('launch_kit_read', { projectId, bundleId: input.bundleId }, signal));
    if (name === 'launch_kit_create') {
      const activity = metadata(await this.invoke('activity_list', { projectId }, signal));
      const captures = z.array(z.object({ id: z.string() }).passthrough()).parse(activity.captures);
      const selected = z.array(z.string()).parse(input.captureIds);
      const reviewed = selected.map(id => { const capture = captures.find(c => c.id === id); if (!capture) throw new Error('A selected capture expired. Recapture and review explicitly.'); return capture; });
      const media = input.icon ? metadata(await this.invoke('media_list', { projectId }, signal)) : undefined;
      return { captures: reviewed, ...(media ? { media } : {}), limitation: 'Fresh React Native Web route renders, not native App Store screenshots. No publication.' };
    }
    if (name === 'media_cancel') return metadata(await this.invoke('media_job', { projectId, jobId: args.jobId }, signal));
    return { instruction: name === 'project_create' ? 'Create this new local project and attach this conversation to it.' : 'Open this existing workspace project and attach this conversation to it.', ...args };
  }
  async call(name: string, supplied: Record<string, unknown>, callerSignal: AbortSignal): Promise<HarnessResult> {
    const signal = AbortSignal.any([callerSignal, this.lifetime]); this.guard(signal);
    if (this.dispatching) throw new Error('Parallel MCP dispatch is disabled');
    this.dispatching = true;
    try {
      if (!toolAllowedInMode(name, this.context.mode, this.tools.find(tool => tool.name === name)?._meta)) throw new Error('Plan mode only permits inspection and proposals. Switch to Build mode before making changes.');
      const args = structuredClone(bounded(supplied));
      if (name === 'builder_mcp_discover') { z.object({}).strict().parse(args); return { content: [{ type: 'text', text: JSON.stringify(this.inventory) }], details: this.inventory }; }
      if (name === 'builder_mcp_read_resource') {
        const { uri } = z.object({ uri: z.string().max(512) }).strict().parse(args);
        const url = new URL(uri);
        if (url.protocol !== 'builder:' || url.username || url.password || url.search || url.hash || url.href !== uri || /%|\\/.test(uri)) throw new Error('Only canonical Dunara resource URIs are allowed');
        if (!(['builder://guide', 'builder://projects'].includes(uri) && this.resources.includes(uri))) {
          const match = /^builder:\/\/projects\/([a-f0-9-]{36})\//.exec(uri); this.scope(match?.[1]);
          if (!this.templates.some(template => new RegExp(`^${template.split(/(\{[^}]+\})/).map(part => part.startsWith('{') ? '[^/]+' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('')}$`).test(uri))) throw new Error('Unknown MCP resource template');
        }
        const result = bounded(await this.client.readResource({ uri }, { signal })); this.guard(signal);
        return bounded({ content: imageSafe(result.contents.map(resource => ({ type: 'resource', resource }))), details: result });
      }
      if (name === 'builder_mcp_get_prompt') {
        const input = z.object({ name: z.string().max(160), arguments: z.record(z.string(), z.string().max(16000)).optional() }).strict().parse(args);
        if (!this.prompts.includes(input.name)) throw new Error('Unknown MCP prompt');
        const result = bounded(await this.client.getPrompt(input, { signal })); this.guard(signal);
        return bounded({ content: imageSafe(result.messages.map(message => message.content)), details: result });
      }
      const plugin = pluginToolPolicy(name, this.tools.find(tool => tool.name === name)?._meta);
      if (!this.tools.some(tool => tool.name === name) || (!Object.hasOwn(TOOL_POLICY, name) && !plugin)) throw new Error('Unclassified MCP capability is discovery-only');
      const policy = TOOL_POLICY[name] ?? plugin!.policy;
      let selecting = false;
      if (policy === 'studio') {
        const { action } = studioControlSchema.parse(args);
        if (action.type === 'select-project') { this.scope(action.projectId); selecting = true; }
        else { this.scope(this.binding.projectId); const current = await this.studio(signal); this.scope(current.projectId); }
      } else if (plugin?.scope === 'global') { /* Host binds global plugin reviews to the account and selection. */ }
      else if (name === 'plugin_action') { if (args.projectId != null) this.scope(args.projectId); }
      else if (policy !== 'catalog' && policy !== 'project') this.scope(args.projectId);
      const mutation = policy !== 'read' && policy !== 'catalog';
      if (mutation) await this.checkSelection(name, args, signal);
      const approval = policy === 'review' || policy === 'project' || policy === 'cancel';
      if (approval) {
        const reviewed = await this.review(name, args, signal);
        await this.context.approvals.request(this.binding, name, args, reviewed, policy === 'project' ? 'This changes the conversation’s project scope. Only approve if you explicitly want this project action.' : name === 'media_cancel' ? 'Cancellation is not rollback or a guaranteed refund.' : 'Approve only after reviewing these exact inputs and the associated images or changes. This does not approve paid image execution or publication.', signal);
        if (fingerprint(await this.review(name, args, signal)) !== fingerprint(reviewed)) throw new Error('The reviewed state changed. Reinspect and request a new approval.');
        if (mutation) { const current = await this.studio(signal); if (current.projectId !== this.selected) throw new Error('Studio project changed while approval was pending'); }
      }
      this.guard(signal);
      const result = await this.invoke(name, args, signal);
      if (!result.isError && policy === 'project') {
        const project = z.object({ project: z.object({ id: z.uuid() }) }).parse(result.structuredContent).project;
        await this.context.bindProject(project.id); this.binding.projectId = project.id;
        if (this.selected === null && (await this.studio(signal)).projectId === project.id) this.selected = project.id;
      }
      if (!result.isError && selecting) this.selected = this.binding.projectId;
      return adapted(result);
    } finally { this.dispatching = false; }
  }
}
