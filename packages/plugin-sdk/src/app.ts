import type { Json } from './server.js';
export interface PluginAppContext {
  readonly pluginId: string; readonly projectId: string | null; readonly signal: AbortSignal;
  /** Writes return a pending review; the host renders the human approval control. */
  invoke(action: string, input?: Json): Promise<Json>;
  settings(): Promise<Record<string, Json>>;
}
export interface PluginPanel {
  id: string; title: string; scope: 'project' | 'global';
  /** Mount into this owned element; return cleanup. React authors can mount their own root. */
  mount(element: HTMLElement, context: PluginAppContext): void | (() => void) | Promise<void | (() => void)>;
}
export interface PluginApp { apiVersion: 1; panels: PluginPanel[] }
export function definePluginApp(app: Omit<PluginApp, 'apiVersion'>): PluginApp { return { apiVersion: 1, ...app }; }
