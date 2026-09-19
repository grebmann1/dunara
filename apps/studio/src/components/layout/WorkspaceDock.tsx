import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { GripVertical, PanelBottom, PanelLeft, PanelRight, RotateCcw } from 'lucide-react';
import { Button } from '../ui/button';
import '../../workspace-dock.css';

export type DockId = 'assistant' | 'design' | 'console';
type Position = 'left' | 'right' | 'bottom';
type Layout = { positions: Record<DockId, Position>; left: number; right: number; bottom: number };
export type DockPane = { id: DockId; label: string; open: boolean };
const defaults: Layout = { positions: { assistant: 'right', design: 'right', console: 'bottom' }, left: 380, right: 400, bottom: 300 };
const ids: DockId[] = ['assistant', 'design', 'console'];
const storageKey = 'builder.workspace-layout.v1';
const query = '(min-width: 1280px) and (min-height: 650px)';
function readLayout(): Layout {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) ?? 'null') as Layout | null;
    if (value && ids.every(id => ['left', 'right', ...(id === 'console' ? ['bottom'] : [])].includes(value.positions?.[id])) && ['left', 'right', 'bottom'].every(key => typeof value[key as Position] === 'number' && Number.isFinite(value[key as Position]))) {
      return { positions: value.positions, left: Math.max(280, Math.min(560, value.left)), right: Math.max(280, Math.min(560, value.right)), bottom: Math.max(180, Math.min(560, value.bottom)) };
    }
  } catch { /* An unavailable or older preference must not prevent opening Studio. */ }
  return structuredClone(defaults);
}
export function useWorkspaceLayout() {
  const [layout, setLayout] = useState(readLayout);
  const [desktop, setDesktop] = useState(() => matchMedia(query).matches);
  const [active, setActive] = useState<Partial<Record<Position, DockId>>>({});
  const [dragging, setDragging] = useState<DockId | null>(null);
  const [announcement, announce] = useState('');
  const [hosts, setHosts] = useState<Partial<Record<DockId, HTMLDivElement>>>({});
  const hostRefs = useRef(Object.fromEntries(ids.map(id => [id, (element: HTMLDivElement | null) => { if (element) setHosts(current => current[id] === element ? current : { ...current, [id]: element }); }])) as Record<DockId, (element: HTMLDivElement | null) => void>);
  useEffect(() => {
    const root = document.getElementById('root'); if (!root) return;
    const measure = () => { const scale = root.getBoundingClientRect().width / root.clientWidth || 1; setDesktop(root.clientWidth >= 1280 && innerHeight / scale >= 650); setDragging(null); };
    measure(); const observer = new ResizeObserver(measure); observer.observe(root); window.addEventListener('resize', measure);
    return () => { observer.disconnect(); window.removeEventListener('resize', measure); };
  }, []);
  useEffect(() => { try { localStorage.setItem(storageKey, JSON.stringify(layout)); } catch { /* Layout remains usable for this session. */ } }, [layout]);
  useEffect(() => {
    if (!dragging) return;
    const cancel = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); setDragging(null); } };
    const clear = () => setDragging(null);
    window.addEventListener('keydown', cancel, true); window.addEventListener('blur', clear);
    return () => { window.removeEventListener('keydown', cancel, true); window.removeEventListener('blur', clear); };
  }, [dragging]);
  const activate = useCallback((id: DockId, position: Position) => setActive(current => ({ ...current, [position]: id })), []);
  const move = (id: DockId, position: Position) => {
    if (position === 'bottom' && id !== 'console') return;
    setLayout(current => ({ ...current, positions: { ...current.positions, [id]: position } })); activate(id, position); setDragging(null);
    announce(`${id === 'assistant' ? 'Assistant' : id === 'design' ? 'Design' : 'Console'} moved to the ${position}.`);
  };
  const reset = () => { setLayout(structuredClone(defaults)); setActive({}); setDragging(null); announce('Default workspace layout restored.'); };
  return { layout, setLayout, desktop, active, activate, dragging, setDragging, announcement, hosts, hostRefs: hostRefs.current, move, reset };
}
type DockContext = ReturnType<typeof useWorkspaceLayout> & { panes: DockPane[] };
const Context = createContext<DockContext | null>(null);
export const WorkspaceDockProvider = Context.Provider;
export function useDock() { const value = useContext(Context); if (!value) throw new Error('Workspace docking context is missing'); return value; }

