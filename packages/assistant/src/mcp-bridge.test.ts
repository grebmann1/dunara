import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import sharp from 'sharp';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Engine } from '../../core/src/engine.js';
import { Projects } from '../../core/src/projects.js';
import { connectDesktop, startDesktopMcp } from '../../mcp/src/socket.js';
import type { HarnessResult, RunBinding } from './contracts.js';
import { McpGateway } from './mcp-bridge.js';
import { ApprovalBroker, TOOL_POLICY } from './permissions.js';
import { makeLegacyApp } from '../../../tests/fixtures/legacy-app.js';
let root: string, engine: Engine, endpoint: Awaited<ReturnType<typeof startDesktopMcp>>, client: Client, gateway: McpGateway, broker: ApprovalBroker, binding: RunBinding, controller: AbortController;
function data(result: HarnessResult) { return z.record(z.string(), z.unknown()).parse(CallToolResultSchema.parse(result.details).structuredContent); }
const projectIdFrom = (result: HarnessResult) => z.object({ project: z.object({ id: z.uuid() }) }).parse(data(result)).project.id;
async function call(name: string, args: Record<string, unknown> = {}) { return gateway.call(name, args, controller.signal); }
async function decide(approve = true) {
  await vi.waitFor(() => expect(broker.list()).toHaveLength(1), { timeout: 10_000 });
  const item = broker.list()[0]!;
  broker.respond({ id: item.id, epoch: item.epoch, runId: item.runId, conversationId: item.conversationId, projectId: item.projectId, approve });
  return item;
}
async function reviewed(name: string, args: Record<string, unknown>) { const work = call(name, args); await decide(); return work; }
async function create() {
  const result = await reviewed('project_create', { name: 'Assistant fixture', slug: 'assistant-fixture' });
  const projectId = projectIdFrom(result);
  const session = await engine.studio.snapshot();
  await call('studio_control', { expectedRevision: session.revision, action: { type: 'select-project', projectId } });
  return projectId;
}
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'assistant-mcp-'));
  engine = new Engine(await Projects.open(path.join(root, 'apps'), path.join(root, 'home')), false);
  endpoint = await startDesktopMcp(engine); client = new Client({ name: 'external-fixture', version: '1' }); await client.connect(await connectDesktop(endpoint.socketPath));
  broker = new ApprovalBroker(); controller = new AbortController(); binding = { epoch: randomUUID(), runId: randomUUID(), conversationId: randomUUID(), projectId: null };
  gateway = await McpGateway.open(endpoint.socketPath, binding, controller.signal, { approvals: broker, async bindProject(id) { binding.projectId = id; } });
});
afterEach(async () => { vi.restoreAllMocks(); controller.abort(); broker.close(); await gateway.close(); await client.close(); await endpoint.close(); await engine.close(); await rm(root, { recursive: true, force: true }); });
it('preserves exact canonical discovery, annotations, resources/templates and prompts rather than a duplicate tool surface', async () => {
  const tools = await client.listTools(), resources = await client.listResources(), templates = await client.listResourceTemplates(), prompts = await client.listPrompts();
  const discovery = await call('builder_mcp_discover');
  expect(discovery.details).toEqual({ ...tools, ...resources, ...templates, ...prompts });
  expect(gateway.tools.filter(tool => !tool.name.startsWith('builder_mcp_'))).toEqual(tools.tools);
  expect(Object.keys(TOOL_POLICY).sort()).toEqual(tools.tools.map(tool => tool.name).sort());
  expect((await call('builder_mcp_get_prompt', { name: 'build-mobile-app', arguments: { brief: 'Build a quiet wellness app' } })).details).toEqual(await client.getPrompt({ name: 'build-mobile-app', arguments: { brief: 'Build a quiet wellness app' } }));
  expect((await call('builder_mcp_read_resource', { uri: 'builder://guide' })).details).toEqual(await client.readResource({ uri: 'builder://guide' }));
  gateway.tools.push({ name: 'future_unclassified', inputSchema: { type: 'object' } });
  await expect(call('future_unclassified')).rejects.toThrow('discovery-only');
  await expect(call('constructor')).rejects.toThrow('discovery-only');
  await expect(call('bash', { command: 'echo malicious' })).rejects.toThrow('discovery-only');
});
it('reviews phone network sharing before execution and exposes variable metadata without accepting private values', async () => {
  const projectId = await create();
  const launch = vi.spyOn(engine.previews, 'setTransport');
  const pending = call('preview_set_transport', { projectId, input: { transport: 'lan', expectedSessionId: null } });
  await vi.waitFor(() => expect(broker.list()).toHaveLength(1), { timeout: 10_000 });
  expect(launch).not.toHaveBeenCalled();
  expect(JSON.stringify(broker.list()[0]!.review)).toContain('local network');
  await decide();
  expect(await pending).toMatchObject({ isError: true, details: { structuredContent: { error: { code: 'TRUST_REQUIRED' } } } });
  const inventory = z.object({ sourceRevision: z.string().nullable() }).parse(data(await call('backend_environment_inspect', { projectId })));
  const args = { projectId, input: { name: 'PAYMENTS_API_KEY', environment: 'development', expectedSourceRevision: inventory.sourceRevision } };
  expect((await call('backend_environment_declare', { ...args, input: { ...args.input, value: 'forbidden-private-canary' } })).isError).toBe(true);
  expect((await call('backend_environment_declare', args)).isError).not.toBe(true);
  const result = await call('backend_environment_inspect', { projectId });
  expect(data(result)).toMatchObject({ variables: [expect.objectContaining({ name: 'PAYMENTS_API_KEY', input: expect.objectContaining({ available: false }) })] });
  expect(JSON.stringify(result)).not.toContain('canary');
  const guide = await client.readResource({ uri: 'builder://guide' });
  expect(JSON.stringify(guide)).toContain('user_reported');
  expect(JSON.stringify(guide)).toContain('function_environment');
});
it('requires human project creation, binds only after success, and shares revision-safe writes with the external client', async () => {
  const work = call('project_create', { name: 'Assistant fixture', slug: 'assistant-fixture' });
  await vi.waitFor(() => expect(broker.list()).toHaveLength(1), { timeout: 10_000 }); expect(await engine.projects.list()).toEqual([]); expect(binding.projectId).toBeNull();
  await decide(); const projectId = projectIdFrom(await work); expect(binding.projectId).toBe(projectId);
  const snapshot = await engine.studio.snapshot(); await call('studio_control', { expectedRevision: snapshot.revision, action: { type: 'select-project', projectId } });
  const writes = [{ path: 'app/assistant.tsx', content: 'export default function Assistant(){return null}', expectedRevision: null }];
  expect((await call('project_write_files', { projectId, writes })).isError).not.toBe(true);
  expect((await client.callTool({ name: 'project_inspect', arguments: { projectId, paths: ['app/assistant.tsx'] } })).structuredContent).toMatchObject({ files: [{ path: 'app/assistant.tsx', content: writes[0]!.content }] });
  expect(await call('project_write_files', { projectId, writes })).toMatchObject({ isError: true, details: { structuredContent: { error: { code: 'REVISION_CONFLICT' } } } });
  const other = (await engine.projects.create({ name: 'Other', slug: 'other' })).id;
  await expect(call('project_inspect', { projectId: other })).rejects.toThrow('Cross-project');
  await expect(call('studio_control', { expectedRevision: (await engine.studio.snapshot()).revision, action: { type: 'select-project', projectId: other } })).rejects.toThrow('Cross-project');
  const opened = await reviewed('project_open', { slug: (await engine.projects.get(other)).slug });
  expect(projectIdFrom(opened)).toBe(other); expect(binding.projectId).toBe(other);
});
it('Plan exposes read capabilities and rejects every mutation before execution or approval', async () => {
  const projectId = await create();
  await gateway.close();
  gateway = await McpGateway.open(endpoint.socketPath, binding, controller.signal, { mode: 'plan', approvals: broker, async bindProject() { throw new Error('Plan cannot rebind a project'); } });
  const blocked = Object.entries(TOOL_POLICY).filter(([name, policy]) => !['read', 'catalog'].includes(policy) || name === 'backend_requirements').map(([name]) => name);
  expect(gateway.tools.map(tool => tool.name)).not.toEqual(expect.arrayContaining(['project_write_files']));
  const discovery = await call('builder_mcp_discover');
  const inventory = z.object({ tools: z.array(z.object({ name: z.string() })) }).parse(discovery.details);
  expect(inventory.tools.map(tool => tool.name)).not.toContain('project_write_files');
  expect((await call('project_inspect', { projectId })).isError).not.toBe(true);
  expect((await call('builder_mcp_read_resource', { uri: 'builder://guide' })).content.length).toBeGreaterThan(0);
  const before = await engine.studio.snapshot();
  for (const name of [...blocked, 'future_tool', 'bash']) await expect(call(name, { projectId, mode: 'build', confirmed: true })).rejects.toThrow('Plan mode');
  expect(broker.list()).toEqual([]);
  expect(await engine.studio.snapshot()).toEqual(before);
  expect(await engine.projects.list()).toHaveLength(1);
});
it('keeps backend discovery and environment selection project-scoped with canonical results', async () => {
  const projectId = await create(), other = (await engine.projects.create({ name: 'Other backend', slug: 'other-backend' })).id;
  for (const name of ['backend_catalog', 'backend_capabilities', 'backend_select_environment']) {
    await expect(call(name, { projectId: other })).rejects.toThrow('Cross-project');
    await expect(call(name, {})).rejects.toThrow('Cross-project');
  }
  const page = { projectId, organizations: [{ slug: 'fixture-org', name: 'Fixture organization' }], projects: [], revision: 'a'.repeat(64), pagination: { offset: 0, limit: 50, nextOffset: null, truncated: false, totalOrganizations: 1, totalProjects: 0 }, connectionRevision: randomUUID(), selectionRequired: true as const };
  vi.spyOn(engine.backends, 'catalog').mockResolvedValue(page);
  expect(data(await call('backend_catalog', { projectId }))).toEqual((await client.callTool({ name: 'backend_catalog', arguments: { projectId } })).structuredContent);
  const capabilities = data(await call('backend_capabilities', { projectId }));
  expect(capabilities).toMatchObject({ projectId, credential: { configured: false, scopes: 'unknown' } });
  const inspected = await engine.backends.inspect(projectId);
  expect(await call('backend_select_environment', { projectId, input: { environment: 'staging', expectedRevision: inspected.environmentRevision } })).toMatchObject({ isError: true, details: { structuredContent: { error: { code: 'BACKEND_NOT_CONFIGURED' } } } });
  const current = await engine.studio.snapshot(); await engine.studio.control({ expectedRevision: current.revision, action: { type: 'select-project', projectId: other } });
  const pending = call('backend_select_environment', { projectId, input: { environment: 'development', expectedRevision: inspected.environmentRevision } });
  await decide(false); await expect(pending).rejects.toThrow('declined');
  expect((await engine.studio.snapshot()).projectId).toBe(other);
});
it('discovers provider fixtures, stages the identified link for human review and shares the selected environment', async () => {
  const projectId = await create(), ref = 'abcdefghijklmnopqrst', organization = 'fixture-org';
  const remote = { id: ref, name: 'Explicit target', region: 'eu-central-1', status: 'ACTIVE_HEALTHY', organization_slug: organization };
  const provider = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    expect(init?.method).toBe('GET'); const url = String(input);
    if (url === 'https://api.supabase.com/v1/organizations') return Response.json([{ slug: organization, name: 'Fixture organization' }]);
    if (url === 'https://api.supabase.com/v1/projects') return Response.json([remote]);
    if (url.endsWith(`/projects/${ref}`)) return Response.json(remote);
    if (url.includes('/health?')) return Response.json([{ name: 'db', status: 'ACTIVE_HEALTHY' }]);
    if (url.includes('/api-keys?')) return Response.json([{ type: 'publishable', api_key: 'sb_publishable_test_only' }]);
    throw new Error('Unexpected provider fixture route');
  });
  engine.backends.configure({ token: 'fixture-management-private' });
  expect(data(await call('backend_catalog', { projectId }))).toEqual((await client.callTool({ name: 'backend_catalog', arguments: { projectId } })).structuredContent);
  const plan = data(await call('backend_plan', { projectId, input: { action: 'link', environment: 'staging', projectRef: ref, organization } }));
  const staged = z.object({ id: z.uuid(), planHash: z.string(), state: z.literal('awaiting_approval') }).parse(data(await call('backend_apply', { projectId, input: { plan, requestId: randomUUID() } })));
  expect(await engine.backends.binding(projectId, 'staging')).toBeNull(); expect(broker.list()).toHaveLength(0);
  await engine.backends.approve(projectId, { operationId: staged.id, planHash: staged.planHash });
  await vi.waitFor(async () => expect((await engine.backends.operation(projectId, staged.id)).state).toBe('succeeded'));
  const state = await engine.backends.inspect(projectId);
  expect(data(await call('backend_select_environment', { projectId, input: { environment: 'staging', expectedRevision: state.environmentRevision } }))).toMatchObject({ activeEnvironment: 'staging' });
  expect((await client.callTool({ name: 'backend_inspect', arguments: { projectId } })).structuredContent).toMatchObject({ activeEnvironment: 'staging' });
  expect(engine.previews.status(projectId).status).toBe('stopped'); expect(provider).toHaveBeenCalled();
});
it('preserves canonical PNG blocks, structured errors and scoped resources without following URLs', async () => {
  const projectId = await create();
  const png = await sharp({ create: { width: 32, height: 32, channels: 4, background: '#336655' } }).png().toBuffer();
  const imported = await call('media_import', { projectId, input: { metadata: { expectedRevision: null, label: 'Review this local image', role: 'illustration', mediaType: 'image/png' }, data: png.toString('base64') } });
  const assetId = z.object({ assets: z.array(z.object({ id: z.uuid() })) }).parse(data(imported)).assets[0]!.id;
  const image = await call('media_read', { projectId, assetId });
  expect(image.details).toEqual(await client.callTool({ name: 'media_read', arguments: { projectId, assetId } }));
  const block = image.content.find(block => block.type === 'image'); expect(block?.type).toBe('image');
  if (block?.type !== 'image') throw new Error('PNG unavailable'); expect((await sharp(Buffer.from(block.data, 'base64')).metadata()).width).toBe(32);
  const uri = `builder://projects/${projectId}/media/${assetId}`;
  expect((await call('builder_mcp_read_resource', { uri })).details).toEqual(await client.readResource({ uri }));
  for (const uri of [`builder://projects/${randomUUID()}/media/${assetId}`, `builder://projects/${projectId}/media/%2e%2e`, 'file:///etc/passwd', 'https://example.invalid/payload', `builder://projects/${projectId}/media/${assetId}?token=secret`]) await expect(call('builder_mcp_read_resource', { uri })).rejects.toThrow();
  expect(await call('preview_start', { projectId })).toMatchObject({ isError: true, details: { structuredContent: { error: { code: 'TRUST_REQUIRED' } } } });
  expect(engine.mediaJobs.providerStatus().configured).toBe(false);
});
it('does not treat confirmed true as approval; rejects stale reviewed state and cancellation before dispatch', async () => {
  const projectId = await create();
  const png = await sharp({ create: { width: 16, height: 16, channels: 4, background: '#ffffff' } }).png().toBuffer();
  const imported = await engine.assets.import(projectId, { expectedRevision: null, label: 'Local candidate', role: 'app-icon', mediaType: 'image/png' }, png);
  const assetId = imported.assets[0]!.id;
  const work = call('media_approve', { projectId, input: { assetId, expectedRevision: imported.revision } });
  await vi.waitFor(() => expect(broker.list()).toHaveLength(1), { timeout: 10_000 }); expect((await engine.assets.list(projectId)).assets[0]!.status).toBe('candidate');
  await engine.assets.brief(projectId, imported.revision, { mood: 'A changed review' });
  await decide(); await expect(work).rejects.toThrow('reviewed state changed');
  expect((await engine.assets.list(projectId)).assets[0]!.status).toBe('candidate');
  const waiting = call('media_approve', { projectId, input: { assetId, expectedRevision: (await engine.assets.list(projectId)).revision } });
  await vi.waitFor(() => expect(broker.list()).toHaveLength(1), { timeout: 10_000 });
  controller.abort(); await expect(waiting).rejects.toThrow(); expect(broker.list()).toEqual([]);
  expect((await engine.assets.list(projectId)).assets[0]!.status).toBe('candidate');
  await expect(call('project_write_files', { projectId, writes: [] })).rejects.toThrow();
});
it('pauses mutations when Studio changes projects without redirecting writes or resetting shared state', async () => {
  const projectId = await create(), other = await engine.projects.create({ name: 'Other', slug: 'other' });
  await engine.studio.control({ expectedRevision: (await engine.studio.snapshot()).revision, action: { type: 'select-project', projectId: other.id } });
  const work = call('project_write_files', { projectId, writes: [{ path: 'app/reviewed.tsx', content: 'export default function Reviewed(){return null}', expectedRevision: null }] });
  const approval = await decide(); expect(approval.consequence).toContain('No work will be redirected'); await work;
  expect((await engine.studio.snapshot()).projectId).toBe(other.id);
  expect((await engine.files.read(projectId, 'app/reviewed.tsx')).content).toContain('Reviewed');
  await expect(engine.files.read(other.id, 'app/reviewed.tsx')).rejects.toThrow();
});
it('reviews exact icon, Inspector and Launch Kit changes before canonical execution (capture fixture only)', async () => {
  const projectId = await create();
  const png = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: '#445544' } }).png().toBuffer();
  const imported = await engine.assets.import(projectId, { expectedRevision: null, label: 'Review master', role: 'app-icon', mediaType: 'image/png' }, png);
  const masterId = imported.assets[0]!.id;
  await reviewed('media_approve', { projectId, input: { assetId: masterId, expectedRevision: imported.revision } });
  const selection = { masterId, background: '#ffffff' };
  const diff = data(await call('icon_preview', { projectId, input: selection }));
  const apply = call('icon_apply', { projectId, input: { ...selection, expectedConfigRevision: diff.expectedConfigRevision, expectedMediaRevision: diff.expectedMediaRevision, proposedRevision: diff.proposedRevision, confirmed: true } });
  await vi.waitFor(() => expect(broker.list()).toHaveLength(1), { timeout: 10_000 });
  expect(broker.list()[0]!.review).toMatchObject({ before: diff.before, after: diff.after });
  expect((await engine.files.read(projectId, 'app.json')).content).toBe(diff.before);
  await decide(); expect((await apply).isError).not.toBe(true); expect((await engine.files.read(projectId, 'app.json')).content).toBe(diff.after);
  const inspector = data(await call('inspector_setup_preview', { projectId }));
  expect((await reviewed('inspector_setup_apply', { projectId, proposedRevision: inspector.proposedRevision, confirmed: true })).isError).not.toBe(true);
  const capturePng = await sharp(png).resize(375, 812).png().toBuffer();
  const capture = { png: capturePng, meta: { id: randomUUID(), projectId, route: '/', viewport: 'compact' as const, width: 375, height: 812, createdAt: new Date().toISOString(), rendering: 'React Native Web' as const, bytes: capturePng.length } };
  vi.spyOn(engine.captures, 'get').mockReturnValue(capture); vi.spyOn(engine.captures, 'list').mockReturnValue([capture.meta]);
  const kit = data(await reviewed('launch_kit_create', { projectId, input: { captureIds: [capture.meta.id], listing: { name: 'Draft kit', summary: '', description: '' }, confirmed: true } }));
  const bundleId = z.object({ manifest: z.object({ id: z.uuid() }) }).parse(kit).manifest.id;
  expect((await call('launch_kit_list', { projectId })).isError).not.toBe(true);
  expect(data(await call('launch_kit_read', { projectId, bundleId }))).toEqual(kit);
  expect((await reviewed('launch_kit_remove', { projectId, input: { bundleId, confirmed: true } })).isError).not.toBe(true);
  expect(await engine.launchKits.list(projectId)).toEqual([]);
});
it('cannot gain cancellation ownership by replaying an independently staged request', async () => {
  const projectId = await create(); const input = { requestId: randomUUID(), expectedRevision: null, prompt: 'Local staged image', operation: 'generate', quality: 'low', size: '1024x1024', label: 'Offline', role: 'illustration' };
  const independent = await engine.mediaJobs.request(projectId, input);
  expect(data(await call('media_request', { projectId, input })).id).toBe(independent.id);
  const work = call('media_cancel', { projectId, jobId: independent.id });
  await vi.waitFor(() => expect(broker.list()).toHaveLength(1), { timeout: 10_000 }); expect((await engine.mediaJobs.get(projectId, independent.id)).state).toBe('awaiting-approval');
  await decide(); await work;
  const own = data(await call('media_request', { projectId, input: { ...input, requestId: randomUUID() } }));
  expect(data(await reviewed('media_cancel', { projectId, jobId: own.id })).state).toBe('cancelled'); expect(broker.list()).toEqual([]);
});
it('requires human review for a recipe upgrade and refuses source changed during that review', async () => {
  const projectId = await create(), project = await engine.projects.get(projectId);
  await makeLegacyApp(project.root);
  const plan = data(await call('recipe_upgrade_preview', { projectId }));
  const args = { projectId, proposedRevision: plan.proposedRevision, confirmed: true };
  const first = call('recipe_upgrade_apply', args);
  await vi.waitFor(() => expect(broker.list()).toHaveLength(1), { timeout: 10_000 });
  expect((await engine.recipeUpgrades.preview(projectId)).state).toBe('ready');
  expect(broker.list()[0]!.review).toMatchObject({ recipe: 'supabase-notes-v1', proposedRevision: plan.proposedRevision, files: expect.arrayContaining([expect.objectContaining({ path: 'package-lock.json' })]) });
  await writeFile(path.join(project.root, 'app/account.js'), '// Another editor reserved this route');
  await decide(); await expect(first).rejects.toThrow('reviewed state changed');
  await rm(path.join(project.root, 'app/account.js'));
  const declined = call('recipe_upgrade_apply', args); await decide(false); await expect(declined).rejects.toThrow();
  expect((await engine.recipeUpgrades.preview(projectId)).state).toBe('ready');
  expect((await reviewed('recipe_upgrade_apply', args)).isError).not.toBe(true);
  expect((await engine.recipeUpgrades.preview(projectId)).state).toBe('current');
});

