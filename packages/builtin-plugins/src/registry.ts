import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Engine } from '../../core/src/engine.js';
import { registerBuiltinTools } from './actions.js';
import { actionOwner } from './catalog.js';
import type { PluginServer } from '../../plugin-sdk/src/server.js';
type Handler = (args: Record<string, unknown>, extra: { signal: AbortSignal }) => Promise<CallToolResult>;
type Definition = { name: string; owner: string | null; config: { inputSchema: z.ZodType | z.ZodRawShape; description?: string; annotations?: { readOnlyHint?: boolean } }; handler: Handler };
/** Compatibility registrar: keeps audited legacy schemas and handlers while transports share dispatch. */
export class BuiltinActions {
  readonly tools = new Map<string, Definition>();
  private readonly active = new Map<string, number>();
  busy(id: string) { return (this.active.get(id) ?? 0) > 0; }
  constructor(private engine: Engine) {
    const scratch = new McpServer({ name: 'builder-registration', version: '1' });
    const capture = new Proxy(scratch, { get: (target, key) => {
      if (key === 'registerTool') return (name: string, config: Definition['config'], handler: Handler) => { this.tools.set(name, { name, config, handler, owner: actionOwner(name) }); return {}; };
      if (key === 'registerResource' || key === 'registerPrompt') return () => ({});
      return Reflect.get(target, key);
    } });
    registerBuiltinTools(capture, engine);
  }
  async invoke(name: string, args: Record<string, unknown>, signal = new AbortController().signal) {
    await this.engine.plugins.ready; const definition = this.tools.get(name); if (!definition) throw Error('Unknown Dunara action');
    if (definition.owner) this.engine.plugins.assertEnabled(definition.owner);
    const input = definition.config.inputSchema instanceof z.ZodType ? definition.config.inputSchema : z.object(definition.config.inputSchema);
    const parsed = input.parse(args) as Record<string, unknown>, owner = definition.owner ?? 'host';
    this.active.set(owner, (this.active.get(owner) ?? 0) + 1);
    try { return await definition.handler(parsed, { signal }); }
    finally { this.active.set(owner, (this.active.get(owner) ?? 1) - 1); }
  }
  async value(name: string, args: Record<string, unknown>) { const result = await this.invoke(name, args); if (result.isError) throw Error(String((result.structuredContent?.error as { message?: string } | undefined)?.message ?? 'Dunara action failed')); return result.structuredContent; }
  contribute(api: PluginServer) {
    for (const definition of this.tools.values()) {
      if (definition.owner !== api.id) continue;
      const input = definition.config.inputSchema instanceof z.ZodType ? definition.config.inputSchema : z.object(definition.config.inputSchema);
      const jsonSchema = z.toJSONSchema(input, { io: 'input', unrepresentable: 'any' });
      api.actions.register({ id: definition.name.replace(/_/g, '-'), title: definition.name.replace(/_/g, ' '), description: definition.config.description ?? '', effect: definition.name !== 'backend_requirements' && definition.config.annotations?.readOnlyHint ? 'read' : 'write', scope: jsonSchema.properties && Object.hasOwn(jsonSchema.properties, 'projectId') ? 'project' : 'global', input: jsonSchema as import('../../plugin-sdk/src/server.js').JsonSchema, output: {},
        run: async (value, context) => {
          const args = z.record(z.string(), z.unknown()).parse(value);
          if (Object.hasOwn(args, 'projectId') && args.projectId !== context.projectId) throw Error('Plugin action belongs to a different project');
          const result = await this.invoke(definition.name, args, context.signal);
          if (result.isError) throw Error(String((result.structuredContent?.error as { message?: string } | undefined)?.message ?? 'Dunara action failed'));
          return z.json().parse(result.structuredContent ?? { content: result.content });
        },
      });
    }
  }
  mount(server: McpServer) {
    const handles = new Map<string, ReturnType<McpServer['registerTool']>>();
    const proxy = new Proxy(server, { get: (target, key) => {
      if (key === 'registerTool') return (name: string, config: Definition['config']) => {
        const handle = target.registerTool(name, config, async (args: Record<string, unknown>, extra: { signal: AbortSignal }) => {
          try { return await this.invoke(name, args as Record<string, unknown>, extra.signal); }
          catch (error) { return { isError: true, content: [{ type: 'text' as const, text: error instanceof Error ? error.message : 'Action unavailable' }] }; }
        }); handles.set(name, handle); return handle;
      };
      const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
    } });
    registerBuiltinTools(proxy, this.engine);
    const update = () => { for (const [name, handle] of handles) { const owner = this.tools.get(name)?.owner; if (!owner || this.engine.plugins.isEnabled(owner)) handle.enable(); else handle.disable(); } };
    void this.engine.plugins.ready.then(update).catch(() => {}); this.engine.plugins.on('change', update);
    return () => this.engine.plugins.off('change', update);
  }
}
