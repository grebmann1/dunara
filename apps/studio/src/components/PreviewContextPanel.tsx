import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import type { PreviewSelection } from '../preview-context';
import { Button } from './ui/button';
import { Textarea } from './ui/textarea';

type Props = { onAskAssistant?: () => void; id: string; open: boolean; onClose: () => void; onReveal: () => void; selection: PreviewSelection | null; text: string; error: string; onParent: () => void; onPrevious: () => void; onNext: () => void; copyRequest: React.MutableRefObject<(() => void) | null> };
export function PreviewContextPanel({ id, open, onClose, onReveal, selection, text, error, onParent, onPrevious, onNext, copyRequest, onAskAssistant }: Props) {
  const [status, setStatus] = useState('');
  const textarea = useRef<HTMLTextAreaElement>(null), latest = useRef(text), alive = useRef(true), manualCopy = useRef(false);
  latest.current = text;
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { setStatus(''); manualCopy.current = false; }, [text]);
  useLayoutEffect(() => {
    if (open && manualCopy.current) { textarea.current?.focus(); textarea.current?.select(); manualCopy.current = false; }
  }, [open, status]);
  function copy() {
    if (!text) return;
    const captured = text;
    const current = () => alive.current && latest.current === captured;
    const fallback = () => { if (current()) { onReveal(); manualCopy.current = true; setStatus('Clipboard unavailable. Select the text below and copy it manually.'); if (open) { textarea.current?.focus(); textarea.current?.select(); manualCopy.current = false; } } };
    if (!navigator.clipboard?.writeText) { fallback(); return; }
    // Called directly by a Studio button/menu gesture; never by an iframe message.
    void navigator.clipboard.writeText(captured).then(() => { if (current()) { onReveal(); setStatus('Context copied. Review it before pasting into Claude Code or Codex.'); } }, fallback);
  }
  copyRequest.current = copy;
  useEffect(() => () => { copyRequest.current = null; }, [copyRequest]);
  return <section id={id} hidden={!open} className="context-panel" aria-label="Selected preview context" onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); }
  }}>
    <div className="context-heading"><h2>Preview context</h2><Button variant="ghost" aria-label="Close preview context" onClick={onClose}><X aria-hidden /></Button></div>
    <p>Rendered web elements, not verified React component identities.</p>
    {selection ? <><p><strong>{selection.element.tag}{selection.element.role ? ` · ${selection.element.role}` : ''}</strong> · {selection.pathname} · {Math.round(selection.bounds.width)} × {Math.round(selection.bounds.height)} CSS px</p><p>{selection.element.label || selection.visibleText || 'No public visible text'}</p><p>Source: {selection.source.status}. {selection.locator.unique ? 'Unique DOM hint at selection time.' : 'DOM hint is not unique.'}</p></> : <p>Close this panel to select an element in the phone, then reopen Preview context. Arrow keys browse elements; Shift+F10 opens the copy menu.</p>}
    <div className="context-actions"><Button disabled={!text} onClick={copy}>Copy context</Button><Button variant="outline" disabled={!selection} onClick={onParent}>Select parent</Button></div>
    {onAskAssistant && <Button variant="outline" disabled={!text || !selection} onClick={onAskAssistant}>Ask assistant about this</Button>}
    <div className="context-actions"><Button variant="ghost" onClick={onPrevious}>Previous element</Button><Button variant="ghost" onClick={onNext}>Next element</Button></div>
    <p className="context-warning">Visible app text may contain personal information. Review before pasting externally; automatic exclusion of editable fields cannot guarantee all secrets are removed.</p>
    {error && <p role="alert">{error}</p>}
    <label>Copyable context<Textarea ref={textarea} readOnly value={text} rows={8} spellCheck={false} /></label>
    <p role="status" aria-live="polite">{status}</p>
  </section>;
}
