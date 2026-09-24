import { useEffect, useRef, useState } from 'react';
import { type StudioState, useStudioClient } from '../api';
import { webVerification } from '../verification';
import { Button } from './ui/button';

export function AppVerification({ state }: { state: StudioState }) {
  const { api } = useStudioClient();
  const [current, setCurrent] = useState(state), [progress, setProgress] = useState(''), [error, setError] = useState('');
  const run = useRef<AbortController | null>(null);
  useEffect(() => { setCurrent(state); }, [state]);
  useEffect(() => () => run.current?.abort(), []);
  const evidence = webVerification(current);
  async function verify() {
    if (run.current) return;
    const controller = new AbortController(); run.current = controller; setError('');
    try {
      for (const screen of current.screens.slice(0, 10)) for (const viewport of ['compact', 'large']) {
        setProgress(`Checking ${screen.name} · ${viewport === 'compact' ? '375 × 812' : '430 × 932'}…`);
        await api(`/projects/${current.project.id}/capture`, { route: screen.route, viewport }, controller.signal);
      }
      const next = await api<StudioState>(`/projects/${current.project.id}`); setCurrent(next);
    } catch (cause) { setError(controller.signal.aborted ? 'Checks stopped. Completed captures remain available.' : cause instanceof Error ? cause.message : 'Web checks could not finish. Start the preview and retry.'); }
    finally { run.current = null; setProgress(''); }
  }
  return <section className="app-verification" aria-label="Verification evidence">
    <h3>{evidence.passed ? 'Web rendering checked' : 'Web checks incomplete'}</h3>
    <p>{evidence.rendered}/{evidence.checks.length} current screen captures. Source changes invalidate these checks.</p>
    <ul>{evidence.checks.map(check => <li key={`${check.route}:${check.viewport}`}><strong>{check.route} · {check.viewport}</strong>: {check.status === 'passed' ? 'Rendered with no reported browser errors' : check.status === 'errors' ? 'Browser errors reported' : check.status === 'rendered' ? 'Captured; runtime errors not measured' : 'Not checked for this version'}</li>)}</ul>
    <p>TypeScript/build: check the prepared workspace receipts in Build setup. Primary actions, persistence and native behavior still need testing. Screenshots alone do not verify them.</p>
    <Button disabled={!!progress || current.preview.status !== 'ready'} onClick={() => void verify()}>Check web screens</Button>
    {progress && <Button variant="ghost" onClick={() => run.current?.abort()}>Stop checks</Button>}
    <p role="status">{progress}</p>{error && <p role="alert">{error}</p>}
  </section>;
}
