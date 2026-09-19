import { useEffect, useState } from 'react';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from './ui/dialog';
import { type StudioState, useStudioClient } from '../api';
import { Input } from './ui/input';
import { FieldSelect } from './ui/field-select';

export function DiagnosticLog({ state }: { state: StudioState }) {
  const [query, setQuery] = useState(''), [level, setLevel] = useState('issues');
  const entries = state.diagnostics.entries.filter(entry => entry.message.trim());
  const groups = new Map<string, { entry: StudioState['diagnostics']['entries'][number]; count: number }>();
  for (const entry of entries) {
    const key = JSON.stringify([entry.source, entry.level, entry.message]);
    const group = groups.get(key); groups.delete(key); groups.set(key, { entry, count: (group?.count ?? 0) + 1 });
  }
  const issues = entries.filter(entry => entry.level !== 'info').length;
  const matches = [...groups.entries()].reverse().filter(([, { entry }]) => (level === 'all' || entry.level !== 'info') && `${entry.message} ${entry.source}`.toLowerCase().includes(query.toLowerCase()));
  return <section className="activity-detail-view" aria-label="Diagnostics"><div className="activity-filterbar"><h2>Diagnostics</h2><Input type="search" aria-label="Search diagnostics" placeholder="Search output…" value={query} onChange={event => setQuery(event.target.value)} /><FieldSelect label="Diagnostic level" value={level} onValueChange={setLevel} options={[{ value: 'issues', label: `Errors · ${issues}` }, { value: 'all', label: `All output · ${entries.length}` }]} /></div>
    <div className="activity-scroll"><p className="activity-retention">Identical messages are grouped.{state.diagnostics.truncated ? ' Older output was truncated.' : ''}</p>
      {!matches.length && <div className="activity-empty"><strong>{query ? 'No matching output' : level === 'issues' ? 'No reported issues' : 'No diagnostic output yet'}</strong><p>{level === 'issues' ? 'Routine preview output is available in All output.' : 'Install, preview and browser feedback will appear here.'}</p>{(query || level !== 'all') && <Button variant="outline" onClick={() => { setQuery(''); setLevel('all'); }}>Show all output</Button>}</div>}
      {matches.map(([key, { entry, count }]) => <details className={`diagnostic-row ${entry.level}`} key={key}><summary><span className="diagnostic-level">{entry.level}</span><span className="diagnostic-message">{entry.message.split('\n').find(line => line.trim())}</span><span>{count > 1 ? `×${count}` : entry.source}</span><time dateTime={entry.time}>{new Date(entry.time).toLocaleTimeString()}</time></summary><pre>{entry.message}</pre><small>{entry.source} · {new Date(entry.time).toLocaleString()}</small></details>)}
    </div></section>;
}

export function CaptureHistory({ state, onLaunchKit, onCaptureOpen, viewer }: { state: StudioState; onLaunchKit(): void; onCaptureOpen?(): void; viewer?: { id: string | null; onChange(id: string | null): void } }) {
  const [route, setRoute] = useState('all'), [size, setSize] = useState('all');
  const captures = state.captures.filter(capture => (route === 'all' || capture.route === route) && (size === 'all' || capture.viewport === size));
  return <section className="activity-detail-view" aria-label="Screenshot history"><div className="activity-filterbar"><h2>Screenshot history</h2><FieldSelect label="Capture route" value={route} onValueChange={setRoute} options={[{ value: 'all', label: 'All routes' }, ...[...new Set(state.captures.map(capture => capture.route))].map(value => ({ value, label: value }))]} /><FieldSelect label="Capture size" value={size} onValueChange={setSize} options={[{ value: 'all', label: 'All sizes' }, { value: 'compact', label: 'Compact' }, { value: 'large', label: 'Large' }]} /></div>
    <div className="activity-scroll">{captures.length ? <div className="capture-grid">{captures.map(capture => <Thumbnail onOpen={onCaptureOpen} open={viewer ? viewer.id === capture.id : undefined} onOpenChange={viewer ? open => viewer.onChange(open ? capture.id : null) : undefined} projectId={state.project.id} key={capture.id} id={capture.id} label={`${capture.route} · ${capture.viewport}`} />)}</div> : <div className="activity-empty"><strong>{state.captures.length ? 'No matching captures' : 'No captures yet'}</strong><p>Capture a route in Preview to see it here.</p>{!!state.captures.length && <Button variant="outline" onClick={() => { setRoute('all'); setSize('all'); }}>Clear filters</Button>}</div>}</div>
    <footer className="media-workspace-footer"><span>Web renders, retained for one hour. Native review is still needed.</span><Button variant="outline" onClick={onLaunchKit}>Prepare Launch Kit</Button></footer>
  </section>;
}
export function Thumbnail({ projectId, id, label, onOpen, open, onOpenChange }: { projectId: string; id: string; label: string; onOpen?: () => void; open?: boolean; onOpenChange?(open: boolean): void }) {
  const { image } = useStudioClient();
  const [src, setSrc] = useState(''); const [error, setError] = useState(''); const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let disposed = false, url = '';
    setSrc(''); setError('');
    void image(projectId, id).then(value => { url = value; if (disposed) URL.revokeObjectURL(value); else setSrc(value); }).catch(e => { if (!disposed) setError(e instanceof Error && e.message === 'Screenshot expired' ? e.message : 'Screenshot unavailable'); });
    return () => { disposed = true; URL.revokeObjectURL(url); };
  }, [projectId, id, attempt]);
  return <figure>{src ? <Dialog open={open} onOpenChange={next => { onOpenChange?.(next); if (next) onOpen?.(); }}>
    <DialogTrigger asChild><Button variant="ghost" className="capture-thumbnail" aria-label={`Open capture of ${label}`}><img src={src} alt={`Capture of ${label}`} onError={() => { setSrc(''); setError('Screenshot unavailable'); }} /></Button></DialogTrigger>
    <DialogContent className="capture-viewer" data-capture-viewer>
      <DialogTitle>Capture · {label}</DialogTitle>
      <DialogDescription>React Native Web capture. Review the image at its original proportions.</DialogDescription>
      <img src={src} alt={`Full capture of ${label}`} />
    </DialogContent>
  </Dialog> : <><span role="status">{error || 'Loading…'}</span>{error === 'Screenshot unavailable' && <Button variant="outline" onClick={() => { setError(''); setAttempt(value => value + 1); }}>Retry image</Button>}</>}<figcaption>{label}</figcaption></figure>;
}
