import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, BookOpen, Check, ChevronDown, ChevronRight, Package, Puzzle, RefreshCw, Search } from 'lucide-react';
import { useStudioClient } from '../api';
import { Button } from '../components/ui/button';
import { AssistantMarkdown } from '../components/AssistantMarkdown';
import { PluginInstaller } from './PluginInstaller';
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
export function PluginSurface({ plugin, projectId, refresh, panelId }: { plugin: PluginView; projectId: string | null; refresh(): Promise<void>; panelId?: string }) {
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
      if (panelId && !app.panels.some(panel => panel.id === panelId)) throw Error('Plugin workspace panel is unavailable');
      for (const panel of app.panels) {
        if (panelId && panel.id !== panelId) continue;
        if (!panel || typeof panel.title !== 'string' || typeof panel.mount !== 'function') throw Error('Invalid plugin panel');
        const element = document.createElement('section'); element.className = 'plugin-surface'; element.setAttribute('aria-label', panel.title); root.append(element);
        if (panel.scope === 'project' && !projectId) { element.textContent = 'Select an app to open this panel.'; continue; }
        const dispose = await panel.mount(element, context);
        if (typeof dispose === 'function') { if (controller.signal.aborted) dispose(); else disposers.push(dispose); }
        if (controller.signal.aborted) break;
      }
    })().catch(() => { if (!controller.signal.aborted) setError('This plugin panel could not open. Use Manage plugin to reload it, or disable the plugin.'); });
    return () => { controller.abort(); for (const dispose of disposers.reverse()) { try { dispose(); } catch { /* A failing plugin must not break shell cleanup. */ } } root.replaceChildren(); };
  }, [plugin.id, plugin.appUrl, panelId, projectId, refresh]);
  return <>{error && <p role="alert" className="plugin-error">{error}</p>}<div ref={container} /></>;
}
function PluginSettings({ plugin, busy, perform }: { plugin: PluginView; busy: boolean; perform(work: () => Promise<unknown>): void }) {
  const { api } = useStudioClient();
  const [values, setValues] = useState<Record<string, Json>>({}), [name, setName] = useState(''), [secret, setSecret] = useState('');
  useEffect(() => { let active = true; void api<Record<string, Json>>('/plugins/settings', { id: plugin.id }).then(value => { if (active) setValues(value); }).catch(() => {}); return () => { active = false; }; }, [plugin.id]);
  return <fieldset className="plugin-settings" disabled={busy}>
    {plugin.settings.length > 0 && <section className="plugin-box"><h3>Settings</h3>{plugin.settings.map(setting => <form key={setting.id} className="plugin-setting" onSubmit={event => { event.preventDefault(); perform(() => api('/plugins/setting', { id: plugin.id, key: setting.id, value: values[setting.id] ?? setting.default ?? (setting.type === 'boolean' ? false : setting.type === 'number' ? 0 : '') })); }}>
      <label>{setting.label}<input type={setting.type === 'boolean' ? 'checkbox' : setting.type === 'number' ? 'number' : 'text'} checked={setting.type === 'boolean' ? Boolean(values[setting.id] ?? setting.default ?? false) : undefined} value={setting.type === 'boolean' ? undefined : String(values[setting.id] ?? setting.default ?? '')} onChange={event => setValues(current => ({ ...current, [setting.id]: setting.type === 'boolean' ? event.target.checked : setting.type === 'number' ? Number(event.target.value) : event.target.value }))} /></label><Button type="submit" variant="outline">Save</Button>
    </form>)}</section>}
    {plugin.capabilities.includes('credentials') && <section className="plugin-box"><h3>Private credentials</h3><p>Stored using Dunara’s protected credential storage. Values are available to this plugin’s trusted server code.</p><form onSubmit={event => { event.preventDefault(); const value = secret; setSecret(''); perform(() => api('/plugins/credential', { id: plugin.id, name, value })); }}><label>Credential name<input required pattern="[a-z][a-z0-9-]{0,47}" value={name} onChange={event => setName(event.target.value)} /></label><label>Secret value<input required type="password" autoComplete="new-password" value={secret} onChange={event => setSecret(event.target.value)} /></label><div className="plugin-controls"><Button type="submit">Save privately</Button><Button variant="outline" disabled={!name} onClick={() => { setSecret(''); perform(() => api('/plugins/credential', { id: plugin.id, name, value: null })); }}>Remove</Button></div></form></section>}
  </fieldset>;
}
export function PluginsPanel({ catalog, projectId }: { catalog: ReturnType<typeof usePlugins>; projectId: string | null }) {
  const { api, capabilities } = useStudioClient();
  const [selected, setSelected] = useState(''), [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [guide, setGuide] = useState(''), [guideName, setGuideName] = useState(''), [guideLoading, setGuideLoading] = useState('');
  const [action, setAction] = useState(''), [input, setInput] = useState('{}'), [result, setResult] = useState('');
  const heading = useRef<HTMLHeadingElement>(null), detail = useRef<HTMLElement>(null), list = useRef<HTMLElement>(null);
  const cards = useRef(new Map<string, HTMLButtonElement>()), focusDetail = useRef(false), focusCard = useRef('');
  const version = useRef(0), guideRequest = useRef(0), operating = useRef(false), mounted = useRef(true);
  const plugin = catalog.state?.plugins.find(p => p.id === selected);
  const plugins = catalog.state?.plugins.filter(item => (item.name + ' ' + item.description).toLowerCase().includes(search.toLowerCase())) ?? [];
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; version.current++; guideRequest.current++; }; }, []);
  useEffect(() => {
    if (plugin && focusDetail.current) { focusDetail.current = false; detail.current?.scrollIntoView({ block: 'nearest' }); heading.current?.focus({ preventScroll: true }); }
    else if (!selected && focusCard.current) { const id = focusCard.current; focusCard.current = ''; (cards.current.get(id) ?? list.current?.querySelector<HTMLInputElement>('input'))?.focus(); }
  }, [selected, plugin]);
  function select(id: string) {
    version.current++; guideRequest.current++; focusDetail.current = true;
    setSelected(id); setGuide(''); setGuideName(''); setGuideLoading(''); setAction(''); setInput('{}'); setResult(''); setNotice(''); setError('');
  }
  function back() { focusCard.current = selected; select(''); focusDetail.current = false; }
  async function perform(work: () => Promise<unknown>, message = 'Saved') {
    if (operating.current) return false;
    operating.current = true; const current = version.current;
    setBusy(true); setError(''); setNotice('');
    try { await work(); await catalog.refresh(); if (mounted.current && current === version.current) setNotice(message); return true; }
    catch (cause) { if (mounted.current && current === version.current) setError(cause instanceof Error ? cause.message : 'Plugin operation failed'); return false; }
    finally { operating.current = false; if (mounted.current) setBusy(false); }
  }
  const change = async (operation: string) => {
    if (!plugin) return;
    const current = version.current;
    const success = await perform(() => api('/plugins/change', { id: plugin.id, operation }), 'Plugin updated');
    if (success && operation === 'uninstall' && mounted.current && current === version.current) back();
  };
  async function readGuide(name: string) {
    if (!plugin) return;
    const current = ++guideRequest.current;
    setGuideLoading(name); setError('');
    try { const value = await api<{ content: string }>('/plugins/guide', { id: plugin.id, name }); if (mounted.current && current === guideRequest.current) { setGuide(value.content); setGuideName(name); } }
    catch (cause) { if (mounted.current && current === guideRequest.current) setError(cause instanceof Error ? cause.message : 'Guide could not open. Try again.'); }
    finally { if (mounted.current && current === guideRequest.current) setGuideLoading(''); }
  }
  return <main className="destination plugins-page">
    <header className="plugins-heading"><div><h1>Plugins</h1><p>Features and tools for your workspace.</p></div><PluginInstaller disabled={busy || !capabilities.managePlugins} refresh={catalog.refresh} onInstalled={id => { setSearch(''); select(id); }} /></header>
    {catalog.error && <p role="alert" className="plugin-error">{catalog.error}</p>}
    {(error || notice) && <p role={error ? 'alert' : 'status'} className={error ? 'plugin-error' : 'plugin-notice'}>{!error && <Check size={14} aria-hidden />}{error || notice}</p>}
    {!capabilities.managePlugins && <p className="plugin-box">Installation and updates are managed by your host.</p>}
    {capabilities.managePlugins && catalog.state?.recovery && <p className="plugin-box" role="status">Recovery mode is active. User plugins are skipped. Restart without BUILDER_DISABLE_USER_PLUGINS to load them.</p>}
    {!!catalog.state?.reviews.length && <section className="plugin-box plugin-reviews"><h2>Review proposed changes</h2>{catalog.state.reviews.map(review => <article key={review.id}><h3>{review.pluginId} · {review.action}</h3><p>{review.projectId ? 'App ' + review.projectId : 'Global action'} · expires {new Date(review.expiresAt).toLocaleTimeString()}</p><pre tabIndex={0}>{JSON.stringify({ input: review.input, changes: review.plan }, null, 2)}</pre><div className="plugin-controls"><Button disabled={busy || !capabilities.managePlugins} onClick={() => void perform(() => api('/plugins/review', { id: review.id, approve: true }), 'Changes applied')}>Apply reviewed changes</Button><Button variant="outline" disabled={busy || !capabilities.managePlugins} onClick={() => void perform(() => api('/plugins/review', { id: review.id, approve: false }), 'Review dismissed')}>Dismiss</Button></div></article>)}</section>}
    <div className="plugins-layout" data-selected={!!plugin}>
      <section ref={list} tabIndex={-1} aria-label="Installed plugins" className="plugin-list">
        <div className="plugin-section-title"><h2>Installed</h2><span>{catalog.state?.plugins.length ?? '…'}</span></div>
        <label className="plugin-search"><Search size={15} aria-hidden /><input type="search" aria-label="Search plugins" placeholder="Search plugins" value={search} onChange={event => setSearch(event.target.value)} /></label>
        <div className="plugin-cards">{plugins.map(item => <button key={item.id} ref={node => { if (node) cards.current.set(item.id, node); else cards.current.delete(item.id); }} className="plugin-card" aria-pressed={selected === item.id} onClick={() => select(item.id)}>
          <span className="plugin-symbol"><Package size={17} aria-hidden /></span>
          <span className="plugin-card-copy"><strong>{item.name}</strong><small>{item.source === 'builtin' ? 'Included with Dunara' : item.source === 'development' ? 'Development' : 'Installed by you'} · {item.version}</small></span>
          <span className={'plugin-status plugin-status-' + item.status}>{item.status}</span><ChevronRight size={14} aria-hidden />
        </button>)}</div>
        {catalog.state && !plugins.length && <p className="plugin-no-results">{search ? 'No matching plugins.' : 'No plugins installed.'}{search && <Button variant="ghost" onClick={() => setSearch('')}>Clear search</Button>}</p>}
        {capabilities.managePlugins && <details className="plugin-library-tools"><summary>Library options<ChevronDown size={14} aria-hidden /></summary><Button variant="ghost" disabled={busy} onClick={() => void perform(() => api('/plugins/restore', { confirm: true }), 'Bundled plugins restored')}><RefreshCw size={14} aria-hidden />Restore bundled plugins</Button></details>}
      </section>
      <section ref={detail} className="plugin-detail" aria-label="Plugin details">
        {plugin ? <div key={plugin.id}>
          <Button variant="ghost" className="plugin-back" onClick={back}><ArrowLeft size={14} aria-hidden />All plugins</Button>
          <header className="plugin-detail-heading"><span className="plugin-detail-symbol"><Puzzle size={22} aria-hidden /></span><div><h2 ref={heading} tabIndex={-1}>{plugin.name}</h2><p>{plugin.source === 'builtin' ? 'Included with Dunara' : 'Installed plugin'} · v{plugin.version}</p></div><span className={'plugin-status plugin-status-' + plugin.status}>{plugin.status}</span></header>
          <p className="plugin-description">{plugin.description}</p>
          {plugin.error && <p role="alert" className="plugin-error">{plugin.error}</p>}
          <div className="plugin-management"><Button variant="outline" disabled={busy || !capabilities.managePlugins} onClick={() => change(plugin.enabled ? 'disable' : 'enable')}>{plugin.enabled ? 'Disable' : 'Enable'}</Button>
            <details><summary>Manage plugin<ChevronDown size={14} aria-hidden /></summary><div className="plugin-controls"><Button variant="outline" disabled={busy || !capabilities.managePlugins || !plugin.enabled} onClick={() => change('reload')}>Reload</Button>{plugin.canRollback && <Button variant="outline" disabled={busy || !capabilities.managePlugins} onClick={() => change('rollback')}>Previous version</Button>}<Button variant="ghost" disabled={busy || !capabilities.managePlugins} onClick={() => change('uninstall')}>Uninstall</Button></div><p className="plugin-muted">Uninstall keeps app source, settings and remote resources.</p><p className="plugin-muted">{plugin.id}{Object.keys(plugin.requires).length > 0 && ' · Requires: ' + Object.keys(plugin.requires).join(', ')}</p></details>
          </div>
          {plugin.status === 'active' && capabilities.managePlugins && <><PluginSurface plugin={plugin} projectId={projectId} refresh={catalog.refresh} /><PluginSettings plugin={plugin} busy={busy} perform={work => { void perform(work); }} />
            {plugin.recipes.length > 0 && <section className="plugin-box"><h3>App recipes</h3><p>Review changes before applying them to the selected app.</p>{plugin.recipes.map(recipe => <div key={recipe.id} className="plugin-recipe"><strong>{recipe.title} · {recipe.version}</strong><p>{recipe.description}</p><Button variant="outline" disabled={busy || !projectId} onClick={() => void perform(() => api('/plugins/invoke', { id: plugin.id, action: 'recipe:' + recipe.id, input: {}, projectId }), 'Ready for review')}>Review recipe</Button></div>)}</section>}
          </>}
          {!!plugin.guides.length && <section className="plugin-guides"><h3>Step-by-step guides</h3><div className="plugin-controls">{plugin.guides.map(name => <Button key={name} variant="outline" aria-pressed={guideName === name} onClick={() => void readGuide(name)}><BookOpen size={14} aria-hidden />{name.includes('agent') ? 'For your assistant' : 'For you'}</Button>)}</div>
            {guideLoading && <p role="status" className="plugin-muted">Loading guide…</p>}{guide && <div className="plugin-guide"><div className="plugin-guide-tools"><Button variant="ghost" onClick={() => void perform(() => navigator.clipboard.writeText(guide), 'Guide copied')}>Copy guide</Button><Button variant="ghost" onClick={() => { guideRequest.current++; setGuide(''); setGuideName(''); setGuideLoading(''); }}>Close guide</Button></div><AssistantMarkdown text={guide} /></div>}
          </section>}
          {plugin.status === 'active' && capabilities.managePlugins && plugin.actions.length > 0 && <details className="plugin-box plugin-advanced"><summary>Developer actions<ChevronDown size={14} aria-hidden /></summary><p>Run a plugin action directly. Write actions prepare changes for review.</p><label>Action<select value={action} onChange={event => { setAction(event.target.value); setResult(''); }}><option value="">Choose an action</option>{plugin.actions.map(a => <option key={a.id} value={a.id}>{a.title}{a.effect === 'write' ? ' · review required' : ''}</option>)}</select></label><label>Input (JSON)<textarea value={input} onChange={event => setInput(event.target.value)} rows={4} spellCheck={false} /></label><Button disabled={busy || !action} onClick={() => { const current = version.current; void perform(async () => { const value = await api('/plugins/invoke', { id: plugin.id, action, input: JSON.parse(input), projectId }); if (mounted.current && current === version.current) setResult(JSON.stringify(value, null, 2)); }, 'Action finished'); }}>Run action</Button>{result && <pre tabIndex={0}>{result}</pre>}</details>}
          {catalog.state?.operations?.some(operation => operation.pluginId === plugin.id) && <details className="plugin-box"><summary>Recent operations<ChevronDown size={14} aria-hidden /></summary>{catalog.state.operations.filter(operation => operation.pluginId === plugin.id).slice(0, 5).map(operation => <div key={operation.id} className="plugin-recipe"><strong>{operation.action} · {operation.state}</strong><p>{operation.message}</p></div>)}<Button variant="outline" disabled={busy || !capabilities.managePlugins} onClick={() => void perform(() => api('/plugins/cancel', { id: plugin.id }), 'Cancellation requested')}>Request cancellation</Button></details>}
        </div> : <div className="plugin-empty"><Puzzle size={30} aria-hidden /><h2>Choose a plugin</h2><p>Browse its features, settings and guides here.</p></div>}
      </section>
    </div>
  </main>;
}
