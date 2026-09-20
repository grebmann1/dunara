import { useEffect, useRef, useState } from 'react';
import type { DeliveryPlan, DeliveryPreflight, DeliverySelection, DeliveryStatus, InstallPlan } from '../../../../packages/core/src/native-delivery-contracts';
import type { WorkspaceStatus } from '../../../../packages/core/src/native-workspace-contracts';
import { useStudioClient } from '../api';
import { Button } from './ui/button';
import { FieldSelect } from './ui/field-select';

const active = (job: DeliveryStatus) => ['building', 'installing', 'launching'].includes(job.state);
const steps = { copy: 'Copying prepared source', dependencies: 'Installing dependencies', prebuild: 'Creating the iOS project', pods: 'Preparing native dependencies', compile: 'Building and signing with Xcode', verify: 'Verifying the signed app', install: 'Installing on iPhone', launch: 'Opening on iPhone' };
const states = { ready: 'Signed app ready', installed: 'Installation verified', launched: 'Opened on iPhone', failed: 'Needs attention', cancelled: 'Build cancelled', interrupted: 'Operation interrupted' };

export function NativeDeliveryPanel({ projectId, workspaces }: { projectId: string; workspaces: WorkspaceStatus[] }) {
  const { api } = useStudioClient(), base = `/projects/${projectId}/native-deliveries`;
  const ready = workspaces.filter(value => value.state === 'ready' && value.selection.profile === 'preview' && value.selection.platform !== 'android' && value.backend.environment === 'none');
  const [preflight, setPreflight] = useState<DeliveryPreflight>(), [selection, setSelection] = useState<DeliverySelection>({ workspaceId: '', deviceId: '', teamId: '' });
  const [plan, setPlan] = useState<DeliveryPlan>(), [installation, setInstallation] = useState<InstallPlan>(), [jobs, setJobs] = useState<DeliveryStatus[]>([]);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [removing, setRemoving] = useState<DeliveryStatus>();
  const alive = useRef(true), operating = useRef(false), requestId = useRef(''), review = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let disposed = false, timer: ReturnType<typeof setTimeout>; alive.current = true;
    async function refresh() {
      try { const result = await api<{ deliveries: DeliveryStatus[] }>(base); if (!disposed) setJobs(result.deliveries); }
      catch (cause) { if (!disposed) setError(cause instanceof Error ? cause.message : 'Build status is unavailable.'); }
      finally { if (!disposed) timer = setTimeout(() => void refresh(), 2000); }
    }
    void refresh(); return () => { disposed = true; alive.current = false; clearTimeout(timer); };
  }, [base]);
  async function perform(action: string, job?: DeliveryStatus) {
    if (operating.current) return; operating.current = true; setBusy(true); setError('');
    try {
      if (action === 'preflight') {
        const value = await api<DeliveryPreflight>(`${base}/preflight`, {});
        if (alive.current) { setPreflight(value); setPlan(undefined); setSelection(current => ({ workspaceId: ready.some(value => value.id === current.workspaceId) ? current.workspaceId : ready[0]?.id ?? '', deviceId: value.devices.some(value => value.id === current.deviceId) ? current.deviceId : value.devices[0]?.id ?? '', teamId: value.teams.some(value => value.id === current.teamId) ? current.teamId : value.teams[0]?.id ?? '' })); }
      } else if (action === 'plan') {
        const value = await api<DeliveryPlan>(`${base}/plan`, selection);
        if (alive.current) { setPlan(value); setInstallation(undefined); requestId.current = crypto.randomUUID(); requestAnimationFrame(() => review.current?.focus()); }
      } else if (action === 'install-plan' && job) {
        const value = await api<InstallPlan>(`${base}/install-plan`, { deliveryId: job.id, expectedRevision: job.revision });
        if (alive.current) { setInstallation(value); setPlan(undefined); requestAnimationFrame(() => review.current?.focus()); }
      } else {
        if (action === 'build' && plan) await api(`${base}/build`, { selection: plan.selection, proposedRevision: plan.proposedRevision, requestId: requestId.current, confirmed: true });
        else if (action === 'install' && installation) await api(`${base}/install`, { deliveryId: installation.deliveryId, expectedRevision: installation.expectedRevision, proposedRevision: installation.proposedRevision, confirmed: true });
        else if (job) await api(`${base}/${action}`, { deliveryId: job.id, expectedRevision: job.revision, ...(['launch', 'remove'].includes(action) ? { confirmed: true } : {}) });
        if (alive.current) { setPlan(undefined); setInstallation(undefined); setRemoving(undefined); }
        const result = await api<{ deliveries: DeliveryStatus[] }>(base); if (alive.current) setJobs(result.deliveries);
      }
    } catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : 'Phone delivery failed. Refresh and review again.'); }
    finally { operating.current = false; if (alive.current) setBusy(false); }
  }
  function select(key: keyof DeliverySelection, value: string) { setSelection(current => ({ ...current, [key]: value })); setPlan(undefined); }
  const running = jobs.some(active);
  return <section className="native-delivery" aria-label="Install on iPhone">
    <div><h3>Install on iPhone</h3><p>Build on this Mac, then install on your connected iPhone. No Expo account or backend needed.</p></div>
    <Button variant="outline" disabled={busy || running} onClick={() => void perform('preflight')}>{busy && !preflight ? 'Checking this Mac…' : preflight ? 'Refresh phone and signing' : 'Check phone and signing'}</Button>
    {preflight && <>
      {!!preflight.issues.length && <ul>{preflight.issues.map(issue => <li key={issue}>{issue}</li>)}</ul>}
      {preflight.supported && <fieldset disabled={busy || running}>
        {!ready.length ? <p>Prepare an iOS Preview workspace with “No backend” above to continue.</p> : <FieldSelect label="Prepared app" value={selection.workspaceId} onValueChange={value => select('workspaceId', value)} options={ready.map(value => ({ value: value.id, label: `${new Date(value.createdAt).toLocaleString()} · ${value.id.slice(0, 8)}` }))} />}
        {!!preflight.devices.length && <FieldSelect label="iPhone" value={selection.deviceId} onValueChange={value => select('deviceId', value)} options={preflight.devices.map(value => ({ value: value.id, label: `${value.name} · ${value.model}` }))} />}
        {!!preflight.teams.length && <FieldSelect label="Apple signing team" value={selection.teamId} onValueChange={value => select('teamId', value)} options={preflight.teams.map(value => ({ value: value.id, label: `${value.name} · ${value.id}` }))} />}
        <Button disabled={!selection.workspaceId || !selection.deviceId || !selection.teamId || !preflight.xcode || !preflight.cocoaPods} onClick={() => void perform('plan')}>Review iPhone build</Button>
      </fieldset>}
    </>}
    {error && <p role="alert">{error}</p>}
    {(plan || installation) && <div className="native-build-review" ref={review} tabIndex={-1} aria-label={installation ? 'iPhone installation review' : 'iPhone build review'}>
      <h4>{installation ? 'Review installation' : 'Review local build'}</h4>
      <p>{(installation ?? plan)!.device.name} · <code>{(installation ?? plan)!.bundleIdentifier}</code></p>
      <ul>{(installation ?? plan)!.consequences.map(value => <li key={value}>{value}</li>)}</ul>
      <div className="native-delivery-actions"><Button disabled={busy || running} onClick={() => void perform(installation ? 'install' : 'build')}>{installation ? installation.replacesExistingApp ? 'Replace app on iPhone' : 'Install on iPhone' : 'Build signed iPhone app'}</Button><Button variant="ghost" disabled={busy} onClick={() => { setPlan(undefined); setInstallation(undefined); }}>Cancel review</Button></div>
    </div>}
    {jobs.map(job => <article className="native-build-note" key={job.id} aria-label={`iPhone build ${job.id.slice(0, 8)}`}>
      <div><h4>{job.device.name}</h4><p className="native-delivery-identity">{job.bundleIdentifier} · {new Date(job.createdAt).toLocaleString()}</p></div>
      <p role="status">{active(job) ? steps[job.step] : states[job.state as keyof typeof states]}</p>
      {job.error && <p role="alert">{job.error}</p>}
      {job.state === 'launched' && <p>Check the app on your iPhone: navigate its screens, try its main action, then reopen it with the preview server stopped.</p>}
      {!!job.receipts.length && <details><summary>{job.receipts.length} steps verified</summary><ol>{job.receipts.map((receipt, index) => <li key={`${receipt.step}-${index}`}>{steps[receipt.step]} · completed</li>)}</ol></details>}
      <div className="native-delivery-actions">
        {job.state === 'building' && <Button variant="outline" disabled={busy} onClick={() => void perform('cancel', job)}>Cancel build</Button>}
        {!active(job) && job.artifact && <Button variant="outline" disabled={busy || running} onClick={() => void perform('install-plan', job)}>Review installation</Button>}
        {!active(job) && job.receipts.some(value => value.step === 'install') && <Button disabled={busy || running} onClick={() => void perform('launch', job)}>Open on iPhone</Button>}
        {!active(job) && <Button variant="ghost" disabled={busy || running} onClick={() => setRemoving(job)}>Remove build files</Button>}
      </div>
      {removing?.id === job.id && <div><p>Delete this retained build and signed app from the Mac? Your original project and installed phone app stay unchanged.</p><div className="native-delivery-actions"><Button variant="outline" disabled={busy} onClick={() => void perform('remove', removing)}>Confirm removal</Button><Button variant="ghost" disabled={busy} onClick={() => setRemoving(undefined)}>Keep build</Button></div></div>}
    </article>)}
  </section>;
}