it('reviews native setup through canonical MCP and invalidates approval after another editor changes profiles', async () => {
  const projectId = await create(), project = await engine.projects.get(projectId);
  const configuration = { iosBundleIdentifier: 'com.acme.still', androidPackage: 'com.acme.still', scheme: 'acme-still' };
  const plan = data(await call('native_build_plan', { projectId, configuration }));
  const args = { projectId, input: { configuration, proposedRevision: plan.proposedRevision, confirmed: true } };
  const pending = call('native_build_apply', args);
  await vi.waitFor(() => expect(broker.list()).toHaveLength(1), { timeout: 10_000 });
  expect(broker.list()[0]!.review).toMatchObject({ configuration, state: 'ready', proposedRevision: plan.proposedRevision });
  await writeFile(path.join(project.root, 'eas.json'), '{"build":{"production":{}}}');
  await decide(); await expect(pending).rejects.toThrow('reviewed state changed');
  const updated = data(await call('native_build_plan', { projectId, configuration }));
  args.input.proposedRevision = updated.proposedRevision;
  const declined = call('native_build_apply', args); await decide(false); await expect(declined).rejects.toThrow();
  expect((await reviewed('native_build_apply', args)).isError).not.toBe(true);
  expect(data(await call('native_build_inspect', { projectId }))).toMatchObject({ configuration, providerOwnership: 'unverified' });
});

