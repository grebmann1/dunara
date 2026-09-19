import { useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Camera, ChevronDown, ChevronUp, Terminal, X } from 'lucide-react';
import type { StudioState } from '../api';
import { CaptureHistory, DiagnosticLog } from './DiagnosticsPanel';
import { Button } from './ui/button';
import '../studio-console.css';
import { DockGrip, DockMenu, useDock } from './layout/WorkspaceDock';

type Panel = 'diagnostics' | 'captures';
export function StudioConsole({ state, panel, onPanel: setPanel, onLaunchKit, onCaptureOpen }: { state: StudioState; panel: Panel | null; onPanel(panel: Panel | null): void; onLaunchKit(): void; onCaptureOpen(): void }) {
  const dock = useDock();
  const diagnosticsButton = useRef<HTMLButtonElement>(null), capturesButton = useRef<HTMLButtonElement>(null);
  const id = useId(), errors = state.diagnostics.entries.filter(entry => entry.level === 'error').length;
  const toggle = (next: Panel) => { if (panel === next) collapse(); else setPanel(next); };
  function collapse() { const trigger = panel === 'captures' ? capturesButton : diagnosticsButton; setPanel(null); requestAnimationFrame(() => trigger.current?.focus({ preventScroll: true })); }
  const content = <footer className="studio-console" aria-label="Workspace console" data-open={!!panel} onKeyDown={event => {
    if (event.key !== 'Escape' || (event.target instanceof Element && event.target.closest('[role="dialog"], [role="listbox"]'))) return;
    event.preventDefault(); event.stopPropagation(); collapse();
  }}>
    <div className="console-bar">
      {panel && <DockGrip id="console" />}
      <Button ref={diagnosticsButton} variant="ghost" className="console-toggle" aria-label="Diagnostics" aria-describedby={`${id}-health`} aria-expanded={panel === 'diagnostics'} aria-controls={`${id}-diagnostics`} onClick={() => toggle('diagnostics')}><Terminal aria-hidden /><span>Diagnostics</span><span id={`${id}-health`} className="console-health" data-error={errors > 0}>{errors ? `${errors} ${errors === 1 ? 'error' : 'errors'}` : 'No errors'}</span>{panel === 'diagnostics' ? <ChevronDown aria-hidden /> : <ChevronUp aria-hidden />}</Button>
      <Button ref={capturesButton} variant="ghost" className="console-toggle" aria-label="Captures" aria-expanded={panel === 'captures'} aria-controls={`${id}-captures`} onClick={() => toggle('captures')}><Camera aria-hidden /><span>Captures</span><span className="console-count">{state.captures.length}</span></Button>
      {panel && <><DockMenu id="console" /><Button variant="ghost" className="console-close" aria-label="Collapse console" title="Collapse console" onClick={collapse}><X aria-hidden /></Button></>}
    </div>
    <div id={`${id}-diagnostics`} className="console-panel" hidden={panel !== 'diagnostics'}>{panel === 'diagnostics' && <DiagnosticLog state={state} />}</div>
    <div id={`${id}-captures`} className="console-panel" hidden={panel !== 'captures'}>{panel === 'captures' && <CaptureHistory state={state} onCaptureOpen={onCaptureOpen} onLaunchKit={() => { setPanel(null); onLaunchKit(); }} />}</div>
  </footer>;
  return dock.desktop && panel && dock.hosts.console ? createPortal(content, dock.hosts.console) : content;
}
