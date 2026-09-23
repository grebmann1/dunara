import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowUpRight, Image, RefreshCw, Square, MessageSquare, X } from 'lucide-react';
import type { BoardCapture } from '../../../../packages/core/src/board-captures';
import type { Screen } from '../../../../packages/core/src/screen-catalog';
import { useStudioClient } from '../api';
import { Button } from './ui/button';
import { PreviewCanvas } from './PreviewCanvas';

function CaptureThumbnail({ projectId, capture, name }: { projectId: string; capture?: BoardCapture; name: string }) {
  const { boardImage } = useStudioClient();
  const [image, setImage] = useState<{ id: string; url: string }>(), [error, setError] = useState('');
  useEffect(() => {
    if (!capture) return;
    let disposed = false, url = '';
    setError('');
    void boardImage(projectId, capture.id).then(value => {
      url = value;
      if (disposed) URL.revokeObjectURL(value); else setImage({ id: capture.id, url: value });
    }).catch(() => { if (!disposed) setError('Image unavailable. Refresh this screen.'); });
    return () => { disposed = true; if (url) URL.revokeObjectURL(url); };
  }, [projectId, capture?.id]);
  return <div className="screen-thumbnail">{image && image.id === capture?.id ? <img draggable={false} src={image.url} width={375} height={812} alt={`${name} saved screen`} /> : <div className="screen-placeholder"><Image aria-hidden /><span>{error || (capture ? 'Loading capture…' : 'No capture yet')}</span></div>}</div>;
}