it('reviews native workspace preparation and rejects source edits made during human approval', async () => {
  const projectId = await create(), project = await engine.projects.get(projectId);
  const setup = await engine.nativeBuilds.plan(projectId, { iosBundleIdentifier: 'com.acme.fixture', androidPackage: 'com.acme.fixture', scheme: 'acme-fixture' });
  await engine.nativeBuilds.apply(projectId, { configuration: setup.configuration, proposedRevision: setup.proposedRevision, confirmed: true });
  const selection = { profile: 'preview', platform: 'all', environment: 'none' };
  const plan = data(await call('native_workspace_plan', { projectId, selection }));
  const args = { projectId, input: { selection, proposedRevision: plan.proposedRevision, requestId: randomUUID(), confirmed: true } };
  const pending = call('native_workspace_prepare', args);
  await vi.waitFor(() => expect(broker.list()).toHaveLength(1), { timeout: 10_000 });
  expect(broker.list()[0]!.review).toMatchObject({ selection, proposedRevision: plan.proposedRevision });
  await writeFile(path.join(project.root, 'src/review-change.ts'), 'export const changed = true;');
  await decide(); await expect(pending).rejects.toThrow('reviewed state changed');
  expect(await engine.nativeWorkspaces.list(projectId)).toEqual([]);
  const updated = data(await call('native_workspace_plan', { projectId, selection })); args.input.proposedRevision = updated.proposedRevision;
  const declined = call('native_workspace_prepare', args); await decide(false); await expect(declined).rejects.toThrow();
  expect(await reviewed('native_workspace_prepare', args)).toMatchObject({ isError: true, details: { structuredContent: { error: { code: 'TRUST_REQUIRED' } } } });
});