export function DockWorkspace({ children }: { children: ReactNode }) {
  const dock = useDock(), root = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 1200, height: 800 });
  const previous = useRef<DockId[]>([]);
  const opened = dock.panes.filter(pane => pane.open);
  const openKey = opened.map(pane => pane.id).join(',');
  useLayoutEffect(() => {
    for (const position of ['left', 'right', 'bottom'] as const) {
      const members = dock.panes.filter(pane => pane.open && dock.layout.positions[pane.id] === position);
      const next = members.filter(pane => !previous.current.includes(pane.id)).at(-1) ?? members.find(pane => pane.id === dock.active[position]) ?? members.at(-1);
      if (next && next.id !== dock.active[position]) dock.activate(next.id, position);
    }
    previous.current = dock.panes.filter(pane => pane.open).map(pane => pane.id);
  }, [openKey, dock.activate, dock.active, dock.layout.positions, dock.panes]);
  useLayoutEffect(() => {
    if (!root.current) return;
    const measure = () => { const box = root.current!.getBoundingClientRect(); setSize({ width: box.width, height: box.height }); };
    measure(); const observer = new ResizeObserver(measure); observer.observe(root.current); return () => observer.disconnect();
  }, []);
  const at = (position: Position) => opened.filter(pane => dock.layout.positions[pane.id] === position);
  const shown = (position: Position) => at(position).find(pane => pane.id === dock.active[position]) ?? at(position).at(-1);
  const sideCount = Number(!!at('left').length) + Number(!!at('right').length);
  const maxSide = Math.max(280, Math.min(560, (size.width - 420) / Math.max(1, sideCount)));
  const maxBottom = Math.max(180, Math.min(560, size.height * .6));
  const dimensions = { left: Math.min(dock.layout.left, maxSide), right: Math.min(dock.layout.right, maxSide), bottom: Math.min(dock.layout.bottom, maxBottom) };
  const style = { '--dock-left': `${at('left').length ? dimensions.left : 0}px`, '--dock-right': `${at('right').length ? dimensions.right : 0}px`, '--dock-bottom': `${at('bottom').length ? dimensions.bottom : 0}px` } as CSSProperties;
  return <div ref={root} className="dock-workspace" data-docking={dock.desktop} style={style}>
    {children}
    {dock.panes.map(pane => {
      const position = dock.layout.positions[pane.id], visible = dock.desktop && shown(position)?.id === pane.id;
      return <div key={pane.id} className="dock-slot" data-panel={pane.id} data-position={position} hidden={!visible} style={{ gridArea: position }}>
        {at(position).length > 1 && <div className="dock-tabs" role="tablist" aria-label={`${position} panels`} onKeyDown={event => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
          const panes = at(position), current = panes.findIndex(item => item.id === pane.id);
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? panes.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + panes.length) % panes.length;
          event.preventDefault(); dock.activate(panes[next]!.id, position);
          requestAnimationFrame(() => root.current?.querySelector<HTMLButtonElement>(`.dock-slot:not([hidden]) [data-tab="${panes[next]!.id}"]`)?.focus());
        }}>{at(position).map(item => <button key={item.id} id={`dock-tab-${pane.id}-${item.id}`} role="tab" data-tab={item.id} aria-controls={`dock-host-${item.id}`} aria-selected={item.id === pane.id} tabIndex={item.id === pane.id ? 0 : -1} onClick={() => dock.activate(item.id, position)}>{item.label}</button>)}</div>}
        <div ref={dock.hostRefs[pane.id]} id={`dock-host-${pane.id}`} className="dock-host" role={at(position).length > 1 ? 'tabpanel' : undefined} aria-labelledby={at(position).length > 1 ? `dock-tab-${pane.id}-${pane.id}` : undefined} />
      </div>;
    })}
    {dock.desktop && (['left', 'right', 'bottom'] as const).filter(position => at(position).length).map(position => <DockResize key={position} position={position} value={dimensions[position]} max={position === 'bottom' ? maxBottom : maxSide} />)}
    {dock.desktop && dock.dragging && <div className="dock-drop-overlay" aria-label="Panel drop destinations">{(['left', 'right', ...(dock.dragging === 'console' ? ['bottom'] : [])] as Position[]).map(position => <div key={position} className="dock-drop-target" data-position={position} data-testid={`dock-drop-${position}`}><span>{position === 'left' ? <PanelLeft /> : position === 'right' ? <PanelRight /> : <PanelBottom />}Move to {position}</span></div>)}</div>}
    <span className="sr-only" role="status">{dock.announcement}</span>
  </div>;
}