type Props = { controlsHost: HTMLDivElement | null; projectId: string; screens: Screen[]; captures: BoardCapture[]; sourceRevision: string; active: boolean; ready: boolean; disabled: boolean; onFocus: (route: string) => void; onCompare: (routes: string[]) => void; onAsk?: (screens: Screen[]) => void };
export function ScreenOverview({ controlsHost, projectId, screens, captures, sourceRevision, active, ready, disabled, onFocus, onCompare, onAsk }: Props) {
  const { api } = useStudioClient();
  const [fresh, setFresh] = useState<Record<string, BoardCapture>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [progress, setProgress] = useState<{ route: string; index: number; total: number }>();
  const [selected, setSelected] = useState<string[]>([]);
  const [autoPaused, setAutoPaused] = useState(false);
  const viewChanged = useCallback(() => {}, []);
  const running = useRef<AbortController | null>(null), attempted = useRef(new Set<string>());
  const mounted = useRef(true);
  const all = new Map(captures.map(capture => [capture.route, capture]));
  for (const capture of Object.values(fresh)) if (!all.has(capture.route) || all.get(capture.route)!.createdAt < capture.createdAt) all.set(capture.route, capture);
  const chosen = screens.filter(screen => selected.includes(screen.route));
  const routesKey = screens.map(screen => screen.route).join('|');
  async function refresh(routes: string[]) {
    if (running.current || !ready || disabled || !routes.length) return;
    const controller = new AbortController(); running.current = controller;
    try {
      for (const [index, route] of routes.entries()) {
        if (controller.signal.aborted) break;
        const attempt = `${sourceRevision}:${route}`;
        attempted.current.add(attempt); setProgress({ route, index: index + 1, total: routes.length });
        setErrors(current => ({ ...current, [route]: '' }));
        try {
          const capture = await api<BoardCapture>(`/projects/${projectId}/board-captures`, { route }, controller.signal);
          if (mounted.current && !controller.signal.aborted) setFresh(current => ({ ...current, [route]: capture }));
        } catch (error) {
          if (controller.signal.aborted) attempted.current.delete(attempt);
          else if (mounted.current) setErrors(current => ({ ...current, [route]: error instanceof Error ? error.message : 'Refresh failed. Try again.' }));
        }
      }
    } finally { if (running.current === controller) { running.current = null; if (mounted.current) setProgress(undefined); } }
  }
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; running.current?.abort(); }; }, []);
  useEffect(() => { attempted.current.clear(); }, [sourceRevision]);
  useEffect(() => {
    if (!active || !ready || disabled) { running.current?.abort(); return; }
    if (!autoPaused) void refresh(screens.filter(screen => { const capture = all.get(screen.route); return (!capture || capture.sourceRevision !== sourceRevision || capture.changedDuringCapture) && !attempted.current.has(`${sourceRevision}:${screen.route}`); }).map(screen => screen.route));
  }, [active, ready, disabled, routesKey, sourceRevision, !!progress, autoPaused]);
  return <section className="screen-overview" aria-label="All app screens" hidden={!active}>
    {active && controlsHost && createPortal(progress ? <Button className="overview-refresh" variant="outline" aria-label="Stop refresh" title="Stop refresh" onClick={() => { setAutoPaused(true); running.current?.abort(); }}><Square aria-hidden /><span className="refresh-label">Stop refresh</span></Button> : <Button className="overview-refresh" variant="ghost" aria-label={chosen.length ? 'Refresh selected' : 'Refresh screens'} title={chosen.length ? 'Refresh selected' : 'Refresh screens'} disabled={!ready || disabled || !screens.length} onClick={() => void refresh((chosen.length ? chosen : screens).map(screen => screen.route))}><RefreshCw aria-hidden /><span className="refresh-label">{chosen.length ? 'Refresh selected' : 'Refresh screens'}</span></Button>, controlsHost)}
    <div className="overview-board">
    <div className="overview-canvas-hint" hidden={!!chosen.length}><span>{screens.length} screens</span><span>Drag background or scroll to move · Pinch or ⌘/Ctrl + scroll to zoom</span></div>
    <div className="overview-selection board-controls" aria-label="Selected screen actions" hidden={!chosen.length}>
      <strong>{chosen.length} selected</strong>
      {chosen.length === 2 && <Button variant="outline" onClick={() => onCompare(chosen.map(screen => screen.route))} aria-label="Compare selected">Compare</Button>}
      {onAsk && <Button variant="ghost" aria-label={`Ask Assistant about ${chosen.length} selected screens`} title="Ask Assistant about selection" onClick={() => onAsk(chosen)}><MessageSquare aria-hidden /><span className="selection-ask-label">Ask Assistant</span></Button>}
      <Button variant="ghost" className="clear-screen-selection" aria-label="Clear selection" title="Clear selection" onClick={() => setSelected([])}><X aria-hidden /></Button>
    </div>
    {progress && <p className="overview-progress" role="status">Capturing {screens.find(screen => screen.route === progress.route)?.name ?? progress.route} · {progress.index} of {progress.total}</p>}
    {!ready && <p className="overview-notice">Start preview to create or refresh captures. Saved images remain available.</p>}
    <PreviewCanvas kind="screens" active={active} activeId={chosen.at(-1)?.route ?? ''} viewCount={screens.length} onViewChange={viewChanged}>
    <div className="screen-grid" style={{ '--screen-columns': Math.min(4, Math.max(1, screens.length)) } as React.CSSProperties}>
      {screens.map(screen => {
        const capture = all.get(screen.route), refreshing = progress?.route === screen.route;
        const stale = capture && (capture.changedDuringCapture || capture.sourceRevision !== sourceRevision);
        return <article key={screen.route} className="screen-card" data-screen-route={screen.route} data-selected={selected.includes(screen.route)} aria-label={`${screen.name} screen`}>
          <div className="screen-card-heading"><label><input type="checkbox" aria-label={`Select ${screen.name}`} checked={selected.includes(screen.route)} onChange={event => setSelected(current => event.target.checked ? [...current, screen.route] : current.filter(route => route !== screen.route))} /><strong title={screen.name}>{screen.name}</strong></label><span className="capture-state" data-stale={!!stale}>{refreshing ? 'Capturing…' : errors[screen.route] ? 'Refresh failed' : stale ? 'Source changed' : capture ? 'Captured' : 'Pending'}</span></div>
          <button className="screen-open" aria-label={`Open ${screen.name} in Focus`} onClick={() => onFocus(screen.route)}><CaptureThumbnail projectId={projectId} capture={capture} name={screen.name} /><span className="screen-open-hint">Open live preview <ArrowUpRight aria-hidden /></span></button>
          <div className="screen-card-footer"><div><code title={screen.route}>{screen.route}</code><small>{capture ? new Date(capture.createdAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '375 × 812'}</small></div><Button variant="ghost" aria-label={`Refresh ${screen.name}`} title={`Refresh ${screen.name}`} disabled={!ready || disabled || !!progress} onClick={() => void refresh([screen.route])}><RefreshCw aria-hidden /></Button></div>
          {errors[screen.route] && <p className="screen-capture-error" role="alert">{errors[screen.route]}{capture && ' Previous capture retained.'}</p>}
        </article>;
      })}
    </div>
    </PreviewCanvas>
    </div>
    {!screens.length && <div className="overview-empty"><Image aria-hidden /><h2>Add your first screen</h2><p>Open Project routes and enter a concrete path. Dynamic routes need actual parameter values.</p></div>}
  </section>;
}
