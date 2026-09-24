import { useEffect, useRef, useState, type ReactNode } from 'react';
import { CircleHelp, Ellipsis, Package, Settings, Smartphone, Waypoints } from 'lucide-react';
import { useStudioClient, type StudioState } from '../api';
import { ScreenList } from './ScreenList';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog';
import { DeviceConnection } from './DeviceConnection';
import { NativeBuildPanel } from './NativeBuildPanel';

type Tool = 'routes' | 'help' | 'device' | 'build';
export function PreviewTools({ state, route, viewport, screenActions, onRoute, onRefresh, onSettings, onOpenDialog }: { state: StudioState; route: string; viewport: 'compact' | 'large'; screenActions: ReactNode; onRoute(route: string): void; onRefresh(): void; onSettings(): void; onOpenDialog(): void }) {
  const { capabilities } = useStudioClient();
  const menu = useRef<HTMLDetailsElement>(null), deviceButton = useRef<HTMLButtonElement>(null), trigger = useRef<HTMLElement | null>(null), title = useRef<HTMLHeadingElement>(null);
  const [tool, setTool] = useState<Tool | null>(null), [manualPath, setManualPath] = useState('');
  function open(next: Tool) {
    trigger.current = next === 'device' ? deviceButton.current : menu.current?.querySelector('summary') ?? null;
    if (menu.current) menu.current.open = false;
    onOpenDialog();
    setTool(next);
  }
  useEffect(() => {
    const dismiss = (event: PointerEvent) => { if (event.target instanceof Node && !menu.current?.contains(event.target) && menu.current) menu.current.open = false; };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, []);
  const labels = { routes: ['Project routes', 'Open a discovered screen or enter a custom path.'], help: ['Canvas help', 'Move around the canvas and preview your app.'], device: ['Connect a device', capabilities.privatePreview || state.preview.transport === 'cloud' ? 'Open this private preview in your phone browser.' : 'Open this preview in Expo Go on your phone.'], build: ['Build setup', 'Prepare an installable version of your app.'] };
  return <>
    <Button ref={deviceButton} variant="ghost" aria-label="Connect a device" title="Connect a device" onClick={() => open('device')}><Smartphone aria-hidden /></Button>
    <details ref={menu} className="preview-tools" onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); event.currentTarget.open = false; event.currentTarget.querySelector('summary')?.focus(); } }}>
      <summary aria-label="Preview tools" title="More preview actions"><Ellipsis aria-hidden /></summary>
      <div className="preview-popover preview-action-menu" onClick={event => { if ((event.target as Element).closest('button') && menu.current) menu.current.open = false; }}>
        <div className="preview-menu-group">{screenActions}<Button variant="ghost" aria-label="Project routes" title={`Project routes · ${route}`} onClick={() => open('routes')}><Waypoints aria-hidden />Browse routes</Button></div>
        <div className="preview-menu-group"><Button variant="ghost" onClick={() => open('build')}><Package aria-hidden />Build setup</Button><Button variant="ghost" onClick={onSettings}><Settings aria-hidden />Project settings</Button><Button variant="ghost" onClick={() => open('help')}><CircleHelp aria-hidden />Canvas help</Button></div>
      </div>
    </details>
    <Dialog open={!!tool} onOpenChange={value => { if (!value) setTool(null); }}>
      <DialogContent placement="drawer" className="preview-tool-dialog" onOpenAutoFocus={event => { event.preventDefault(); title.current?.focus(); }} onCloseAutoFocus={event => { event.preventDefault(); (trigger.current?.isConnected ? trigger.current : menu.current?.querySelector('summary'))?.focus({ preventScroll: true }); }}>
        <header><DialogTitle ref={title} tabIndex={-1}>{tool ? labels[tool][0] : ''}</DialogTitle><DialogDescription>{tool ? labels[tool][1] : ''}</DialogDescription></header>
        <div className="preview-tool-body">
          {tool === 'routes' && <ScreenList route={route} onRoute={value => { onRoute(value); setTool(null); }} routes={state.routeCandidates} onRefresh={onRefresh} manualPath={manualPath} onManualPath={setManualPath} />}
          {tool === 'help' && <><dl className="canvas-shortcuts"><div><dt>Move around</dt><dd>Drag the canvas background, scroll, or use two fingers on your trackpad. You can also drag with the middle mouse button.</dd></div><div><dt>Zoom</dt><dd>Pinch, or hold ⌘ / Ctrl while scrolling.</dd></div><div><dt>Fit all screens</dt><dd>Use Fit all, or press <kbd>0</kbd> with the canvas focused.</dd></div><div><dt>Keyboard</dt><dd>Arrow keys move the camera. <kbd>+</kbd> and <kbd>−</kbd> zoom.</dd></div></dl><p>Scroll inside a live phone to scroll the app. Click a saved screen to open its live preview.</p><details className="preview-capture-help"><summary>How live previews and captures work</summary><p>Captures use the selected entry path <code>{route}</code> at {viewport === 'compact' ? '375 × 812' : '430 × 932'}. Navigation inside the phone does not update this path.</p><p>Live phones share the same app process and storage. Preview controls act on the selected phone.</p></details></>}
          {tool === 'device' && <DeviceConnection key={state.project.id} preview={state.preview} appName={state.project.name} onRefresh={onRefresh} />}
          {tool === 'build' && <NativeBuildPanel key={state.project.id} projectId={state.project.id} onRefresh={onRefresh} />}
        </div>
      </DialogContent>
    </Dialog>
  </>;
}
