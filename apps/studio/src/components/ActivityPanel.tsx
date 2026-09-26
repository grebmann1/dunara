import { useEffect, useState } from 'react';
import { Image } from 'lucide-react';
import { type MediaState, type StudioState, useStudioClient } from '../api';
import type { Backends } from '../../../../packages/core/src/backends';
import { DiagnosticLog, CaptureHistory } from './DiagnosticsPanel';
import { AssetImage } from './AssetImage';
import { Button } from './ui/button';
import { SectionTab } from './ui/section-tab';
import { Input } from './ui/input';
import { FieldSelect } from './ui/field-select';

export function ActivityPanel({ projectId, data, state, onReview, onResult, onLaunchKit, onAssets, onBackend }: { projectId: string; data: MediaState; state?: StudioState; onReview(id: string): void; onResult(id: string): void; onLaunchKit(): void; onAssets(): void; onBackend(): void }) {
  const [tab, setTab] = useState('requests'), [query, setQuery] = useState(''), [filter, setFilter] = useState('all');
  const active = (job: MediaState['jobs'][number]) => ['awaiting-approval', 'queued', 'running'].includes(job.state);
  const failed = (job: MediaState['jobs'][number]) => ['failed', 'interrupted'].includes(job.state);
  const priority = (job: MediaState['jobs'][number]) => active(job) ? 0 : failed(job) ? 1 : 2;
  const jobs = [...data.jobs].sort((a, b) => priority(a) - priority(b) || b.createdAt.localeCompare(a.createdAt));
  const pending = jobs.filter(active).length, failures = jobs.filter(failed).length;
  const errors = state?.diagnostics.entries.filter(entry => entry.level === 'error').length ?? 0;
  const matches = jobs.filter(job => job.request.label.toLowerCase().includes(query.toLowerCase()) && (filter === 'all' || (filter === 'active' ? active(job) : filter === 'failed' ? failed(job) : job.state === 'succeeded')));
  return <>
    <header className="activity-header"><div><h1>Activity</h1><p>Follow the work. Open the details when you need them.</p></div><span className="activity-health" data-error={errors > 0}>{errors ? `${errors} reported errors` : 'No reported errors'}</span></header>
    <div className="media-workspace-toolbar section-tabs" role="group" aria-label="Activity categories">{[['backend', 'Backend'], ['requests', `Requests · ${jobs.length}`], ['diagnostics', `Diagnostics${errors ? ` · ${errors}` : ''}`], ['captures', `Captures · ${state?.captures.length ?? 0}`]].map(([value, title]) => <SectionTab key={value} selected={tab === value} aria-pressed={tab === value} onClick={() => setTab(value!)}>{title}</SectionTab>)}{(pending > 0 || failures > 0) && <Button className="activity-attention" variant="outline" onClick={() => { setTab('requests'); setFilter(pending ? 'active' : 'failed'); setQuery(''); }}>{pending ? `${pending} active` : `${failures} need attention`}</Button>}</div>
    <section hidden={tab !== 'requests'} className="activity-detail-view" aria-label="Media activity"><div className="activity-filterbar"><h2 className="sr-only">Media requests</h2><Input type="search" aria-label="Search requests" placeholder="Search requests…" value={query} onChange={event => setQuery(event.target.value)} /><FieldSelect label="Request status" value={filter} onValueChange={setFilter} options={[{ value: 'all', label: 'All requests' }, { value: 'active', label: 'Active & awaiting approval' }, { value: 'failed', label: 'Failed & interrupted' }, { value: 'succeeded', label: 'Completed' }]} /><span>{matches.length} requests</span></div>
      <div className="activity-scroll"><p className="activity-retention">Pending work first. Retained requests are not a permanent audit log.</p>
        {!matches.length && <div className="activity-empty"><strong>{jobs.length ? 'No matching requests' : 'No image requests yet'}</strong><p>Local imports and transforms are available in Assets without a key.</p>{jobs.length ? <Button variant="outline" onClick={() => { setQuery(''); setFilter('all'); }}>Clear filters</Button> : <Button variant="outline" onClick={onAssets}>Open asset library</Button>}</div>}
        <div className="activity-request-list">{matches.map(job => {
          const result = data.assets.find(asset => asset.id === job.resultIds[0]);
          return <article className="activity-job" key={job.id}>
            <span className="activity-request-image">{result ? <AssetImage projectId={projectId} asset={result} /> : <Image size={20} aria-hidden />}</span><Button variant="ghost" className="activity-request-open" aria-label={`Open request ${job.request.label}`} onClick={() => onReview(job.id)}><span className="activity-summary"><strong>{job.request.label}</strong><span>{job.request.operation} · {job.request.count} {job.request.count === 1 ? 'image' : 'images'}</span></span><span className="asset-status" data-state={job.state}>{job.state}</span><time dateTime={job.createdAt}>{new Date(job.createdAt).toLocaleString()}</time></Button>
            {result && <Button variant="outline" className="activity-result" aria-label={`View ${result.label}`} onClick={() => onResult(result.id)}>View image</Button>}
          </article>;
        })}</div>
      </div>
    </section>
    {tab === 'backend' && <BackendActivity projectId={projectId} onOpen={onBackend} />}
    {state && <><div className="activity-category" hidden={tab !== 'diagnostics'}><DiagnosticLog state={state} /></div><div className="activity-category" hidden={tab !== 'captures'}><CaptureHistory state={state} onLaunchKit={onLaunchKit} /></div></>}
  </>;
}

function BackendActivity({ projectId, onOpen }: { projectId: string; onOpen: () => void }) {
  const { api } = useStudioClient();
  const [state, setState] = useState<Awaited<ReturnType<Backends['inspect']>>>(), [error, setError] = useState('');
  useEffect(() => { let alive = true; const refresh = () => { void api<Awaited<ReturnType<Backends['inspect']>>>(`/projects/${projectId}/backend`).then(value => { if (alive) { setState(value); setError(''); } }).catch(() => { if (alive) setError('Backend activity is unavailable.'); }); }; refresh(); const timer = setInterval(refresh, 4000); return () => { alive = false; clearInterval(timer); }; }, [projectId]);
  return <section className="activity-detail-view backend-activity" aria-label="Backend activity"><h2>Backend setup</h2><p>{state?.setup.next}</p><Button onClick={onOpen}>Open Backend reviews</Button>{error && <p role="alert">{error}</p>}{state?.operations.map(operation => <article className="backend-card" key={operation.id}><h3>{({ backend_configure: 'Configure app services', backend_link: 'Connect project', backend_create: 'Create project', backend_migrate: 'Apply migration' } as Record<string, string>)[operation.kind] ?? operation.kind.replaceAll('_', ' ')}</h3><p>{operation.environment} · {operation.state.replaceAll('_', ' ')}</p>{operation.error && <p>{operation.error}</p>}<ol>{operation.steps.map(step => <li key={step.name}>{step.name} · {step.state.replaceAll('_', ' ')}</li>)}</ol></article>)}</section>;
}