it('reviews the exact native device and signing plan and rejects changes while approval is pending', async () => {
  const projectId = await create(), selection = { workspaceId: randomUUID(), deviceId: '00008130-001918DC2E520010', teamId: 'ABCDE12345' };
  const proposal = { selection, device: { id: selection.deviceId, name: 'Fixture phone', model: 'iPhone', developerMode: true }, team: { id: selection.teamId, name: 'Fixture team' }, bundleIdentifier: 'com.fixture.phone', sourceFingerprint: '1'.repeat(64), proposedRevision: '2'.repeat(64), consequences: ['Sign with the selected team, then review installation separately.'] };
  vi.spyOn(engine.nativeDeliveries, 'plan').mockImplementation(async () => structuredClone(proposal));
  const build = vi.spyOn(engine.nativeDeliveries, 'build');
  const args = { projectId, input: { selection, proposedRevision: proposal.proposedRevision, requestId: randomUUID(), confirmed: true } };
  const pending = call('native_delivery_build', args);
  await vi.waitFor(() => expect(broker.list()).toHaveLength(1));
  expect(broker.list()[0]!.review).toMatchObject({ device: proposal.device, team: proposal.team });
  proposal.proposedRevision = '3'.repeat(64); await decide(); await expect(pending).rejects.toThrow('reviewed state changed'); expect(build).not.toHaveBeenCalled();
  const declined = call('native_delivery_build', args); await decide(false); await expect(declined).rejects.toThrow(); expect(build).not.toHaveBeenCalled();
});

