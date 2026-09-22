import { useEffect, useRef, useState } from 'react';
import type { MediaState } from '../api';
import { ASTRA_MODEL, mediaModelLabel } from '../../../../packages/core/src/media-job-contracts';
import { AssetImage } from './AssetImage';
import { Button } from './ui/button';
import { Label } from './ui/label';
import { Check, LoaderCircle, Sparkles } from 'lucide-react';
import type { Asset } from '../../../../packages/core/src/media-contracts';

const stateLabels = { 'awaiting-approval': 'Ready to generate', queued: 'Queued', running: 'Creating', succeeded: 'Ready to review', failed: 'Could not finish', cancelled: 'Cancelled', interrupted: 'Interrupted' };

export function JobCard({ job, data, projectId, focused, disabled, save, onResult, onRemix }: { job: MediaState['jobs'][number]; data: MediaState; projectId: string; focused: boolean; disabled: boolean; save: (action: string, input: unknown) => Promise<boolean>; onResult: (id: string) => void; onRemix?: (asset: Asset) => void }) {
  const [consentRevision, setConsentRevision] = useState('');
  const card = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!focused) return;
    const details = card.current?.querySelector<HTMLDetailsElement>(':scope > details');
    if (details) details.open = true;
    card.current?.focus({ preventScroll: true });
    card.current?.scrollIntoView({ block: 'start' });
  }, [focused]);
  const revision = data.capabilities.provider.revision;
  const consent = consentRevision === revision;
  const waiting = job.state === 'awaiting-approval';
  const disclosure = <>
    {waiting && data.capabilities.provider.source === 'managed' && <p>{job.creditEstimate === undefined ? 'Credit estimate unavailable. Choose a supported request or a personal image key.' : `Estimated reservation: ${job.creditEstimate.toLocaleString(undefined,{ maximumFractionDigits: 2 })} credits. Actual reported usage is charged; unused credit is released.`}</p>}
    <dl><dt>Provider / model</dt><dd>OpenAI / {mediaModelLabel(job.model)}</dd><dt>Requested outputs</dt><dd>{job.request.count} · {job.request.quality} quality · {job.request.size} · {job.request.operation}</dd><dt>Exact prompt sent</dt><dd className="media-prompt">{job.request.prompt}</dd><dt>Reference images leaving this machine</dt><dd>{job.request.referenceIds.length ? job.request.referenceIds.map(id => { const asset = data.assets.find(a => a.id === id); return <div key={id}>{asset ? <><code>{asset.path}</code><AssetImage projectId={projectId} asset={asset} /></> : id}</div>; }) : 'None'}</dd></dl>
    <details className="creative-billing"><summary>Generation & billing details</summary>{job.model === ASTRA_MODEL && <p>Astra art-directs your prompt for GPT Image. Text and image charges apply. One Responses request, low reasoning effort, at most one image call and 4,096 output tokens.</p>}<p>Billable request; exact cost unknown. No automatic retry. Cancellation cannot guarantee a refund or stop provider-side processing.</p></details>
  </>;
  return <article ref={card} tabIndex={-1} aria-label={`${job.request.label} request`} className="media-card media-job" data-state={job.state}><div className="creative-job-heading"><span className="creative-job-mark" aria-hidden>{job.state === 'succeeded' ? <Check size={20} /> : job.state === 'running' ? <LoaderCircle size={20} className="assistant-spinner" /> : <Sparkles size={20} />}</span><div><h3>{job.request.label} · {stateLabels[job.state]}</h3><p>{job.request.size.replace('x', ' × ')} · {job.request.quality} quality · {job.request.count} {job.request.count === 1 ? 'image' : 'images'}</p></div></div>{job.error && <p role="alert">{job.error}</p>}
    {waiting ? <section aria-label="Request disclosure"><h4>Request disclosure</h4>{disclosure}</section> : <details><summary>Request disclosure</summary>{disclosure}</details>}
    <fieldset disabled={disabled}><div className="media-actions">{waiting && <><Label className="consent"><input type="checkbox" checked={consent} onChange={e => setConsentRevision(e.target.checked ? revision : '')} />I authorize this exact paid request and disclosure using the current {data.capabilities.provider.source} configuration.</Label><Button disabled={!consent || !data.capabilities.available} onClick={() => void save('job-approve', { jobId: job.id, expectedConfigurationRevision: consentRevision })}>Approve paid request</Button></>}{['awaiting-approval', 'queued', 'running'].includes(job.state) && <Button variant="outline" onClick={() => void save('job-cancel', { jobId: job.id })}>Cancel local job</Button>}</div></fieldset>
    {['queued', 'running'].includes(job.state) && <div className="creative-generating" role="status"><Sparkles size={28} aria-hidden /><strong>{job.state === 'queued' ? 'Your artwork is in the queue' : 'Bringing your idea to life'}</strong><p>You can keep exploring your app. Your images will appear here when ready.</p></div>}
    {!!job.resultIds.length && <div className="creative-results" role="group" aria-label="Generated candidates">{job.resultIds.map(id => {
      const result = data.assets.find(asset => asset.id === id);
      return <div key={id}>{result && <AssetImage projectId={projectId} asset={result} />}<Button variant="outline" disabled={disabled || !result} onClick={() => onResult(id)}>{result ? `Review ${result.label}` : 'Candidate unavailable'}</Button>{result?.status === 'approved' && onRemix && <Button variant="ghost" disabled={disabled} onClick={() => onRemix(result)}>Create a variation</Button>}</div>;
    })}</div>}
  </article>;
}
