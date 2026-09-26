/** Public protocol. No Dunara source imports or runtime dependencies. Plugins are trusted code. */
export const BUILDER_PLUGIN_API = 1;
export type { BackendEnvironmentProvider, CaptureProvider, AssetProvider } from './providers.js';
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonSchema = { [key: string]: Json };
export type Effect = 'read' | 'write';
export interface PluginManifest {
  id: string; name: string; description: string; apiVersion: 1;
  server?: string; app?: string; guides?: string[];
  /** The app panel to show as this provider's workspace under Backend. */
  workspacePanel?: string;
  workspaceGroup?: 'backend';
  capabilities?: Array<'project.read' | 'project.write' | 'storage' | 'credentials'>;
  requires?: Record<string, string>;
}
export interface FileChange { path: string; content: string; expectedRevision: string | null }
export interface ActionContext {
  projectId: string | null; signal: AbortSignal;
  readonly review?: Json;
  /** Durable identity for an approved write. Use it as the provider idempotency key when supported. */
  readonly operationId?: string;
  progress(message: string): Promise<void>;
  files: {
    list(): Promise<{ files: string[]; truncated: boolean }>;
    read(path: string): Promise<{ path: string; content: string; revision: string }>;
    write(changes: FileChange[]): Promise<unknown>;
  };
}
export interface PluginAction {
  id: string; title: string; description: string; effect: Effect; scope: 'project' | 'global';
  input: JsonSchema; output: JsonSchema;
  /** Pure review data. Never perform mutations or provider requests here. */
  plan?(input: Json, context: ActionContext): Promise<Json> | Json;
  run(input: Json, context: ActionContext): Promise<Json> | Json;
}
export interface PluginSetting { id: string; label: string; type: 'string' | 'boolean' | 'number'; default?: Json }
export interface PluginServer {
  readonly id: string;
  actions: { register(action: PluginAction): void };
  settings: { define(settings: PluginSetting[]): void };
  storage: { get(key: string): Promise<Json | undefined>; set(key: string, value: Json): Promise<void>; delete(key: string): Promise<void> };
  /** Credentials are private, namespaced and available only to trusted server code. */
  credentials: { get(name: string): Promise<string | undefined> };
  services: { provide<T>(name: string, version: string, service: T): void; use<T>(providerId: string, name: string, version: string): T };
  recipes: { register(recipe: import('./recipes.js').PluginRecipe): void };
  onDispose(dispose: () => void | Promise<void>): void;
}
export type PluginFactory = (api: PluginServer) => void | Promise<void>;
export function definePlugin(factory: PluginFactory): PluginFactory { return factory; }
export function defineAction(action: PluginAction): PluginAction { return action; }
