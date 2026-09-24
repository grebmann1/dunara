import { useEffect, useRef, useState } from 'react';
import type { AndroidDelivery, AndroidInstallPlan, AndroidPlan, AndroidPreflight } from '../../../../packages/core/src/android-delivery-contracts';
import type { WorkspaceStatus } from '../../../../packages/core/src/native-workspace-contracts';
import { useStudioClient } from '../api';
import { Button } from './ui/button';
import { FieldSelect } from './ui/field-select';

export function AndroidDeliveryPanel({ projectId, workspaces }: { projectId: string; workspaces: WorkspaceStatus[] }) {
  const { api, androidApk } = useStudioClient(), base = `/projects/${projectId}/android-deliveries`;
  const [host, setHost] = useState<AndroidPreflight>(), [jobs, setJobs] = useState<AndroidDelivery[]>([]), [workspaceId, setWorkspaceId] = useState(''), [deviceId, setDeviceId] = useState('');
  const [plan, setPlan] = useState<AndroidPlan>(), [installation, setInstallation] = useState<AndroidInstallPlan>(), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const operating = useRef(false), alive = useRef(true), requestId = useRef('');
  const ready = workspaces.filter(item => item.state === 'ready' && item.selection.profile === 'preview' && item.selection.platform !== 'ios');
  const selected = ready.find(item => item.id === workspaceId)?.id ?? ready[0]?.id ?? '';
  useEffect(() => {
    let disposed = false; alive.current = true; let timer: ReturnType<typeof setTimeout>;
    async function refresh() { try { const result = await api<{ deliveries: AndroidDelivery[] }>(base); if (!disposed) setJobs(result.deliveries); } catch { /* Surface errors on explicit actions, without interrupting iOS setup. */ } finally { if (!disposed) timer = setTimeout(() => void refresh(), 2000); } }
    void refresh(); return () => { disposed = true; alive.current = false; clearTimeout(timer); };
  }, [base, api]);
  async function perform(work: () => Promise<void>) {
    if (operating.current) return; operating.current = true; setBusy(true); setError('');
    try { await work(); const value = await api<{ deliveries: AndroidDelivery[] }>(base); if (alive.current) setJobs(value.deliveries); }
    catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : 'Android operation failed. Refresh and review again.'); }
    finally { operating.current = false; if (alive.current) setBusy(false); }
  }
  const active = jobs.some(job => ['building', 'installing'].includes(job.state));
  return <section className="native-delivery" aria-label="Install on Android"><h3>Install on Android</h3><p>Build a preview APK with bundled JavaScript, then review installation on an authorized Android device. Android Studio, its SDK and a compatible JDK are required.</p>
    <Button variant="outline" disabled={busy || active} onClick={() => void perform(async () => { setHost(await api<AndroidPreflight>(`${base}/preflight`, {})); setPlan(undefined); setInstallation(undefined); })}>Check Android setup</Button>
    {host?.issues.map(issue => <p key={issue}>{issue}</p>)}
    {host?.available && <><FieldSelect label="Android prepared app" value={selected} disabled={busy || active} onValueChange={value => { setWorkspaceId(value); setPlan(undefined); }} options={ready.map(item => ({ value: item.id, label: `${item.backend.environment} · ${new Date(item.createdAt).toLocaleString()}` }))} />
      {!ready.length && <p>Prepare an Android Preview workspace above.</p>}
      <Button disabled={busy || active || !selected} onClick={() => void perform(async () => { setPlan(await api<AndroidPlan>(`${base}/plan`, { workspaceId: selected })); requestId.current = crypto.randomUUID(); })}>Review Android build</Button>
      <FieldSelect label="Android device" value={deviceId} disabled={busy || active} onValueChange={value => { setDeviceId(value); setInstallation(undefined); }} options={[{ value: '', label: 'Choose a connected device' }, ...host.devices.map(device => ({ value: device.id, label: device.name }))]} />
    </>}
    {plan && <div className="native-build-review"><h4>Review Android preview build</h4><p>{plan.packageName} · {plan.backend}</p><ul>{plan.consequences.map(text => <li key={text}>{text}</li>)}</ul><Button disabled={busy || active} onClick={() => void perform(async () => { await api(`${base}/build`, { selection: plan.selection, proposedRevision: plan.proposedRevision, requestId: requestId.current, confirmed: true }); setPlan(undefined); })}>Build reviewed APK</Button></div>}
    {jobs.map(job => <article key={job.id}><h4>{job.packageName}</h4><p>{job.state} · {job.step}</p>{job.error && <p role="alert">{job.error}</p>}
      {['building', 'installing'].includes(job.state) && <Button variant="outline" disabled={busy} onClick={() => void perform(async () => { await api(`${base}/cancel`, { id: job.id, expectedRevision: job.revision }); })}>Stop Android operation</Button>}
      {job.artifact && !['building', 'installing'].includes(job.state) && <><Button variant="outline" disabled={busy} onClick={() => void perform(async () => { const blob = await androidApk(projectId, job.id), url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = 'preview.apk'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 60_000); })}>Download APK</Button><Button disabled={busy || active || !deviceId} onClick={() => void perform(async () => { setInstallation(await api<AndroidInstallPlan>(`${base}/install-plan`, { id: job.id, expectedRevision: job.revision, deviceId })); })}>Review Android installation</Button></>}
      {!['building', 'installing'].includes(job.state) && <details><summary>Remove local build</summary><p>Delete this APK and its temporary build files. Your app source and installed phone app remain available.</p><Button variant="outline" disabled={busy || active} onClick={() => void perform(async () => { await api(`${base}/remove`, { id: job.id, expectedRevision: job.revision, confirmed: true }); })}>Remove this local Android build</Button></details>}
      {job.state === 'installed' && <p>Installation verified. Open the app on your device, stop Metro, and check its primary action, sign-in and saved data. Those device behaviors have not been automatically verified.</p>}
    </article>)}
    {installation && <div className="native-build-review"><h4>Review Android installation</h4><p>{installation.packageName} · {host?.devices.find(device => device.id === installation.deviceId)?.name ?? 'Selected device'}</p><p>{installation.replacesExistingApp ? 'This replaces the installed app with the same package ID. Android may reject incompatible signing keys; Dunara will not uninstall it or erase its data.' : 'Install this preview app on the selected device.'}</p><Button disabled={busy || active} onClick={() => void perform(async () => { await api(`${base}/install`, { id: installation.id, expectedRevision: installation.expectedRevision, deviceId: installation.deviceId, proposedRevision: installation.proposedRevision, confirmed: true }); setInstallation(undefined); })}>Install reviewed APK</Button></div>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