function DockResize({ position, value, max }: { position: Position; value: number; max: number }) {
  const dock = useDock(), initial = useRef<{ x: number; y: number; value: number; pointer: number } | null>(null);
  const [resizing, setResizing] = useState(false), min = position === 'bottom' ? 180 : 280;
  const update = (size: number) => dock.setLayout(current => ({ ...current, [position]: Math.round(Math.max(min, Math.min(max, size))) }));
  return <><div role="separator" tabIndex={0} aria-label={`Resize ${position} panel`} aria-orientation={position === 'bottom' ? 'horizontal' : 'vertical'} aria-valuemin={min} aria-valuemax={Math.round(max)} aria-valuenow={Math.round(value)} className="dock-resize" data-position={position} onDoubleClick={() => update(defaults[position])} onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); event.currentTarget.focus(); initial.current = { x: event.clientX, y: event.clientY, value, pointer: event.pointerId }; event.currentTarget.setPointerCapture(event.pointerId); setResizing(true); }} onPointerMove={event => { const start = initial.current; if (start && start.pointer === event.pointerId) update(start.value + (position === 'bottom' ? start.y - event.clientY : (event.clientX - start.x) * (position === 'left' ? 1 : -1))); }} onPointerUp={event => { initial.current = null; setResizing(false); if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }} onPointerCancel={() => { if (initial.current) update(initial.current.value); initial.current = null; setResizing(false); }} onLostPointerCapture={() => { initial.current = null; setResizing(false); }} onKeyDown={event => {
    if (event.key === 'Escape' && initial.current) { update(initial.current.value); const pointer = initial.current.pointer; initial.current = null; setResizing(false); event.currentTarget.releasePointerCapture(pointer); event.preventDefault(); }
    const direction = position === 'bottom' ? event.key === 'ArrowUp' ? 1 : event.key === 'ArrowDown' ? -1 : 0 : event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (direction) { event.preventDefault(); update(value + direction * (position === 'right' ? -20 : 20)); }
    if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); update(event.key === 'Home' ? min : max); }
  }} />{resizing && <div className="dock-resize-shield" data-position={position} />}</>;
}

