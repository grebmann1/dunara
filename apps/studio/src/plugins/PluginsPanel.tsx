import { useCallback, useEffect, useRef, useState } from 'react';
import { BookOpen, Check, ChevronRight, Package, Plus, Puzzle, RefreshCw } from 'lucide-react';
import { useStudioClient } from '../api';
import { Button } from '../components/ui/button';
import type { PluginView } from '../../../../packages/plugin-runtime/src/contracts';
import type { PluginApp, PluginAppContext } from '../../../../packages/plugin-sdk/src/app';
import type { Json } from '../../../../packages/plugin-sdk/src/server';
import './plugins.css';

export type PluginState = { plugins: PluginView[]; reviews: Array<{ id: string; pluginId: string; action: string; projectId: string | null; input: Json; plan: Json; expiresAt: string }>; operations?: Array<{ id: string; pluginId: string; action: string; state: string; message: string; updatedAt: string }>; recovery: boolean };
export function usePlugins(ready: boolean) {
  const { api } = useStudioClient();
  const [state, setState] = useState<PluginState>(), [error, setError] = useState('');
  const refresh = useCallback(async () => { if (!ready) return; try { setState(await api<PluginState>('/plugins')); setError(''); } catch (error) { setError(error instanceof Error ? error.message : 'Plugins are unavailable'); } }, [ready]);
  useEffect(() => { if (!ready) return; let stopped = false; const poll = async () => { if (!stopped) await refresh(); }; void poll(); const timer = setInterval(() => { void poll(); }, 3000); return () => { stopped = true; clearInterval(timer); }; }, [ready, refresh]);
  return { state, error, refresh };
}
function PluginSurface({ plugin, projectId, refresh }: { plugin: PluginView; projectId: string | null; refresh(): Promise<void> }) {
  const { api } = useStudioClient();
  const container = useRef<HTMLDivElement>(null), [error, setError] = useState('');
  useEffect(() => {
    if (!plugin.appUrl || !container.current) return;
    const root = container.current, controller = new AbortController(), disposers: Array<() => void> = [];
    setError(''); root.replaceChildren();
    const context: PluginAppContext = { pluginId: plugin.id, projectId, signal: controller.signal,
      invoke: async (action, input = {}) => { const result = await api<Json>('/plugins/invoke', { id: plugin.id, action, input, projectId }, controller.signal); await refresh(); return result; },
      settings: () => api('/plugins/settings', { id: plugin.id }, controller.signal),
    };
    void (async () => {
      const module = await import(/* @vite-ignore */ plugin.appUrl!); if (controller.signal.aborted) return;
      const app = module.default as PluginApp;
      if (app?.apiVersion !== 1 || !Array.isArray(app.panels) || app.panels.length > 10) throw Error('Unsupported plugin app entry');
      for (const panel of app.panels) {
        if (!panel || typeof panel.title !== 'string' || typeof panel.mount !== 'function') throw Error('Invalid plugin panel');
        const element = document.createElement('section'); element.className = 'plugin-surface'; element.setAttribute('aria-label', panel.title); root.append(element);
        if (panel.scope === 'project' && !projectId) { element.textContent = 'Select an app to open this panel.'; continue; }
        const dispose = await panel.mount(element, context);
        if (typeof dispose === 'function') { if (controller.signal.aborted) dispose(); else disposers.push(dispose); }
        if (controller.signal.aborted) break;
      }
    })().catch(() => { if (!controller.signal.aborted) setError('This plugin panel could not open. Reload or disable the plugin from its controls below.'); });
    return () => { controller.abort(); for (const dispose of disposers.reverse()) { try { dispose(); } catch { /* A failing plugin must not break shell cleanup. */ } } root.replaceChildren(); };
  }, [plugin.id, plugin.appUrl, projectId, refresh]);
  return <>{error && <p role="alert" className="plugin-error">{error}</p>}<div ref={container} /></>;
}
function PluginSettings({ plugin, perform }: { plugin: PluginView; perform(work: () => Promise<unknown>): void }) {
  const { api } = useStudioClient();
  const [values, setValues] = useState<Record<string, Json>>({}), [name, setName] = useState(''), [secret, setSecret] = useState('');
  useEffect(() => { let active = true; void api<Record<string, Json>>('/plugins/settings', { id: plugin.id }).then(value => { if (active) setValues(value); }).catch(() => {}); return () => { active = false; }; }, [plugin.id]);
  return <>
    {plugin.settings.length > 0 && <section className="plugin-box"><h3>Settings</h3>{plugin.settings.map(setting => <form key={setting.id} className="plugin-setting" onSubmit={event => { event.preventDefault(); perform(() => api('/plugins/setting', { id: plugin.id, key: setting.id, value: values[setting.id] ?? setting.default ?? (setting.type === 'boolean' ? false : setting.type === 'number' ? 0 : '') })); }}>
      <label>{setting.label}<input type={setting.type === 'boolean' ? 'checkbox' : setting.type === 'number' ? 'number' : 'text'} checked={setting.type === 'boolean' ? !!values[setting.id] : undefined} value={setting.type === 'boolean' ? undefined : String(values[setting.id] ?? setting.default ?? '')} onChange={event => setValues(current => ({ ...current, [setting.id]: setting.type === 'boolean' ? event.target.checked : setting.type === 'number' ? Number(event.target.value) : event.target.value }))} /></label><Button type="submit" variant="outline">Save</Button>
    </form>)}</section>}
    {plugin.capabilities.includes('credentials') && <section className="plugin-box"><h3>Private credentials</h3><p>Stored using Dunara’s protected credential storage. Values are available to this plugin’s trusted server code.</p><form onSubmit={event => { event.preventDefault(); const value = secret; setSecret(''); perform(() => api('/plugins/credential', { id: plugin.id, name, value })); }}><label>Credential name<input required pattern="[a-z][a-z0-9-]{0,47}" value={name} onChange={event => setName(event.target.value)} /></label><label>Secret value<input required type="password" autoComplete="new-password" value={secret} onChange={event => setSecret(event.target.value)} /></label><div className="plugin-controls"><Button type="submit">Save privately</Button><Button variant="outline" disabled={!name} onClick={() => { setSecret(''); perform(() => api('/plugins/credential', { id: plugin.id, name, value: null })); }}>Remove</Button></div></form></section>}
  </>;
}
export function PluginsPanel({ catalog, projectId }: { catalog: ReturnType<typeof usePlugins>; projectId: string | null }) {
  const { api, capabilities } = useStudioClient();
  const [selected, setSelected] = useState(''), [source, setSource] = useState(''), [trust, setTrust] = useState(false), [development, setDevelopment] = useState(false), [installing, setInstalling] = useState(false);
  const [inspection, setInspection] = useState<{ package: { version: string; builder: { id: string; name: string; description: string; capabilities: string[] } }; digest: string; files: string[] }>();
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [guide, setGuide] = useState(''), [action, setAction] = useState(''), [input, setInput] = useState('{}');
  const plugin = catalog.state?.plugins.find(p => p.id === selected);
  async function perform(work: () => Promise<unknown>) { setBusy(true); setError(''); setNotice(''); try { await work(); await catalog.refresh(); setNotice('Done'); } catch (error) { setError(error instanceof Error ? error.message : 'Plugin operation failed'); } finally { setBusy(false); } }
  const change = (operation: string) => { if (plugin) void perform(() => api('/plugins/change', { id: plugin.id, operation })); };
  return <main className="destination plugins-page" aria-busy={busy}>
    <header className="plugins-heading"><div><div className="plugin-eyebrow"><Puzzle size={16} aria-hidden />MAKE DUNARA YOURS</div><h1>Plugins</h1><p>Everything you need, with room for what you build next.</p></div><Button variant="outline" disabled={!capabilities.managePlugins} onClick={() => setInstalling(!installing)}><Plus size={16} aria-hidden />Install plugin</Button></header>
    {(error || catalog.error) && <p role="alert" className="plugin-error">{error || catalog.error}</p>}{notice && <p role="status" className="plugin-notice"><Check size={14} aria-hidden />{notice}</p>}
    {!capabilities.managePlugins && <p className="plugin-box">Your cloud workspace includes the plugins below. Installation and updates are managed by your host.</p>}
    {capabilities.managePlugins && catalog.state?.recovery && <p className="plugin-box" role="status">Recovery mode is active. User plugins are skipped. Restart without BUILDER_DISABLE_USER_PLUGINS to load them.</p>}
    {installing && <section className="plugin-box plugin-install"><h2>Install a local plugin</h2><p>Choose a prebuilt plugin directory or a .builder-plugin.json package on this computer.</p><form onSubmit={event => { event.preventDefault(); setTrust(false); void perform(async () => setInspection(await api('/plugins/inspect', { source }))); }}><label>Package path<input placeholder="/absolute/path/my-plugin" value={source} onChange={event => { setSource(event.target.value); setInspection(undefined); setTrust(false); }} required /></label><Button variant="outline" type="submit" disabled={busy || !capabilities.managePlugins}>Inspect package</Button></form>
      {inspection && <div className="plugin-install-review"><h3>{inspection.package.builder.name} <small>{inspection.package.version}</small></h3><p>{inspection.package.builder.description}</p><p>Capabilities: {inspection.package.builder.capabilities.join(', ') || 'No host capabilities declared'}</p><details><summary>{inspection.files.length} package files · content fingerprint</summary><pre>{inspection.digest}{'\n\n'}{inspection.files.join('\n')}</pre></details><label className="plugin-check"><input type="checkbox" checked={trust} onChange={event => setTrust(event.target.checked)} />I trust this plugin. Its code can access my computer and data.</label><label className="plugin-check"><input type="checkbox" checked={development} onChange={event => setDevelopment(event.target.checked)} />Remember as a development package</label><Button disabled={busy || !trust} onClick={() => void perform(async () => { await api('/plugins/install', { source, digest: inspection.digest, trust: true, development }); setSelected(inspection.package.builder.id); setInspection(undefined); setTrust(false); setInstalling(false); })}>Install and enable</Button></div>}
    </section>}
    {!!catalog.state?.reviews.length && <section className="plugin-box plugin-reviews"><h2>Review proposed changes</h2>{catalog.state.reviews.map(review => <article key={review.id}><h3>{review.pluginId} · {review.action}</h3><p>{review.projectId ? `App ${review.projectId}` : 'Global action'} · expires {new Date(review.expiresAt).toLocaleTimeString()}</p><pre>{JSON.stringify({ input: review.input, changes: review.plan }, null, 2)}</pre><div className="plugin-controls"><Button disabled={busy || !capabilities.managePlugins} onClick={() => void perform(() => api('/plugins/review', { id: review.id, approve: true }))}>Apply reviewed changes</Button><Button variant="outline" disabled={busy || !capabilities.managePlugins} onClick={() => void perform(() => api('/plugins/review', { id: review.id, approve: false }))}>Dismiss</Button></div></article>)}</section>}
    <div className="plugins-layout"><section aria-label="Installed plugins" className="plugin-list"><div className="plugin-section-title"><h2>Installed</h2><span>{catalog.state?.plugins.length ?? '…'}</span></div>{catalog.state?.plugins.map(item => <button key={item.id} className="plugin-card" aria-pressed={selected === item.id} onClick={() => { setSelected(item.id); setGuide(''); setAction(''); setInput('{}'); setNotice(''); }}><span className="plugin-symbol"><Package size={19} aria-hidden /></span><span className="plugin-card-copy"><strong>{item.name}</strong><span>{item.description}</span><small>{item.source === 'builtin' ? 'Included with Dunara' : item.source === 'development' ? 'Development' : 'Installed by you'} · {item.version}</small></span><span className={`plugin-status plugin-status-${item.status}`}>{item.status}</span><ChevronRight size={16} aria-hidden /></button>)}<Button variant="ghost" disabled={busy || !capabilities.managePlugins} onClick={() => void perform(() => api('/plugins/restore', { confirm: true }))}><RefreshCw size={14} aria-hidden />Restore bundled plugins</Button></section>
      <section className="plugin-detail" aria-label="Plugin details">{plugin ? <>
        <div className="plugin-detail-heading"><Puzzle size={25} aria-hidden /><h2>{plugin.name}</h2><span className={`plugin-status plugin-status-${plugin.status}`}>{plugin.status}</span></div><p>{plugin.description}</p><p className="plugin-muted">{plugin.id} · v{plugin.version}</p>{plugin.error && <p role="alert" className="plugin-error">{plugin.error}</p>}
        <div className="plugin-controls"><Button variant="outline" disabled={busy || !capabilities.managePlugins} onClick={() => change(plugin.enabled ? 'disable' : 'enable')}>{plugin.enabled ? 'Disable' : 'Enable'}</Button><Button variant="outline" disabled={busy || !capabilities.managePlugins || !plugin.enabled} onClick={() => change('reload')}>Reload</Button>{plugin.canRollback && <Button variant="outline" disabled={busy || !capabilities.managePlugins} onClick={() => change('rollback')}>Previous version</Button>}<Button variant="ghost" disabled={busy || !capabilities.managePlugins} onClick={() => change('uninstall')}>Uninstall</Button></div>
        <p className="plugin-muted">Uninstall keeps app source, settings and remote resources.</p>{Object.keys(plugin.requires).length > 0 && <p className="plugin-muted">Requires: {Object.keys(plugin.requires).join(', ')}</p>}
        {plugin.status === 'active' && capabilities.managePlugins && <><PluginSurface plugin={plugin} projectId={projectId} refresh={catalog.refresh} /><PluginSettings key={plugin.id} plugin={plugin} perform={work => { void perform(work); }} />
          {plugin.actions.length > 0 && <section className="plugin-box"><h3>Actions</h3><label>Action<select value={action} onChange={event => setAction(event.target.value)}><option value="">Choose an action</option>{plugin.actions.map(a => <option key={a.id} value={a.id}>{a.title}{a.effect === 'write' ? ' · review required' : ''}</option>)}</select></label><label>Input (JSON)<textarea value={input} onChange={event => setInput(event.target.value)} rows={4} spellCheck={false} /></label><Button disabled={busy || !action} onClick={() => void perform(async () => { const result = await api('/plugins/invoke', { id: plugin.id, action, input: JSON.parse(input), projectId }); setGuide(JSON.stringify(result, null, 2)); })}>Run action</Button></section>}
          {plugin.recipes.length > 0 && <section className="plugin-box"><h3>App recipes</h3><p>Review changes before applying them to the selected app.</p>{plugin.recipes.map(recipe => <div key={recipe.id} className="plugin-recipe"><strong>{recipe.title} · {recipe.version}</strong><p>{recipe.description}</p><Button variant="outline" disabled={busy || !projectId} onClick={() => void perform(() => api('/plugins/invoke', { id: plugin.id, action: `recipe:${recipe.id}`, input: {}, projectId }))}>Review recipe</Button></div>)}</section>}
        </>}
        {catalog.state?.operations?.some(operation => operation.pluginId === plugin.id) && <section className="plugin-box"><h3>Recent operations</h3>{catalog.state.operations.filter(operation => operation.pluginId === plugin.id).slice(0, 5).map(operation => <div key={operation.id} className="plugin-recipe"><strong>{operation.action} · {operation.state}</strong><p>{operation.message}</p></div>)}<Button variant="outline" disabled={busy || !capabilities.managePlugins} onClick={() => void perform(() => api('/plugins/cancel', { id: plugin.id }))}>Request cancellation</Button></section>}
        <section className="plugin-guides"><h3>Step-by-step guides</h3><div className="plugin-controls">{plugin.guides.map(name => <Button key={name} variant="outline" onClick={() => void perform(async () => { const value = await api<{ content: string }>('/plugins/guide', { id: plugin.id, name }); setGuide(value.content); })}><BookOpen size={14} aria-hidden />{name.includes('agent') ? 'For your assistant' : 'For you'}</Button>)}</div>{guide && <><Button variant="ghost" onClick={() => void perform(() => navigator.clipboard.writeText(guide))}>Copy</Button><pre className="plugin-guide">{guide}</pre></>}</section>
      </> : <div className="plugin-empty"><Puzzle size={38} aria-hidden /><h2>Your Dunara, extended.</h2><p>Select a plugin to see its features, settings and guides. Start with Plugin Guide to create your own.</p></div>}</section></div>
  </main>;
}
