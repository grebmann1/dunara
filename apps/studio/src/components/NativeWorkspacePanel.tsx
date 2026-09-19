import { useEffect, useRef, useState } from 'react';
import type { WorkspacePlan, WorkspaceSelection, WorkspaceStatus } from '../../../../packages/core/src/native-workspace-contracts';
import { useStudioClient } from '../api';
import { Button } from './ui/button';
import { FieldSelect } from './ui/field-select';

const steps = { copy: 'Copying reviewed source', install: 'Installing pinned dependencies', typecheck: 'Checking TypeScript', 'export-web': 'Exporting web', 'export-ios': 'Exporting iOS JavaScript', 'export-android': 'Exporting Android JavaScript', verify: 'Verifying prepared files' };
const running = (value: WorkspaceStatus) => value.state === 'preparing' || value.state === 'cancelling';
export function NativeWorkspacePanel({ projectId }: { projectId: string }) {
  const { api } = useStudioClient();
  const base = `/projects/${projectId}/native-workspaces`;
  const [selection, setSelection] = useState<WorkspaceSelection>({ profile: 'preview', platform: 'all', environment: 'none' });
  const [plan, setPlan] = useState<WorkspacePlan>(), [workspaces, setWorkspaces] = useState<WorkspaceStatus[]>([]);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [removing, setRemoving] = useState<WorkspaceStatus>();
  const alive = useRef(true), operating = useRef(false), review = useRef<HTMLDivElement>(null), requestId = useRef<string | undefined>(undefined);
  useEffect(() => {
    let disposed = false, timer: ReturnType<typeof setTimeout>; alive.current = true;
    async function refresh() {
      try { const result = await api<{ workspaces: WorkspaceStatus[] }>(base); if (!disposed) setWorkspaces(result.workspaces); }
      catch (cause) { if (!disposed) setError(cause instanceof Error ? cause.message : 'Preparation status is unavailable.'); }
      finally { if (!disposed) timer = setTimeout(() => void refresh(), 1500); }
    }
    void refresh();
    return () => { disposed = true; alive.current = false; clearTimeout(timer); };
  }, [base]);
  async function perform(action: 'plan' | 'prepare' | 'cancel' | 'remove', workspace?: WorkspaceStatus) {
    if (operating.current) return;
    operating.current = true; setBusy(true); setError('');
    try {
      if (action === 'plan') {
        const value = await api<WorkspacePlan>(`${base}/plan`, selection);
        if (alive.current) { setPlan(value); requestId.current = crypto.randomUUID(); requestAnimationFrame(() => review.current?.focus()); }
      } else {
        if (action === 'prepare') {
          if (!plan || !requestId.current) return;
          await api(`${base}/prepare`, { selection: plan.selection, proposedRevision: plan.proposedRevision, requestId: requestId.current, confirmed: true });
          if (alive.current) setPlan(undefined);
        } else if (workspace) {
          await api(`${base}/${action}`, { workspaceId: workspace.id, expectedRevision: workspace.revision, ...(action === 'remove' ? { confirmed: true } : {}) });
          if (alive.current) setRemoving(undefined);
        }
        const value = await api<{ workspaces: WorkspaceStatus[] }>(base);
        if (alive.current) setWorkspaces(value.workspaces);
      }
    } catch (cause) {
      if (alive.current) setError(cause instanceof Error ? cause.message : 'Preparation failed. Refresh and review again.');
      // Keep the same request ID after a lost response: retry cannot start duplicate work.
    } finally { operating.current = false; if (alive.current) setBusy(false); }
  }
  function select<K extends keyof WorkspaceSelection>(key: K, value: WorkspaceSelection[K]) { setSelection(current => ({ ...current, [key]: value })); setPlan(undefined); }
  return <section className="native-workspaces" aria-label="Prepare a build workspace">
    <h3>Prepare a build workspace</h3>
    <p>Validate a separate copy of this app before building. Your current app and preview stay available.</p>
    <fieldset disabled={busy}>
      <FieldSelect label="Build profile" value={selection.profile} onValueChange={value => select('profile', value as WorkspaceSelection['profile'])} options={[{ value: 'preview', label: 'Preview · bundled app' }, { value: 'development', label: 'Development · native debugging' }]} />
      <FieldSelect label="Build platforms" value={selection.platform} onValueChange={value => select('platform', value as WorkspaceSelection['platform'])} options={[{ value: 'all', label: 'iOS and Android' }, { value: 'ios', label: 'iOS' }, { value: 'android', label: 'Android' }]} />
      <FieldSelect label="Build backend" value={selection.environment} onValueChange={value => select('environment', value as WorkspaceSelection['environment'])} options={[{ value: 'none', label: 'No backend' }, { value: 'development', label: 'Development backend' }, { value: 'staging', label: 'Staging backend' }]} />
      <Button disabled={busy} onClick={() => void perform('plan')}>Review preparation</Button>
    </fieldset>
    {error && <p role="alert">{error}</p>}
    {plan && <div className="native-build-review native-workspace-review" ref={review} tabIndex={-1} aria-label="Preparation review">
      <h3>Review preparation</h3>
      <p>{plan.selection.profile} · {plan.selection.platform === 'all' ? 'iOS and Android' : plan.selection.platform} · {plan.backend.environment === 'none' ? 'No backend' : `${plan.backend.environment} backend`}</p>
      {plan.backend.url && <p className="native-workspace-target">{plan.backend.url}</p>}
      <p>{plan.files.length} reviewed files · {Math.ceil(plan.bytes / 1024)} KB</p>
      <ul>{plan.consequences.map(item => <li key={item}>{item}</li>)}</ul>
      <details><summary>Files in this preparation</summary><ul className="native-workspace-files">{plan.files.map(file => <li key={file.path}><code>{file.path}</code>{plan.overlays.some(change => change.path === file.path) ? ' · adjusted in the copy' : ''}</li>)}</ul></details>
      <Button disabled={busy || workspaces.some(running)} onClick={() => void perform('prepare')}>{busy ? 'Starting preparation…' : 'Prepare reviewed workspace'}</Button>
    </div>}
    <p>Successful preparation checks JavaScript exports. Installing on a phone still requires a signed build and an Expo account.</p>
    {!!workspaces.length && <div className="native-workspace-jobs"><h3>Preparations</h3>{workspaces.map(workspace => <article className="native-build-note" key={workspace.id} aria-label={`Preparation ${workspace.id.slice(0, 8)}`}>
      <h4>{workspace.selection.profile === 'preview' ? 'Preview' : 'Development'} · {workspace.selection.platform === 'all' ? 'iOS and Android' : workspace.selection.platform === 'ios' ? 'iOS' : 'Android'} · {workspace.backend.environment === 'none' ? 'No backend' : workspace.backend.environment}</h4>
      <p role="status">{workspace.state === 'ready' ? 'Ready for the next build step' : workspace.state === 'preparing' ? steps[workspace.step] : workspace.state === 'cancelling' ? 'Cancelling preparation…' : `Preparation ${workspace.state}`}</p>
      <p>{new Date(workspace.createdAt).toLocaleString()} · {workspace.id.slice(0, 8)}</p>
      {workspace.error && <p>{workspace.error}</p>}
      {!!workspace.receipts.length && <details><summary>{workspace.receipts.length} checks completed</summary><ul>{workspace.receipts.map(receipt => <li key={receipt.step}>{steps[receipt.step]} · passed</li>)}</ul></details>}
      {!!workspace.exports.length && <p>Exports checked: {workspace.exports.map(value => value.platform).join(', ')}</p>}
      {running(workspace) ? <Button variant="outline" disabled={busy || workspace.state === 'cancelling'} onClick={() => void perform('cancel', workspace)}>Cancel preparation</Button> : <Button variant="outline" disabled={busy} onClick={() => setRemoving(workspace)}>Remove workspace</Button>}
      {removing?.id === workspace.id && <div className="native-workspace-remove"><p>Remove this prepared copy and its exports? The original app stays unchanged.</p><Button disabled={busy} onClick={() => void perform('remove', removing)}>Confirm removal</Button><Button variant="ghost" disabled={busy} onClick={() => setRemoving(undefined)}>Keep workspace</Button></div>}
    </article>)}</div>}
  </section>;
}