export function DockGrip({ id }: { id: DockId }) {
  const dock = useDock(), label = dock.panes.find(pane => pane.id === id)!.label;
  const start = useRef<{ x: number; y: number; pointer: number; moved: boolean } | null>(null), suppressClick = useRef(false);
  useEffect(() => { if (!dock.dragging && start.current?.moved) start.current = null; }, [dock.dragging]);
  useEffect(() => {
    const destination = (x: number, y: number) => {
      let result: Position | null = null;
      const bounds = document.querySelector('.dock-workspace')?.getBoundingClientRect();
      if (bounds && y >= bounds.top + 12 && y <= bounds.bottom - 12) {
        if (x >= bounds.left + 12 && x <= bounds.left + 12 + bounds.width * .27) result = 'left';
        else if (x >= bounds.right - 12 - bounds.width * .27 && x <= bounds.right - 12) result = 'right';
        else if (id === 'console' && y >= bounds.bottom - 12 - bounds.height * .28 && x >= bounds.left + bounds.width * .3 && x <= bounds.right - bounds.width * .3) result = 'bottom';
      }
      for (const element of document.querySelectorAll<HTMLElement>('.dock-drop-target')) {
        element.dataset.over = String(element.dataset.position === result);
      }
      return result;
    };
    const cancel = () => { start.current = null; dock.setDragging(null); };
    const move = (event: PointerEvent) => {
      const origin = start.current; if (!origin || origin.pointer !== event.pointerId) return;
      if (event.buttons === 0) { cancel(); return; }
      if (!origin.moved && Math.hypot(event.clientX - origin.x, event.clientY - origin.y) >= 6) { origin.moved = true; suppressClick.current = true; dock.setDragging(id); }
      if (origin.moved) destination(event.clientX, event.clientY);
    };
    const finish = (event: MouseEvent) => {
      const origin = start.current; start.current = null;
      if (origin && (origin.moved || Math.hypot(event.clientX - origin.x, event.clientY - origin.y) >= 6)) { suppressClick.current = true; const position = destination(event.clientX, event.clientY); if (position) dock.move(id, position); else dock.setDragging(null); }
    };
    // The overlay shields iframes. Window release listeners also cover Electron's mouse event path.
    window.addEventListener('pointermove', move, true); window.addEventListener('pointerup', finish, true); window.addEventListener('mouseup', finish, true);
    window.addEventListener('pointercancel', cancel); window.addEventListener('blur', cancel);
    return () => { window.removeEventListener('pointermove', move, true); window.removeEventListener('pointerup', finish, true); window.removeEventListener('mouseup', finish, true); window.removeEventListener('pointercancel', cancel); window.removeEventListener('blur', cancel); };
  }, [dock.move, dock.setDragging, id]);
  return dock.desktop && <button className="dock-grip" aria-label={`Drag ${label} panel`} title="Drag to another side · click for placement options" onClick={event => { if (suppressClick.current) { suppressClick.current = false; return; } const menu = event.currentTarget.parentElement?.querySelector<HTMLDetailsElement>('.dock-menu'); if (menu) { menu.open = true; menu.querySelector('summary')?.focus(); } }} onPointerDown={event => {
    if (event.button !== 0) return; event.preventDefault(); event.currentTarget.focus(); suppressClick.current = false;
    start.current = { x: event.clientX, y: event.clientY, pointer: event.pointerId, moved: false };
  }}><GripVertical aria-hidden /></button>;
}
export function DockMenu({ id }: { id: DockId }) {
  const dock = useDock(), menu = useRef<HTMLDetailsElement>(null), label = dock.panes.find(pane => pane.id === id)!.label;
  useEffect(() => { const close = (event: PointerEvent) => { if (event.target instanceof Node && !menu.current?.contains(event.target) && menu.current) menu.current.open = false; }; document.addEventListener('pointerdown', close); return () => document.removeEventListener('pointerdown', close); }, []);
  const finish = (action: () => void) => { action(); if (menu.current) { menu.current.open = false; menu.current.querySelector('summary')?.focus(); } };
  return dock.desktop && <details ref={menu} className="dock-menu" onKeyDown={event => { if (event.key === 'Escape' && menu.current?.open) { event.preventDefault(); event.stopPropagation(); menu.current.open = false; menu.current.querySelector('summary')?.focus(); } }}><summary aria-label={`Arrange ${label} panel`} title="Arrange panel"><PanelRight aria-hidden /></summary><div className="dock-menu-content"><p>Move panel</p>{(['left', 'right', ...(id === 'console' ? ['bottom'] : [])] as Position[]).map(position => <Button key={position} variant="ghost" aria-pressed={dock.layout.positions[id] === position} onClick={() => finish(() => dock.move(id, position))}>{position === 'left' ? <PanelLeft aria-hidden /> : position === 'right' ? <PanelRight aria-hidden /> : <PanelBottom aria-hidden />}Move to {position}</Button>)}<Button variant="ghost" onClick={() => finish(dock.reset)}><RotateCcw aria-hidden />Reset workspace layout</Button></div></details>;
}
