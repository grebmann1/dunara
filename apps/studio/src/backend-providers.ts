import type { PluginView } from '../../../packages/plugin-runtime/src/contracts';

export function backendProviders(plugins: PluginView[] = []) {
  return plugins.filter(plugin => plugin.workspaceGroup === 'backend' && !!plugin.workspacePanel)
    .sort((a, b) => a.id === 'builder.supabase' ? -1 : b.id === 'builder.supabase' ? 1 : a.name.localeCompare(b.name));
}
