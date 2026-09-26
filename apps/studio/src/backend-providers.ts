import type { PluginView } from '../../../packages/plugin-runtime/src/contracts';

export function backendProviders(plugins: PluginView[] = []) {
  return plugins.filter(plugin => plugin.status === 'active' && (plugin.id === 'builder.supabase' || plugin.workspaceGroup === 'backend' && !!plugin.workspacePanel && !!plugin.appUrl))
    .sort((a, b) => a.id === 'builder.supabase' ? -1 : b.id === 'builder.supabase' ? 1 : a.name.localeCompare(b.name));
}
