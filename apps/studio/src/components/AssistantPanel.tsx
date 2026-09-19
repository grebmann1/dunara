import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { ArrowDown, ArrowUp, Check, ChevronRight, Hammer, History, ListTodo, LoaderCircle, Play, Plus, Sparkles, Square, X } from 'lucide-react';
import { Button } from './ui/button';
import type { AssistantController } from '../assistant';
import { AssistantAttachments, AttachmentImage } from './AssistantAttachments';
import { AssistantMarkdown, CopyMessage } from './AssistantMarkdown';
import { AssistantTasks } from './AssistantTasks';
import { AssistantHistory } from './AssistantHistory';
import { continuationPrompt } from '../assistant-history';
import { DockGrip, DockMenu, useDock } from './layout/WorkspaceDock';

type Props = { controller: AssistantController; open: boolean; onOpenChange(open: boolean): void; trigger: RefObject<HTMLButtonElement | null>; projectName?: string; onSettings(): void };
const starters = [
  { title: 'Refine this screen', detail: 'Make the details feel right', prompt: 'Review the current screen and suggest improvements to its layout, spacing, and typography.' },
  { title: 'Build something new', detail: 'Turn an idea into a working app', prompt: 'Help me plan a new mobile app. Ask me about the idea, who it is for, and the visual direction.' },
  { title: 'Find and fix an issue', detail: 'Get things working again', prompt: 'Review this project for errors and help me fix what is not working.' },
];
const toolLabel = (name: string) => name.replace(/^builder_mcp_/, '').replaceAll('_', ' ');
export function AssistantPanel({ controller: a, open, onOpenChange, trigger, projectName, onSettings }: Props) {
  const dock = useDock(), narrow = !dock.desktop;
  const [deleting, setDeleting] = useState(false), [showHistory, setShowHistory] = useState(false), [count, setCount] = useState(40), [atBottom, setAtBottom] = useState(true);
  const title = useRef<HTMLHeadingElement>(null), scroll = useRef<HTMLDivElement>(null), input = useRef<HTMLTextAreaElement>(null), following = useRef(true), earlierHeight = useRef<number | null>(null);
  const lastScroll = useRef<{ element: HTMLDivElement; top: number } | null>(null);
  const followLatest = () => { following.current = true; lastScroll.current = null; };
  useLayoutEffect(() => { setDeleting(false); setCount(40); followLatest(); earlierHeight.current = null; setAtBottom(true); }, [a.conversation?.id]);
  useLayoutEffect(() => {
    const element = scroll.current; if (!element) return;
    // Native scroll events can follow a React layout commit. Respect an upward
    // move already present in the DOM before following newly rendered content.
    const previous = lastScroll.current;
    if (following.current && previous?.element === element && element.scrollTop < previous.top - 1 && element.scrollHeight - element.scrollTop - element.clientHeight >= 60) {
      following.current = false; setAtBottom(false);
    }
    if (earlierHeight.current !== null) { element.scrollTop += element.scrollHeight - earlierHeight.current; earlierHeight.current = null; }
    else if (following.current) element.scrollTop = element.scrollHeight;
    lastScroll.current = { element, top: element.scrollTop };
  }, [a.conversation?.turns, a.approvals, a.working, a.error, a.connectionError, deleting, showHistory, count, open, narrow]);
  useLayoutEffect(() => { const element = input.current; if (element) { element.style.height = 'auto'; element.style.height = `${Math.min(element.scrollHeight, 160)}px`; } }, [a.draft, open]);
  const active = a.status?.active, here = !!active && active.conversationId === a.conversation?.id;
  const reviews = a.approvals.filter(review => review.conversationId === a.conversation?.id);
  const lastTurn = a.conversation?.turns.at(-1);
  const toolEvents = here ? a.activity.filter(event => event.runId === active.runId && event.type === 'tool') : [];
  const runningTool = toolEvents.length > (lastTurn?.tools.length ?? 0) ? toolEvents.at(-1)?.tool : undefined;
  const promptBytes = new TextEncoder().encode(a.draft).length, maxBytes = a.status?.limits?.promptBytes ?? 16384;
  const canSend = !a.working && !a.loading && !a.persistence.loading && !a.historyError && !!a.status?.epoch && a.status.configured && a.status.available && !a.status.busy && !!a.draft.trim() && promptBytes <= maxBytes;
  const progress = reviews.length ? 'Waiting for your review' : runningTool ? `Working · ${toolLabel(runningTool)}` : active?.state === 'starting' ? 'Getting started…' : lastTurn?.response ? 'Writing…' : 'Thinking…';
  const send = () => { if (canSend) { followLatest(); setAtBottom(true); input.current?.focus(); void a.send(); } };
  return <Dialog.Root open={open} onOpenChange={onOpenChange} modal={narrow}>
    <Dialog.Portal container={dock.desktop ? dock.hosts.assistant : undefined}>
      {narrow && <Dialog.Overlay className="assistant-scrim" />}
      <Dialog.Content id="assistant-panel" className="assistant-panel" onEscapeKeyDown={event => {
        if (dock.desktop && event.target instanceof Element && !event.target.closest('#assistant-panel')) { event.preventDefault(); return; }
        const menu = document.querySelector<HTMLDetailsElement>('#assistant-panel .dock-menu[open]');
        if (dock.dragging) { event.preventDefault(); dock.setDragging(null); }
        else if (menu) { event.preventDefault(); menu.open = false; menu.querySelector('summary')?.focus(); }
      }} onInteractOutside={event => event.preventDefault()} onOpenAutoFocus={event => { event.preventDefault(); if (!narrow && a.status?.configured) input.current?.focus(); else title.current?.focus(); }} onCloseAutoFocus={event => { event.preventDefault(); trigger.current?.focus(); }}>
        <header className="assistant-header">
          <DockGrip id="assistant" />
          <div className="assistant-identity"><span className="assistant-mark" aria-hidden><Sparkles size={19} /></span><div><Dialog.Title ref={title} tabIndex={-1}>Assistant</Dialog.Title><Dialog.Description title={projectName}>{projectName ?? 'Your next app'}</Dialog.Description></div></div>
          <div className="assistant-header-actions">
            <Button variant="ghost" aria-label="Conversation history" title="Conversation history" aria-expanded={showHistory} aria-controls="assistant-history" onClick={() => setShowHistory(value => !value)}><History aria-hidden /></Button>
            <Button variant="ghost" aria-label="New conversation" title="New conversation" disabled={a.working || a.loading || a.status?.busy || !a.status?.available} onClick={() => { setShowHistory(false); void a.create(); }}><Plus aria-hidden /></Button>
            <DockMenu id="assistant" />
            <Dialog.Close asChild><Button variant="ghost" aria-label="Close assistant" title="Close assistant"><X aria-hidden /></Button></Dialog.Close>
          </div>
        </header>
        {showHistory && <AssistantHistory key={a.projectId ?? 'new'} controller={a} onSelect={() => setShowHistory(false)} onDelete={() => { setDeleting(true); setShowHistory(false); followLatest(); }} />}
        <div className="assistant-conversation">
          <div className="assistant-transcript" ref={scroll} aria-label="Conversation" onScroll={() => { if (scroll.current) { const near = scroll.current.scrollHeight - scroll.current.scrollTop - scroll.current.clientHeight < 60; following.current = near; lastScroll.current = { element: scroll.current, top: scroll.current.scrollTop }; setAtBottom(near); } }}>
            {!a.status || (a.status.configured && a.loading) ? <div className="assistant-loading" role="status"><LoaderCircle className="assistant-spinner" size={18} aria-hidden />Loading conversation…</div> : !a.status.configured ? <section className="assistant-empty"><span className="assistant-empty-mark" aria-hidden><Sparkles size={26} /></span><h3>A little help. A lot of possibility.</h3><p>Build an app, refine a screen, or work through an idea, right beside your preview.</p><Button onClick={() => { onOpenChange(false); onSettings(); }}>Connect assistant<ChevronRight size={16} aria-hidden /></Button><small>Connect your OpenAI key in Settings to get started.</small></section> : !a.conversation?.turns.length && !a.historyError && !a.error && <section className="assistant-empty"><span className="assistant-empty-mark" aria-hidden><Sparkles size={26} /></span><h3>What would you like to build?</h3><p>A fresh idea or a finishing touch.<br />Let’s make your app feel right.</p><div className="assistant-starters">{starters.map(({ title, detail, prompt }) => <button key={title} onClick={() => { a.setDraft(prompt); input.current?.focus(); }} disabled={a.working}><span><strong>{title}</strong><small>{detail}</small></span><ChevronRight size={16} aria-hidden /></button>)}</div></section>}
            {a.conversation && a.conversation.turns.length > count && <Button variant="ghost" onClick={() => { following.current = false; earlierHeight.current = scroll.current?.scrollHeight ?? null; setCount(value => value + 40); }}>Show earlier messages</Button>}
            {a.conversation?.turns.slice(-count).map(turn => <article key={turn.id} className="assistant-turn">
              <div className="assistant-user-message"><h3>You <span className="assistant-mode-tag">{turn.mode === 'plan' ? 'Plan' : 'Build'}</span></h3><p className="assistant-user">{turn.prompt}</p></div>
              {turn.inspector && <small className="assistant-context-tag">Inspector · {turn.inspector.route}</small>}
              <AssistantTasks turn={turn} active={here && turn.id === active?.runId} />
              {turn.images?.map(reference => <details key={`${reference.kind}:${reference.id}`} className="assistant-tool"><summary>{reference.status === 'adapter-accepted' ? 'Image content accepted by provider adapter' : 'Image unavailable or awaiting delivery'}</summary><p>{reference.description}</p><AttachmentImage reference={reference} /></details>)}
              {turn.tools.length > 0 && <details className="assistant-tool"><summary><span>{turn.tools.length} Dunara {turn.tools.length === 1 ? 'action' : 'actions'}</span></summary><ul>{turn.tools.map((tool, index) => <li key={index}><span>{toolLabel(tool.name)}</span><span className="assistant-tool-state" data-state={tool.state}>{tool.state === 'completed' && <Check size={12} aria-hidden />}{tool.state}</span></li>)}</ul></details>}
              {(turn.response || (here && turn.id === active?.runId)) && <div className="assistant-response"><h3><Sparkles size={14} aria-hidden />Assistant</h3>{turn.response && <AssistantMarkdown text={turn.response} />}{here && turn.id === active?.runId ? <div className="assistant-progress" role="status">{reviews.length ? <span className="assistant-waiting-dot" /> : <LoaderCircle className="assistant-spinner" size={14} aria-hidden />}{progress}</div> : turn.response && <CopyMessage text={turn.response} />}</div>}
              {turn.notice && <p className="assistant-turn-notice" data-state={turn.state}>{turn.notice}</p>}
              {turn.id === lastTurn?.id && turn.mode === 'plan' && turn.state === 'completed' && turn.response && <Button variant="outline" className="assistant-build-plan" disabled={a.working || a.status?.busy || !!a.draft.trim()} onClick={() => { a.setMode('build'); a.setDraft('Implement the plan we just discussed. Follow its steps and verify the changes.'); input.current?.focus(); }}><Hammer size={14} aria-hidden />Build this plan</Button>}
              {turn.id === lastTurn?.id && ['cancelled', 'failed', 'interrupted', 'limited'].includes(turn.state) && <Button variant="outline" className="assistant-build-plan" disabled={a.working || a.status?.busy || !!a.draft.trim()} onClick={() => { a.setMode(turn.mode ?? 'build'); a.setDraft(continuationPrompt(turn)); input.current?.focus(); }}><Play size={14} aria-hidden />Continue</Button>}
              {['failed', 'interrupted', 'limited'].includes(turn.state) && <Button variant="ghost" className="assistant-edit-message" disabled={a.working || a.status?.busy || !!a.draft.trim()} onClick={() => { a.setMode(turn.mode ?? 'build'); a.setDraft(turn.prompt); input.current?.focus(); }}>Edit and resend</Button>}
              {!turn.notice && ['failed', 'interrupted', 'cancelled', 'limited'].includes(turn.state) && <p className="assistant-turn-notice">{turn.state === 'cancelled' ? 'Stopped' : 'This response was interrupted.'}</p>}
            </article>)}
            {a.working && !a.status?.busy && <p className="assistant-progress" role="status"><LoaderCircle className="assistant-spinner" size={14} aria-hidden />Updating conversation…</p>}
            {reviews.map(review => <ApprovalCard key={review.id} review={review} busy={a.working} onAnswer={approve => void a.approve(review, approve)} />)}
            {a.status?.busy && !here && <p className="assistant-turn-notice">Assistant is working in another conversation. You can keep writing here and send when it finishes.</p>}
            {deleting && <section className="assistant-confirm" aria-label="Delete local conversation"><h3>Delete this conversation?</h3><p>This removes its saved chat history. Your project files and completed changes remain.</p><div className="assistant-actions"><Button variant="destructive" disabled={a.working} onClick={() => { void a.remove(); setDeleting(false); }}>Permanently delete history</Button><Button variant="outline" onClick={() => setDeleting(false)}>Keep history</Button></div></section>}
            {a.error && <div className="assistant-error" role="alert"><strong>Something went wrong</strong><p>{a.error}</p><small>Your draft is kept. Check the conversation before sending again.</small><Button variant="outline" onClick={() => void a.refresh()}>Refresh conversation</Button></div>}
            {a.connectionError && <div role="status" className="assistant-turn-notice"><p>{a.connectionError}</p><Button variant="ghost" onClick={() => void a.refresh()}>Refresh conversation</Button></div>}
          </div>
          {!atBottom && !reviews.length && !!a.conversation?.turns.length && <Button className="assistant-jump" variant="outline" onClick={() => { followLatest(); setAtBottom(true); scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: 'smooth' }); }}><ArrowDown size={14} aria-hidden />Latest message</Button>}
        </div>
        <footer className="assistant-composer">
          <form className="assistant-input-box" onSubmit={event => { event.preventDefault(); send(); }}>
            <div className="assistant-mode-bar"><div className="assistant-mode-switch" role="group" aria-label="Assistant mode" aria-describedby="assistant-mode-description">
              <button type="button" aria-label="Plan mode" aria-pressed={a.mode === 'plan'} disabled={a.working || a.loading || a.status?.busy} onClick={() => a.setMode('plan')}><ListTodo size={14} aria-hidden />Plan</button>
              <button type="button" aria-label="Build mode" aria-pressed={a.mode === 'build'} disabled={a.working || a.loading || a.status?.busy} onClick={() => a.setMode('build')}><Hammer size={14} aria-hidden />Build</button>
            </div><span id="assistant-mode-description">{a.mode === 'plan' ? 'Explore and plan. No app changes.' : 'Make changes and verify them.'}</span></div>
            <label htmlFor="assistant-message" className="sr-only">Message assistant</label>
            <textarea ref={input} id="assistant-message" rows={2} placeholder={a.status?.configured ? a.status.busy ? 'Write your next message…' : 'Ask anything about your app…' : 'Describe your idea…'} value={a.draft} onChange={event => a.setDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); send(); } }} maxLength={maxBytes} readOnly={a.working || a.loading || a.persistence.loading} aria-describedby="assistant-composer-hint" />
            <div className="assistant-composer-toolbar"><AssistantAttachments key={a.conversation?.id ?? a.projectId ?? 'new'} controller={a} /><span className="assistant-composer-hint" id="assistant-composer-hint">{promptBytes > maxBytes * .8 ? `${promptBytes.toLocaleString()} / ${maxBytes.toLocaleString()} bytes` : 'Enter to send · Shift + Enter for a new line'}</span>{a.status?.busy ? <Button className="assistant-send" variant="outline" aria-label="Stop turn" title="Stop turn" disabled={a.working} onClick={() => void a.stop()}><Square size={16} aria-hidden /></Button> : <Button className="assistant-send" type="submit" aria-label="Send message" title="Send message" disabled={!canSend}><ArrowUp size={18} aria-hidden /></Button>}</div>
          </form>
          <details className="assistant-disclosure"><summary>Draft storage</summary><label className="assistant-review-check"><input type="checkbox" checked={a.persistence.enabled} disabled={!a.persistence.available || a.persistence.loading || a.working} onChange={event => void a.persistence.configure(event.target.checked)} />Remember drafts on this computer</label><p role="status">{a.persistence.notice}</p><p>Unsent text and attachment references are stored privately in Dunara home. Turning this off forgets saved drafts for this Dunara account.</p></details>
          <details className="assistant-disclosure"><summary><span className="assistant-model-dot" data-connected={a.status?.configured || undefined} />{a.status?.model ?? 'Assistant'}<span>Usage & privacy</span></summary><p>Your message, recent context and requested tool results go to OpenAI. Sending may incur charges. Each turn is limited to 40 actions and 10 minutes. Image generation has a separate approval.</p><p>History is saved on this computer. Stop ends the turn; completed changes remain. Messages are never automatically resent.</p></details>
        </footer>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
function ApprovalCard({ review, busy, onAnswer }: { review: AssistantController['approvals'][number]; busy: boolean; onAnswer(approve: boolean): void }) {
  const [reviewed, setReviewed] = useState(false);
  return <section className="assistant-approval" aria-label={`Review ${review.tool}`}><h3>Review required</h3><p><code>{review.tool}</code></p><p>{review.consequence}</p>
    <details open><summary>Exact inputs and current state</summary><pre>{JSON.stringify({ arguments: review.args, review: review.review }, null, 2)}</pre></details>
    <small>One use · expires {new Date(review.expiresAt).toLocaleTimeString()} · revisions rechecked before execution</small>
    <label className="assistant-review-check"><input type="checkbox" checked={reviewed} onChange={event => setReviewed(event.target.checked)} />I reviewed these exact inputs and consequences.</label>
    <div className="assistant-actions"><Button disabled={busy || !reviewed} onClick={() => onAnswer(true)}>Approve this action</Button><Button variant="outline" disabled={busy} onClick={() => onAnswer(false)}>Decline</Button></div>
  </section>;
}
