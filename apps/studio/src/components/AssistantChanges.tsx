import { useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Check, FileDiff, RotateCcw, X } from 'lucide-react';
import type { SourceChangeReview } from '../../../../packages/core/src/source-changes';
import { useStudioClient, type AssistantStatus } from '../api';
import { Button } from './ui/button';
import '../assistant-changes.css';

type FileChange = { path: string; before: string | null; after: string | null; uncertain?: boolean };
type Props = { conversationId: string; runId: string; status: AssistantStatus; working: boolean; onRestore(): Promise<void> };

export function AssistantChanges({ conversationId, runId, status, working, onRestore }: Props) {
  const { api } = useStudioClient();
  const [open, setOpen] = useState(false), [review, setReview] = useState<SourceChangeReview>(), [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [confirmed, setConfirmed] = useState(false);
  const session = useRef({ epoch: status.epoch, accountContext: status.accountContext });
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  const refresh = async () => {
    request.current?.abort(); const controller = new AbortController(); request.current = controller;
    session.current = { epoch: status.epoch, accountContext: status.accountContext };
    setBusy(true); setError(''); setConfirmed(false);
    try {
      const value = await api<SourceChangeReview>('/assistant/changes/review', { conversationId, runId }, controller.signal);
      if (controller.signal.aborted) return;
      setReview(value); setSelected(current => value.changes.some(file => file.path === current) ? current : value.changes[0]?.path ?? '');
    } catch (error) { if (!controller.signal.aborted) { setReview(undefined); setError((error as Error).message); } }
    finally { if (!controller.signal.aborted) setBusy(false); }
  };
  const restore = async () => {
    if (!review?.canRestore || !confirmed || busy || working || status.busy) return;
    const controller = new AbortController(); request.current = controller;
    setBusy(true); setError(''); setConfirmed(false);
    try {
      const value = await api<SourceChangeReview>('/assistant/changes/restore', { conversationId, runId, expectedRevision: review.revision, ...session.current, confirmed: true }, controller.signal);
      if (!controller.signal.aborted) { setReview(value); await onRestore(); }
    } catch (error) { if (!controller.signal.aborted) { setReview(value => value && { ...value, canRestore: false }); setError((error as Error).message); } }
    finally { if (!controller.signal.aborted) setBusy(false); }
  };
  return <Dialog.Root open={open} onOpenChange={value => { if (busy && open) return; setOpen(value); if (value) void refresh(); }}>
    <Dialog.Trigger asChild><Button variant="ghost" className="assistant-review-source" disabled={working || status.busy}><FileDiff size={14} aria-hidden />Review source changes</Button></Dialog.Trigger>
    <Dialog.Portal>
      <Dialog.Overlay className="source-changes-overlay" />
      <Dialog.Content className="source-changes-dialog" onEscapeKeyDown={event => { event.stopPropagation(); if (busy) event.preventDefault(); }} onInteractOutside={event => event.preventDefault()}>
        <header><div><Dialog.Title>Source changes</Dialog.Title><Dialog.Description>Review the app files edited during this Assistant turn.</Dialog.Description></div><Dialog.Close asChild><Button variant="ghost" aria-label="Close source changes" disabled={busy}><X aria-hidden /></Button></Dialog.Close></header>
        <div className="source-changes-body">
          <p className="source-changes-scope">Restore puts these text files back to their first version in this turn and removes files the turn added. Backend operations, media, and build setup keep their own recovery flows.</p>
          {busy && <p role="status">{review ? 'Checking source changes…' : 'Loading source changes…'}</p>}
          {error && <p className="source-changes-error" role="alert">{error}</p>}
          {review?.state === 'restored' && <p className="source-changes-success" role="status"><Check size={16} aria-hidden />This turn’s source changes were restored.</p>}
          {review?.state === 'restoring' && <p role="status">A previous restore was interrupted. Review the remaining files, then finish restoring.</p>}
          {review && review.changes.length === 0 && <p>No managed text edits were recorded for this turn. Older turns have no checkpoint.</p>}
          {!!review?.conflicts.length && <div className="source-changes-conflict" role="alert"><strong>Newer edits need your attention</strong><p>Restore is blocked to preserve current work. Compare these files with the recorded diff, then refresh the review.</p><ul>{review.conflicts.map(file => <li key={file}><code>{file}</code></li>)}</ul></div>}
          {!!review?.changes.length && <><div className="source-changes-files" aria-label="Changed files">{review.changes.map(file => <button key={file.path} aria-pressed={selected === file.path} onClick={() => setSelected(file.path)}><code>{file.path}</code><span>{file.conflict ? 'Conflict' : file.kind === 'added' ? 'Added' : 'Modified'}</span></button>)}</div>
            {selected && <FileDiffView key={`${selected}:${review.revision}`} conversationId={conversationId} runId={runId} path={selected} />}</>}
        </div>
        <footer>
          {review?.canRestore && <label><input type="checkbox" checked={confirmed} disabled={busy || status.busy} onChange={event => setConfirmed(event.target.checked)} />I reviewed these files and want to undo this turn’s source edits.</label>}
          <div><Button variant="outline" disabled={busy || working || status.busy} onClick={() => void refresh()}>Refresh review</Button>
            {review?.state !== 'restored' && <Button disabled={!review?.canRestore || !confirmed || busy || working || status.busy} onClick={() => void restore()}><RotateCcw size={14} aria-hidden />{review?.state === 'restoring' ? 'Finish restoring' : 'Restore this turn'}</Button>}</div>
        </footer>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}

function FileDiffView({ conversationId, runId, path }: { conversationId: string; runId: string; path: string }) {
  const { api } = useStudioClient(), [file, setFile] = useState<FileChange>(), [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    void api<FileChange>('/assistant/changes/file', { conversationId, runId, path }, controller.signal).then(value => { if (!controller.signal.aborted) setFile(value); }).catch(error => { if (!controller.signal.aborted) setError(error.message); });
    return () => controller.abort();
  }, [api, conversationId, runId, path]);
  if (error) return <p role="alert">{error}</p>;
  if (!file) return <p role="status">Loading file diff…</p>;
  const before = file.before?.split('\n') ?? [], after = file.after?.split('\n') ?? [];
  let start = 0, end = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  while (end < before.length - start && end < after.length - start && before[before.length - end - 1] === after[after.length - end - 1]) end++;
  const lines = [...before.slice(Math.max(0, start - 3), start).map(text => ({ type: ' ', text })), ...before.slice(start, before.length - end).map(text => ({ type: '-', text })), ...after.slice(start, after.length - end).map(text => ({ type: '+', text })), ...after.slice(after.length - end, after.length - end + 3).map(text => ({ type: ' ', text }))];
  return <section className="source-changes-diff" aria-label={`Diff for ${path}`}><h3><code>{path}</code></h3><p>− Before this turn · + After this turn</p>
    {file.uncertain && <p role="alert">This write was interrupted. The added lines show its intended result; inspect the current file before continuing.</p>}
    <pre tabIndex={0} aria-label="Source diff">{lines.slice(0, 300).map((line, index) => <span key={index} data-change={line.type}>{line.type} {line.text}{'\n'}</span>)}</pre>
    {lines.length > 300 && <details><summary>Diff shortened. Show full file contents</summary><h4>Before this turn</h4><pre tabIndex={0}>{file.before ?? '(File did not exist)'}</pre><h4>After this turn</h4><pre tabIndex={0}>{file.after ?? '(File did not exist)'}</pre></details>}
  </section>;
}
