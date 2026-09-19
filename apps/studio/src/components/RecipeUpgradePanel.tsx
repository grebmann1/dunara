import { useEffect, useRef, useState } from 'react';
import type { RecipeUpgradeProposal } from '../../../../packages/core/src/recipe-upgrades';
import { useStudioClient } from '../api';
import { Button } from './ui/button';

export function RecipeUpgradePanel({ projectId, disabled }: { projectId: string; disabled: boolean }) {
  const { api } = useStudioClient();
  const [plan, setPlan] = useState<RecipeUpgradeProposal>(), [reviewing, setReviewing] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const alive = useRef(true), operating = useRef(false);
  const base = `/projects/${projectId}/recipe-upgrade`;
  useEffect(() => {
    alive.current = true;
    void api<RecipeUpgradeProposal>(base).then(value => { if (alive.current) setPlan(value); }).catch(cause => { if (alive.current) setError(cause instanceof Error ? cause.message : 'Upgrade status unavailable.'); });
    return () => { alive.current = false; };
  }, [base]);
  async function perform(apply: boolean) {
    if (disabled || operating.current || apply && !plan) return;
    operating.current = true; setBusy(true); setError(''); setNotice('');
    try {
      if (apply) await api(`${base}/apply`, { projectId, proposedRevision: plan!.proposedRevision, confirmed: true });
      const next = await api<RecipeUpgradeProposal>(base);
      if (alive.current) { setPlan(next); setReviewing(!apply); if (apply) setNotice(plan!.state === 'recovery' ? 'Original files restored. You can review the upgrade again.' : 'Backend support added. Start a preview to install dependencies, then open /account.'); }
    } catch (cause) {
      if (alive.current) { setReviewing(false); setError(cause instanceof Error ? cause.message : 'Upgrade failed. Review again before retrying.'); }
    } finally { operating.current = false; if (alive.current) setBusy(false); }
  }
  return <section className="backend-card backend-operation recipe-upgrade" aria-label="App backend support">
    <div className="backend-heading"><h2>App backend support</h2>{plan && <span className="backend-badge">{plan.state === 'current' ? 'Ready' : plan.state === 'recovery' ? 'Recovery needed' : plan.state === 'conflict' ? 'Manual merge needed' : 'Upgrade available'}</span>}</div>
    <p>{plan?.state === 'current' ? 'This app has the Supabase dependency profile. Its backend files remain yours to customize.' : 'Add sign-in, private notes and secure session storage to this app. Review the local changes before applying.'}</p>
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {plan?.state !== 'current' && <Button variant="outline" disabled={disabled || busy} onClick={() => void perform(false)}>{busy ? 'Checking upgrade…' : reviewing ? 'Refresh review' : 'Review upgrade'}</Button>}
    {reviewing && plan && <div className="recipe-review">
      <p className="backend-muted">Recipe {plan.recipe} · {plan.files.length} file changes</p>
      <ul>{plan.consequences.map(item => <li key={item}>{item}</li>)}</ul>
      {!!plan.dependencyChanges.length && <details className="recipe-dependencies"><summary>Dependency changes ({plan.dependencyChanges.length})</summary><ul>{plan.dependencyChanges.map(change => <li key={change.name}><strong>{change.name.replace(/^node_modules\//, '')}</strong>: {change.before ?? 'New'} → {change.after ?? 'Removed'}</li>)}</ul><p className="backend-muted">The complete manifest and lockfile versions are available below.</p></details>}
      {!!plan.conflicts.length && <div role="alert"><p>Resolve these conflicts before applying:</p><ul>{plan.conflicts.map(item => <li key={`${item.path}:${item.reason}`}><strong>{item.path}</strong> — {item.reason}</li>)}</ul></div>}
      <div className="recipe-files" aria-label="Reviewed file changes">{plan.files.map(file => <details key={file.path}><summary><span>{file.after === null ? 'Remove' : file.before === null ? 'Add' : 'Update'}</span> {file.path}</summary><FileVersions before={file.before} after={file.after} /></details>)}</div>
      {['ready', 'recovery'].includes(plan.state) && <div className="backend-actions"><Button disabled={disabled || busy} onClick={() => void perform(true)}>{plan.state === 'recovery' ? 'Approve restoration' : 'Approve app upgrade'}</Button><Button variant="ghost" disabled={busy} onClick={() => setReviewing(false)}>Close review</Button></div>}
    </div>}
  </section>;
}
function FileVersions({ before, after }: { before: string | null; after: string | null }) {
  return <div className="recipe-versions">{before !== null && <details><summary>Before</summary><pre tabIndex={0}>{before}</pre></details>}{after !== null && <details><summary>After</summary><pre tabIndex={0}>{after}</pre></details>}</div>;
}
