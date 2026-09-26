import { useRef, useState } from 'react';
import type { PluginView } from '../../../../packages/plugin-runtime/src/contracts';
import { useStudioClient } from '../api';
import { PluginSurface, type usePlugins } from '../plugins/PluginsPanel';
import { BackendTabs } from './BackendTabs';
import { Button } from './ui/button';
import '../backend.css';

export function BackendPluginPanel({ plugin, projectId, catalog, disabled }: { plugin: PluginView; projectId: string; catalog: ReturnType<typeof usePlugins>; disabled: boolean }) {
  const { api, capabilities } = useStudioClient();
  const [tab, setTab] = useState<'workspace' | 'reviews'>('workspace');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [revision, setRevision] = useState(0);
  const operating = useRef(false);
  const reviews = catalog.state?.reviews.filter(review => review.pluginId === plugin.id && (review.projectId === projectId || review.projectId === null)) ?? [];
  async function answer(id: string, approve: boolean) {
    if (disabled || operating.current || !capabilities.managePlugins) return;
    operating.current = true; setBusy(true); setError('');
    try { await api('/plugins/review', { id, approve }); await catalog.refresh(); setRevision(value => value + 1); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Review could not be completed.'); }
    finally { operating.current = false; setBusy(false); }
  }
  return <main className="destination backend-workspace"><header className="backend-title"><div><p className="backend-eyebrow">BACKEND</p><h1>{plugin.name}</h1><p>{plugin.description}</p></div></header>
    {!capabilities.managePlugins ? <p>This backend integration is managed by your host.</p> : <BackendTabs<'workspace' | 'reviews'> label={`${plugin.name} sections`} tabs={[{ id: 'workspace', label: 'Workspace' }, { id: 'reviews', label: 'Reviews', count: reviews.length }]} active={tab} onChange={setTab}>{section => section === 'workspace' ? <>
      {reviews.length > 0 && <div className="backend-card backend-review-notice"><p>{reviews.length} proposed {reviews.length === 1 ? 'change is' : 'changes are'} ready for review.</p><Button onClick={() => setTab('reviews')}>Review changes</Button></div>}
      <fieldset disabled={disabled || busy} className="backend-plugin-surface"><PluginSurface key={revision} plugin={plugin} panelId={plugin.workspacePanel} projectId={projectId} refresh={catalog.refresh} /></fieldset>
    </> : <section aria-label={`${plugin.name} reviews`}><div className="backend-section-intro"><h2>Changes & reviews</h2><p>Approve proposed changes for this app or this provider’s account.</p></div>{error && <p role="alert">{error}</p>}{reviews.length === 0 && <div className="backend-card"><p>No changes to review.</p></div>}{reviews.map(review => <article key={review.id} className="backend-card"><h3>{plugin.actions.find(action => action.id === review.action)?.title ?? review.action}</h3><p>{review.projectId ? 'This app' : 'Account-wide change'} · expires {new Date(review.expiresAt).toLocaleTimeString()}</p><pre tabIndex={0}>{JSON.stringify({ input: review.input, changes: review.plan }, null, 2)}</pre><div className="backend-actions"><Button disabled={disabled || busy} onClick={() => void answer(review.id, true)}>Apply reviewed changes</Button><Button variant="outline" disabled={disabled || busy} onClick={() => void answer(review.id, false)}>Dismiss</Button></div></article>)}</section>}</BackendTabs>}
  </main>;
}
