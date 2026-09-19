import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Focus, Maximize, Minus, Plus } from 'lucide-react';
import { Button } from './ui/button';

type Props = { children: ReactNode; controls?: ReactNode; overlay?: ReactNode; activeId: string; viewCount: number; active: boolean; onViewChange: () => void; kind?: 'phones' | 'screens' };
export function PreviewCanvas({ children, controls, overlay, activeId, viewCount, active, onViewChange, kind = 'phones' }: Props) {
  const overview = kind === 'screens', minimumScale = overview ? 0.05 : 0.25;
  const itemSelector = overview ? '[data-screen-route]' : '[data-view-id]';
  const area = useRef<HTMLDivElement>(null), phone = useRef<HTMLDivElement>(null);
  const hint = useId();
  const [size, setSize] = useState({ width: 0, height: 0, phoneWidth: 0, phoneHeight: 0, gutter: 144, offset: 0 });
  const width = size.phoneWidth || 389;
  const [zoom, setZoom] = useState<number | null>(null);
  const [focusRequest, setFocusRequest] = useState(0);
  const previous = useRef({ scale: 0, width: 0, height: 0, contentWidth: 0, contentHeight: 0, offset: 0 });
  const wheelAnchor = useRef<{ x: number; y: number } | null>(null);
  const pan = useRef<{ pointerId: number; x: number; y: number; left: number; top: number; ratio: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const fittedScale = Math.min(1, (size.width - 48) / width, size.phoneHeight ? (size.height - size.gutter) / size.phoneHeight : 0);
  const scale = zoom ?? Math.max(minimumScale, fittedScale);
  const gridSize = 32 * scale * 2 ** Math.max(0, Math.ceil(Math.log2(0.5 / scale)));
  const fitLimited = zoom === null && size.phoneHeight > 0 && fittedScale < minimumScale;
  const surfaceWidth = Math.max(size.width, width * scale + 48) + size.width * 2, surfaceHeight = Math.max(size.height, size.phoneHeight * scale + 48) + size.height * 2;
  function stopPan() {
    const pointerId = pan.current?.pointerId;
    pan.current = null; setDragging(false);
    if (pointerId !== undefined && area.current?.hasPointerCapture(pointerId)) area.current.releasePointerCapture(pointerId);
  }
  useLayoutEffect(() => {
    if (!active) stopPan();
    window.addEventListener('blur', stopPan);
    return () => window.removeEventListener('blur', stopPan);
  }, [active]);
  useLayoutEffect(() => {
    const element = area.current, frame = phone.current?.firstElementChild;
    if (!element || !(frame instanceof HTMLElement)) return;
    const workspace = element.closest<HTMLElement>('.workspace-content');
    const main = element.closest<HTMLElement>('.main'), workbench = element.closest<HTMLElement>('.preview-workbench');
    const stage = element.closest<HTMLElement>('.device-stage');
    const board = element.closest<HTMLElement>('.live-board, .overview-board');
    const controls = board?.querySelector<HTMLElement>('.canvas-controls'), views = board?.querySelector<HTMLElement>('.board-controls');
    const measure = () => {
      if (!active) return;
      if (workspace && main && workbench && stage && getComputedStyle(workspace).overflowY === 'auto') {
        const ratio = workspace.getBoundingClientRect().height / workspace.offsetHeight || 1;
        const rect = element.getBoundingClientRect();
        const above = (rect.top - workspace.getBoundingClientRect().top) / ratio + workspace.scrollTop;
        // Exclude the canvas and inline Design panel from the budget to prevent resize feedback.
        const below = (stage.getBoundingClientRect().bottom - rect.bottom + main.getBoundingClientRect().bottom - workbench.getBoundingClientRect().bottom) / ratio;
        element.style.height = `${Math.max(320, Math.floor(workspace.clientHeight - above - below - 2))}px`;
      } else element.style.removeProperty('height');
      if (!overview) frame.dataset.vertical = String(element.clientWidth < 600);
      // Selection tools overlay the overview; showing them must not move or refit its camera.
      const bottom = controls?.offsetHeight ?? 0, top = overview ? 72 : views?.offsetHeight ?? 0;
      const next = { width: element.clientWidth, height: element.clientHeight, phoneWidth: frame.offsetWidth, phoneHeight: frame.offsetHeight, gutter: top + bottom + 48, offset: (top - bottom) / 2 };
      setSize(current => current.width === next.width && current.height === next.height && current.phoneWidth === next.phoneWidth && current.phoneHeight === next.phoneHeight && current.gutter === next.gutter && current.offset === next.offset ? current : next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    for (const node of [element, frame, workspace, main, stage, controls, views]) if (node) observer.observe(node);
    window.addEventListener('resize', measure);
    return () => { observer.disconnect(); window.removeEventListener('resize', measure); };
  }, [active, viewCount, overview]);
  useLayoutEffect(() => {
    const element = area.current, old = previous.current;
    if (!element || !active) return;
    if (zoom === null || !old.scale) element.scrollTo((surfaceWidth - size.width) / 2, (surfaceHeight - size.height) / 2);
    else {
      const anchor = wheelAnchor.current ?? { x: size.width / 2, y: size.height / 2 };
      const x = (element.scrollLeft + anchor.x - (old.width - old.contentWidth * old.scale) / 2) / old.scale;
      const y = (element.scrollTop + anchor.y - (old.height - old.contentHeight * old.scale) / 2 - old.offset) / old.scale;
      element.scrollTo(x * scale + (surfaceWidth - width * scale) / 2 - anchor.x, y * scale + (surfaceHeight - size.phoneHeight * scale) / 2 + size.offset - anchor.y);
    }
    wheelAnchor.current = null;
    previous.current = { scale, width: surfaceWidth, height: surfaceHeight, contentWidth: width, contentHeight: size.phoneHeight, offset: size.offset };
  }, [scale, surfaceWidth, surfaceHeight, size.width, size.height, size.phoneHeight, size.offset, width, zoom, active]);
  useLayoutEffect(() => {
    const element = area.current;
    if (!element || !active) return;
    const wheel = (event: WheelEvent) => {
      if (!event.cancelable || (!event.deltaX && !event.deltaY)) return;
      event.preventDefault();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientHeight : 1;
      if (!event.ctrlKey && !event.metaKey) {
        // Wheel/trackpad scrolling changes the camera, never the screen layout.
        setZoom(scale);
        element.scrollBy(event.shiftKey && !event.deltaX ? event.deltaY * unit : event.deltaX * unit, event.shiftKey && !event.deltaX ? 0 : event.deltaY * unit);
        return;
      }
      const next = Math.min(2, Math.max(minimumScale, scale * Math.exp(-event.deltaY * unit * 0.002)));
      if (next === scale) return;
      const rect = element.getBoundingClientRect(), ratio = rect.width / element.offsetWidth || 1;
      wheelAnchor.current = { x: (event.clientX - rect.left) / ratio - element.clientLeft, y: (event.clientY - rect.top) / ratio - element.clientTop };
      onViewChange(); setZoom(next);
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, [active, scale, onViewChange, minimumScale]);
  function activePhone() { return Array.from(phone.current?.querySelectorAll<HTMLElement>(itemSelector) ?? []).find(node => (overview ? node.dataset.screenRoute : node.dataset.viewId) === activeId); }
  useLayoutEffect(() => {
    if (!focusRequest) return;
    const element = area.current, target = activePhone();
    if (!element || !target) return;
    const bounds = element.getBoundingClientRect(), rect = target.getBoundingClientRect(), ratio = bounds.width / element.offsetWidth || 1;
    element.scrollBy((rect.left + rect.width / 2 - bounds.left - bounds.width / 2) / ratio, (rect.top + rect.height / 2 - bounds.top - bounds.height / 2) / ratio - size.offset);
  }, [focusRequest]);
  function focusActive() {
    const target = activePhone();
    if (!target) return;
    changeZoom(Math.min(1, (size.width - 48) / target.offsetWidth, (size.height - size.gutter) / target.offsetHeight));
    setFocusRequest(value => value + 1);
  }
  function changeZoom(value: number | null) {
    wheelAnchor.current = null; onViewChange();
    if (value === null) area.current?.scrollTo((surfaceWidth - size.width) / 2, (surfaceHeight - size.height) / 2);
    setZoom(value === null ? null : Math.min(2, Math.max(minimumScale, Math.round(value * 100) / 100)));
  }
  return <>
    <div className="canvas-controls">
      <div className="canvas-zoom" role="group" aria-label="Canvas zoom">
        <Button variant="ghost" aria-label="Zoom out" title="Zoom out" disabled={scale <= minimumScale} onClick={() => changeZoom(scale - 0.1)}><Minus aria-hidden /></Button>
        <output aria-label="Canvas zoom level">{Math.round(scale * 100)}%</output>
        <Button variant="ghost" aria-label="Zoom in" title="Zoom in" disabled={scale >= 2} onClick={() => changeZoom(scale + 0.1)}><Plus aria-hidden /></Button>
        <Button variant="ghost" aria-label={viewCount > 1 ? 'Fit all' : 'Fit'} title={viewCount > 1 ? 'Fit all' : 'Fit'} aria-pressed={zoom === null} onClick={() => changeZoom(null)}><Maximize aria-hidden />{overview && 'Fit all'}</Button>
        {(!overview || activeId) && <Button variant="ghost" aria-label={overview ? 'Zoom to selected screen' : 'Focus active view'} title={overview ? 'Zoom to selected screen' : 'Focus active view'} onClick={focusActive}><Focus aria-hidden /></Button>}
        {!overview && <Button variant="ghost" title="Actual size" aria-pressed={zoom === 1} onClick={() => changeZoom(1)}>100%</Button>}
      </div>
      {controls}
    </div>
    <div className="canvas-viewport">
    <div ref={area} className="device-area" role="region" aria-label={overview ? 'Screen overview canvas' : 'Phone preview canvas'} aria-describedby={hint} tabIndex={0} data-kind={kind} data-dragging={dragging || undefined} onScroll={onViewChange}
      onPointerDown={event => {
        if (!active || event.pointerType !== 'mouse' || !event.isPrimary || pan.current || ![0, 1].includes(event.button)) return;
        const node = event.currentTarget, target = event.target;
        if (!(target instanceof Element) || (event.button === 0 && target.closest(`${itemSelector}, button, a, input, select, textarea, [contenteditable]`))) return;
        const rect = node.getBoundingClientRect(), ratio = rect.width / node.offsetWidth || 1;
        if ((event.clientX - rect.left) / ratio >= node.clientLeft + node.clientWidth || (event.clientY - rect.top) / ratio >= node.clientTop + node.clientHeight) return;
        event.preventDefault(); node.focus({ preventScroll: true });
        pan.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, left: node.scrollLeft, top: node.scrollTop, ratio };
        node.setPointerCapture(event.pointerId); setDragging(true);
      }}
      onPointerMove={event => {
        const start = pan.current;
        if (!start || start.pointerId !== event.pointerId) return;
        event.preventDefault(); setZoom(scale);
        event.currentTarget.scrollTo(start.left - (event.clientX - start.x) / start.ratio, start.top - (event.clientY - start.y) / start.ratio);
      }}
      onPointerUp={stopPan} onPointerCancel={stopPan} onLostPointerCapture={stopPan}
      onKeyDown={event => {
        if (event.key === 'Escape') stopPan();
        if (event.target !== event.currentTarget) return;
        const node = event.currentTarget;
        const movement: Record<string, [number, number]> = { ArrowLeft: [-60, 0], ArrowRight: [60, 0], ArrowUp: [0, -60], ArrowDown: [0, 60], PageUp: [0, -node.clientHeight * 0.8], PageDown: [0, node.clientHeight * 0.8] };
        const step = movement[event.key];
        if (step) { event.preventDefault(); setZoom(scale); node.scrollBy(...step); }
        if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); setZoom(scale); const top = (surfaceHeight - size.phoneHeight * scale) / 2 + size.offset; node.scrollTo(node.scrollLeft, event.key === 'Home' ? top - 24 : top + size.phoneHeight * scale - node.clientHeight + 24); }
        if (['+', '=', '-', '0'].includes(event.key) && !event.metaKey && !event.ctrlKey) { event.preventDefault(); changeZoom(event.key === '0' ? null : scale + (event.key === '-' ? -0.1 : 0.1)); }
      }}
      onTouchStart={() => setZoom(scale)}
      onDragStart={event => event.preventDefault()}>
      <div className="canvas-surface" style={{ width: surfaceWidth, height: surfaceHeight, backgroundSize: `${gridSize}px ${gridSize}px`, backgroundPosition: `${(surfaceWidth - width * scale) / 2}px ${(surfaceHeight - size.phoneHeight * scale) / 2 + size.offset}px` }}>
        <div ref={phone} className="device-fit" style={{ width: width * scale, height: size.phoneHeight * scale, top: size.offset, '--phone-scale': scale } as React.CSSProperties}>{children}</div>
      </div>
    </div>
    {overlay}
    </div>
    <p id={hint} className="sr-only">Drag the background or scroll to move the camera. Middle-button drag also pans. Pinch or hold Control or Command while scrolling to zoom. Shift-scroll moves horizontally. Arrow keys pan; plus and minus zoom; zero fits all views. {overview ? 'Screens stay fixed on the canvas. Click a screen to open Focus.' : 'Scrolling inside a live phone scrolls the app.'}</p>
    {fitLimited && <p className="canvas-hint" role="status">{minimumScale * 100}% minimum zoom reached: the whole board cannot fit here. Pan or zoom to a screen.</p>}
  </>;
}