it('shares configuration plans and private-input boundaries between the Assistant and external MCP', async () => {
  const projectId = await create(), ref = 'abcdefghijklmnopqrst', organization = 'fixture-org';
  const remote = { id: ref, name: 'Explicit target', region: 'eu-central-1', status: 'ACTIVE_HEALTHY', organization_slug: organization };
  const auth: Record<string, unknown> = { external_email_enabled: false, disable_signup: true, mailer_autoconfirm: true, smtp_pass: 'never-public-canary' };
  const provider = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.endsWith(`/projects/${ref}`)) return Response.json(remote);
    if (url.includes('/health?')) return Response.json([{ name: 'db', status: 'ACTIVE_HEALTHY' }]);
    if (url.includes('/api-keys?')) return Response.json([{ type: 'publishable', api_key: 'sb_publishable_test_only' }]);
    if (url.endsWith('/config/auth')) { if (init?.method === 'PATCH') Object.assign(auth, JSON.parse(String(init.body))); return Response.json(auth); }
    throw new Error('Unexpected configuration fixture route');
  });
  engine.backends.configure({ token: 'fixture-management-canary' });
  const link = await engine.backends.plan(projectId, { action: 'link', environment: 'development', projectRef: ref, organization });
  const linked = await engine.backends.submit(projectId, { plan: link, requestId: randomUUID() }); await engine.backends.approve(projectId, { operationId: linked.id, planHash: linked.planHash });
  await vi.waitFor(async () => expect((await engine.backends.operation(projectId, linked.id)).state).toBe('succeeded'));
  const requirements = data(await call('backend_requirements', { projectId })); expect(requirements.inputs).toEqual([]);
  const prepared = data(await call('backend_plan', { projectId, input: { action: 'configure' } }));
  expect(prepared).toMatchObject({ version: 2, sources: expect.arrayContaining([expect.objectContaining({ path: 'backend/configuration.json' })]) });
  expect(JSON.stringify(prepared)).not.toContain('canary');
  const input = { preparedPlanHash: prepared.preparedPlanHash, requestId: randomUUID() };
  const staged = data(await call('backend_apply', { projectId, input }));
  expect(staged.state).toBe('awaiting_approval');
  expect((await client.callTool({ name: 'backend_apply', arguments: { projectId, input } })).structuredContent).toEqual(staged);
  expect(provider.mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(0);
  await engine.backends.approve(projectId, { operationId: staged.id, planHash: staged.planHash });
  await vi.waitFor(async () => expect((await engine.backends.operation(projectId, String(staged.id))).state).toBe('succeeded'));
  expect(auth.external_email_enabled).toBe(true);
  expect((await call('backend_validate', { projectId, input: {} })).isError).not.toBe(true);
  const other = (await engine.projects.create({ name: 'Other', slug: 'other' })).id;
  await expect(call('backend_requirements', { projectId: other })).rejects.toThrow('Cross-project');
  await expect(call('backend_validate', { projectId: other, input: {} })).rejects.toThrow('Cross-project');
});
