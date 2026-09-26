import { useEffect, useRef, useState } from 'react';
import type { PluginView } from '../../../../packages/plugin-runtime/src/contracts';
import { useStudioClient } from '../api';
import type { usePlugins } from '../plugins/PluginsPanel';
import { BackendPanel, type SupabaseTab } from './BackendPanel';
import { BackendPluginPanel } from './BackendPluginPanel';
import { Button } from './ui/button';

type Selection = { enabled: boolean; revision: string; available: boolean };
export function BackendProviderPanel({ plugin, projectId, catalog, disabled, navigation }: { plugin: PluginView; projectId: string; catalog: ReturnType<typeof usePlugins>; disabled: boolean; navigation?: { tab?: SupabaseTab } }) {
  const { api } = useStudioClient();
  const [state, setState] = useState<Selection>(), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const operating = useRef(false), generation = useRef(0);
  const base = `/projects/${projectId}/backend-plugins/${plugin.id}`;
  useEffect(() => {
    let alive = true;
    const refresh = () => { const request = ++generation.current; if (!operating.current) void api<Selection>(base).then(value => { if (alive && !operating.current && request === generation.current) setState(value); }).catch(() => { if (alive) setError('Backend selection unavailable. Refresh to try again.'); }); };
    refresh(); const timer = setInterval(refresh, 2000);
    return () => { alive = false; clearInterval(timer); };
  }, [api, base]);
  async function change() {
    if (!state || disabled || operating.current) return;
    operating.current = true; generation.current++; setBusy(true); setError('');
    try { setState(await api<Selection>(base, { enabled: !state.enabled || !state.available, expectedRevision: state.revision })); await catalog.refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Backend selection could not be saved.'); }
    finally { operating.current = false; setBusy(false); }
  }
  const enabled = state?.enabled && state.available;
  const control = <section className="backend-card backend-project-selection" aria-label={`${plugin.name} for this app`}>
      <div><h2>{plugin.name} for this app</h2><p>{!state ? 'Loading backend selection…' : enabled ? 'Enabled for this app. Disabling keeps saved settings and app source.' : 'Installed in the editor. Enable it for this app; other apps keep their own choices.'}</p></div>
      <Button variant={enabled ? 'outline' : 'default'} disabled={disabled || busy || !state} onClick={() => void change()}>{busy ? 'Saving…' : enabled ? 'Disable for this app' : 'Enable for this app'}</Button>
      {error && <p role="alert">{error}</p>}
    </section>;
  if (!enabled) return <main className="destination backend-workspace"><header className="backend-title"><div><p className="backend-eyebrow">BACKEND</p><h1>{plugin.name}</h1><p>{plugin.description}</p></div></header>{control}</main>;
  return plugin.id === 'builder.supabase' ? <BackendPanel projectControl={control} projectId={projectId} disabled={disabled || busy} navigation={navigation} /> : <BackendPluginPanel projectControl={control} plugin={plugin} projectId={projectId} catalog={catalog} disabled={disabled || busy} />;
}
