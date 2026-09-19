import { useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import type { Preview, Project } from '../../../../packages/core/src/contracts';
import type { InspectorProposal } from '../../../../packages/core/src/preview-inspector';
import { useStudioClient } from '../api';
import { command, formatContext, parseReply, type InspectorCommand, type PreviewSelection } from '../preview-context';
import { PreviewContextPanel } from './PreviewContextPanel';
import type { InspectorAttachment } from '../../../../packages/assistant/src/contracts';
import { BatteryFull, MousePointer2, PanelRight, RotateCw, Smartphone, Wrench } from 'lucide-react';
import { Button } from './ui/button';

type Props = { onAskAssistant?: (attachment: InspectorAttachment) => void; onRevealContext?: () => void; contextSuppressed?: boolean; preview: Preview; project: Project; route: string; viewport: 'compact' | 'large'; refresh: number; active: boolean; disabled: boolean; perform: (label: string, operation: () => Promise<unknown>) => Promise<boolean>; onReload: () => void; viewId: string; label: number; controlsHost: HTMLDivElement | null; overlayHost: HTMLDivElement | null; dismissMenu: RefObject<(() => void) | null> };
export function DevicePreview({ preview, project, route, viewport, refresh, active, disabled, perform, onReload, viewId, label, screenName, controlsHost, overlayHost, dismissMenu, onAskAssistant, onRevealContext, contextSuppressed = false }: Props & { screenName?: string }) {
  const { api, capabilities } = useStudioClient();
  const [loaded, setLoaded] = useState('');
  const iframe = useRef<HTMLIFrameElement>(null);
  const inspectButton = useRef<HTMLButtonElement>(null), menuElement = useRef<HTMLDivElement>(null), setupDialog = useRef<HTMLDialogElement>(null);
  const copy = useRef<(() => void) | null>(null);
  const isActive = useRef(active); isActive.current = active;
  const [contextOpen, setContextOpen] = useState(false);
  const contextId = useId(), contextButton = useRef<HTMLButtonElement>(null);
  function closeContext() { setContextOpen(false); contextButton.current?.focus(); }
  function revealContext() { onRevealContext?.(); setContextOpen(true); }
  const [bridge, setBridge] = useState<'connecting' | 'ready' | 'missing'>('connecting');
  const [inspecting, setInspecting] = useState(false), [selection, setSelection] = useState<PreviewSelection | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const menuOpen = useRef(false), menuFocus = useRef<Element | null>(null);
  const [proposal, setProposal] = useState<InspectorProposal | null>(null), [confirmed, setConfirmed] = useState(false);
  const setupVersion = useRef(0);
  const session = useRef<{ nonce: string; origin: string; frame: Window; enabled: boolean; ready: boolean } | null>(null);
  const restart = useRef<(() => void) | null>(null);
  const source = preview.status === 'ready' && preview.url ? new URL(route, preview.url).href : '';
  const key = `${project.id}:${source}:${refresh}`;
  function send(type: InspectorCommand) { const current = session.current; if (current) current.frame.postMessage(command(current.nonce, type), current.origin); }
  function closeMenu(restore = true) {
    setMenu(null); menuOpen.current = false; send('menu-close');
    if (restore) { const target = menuFocus.current; if (target instanceof HTMLElement && target.isConnected) target.focus(); else inspectButton.current?.focus(); }
  }
  function exit() { if (session.current) session.current.enabled = false; send('disable'); closeMenu(false); setInspecting(false); setSelection(null); inspectButton.current?.focus(); }
  useLayoutEffect(() => {
    let interval: ReturnType<typeof setInterval> | undefined, timeout: ReturnType<typeof setTimeout> | undefined;
    function reset() {
      clearInterval(interval); clearTimeout(timeout);
      send('disconnect'); session.current = null;
      setSelection(null); setInspecting(false); setContextOpen(false); setMenu(null); menuOpen.current = false;
      if (!source || !active || !iframe.current?.contentWindow) return;
      setBridge('connecting');
      session.current = { nonce: crypto.randomUUID(), origin: new URL(source).origin, frame: iframe.current.contentWindow, enabled: false, ready: false };
      send('init');
      interval = setInterval(() => send('init'), 500);
      timeout = setTimeout(() => { clearInterval(interval); if (session.current && !session.current.ready) { session.current = null; setBridge('missing'); } }, 8000);
    }
    function receive(event: MessageEvent) {
      const current = session.current;
      if (!current || event.source !== current.frame || event.source !== iframe.current?.contentWindow || event.origin !== current.origin) return;
      const message = parseReply(event.data, current.nonce); if (!message) return;
      if (message.type === 'ready') { clearInterval(interval); clearTimeout(timeout); current.ready = true; setBridge('ready'); return; }
      if (message.type === 'disconnect') { reset(); return; }
      if (!current.ready || !current.enabled) return;
      if (message.type === 'clear') { setSelection(null); closeMenu(false); }
      if (message.type === 'escape') { if (menuOpen.current) closeMenu(); else exit(); }
      if (message.type === 'selection' || message.type === 'context-menu') {
        setSelection(message.selection);
        if (message.type === 'context-menu' && iframe.current) {
          const rect = iframe.current.getBoundingClientRect();
          // Right-click may leave focus on the canvas after keyboard panning.
          menuFocus.current = iframe.current;
          menuOpen.current = true;
          setMenu({ x: rect.left + message.point.x * rect.width / message.selection.viewport.width, y: rect.top + message.point.y * rect.height / message.selection.viewport.height });
        }
      }
    }
    restart.current = reset; window.addEventListener('message', receive); reset();
    return () => { clearInterval(interval); clearTimeout(timeout); window.removeEventListener('message', receive); send('disconnect'); session.current = null; restart.current = null; setupVersion.current++; };
  }, [key, active, viewport]);
  useLayoutEffect(() => {
    if (!active) return;
    dismissMenu.current = () => { if (menuOpen.current) closeMenu(false); };
    return () => { dismissMenu.current = null; };
  }, [active, dismissMenu]);
  useEffect(() => { setProposal(null); setConfirmed(false); }, [key, active, viewport]);
  useEffect(() => {
    function keyboard(event: KeyboardEvent) {
      if (event.key === 'Escape' && !setupDialog.current?.open && session.current?.enabled) { event.preventDefault(); if (menuOpen.current) closeMenu(); else exit(); }
    }
    window.addEventListener('keydown', keyboard); return () => window.removeEventListener('keydown', keyboard);
  }, [active]);
  useLayoutEffect(() => {
    if (!menu || !menuElement.current) return;
    const element = menuElement.current;
    const position = () => {
      element.style.left = '0px'; element.style.top = '0px';
      const rect = element.getBoundingClientRect(), ratio = rect.width / element.offsetWidth || 1;
      element.style.left = `${(Math.max(8, Math.min(menu.x, innerWidth - rect.width - 8)) - rect.left) / ratio}px`;
      element.style.top = `${(Math.max(8, Math.min(menu.y, innerHeight - rect.height - 8)) - rect.top) / ratio}px`;
    };
    position(); element.querySelector('button')?.focus();
    const outside = (event: PointerEvent) => { if (!element.contains(event.target as Node)) closeMenu(false); };
    window.addEventListener('resize', position); window.addEventListener('pointerdown', outside, true);
    return () => { window.removeEventListener('resize', position); window.removeEventListener('pointerdown', outside, true); };
  }, [menu]);
  useEffect(() => {
    if (!proposal) return;
    const previous = document.activeElement; setupDialog.current?.showModal();
    return () => { if (isActive.current && previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, [proposal]);
  let text = '', formatError = '';
  if (selection && inspecting && active) try { text = formatContext(project, selection); } catch (error) { formatError = error instanceof Error ? error.message : 'Cannot format context'; }
  function reviewSetup() {
    const version = ++setupVersion.current;
    void perform('Reviewing inspection setup', async () => {
      const result = await api<InspectorProposal>(`/projects/${project.id}/inspector/setup-preview`, {});
      if (setupVersion.current === version) { setConfirmed(false); setProposal(result); }
    });
  }
  return <div className="preview-phone" data-view-id={viewId} data-view-label={label} data-active={active} aria-label={`${screenName ?? `View ${label}`} ${viewport} phone`}>
    {active && controlsHost && source && createPortal(<div className="inspect-controls"><Button variant="ghost" ref={inspectButton} aria-label="Inspect" title="Inspect" aria-pressed={inspecting} disabled={disabled || !active || bridge !== 'ready'} onClick={() => {
      if (inspecting) { exit(); return; }
      if (!session.current?.ready) return;
      session.current.enabled = true; setInspecting(true); setContextOpen(false); setSelection(null); send('enable'); iframe.current?.focus();
    }}><MousePointer2 aria-hidden /></Button>
      <Button variant="ghost" ref={contextButton} aria-label="Preview context" title="Preview context" disabled={!inspecting} aria-expanded={inspecting && contextOpen && !contextSuppressed} aria-controls={contextId} onClick={() => { if (contextOpen && !contextSuppressed) closeContext(); else revealContext(); }}><PanelRight aria-hidden /></Button>
      {bridge === 'connecting' && <span className="sr-only" role="status">Connecting inspection bridge…</span>}
      {bridge === 'missing' && <><p className="sr-only">Inspection bridge unavailable or incompatible. Review setup for this project, then reload the preview. A preview redirected to a different origin is not inspectable.</p><Button variant="ghost" aria-label="Review inspection setup" title="Inspection unavailable · Review inspection setup" disabled={disabled || !active} onClick={reviewSetup}><Wrench aria-hidden /></Button><Button variant="ghost" aria-label="Retry connection" title="Retry inspection connection" onClick={() => restart.current?.()}><RotateCw aria-hidden /></Button></>}
    </div>, controlsHost)}
    {active && overlayHost && inspecting && createPortal(<PreviewContextPanel onAskAssistant={onAskAssistant ? () => { if (isActive.current && inspecting && selection && text) { onAskAssistant({ projectId: project.id, viewId, view: { route, viewport, refresh }, selection }); setContextOpen(false); } } : undefined} id={contextId} open={contextOpen && !contextSuppressed} onClose={closeContext} onReveal={revealContext} selection={selection} text={text} error={formatError} onParent={() => send('parent')} onPrevious={() => send('previous')} onNext={() => send('next')} copyRequest={copy} />, overlayHost)}
    <div className={`device ${viewport}`}><div className="device-status"><span>9:41</span><div className="island" /><BatteryFull className="device-battery" role="img" aria-label="Full battery" /></div>{source ? <><iframe ref={iframe} key={key} tabIndex={0} title="Live app preview" src={source} sandbox="allow-scripts allow-same-origin" referrerPolicy="no-referrer" onLoad={() => { setLoaded(key); restart.current?.(); }} />{loaded !== key && <div className="device-loading">Loading your app…</div>}</> : <div className="device-empty"><Smartphone aria-hidden className="size-9 text-muted-foreground" /><h2>{preview.status === 'starting' ? 'Preparing your preview' : preview.status === 'failed' ? 'Preview could not start' : 'Preview is stopped'}</h2><p>{preview.status === 'starting' ? 'Preparing Expo. The first start installs pinned dependencies; this can take a few minutes.' : preview.error ?? (capabilities.privatePreview ? 'Start a private cloud preview to see your app.' : 'Choose Start preview above to run this app locally.')}</p>{preview.status === 'failed' && <p>Review Activity for diagnostics, repair the source with your agent, then start again.</p>}</div>}<div className="home-indicator" /></div>
    <p className="preview-caption"><strong>{screenName ?? `View ${label}`}</strong> <span>·</span> {source ? 'Live' : 'Stopped'} <span>·</span> {viewport === 'compact' ? '375 × 812' : '430 × 932'} <span>·</span> Opens {route}</p>
    {menu && text && createPortal(<div ref={menuElement} role="menu" aria-label="Preview element" className="context-menu" onKeyDown={event => {
      const buttons = Array.from(event.currentTarget.querySelectorAll('button'));
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) { event.preventDefault(); const index = buttons.indexOf(document.activeElement as HTMLButtonElement); buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length]?.focus(); }
      if (event.key === 'Tab') closeMenu(false);
    }}><button role="menuitem" onClick={() => { closeMenu(); copy.current?.(); }}>Copy context</button><button role="menuitem" onClick={() => { send('parent'); closeMenu(); }}>Select parent</button></div>, document.body)}
    {proposal && createPortal(<dialog ref={setupDialog} className="modal inspector-setup" aria-label="Review inspection setup" onCancel={() => setProposal(null)}><h2>Review inspection setup</h2><p>{proposal.project.name} · {proposal.project.root}</p><p>Development-only web inspection. No new app dependencies, credentials, model calls or automatic source edits from selections.</p>
      {proposal.installed ? <p>The canonical bridge is already installed. Reload the preview; if needed restart Expo. Production and standalone tabs intentionally do not connect.</p> : proposal.files.map(file => <section key={file.path}><h3>{file.path} {file.before === file.after ? '(unchanged)' : ''}</h3><details><summary>Before (full file)</summary><pre>{file.before ?? '(new file)'}</pre></details><details open><summary>After (full file)</summary><pre>{file.after}</pre></details></section>)}
      {!proposal.installed && <label><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} /> I reviewed these exact file changes and approve setup.</label>}
      <div className="context-actions"><button onClick={() => setProposal(null)}>Cancel</button>{proposal.installed ? <button onClick={() => { setProposal(null); onReload(); }}>Reload preview</button> : <button disabled={!confirmed || disabled} onClick={() => {
        const version = setupVersion.current;
        void perform('Installing inspection bridge', async () => {
          await api(`/projects/${project.id}/inspector/setup-apply`, { projectId: project.id, proposedRevision: proposal.proposedRevision, confirmed: true });
          if (setupVersion.current === version) { setProposal(null); onReload(); }
        });
      }}>Apply inspection setup</button>}</div><p>If interrupted or conflicted, cancel and review a fresh proposal before retrying. Successfully installed helper files are retained.</p></dialog>, document.body)}
  </div>;
}
