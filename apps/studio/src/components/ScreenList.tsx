import { useRef, useState } from 'react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { routeSchema } from '../../../../packages/core/src/contracts';
import type { RouteCandidates } from '../../../../packages/core/src/routes';

export function ScreenList({ route, onRoute, routes, onRefresh, manualPath: custom, onManualPath: setCustom }: { manualPath: string; onManualPath: (value: string) => void; route: string; onRoute: (route: string) => void; routes?: RouteCandidates; onRefresh: () => void }) {
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  return <section className="screens" aria-label="Project routes">
    <div className="section-title normal-case tracking-normal">Routes <Button variant="ghost" onClick={onRefresh} aria-label="Refresh project routes">Refresh</Button></div>
    {routes?.candidates.map(candidate => <button aria-pressed={route === candidate.path} className={`screen-link ${route === candidate.path ? 'selected' : ''}`} key={candidate.path} onClick={() => {
      if (candidate.kind === 'static') { setError(''); onRoute(candidate.path); }
      else { setCustom(candidate.path); setError('Replace each bracketed parameter with a concrete value before opening.'); input.current?.focus(); }
    }}><span><strong>{candidate.path}</strong><small>{candidate.kind === 'dynamic' ? 'Requires a concrete path' : 'File candidate'}{candidate.ambiguous ? ' · ambiguous' : ''}</small></span></button>)}
    {!routes?.candidates.length && <p>No supported routes listed. Enter a known path below.</p>}
    <details className="route-limits"><summary>Discovery limits</summary>{routes?.warnings.map(warning => <p key={warning}>{warning}</p>)}</details>
    <form className="custom-route" onSubmit={e => { e.preventDefault(); const result = routeSchema.safeParse(custom); if (result.success) { setError(''); onRoute(result.data); } else setError('Use a concrete route such as /settings, without placeholders, queries or fragments.'); }}>
      <Label htmlFor="custom-route">Agent-added screen / manual path</Label><div className="inline"><Input ref={input} id="custom-route" placeholder="/settings" value={custom} onChange={e => setCustom(e.target.value)} /><Button variant="outline" type="submit" aria-label="Open custom route">Open</Button></div>{error && <small role="alert">{error}</small>}
    </form>
  </section>;
}
