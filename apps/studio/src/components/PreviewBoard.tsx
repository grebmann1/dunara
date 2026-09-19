import { useCallback, useRef, useState, type ReactNode } from 'react';
import type { Preview, Project } from '../../../../packages/core/src/contracts';
import type { BoardCapture } from '../../../../packages/core/src/board-captures';
import type { Screen } from '../../../../packages/core/src/screen-catalog';
import type { BoardAction, PreviewBoardState } from '../preview-board';
import { DevicePreview } from './DevicePreview';
import type { InspectorAttachment } from '../../../../packages/assistant/src/contracts';
import { PreviewCanvas } from './PreviewCanvas';
import { ScreenOverview } from './ScreenOverview';
import { ScreenManager } from './ScreenManager';
import { Button } from './ui/button';
import { Columns2, LayoutGrid, Smartphone, MessageSquare } from 'lucide-react';
import '../preview-workspace.css';

type Props = { renderTools: (screenActions: ReactNode) => ReactNode; phoneControls?: ReactNode; onAskAssistant?: (attachment: InspectorAttachment) => void; onAskScreens?: (screens: Screen[]) => void; onRevealContext?: () => void; suppressContext?: boolean; preview: Preview; project: Project; board: PreviewBoardState; screens: Screen[]; captures: BoardCapture[]; sourceRevision: string; candidates: string[]; onChange: (action: BoardAction) => Promise<boolean>; active: boolean; disabled: boolean; perform: (label: string, operation: () => Promise<unknown>) => Promise<boolean> };
export function PreviewBoard({ renderTools, phoneControls, preview, project, board, screens: discovered, captures, sourceRevision, candidates, onChange, active, disabled, perform, suppressContext = false, onRevealContext, onAskAssistant, onAskScreens }: Props) {
  const [overviewControls, setOverviewControls] = useState<HTMLDivElement | null>(null);
  const [managing, setManaging] = useState(false);
  const screenManagerOpener = useRef<HTMLElement | null>(null);
  const [controlsHost, setControlsHost] = useState<HTMLDivElement | null>(null), [overlayHost, setOverlayHost] = useState<HTMLDivElement | null>(null);
  const dismissMenu = useRef<(() => void) | null>(null);
  const viewChanged = useCallback(() => dismissMenu.current?.(), []);
  const screens = [...discovered];
  for (const view of board.views) if (!screens.some(screen => screen.route === view.route)) screens.push({ route: view.route, name: view.route === '/' ? 'Home' : view.route.slice(1).replace(/[-_]/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase()) });
  const overviewScreens = board.screens ?? screens;
  const name = (route: string) => screens.find(screen => screen.route === route)?.name ?? route;
  const current = board.views.find(view => view.id === board.activeId)!;
  const liveViews = board.mode === 'compare' ? board.views : board.views.filter(view => view.id === board.activeId);
  const comparison = (kind = board.comparison, route = board.views[0]!.route, otherRoute = board.views[1]?.route ?? screens.find(screen => screen.route !== route)?.route ?? route) => onChange({ type: 'compare', comparison: kind, route, otherRoute });
  const picker = (label: string, route: string, change: (route: string) => void) => <label className="board-screen-picker"><span>{label}</span><select aria-label={label} value={route} onChange={event => change(event.target.value)}>{screens.map(screen => <option key={screen.route} value={screen.route}>{screen.name}</option>)}</select></label>;
  return <div className="device-stage preview-workspace" data-mode={board.mode}>
    <div className="board-heading">
      <div className="canvas-modes" role="group" aria-label="Preview mode">{([{ mode: 'overview', label: 'All screens', Icon: LayoutGrid }, { mode: 'focus', label: 'Focus', Icon: Smartphone }, { mode: 'compare', label: 'Compare', Icon: Columns2 }] as const).map(({ mode, label, Icon }) => <Button key={mode} variant="ghost" aria-pressed={board.mode === mode} onClick={() => mode === 'compare' && board.views.length === 1 ? comparison() : onChange({ type: 'canvas-mode', mode })}><Icon aria-hidden /><span>{label}</span></Button>)}</div>
      <div className="board-actions"><div ref={setOverviewControls} hidden={board.mode !== 'overview'} />{renderTools(<><Button variant="ghost" onClick={event => { screenManagerOpener.current = event.currentTarget.closest('details')?.querySelector('summary') ?? event.currentTarget; setManaging(true); }}><LayoutGrid aria-hidden />Manage screens</Button>{onAskScreens && <Button variant="ghost" onClick={() => onAskScreens(overviewScreens)}><MessageSquare aria-hidden />Ask Assistant about all screens</Button>}</>)}</div>
    </div>
    <ScreenOverview controlsHost={overviewControls} projectId={project.id} screens={overviewScreens} captures={captures} sourceRevision={sourceRevision} active={active && board.mode === 'overview'} ready={preview.status === 'ready'} disabled={disabled} onFocus={route => onChange({ type: 'focus-screen', route })} onCompare={routes => comparison('screens', routes[0], routes[1])} onAsk={onAskScreens} />
    {managing && <ScreenManager restoreFocus={() => screenManagerOpener.current?.focus({ preventScroll: true })} screens={overviewScreens} candidates={candidates} onClose={() => setManaging(false)} onSave={screens => onChange({ type: 'screen-list', screens })} />}
    {board.mode !== 'overview' && <>
      <div className="board-selection">
        {board.mode === 'focus' ? <nav className="focus-screens" aria-label="App screens">{screens.map(screen => <Button key={screen.route} variant="ghost" aria-pressed={current.route === screen.route} onClick={() => onChange({ type: 'focus-screen', route: screen.route })}>{screen.name}</Button>)}</nav> : <div className="comparison-selectors">
          <label className="board-screen-picker"><span>Compare</span><select aria-label="Compare by" value={board.comparison} onChange={event => comparison(event.target.value as 'screens' | 'sizes')}><option value="screens">Two screens</option><option value="sizes">Phone sizes</option></select></label>
          {picker(board.comparison === 'sizes' ? 'Screen' : 'Left screen', board.views[0]!.route, route => comparison(board.comparison, route))}
          {board.comparison === 'screens' && picker('Right screen', board.views[1]?.route ?? current.route, route => comparison('screens', board.views[0]!.route, route))}
        </div>}
        <div className="board-view-tools">{phoneControls}{onAskScreens && <Button className="board-ask" variant="ghost" aria-label={board.mode === 'focus' ? 'Ask Assistant about this screen' : 'Ask Assistant about these screens'} onClick={() => onAskScreens(screens.filter(screen => liveViews.some(view => view.route === screen.route)))}><MessageSquare aria-hidden /><span>Ask Assistant</span></Button>}</div>
      </div>
      <div className="live-board">
        {board.mode === 'compare' && <div className="board-controls" role="group" aria-label="Active comparison screen">{liveViews.map((view, index) => <Button key={view.id} variant="ghost" aria-pressed={board.activeId === view.id} onClick={() => onChange({ type: 'activate', id: view.id })}>{board.comparison === 'sizes' ? (view.viewport === 'compact' ? 'Compact' : 'Large') : `${index === 0 ? 'Left' : 'Right'} · ${name(view.route)}`}</Button>)}</div>}
        <PreviewCanvas activeId={board.activeId} viewCount={liveViews.length} active={active} onViewChange={viewChanged} controls={<div className="board-inspection" ref={setControlsHost} />} overlay={<div className="board-context" ref={setOverlayHost} hidden={suppressContext} />}>
          <div className="preview-phones">{liveViews.map(view => <DevicePreview onAskAssistant={onAskAssistant} onRevealContext={onRevealContext} contextSuppressed={suppressContext} key={view.id} viewId={view.id} label={view.label} screenName={name(view.route)} preview={preview} project={project} route={view.route} viewport={view.viewport} refresh={view.refresh} active={active && board.activeId === view.id} disabled={disabled} perform={perform} onReload={() => onChange({ type: 'reload', id: view.id })} controlsHost={controlsHost} overlayHost={overlayHost} dismissMenu={dismissMenu} />)}</div>
        </PreviewCanvas>
      </div>
    </>}
  </div>;
}
