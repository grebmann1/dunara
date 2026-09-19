import { useEffect, useId, useRef, useState } from 'react';
import type { NativeBuilds, NativeBuildPlan } from '../../../../packages/core/src/native-builds';
import { useStudioClient } from '../api';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { NativeWorkspacePanel } from './NativeWorkspacePanel';
import '../native-build.css';

type Status = Awaited<ReturnType<NativeBuilds['inspect']>>;
const empty = { iosBundleIdentifier: '', androidPackage: '', scheme: '', expoOwner: '', easProjectId: '' };
export function NativeBuildPanel({ projectId, onRefresh }: { projectId: string; onRefresh(): void }) {
  const { api } = useStudioClient();
  const [status, setStatus] = useState<Status>(), [form, setForm] = useState(empty), [plan, setPlan] = useState<NativeBuildPlan>();
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const alive = useRef(true), operating = useRef(false), review = useRef<HTMLDivElement>(null);
  const schemeId = useId();
  const base = `/projects/${projectId}/native-build`;
  useEffect(() => {
    alive.current = true;
    void api<Status>(base).then(value => { if (alive.current) { setStatus(value); setForm(value.configuration); } }).catch(cause => { if (alive.current) setError(cause instanceof Error ? cause.message : 'Build setup is unavailable.'); });
    return () => { alive.current = false; };
  }, [base]);
  async function perform(apply: boolean) {
    if (operating.current || !status || apply && !plan) return;
    operating.current = true; setBusy(true); setError(''); setNotice('');
    try {
      if (apply) {
        const result = await api<{ recovered: boolean; applied: string[] }>(`${base}/apply`, { configuration: plan!.configuration ?? undefined, proposedRevision: plan!.proposedRevision, confirmed: true });
        if (alive.current) { setPlan(undefined); setNotice(result.recovered ? 'Original configuration restored. You can review setup again.' : 'Build setup saved. Follow the build checklist below; restart your preview when ready.'); }
        onRefresh();
        const value = await api<Status>(base);
        if (alive.current) { setStatus(value); setForm(value.configuration); }
      } else {
        if (!status.recoveryRequired && !!form.expoOwner.trim() !== !!form.easProjectId.trim()) throw new Error('Enter both the Expo owner and EAS project ID, or leave both empty.');
        const configuration = status.recoveryRequired ? undefined : { iosBundleIdentifier: form.iosBundleIdentifier.trim(), androidPackage: form.androidPackage.trim(), scheme: form.scheme.trim(), ...(form.expoOwner.trim() ? { expoOwner: form.expoOwner.trim(), easProjectId: form.easProjectId.trim() } : {}) };
        const value = await api<NativeBuildPlan>(`${base}/plan`, { configuration });
        if (alive.current) { setPlan(value); requestAnimationFrame(() => review.current?.focus()); }
      }
    } catch (cause) {
      if (alive.current) { setPlan(undefined); setError(cause instanceof Error ? cause.message : 'Build setup failed. Review again before retrying.'); }
      // An interrupted commit can require recovery even when the original request failed.
      const value = await api<Status>(base).catch(() => undefined);
      if (alive.current && value) setStatus(value);
    } finally { operating.current = false; if (alive.current) setBusy(false); }
  }
  function update(key: keyof typeof empty, value: string) { setForm(current => ({ ...current, [key]: value })); setPlan(undefined); setNotice(''); }
  return <section className="native-build-setup" aria-label="Native build setup">
    <p>Prepare this app’s identity and internal build profiles. You’ll review the local file changes before saving.</p>
    {!status && !error && <p role="status">Loading build setup…</p>}
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {status && <>
      {status.recoveryRequired ? <div className="native-build-note"><h3>Recover interrupted setup</h3><p>Review restoration of the original files before continuing. Any newer edits are preserved.</p><Button disabled={busy} onClick={() => void perform(false)}>Review recovery</Button></div> : <form onSubmit={event => { event.preventDefault(); void perform(false); }}>
        <fieldset disabled={busy}><legend>App identity</legend><p>Use identifiers in a namespace you control. Each app needs its own identifiers and URL scheme.</p>
          <label>iOS bundle identifier<Input required maxLength={155} autoCapitalize="none" autoComplete="off" spellCheck={false} placeholder="com.yourcompany.yourapp" value={form.iosBundleIdentifier} onChange={event => update('iosBundleIdentifier', event.target.value)} /></label>
          <label>Android package<Input required maxLength={155} autoCapitalize="none" autoComplete="off" spellCheck={false} placeholder="com.yourcompany.yourapp" value={form.androidPackage} onChange={event => update('androidPackage', event.target.value)} /></label>
          <div className="native-build-field"><label htmlFor={schemeId}>App URL scheme</label><Input id={schemeId} aria-describedby={`${schemeId}-help`} required maxLength={63} autoCapitalize="none" autoComplete="off" spellCheck={false} placeholder="yourcompany-yourapp" value={form.scheme} onChange={event => update('scheme', event.target.value)} /><span id={`${schemeId}-help`}>Used when links open your installed app. Updating this also requires reviewing your backend’s redirect URLs.</span></div>
          <details className="native-build-expo"><summary>Link an existing Expo project (optional)</summary><p>Enter the owner and project ID from this app’s Expo project. Account ownership is verified separately before building.</p>
            <label>Expo owner<Input maxLength={64} autoCapitalize="none" autoComplete="off" spellCheck={false} value={form.expoOwner} onChange={event => update('expoOwner', event.target.value)} /></label>
            <label>EAS project ID<Input maxLength={36} autoCapitalize="none" autoComplete="off" spellCheck={false} placeholder="Project UUID from Expo" value={form.easProjectId} onChange={event => update('easProjectId', event.target.value)} /></label>
          </details>
          <Button type="submit" disabled={busy}>{busy ? 'Preparing review…' : 'Review build setup'}</Button>
        </fieldset>
      </form>}
      {plan && <div className="native-build-review" ref={review} tabIndex={-1} aria-label="Build setup review">
        <h3>{plan.state === 'recovery' ? 'Review restoration' : plan.state === 'current' ? 'Configuration is up to date' : 'Review local changes'}</h3>
        {!!plan.conflicts.length && <div role="alert"><p>Resolve these conflicts first:</p><ul>{plan.conflicts.map(item => <li key={item}>{item}</li>)}</ul></div>}
        <ul>{plan.consequences.map(item => <li key={item}>{item}</li>)}</ul>
        <div className="native-build-files">{plan.files.map(file => <details key={file.path}><summary>{file.before === null ? 'Add' : file.after === null ? 'Remove' : 'Update'} {file.path}</summary><h4>Before</h4><pre>{file.before ?? 'File does not exist'}</pre><h4>After</h4><pre>{file.after ?? 'File will be removed'}</pre></details>)}</div>
        {plan.state !== 'current' && <Button disabled={busy || !!plan.conflicts.length} onClick={() => void perform(true)}>{busy ? 'Saving…' : plan.state === 'recovery' ? 'Restore original configuration' : 'Save build setup'}</Button>}
      </div>}
      <div className="native-build-profiles"><h3>Two ways to test</h3><dl><div><dt>Development</dt><dd>Native debugging with Metro. Requires the Expo development client.</dd></div><div><dt>Preview</dt><dd>Installed app with bundled JavaScript. Android APK; registered devices for iOS.</dd></div></dl><p>Both profiles use the same app identity and replace each other on a device.</p></div>
      {!status.recoveryRequired && <NativeWorkspacePanel key={projectId} projectId={projectId} />}
      <details className="native-build-guide" open={!!notice}><summary>Before your first build</summary><ul>{status.prerequisites.map(item => <li key={item}>{item}</li>)}</ul><p>Expo {status.dependencies.expo || 'unknown'} · React Native {status.dependencies.reactNative || 'unknown'}</p><p>Expo project ownership: {status.providerOwnership}. Saving this setup does not start or upload a build.</p><h3>Step by step</h3><ol>{status.guide.user.slice(3).map(item => <li key={item}>{item}</li>)}</ol></details>
    </>}
  </section>;
}
