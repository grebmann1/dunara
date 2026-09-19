import { useEffect, useState } from 'react';
import { Download, Trash2 } from 'lucide-react';
import { type AssistantConversationList, useStudioClient } from '../api';
import type { AssistantController } from '../assistant';
import { conversationFilename, conversationMarkdown } from '../assistant-history';
import { Button } from './ui/button';

export function AssistantHistory({ controller: a, onSelect, onDelete }: { controller: AssistantController; onSelect(): void; onDelete(): void }) {
  const { api } = useStudioClient();
  const [query, setQuery] = useState(''), [matches, setMatches] = useState<AssistantConversationList>([]), [loading, setLoading] = useState(false), [error, setError] = useState('');
  const search = query.trim();
  useEffect(() => {
    setError('');
    if (!search) { setLoading(false); return; }
    const controller = new AbortController();
    setLoading(true);
    const timer = setTimeout(() => {
      void api<AssistantConversationList>('/assistant/conversations/list', { projectId: a.projectId, query: search }, controller.signal)
        .then(value => { if (!controller.signal.aborted) setMatches(value); })
        .catch(() => { if (!controller.signal.aborted) { setMatches([]); setError('Could not search conversations. Try again.'); } })
        .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, 200);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [search, a.projectId, a.history.length, a.status?.busy]);
  const items = search ? matches : a.history;
  const selected = items.some(item => item.id === a.conversation?.id) ? a.conversation?.id : '';
  function download() {
    if (!a.conversation) return;
    const url = URL.createObjectURL(new Blob([conversationMarkdown(a.conversation)], { type: 'text/markdown;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = conversationFilename(a.conversation); link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <section id="assistant-history" className="assistant-history" aria-label="Saved conversations">
    <div className="assistant-section-label"><span>Conversations</span><small>Saved on this computer</small></div>
    <label className="sr-only" htmlFor="assistant-history-search">Search conversations</label>
    <input id="assistant-history-search" type="search" value={query} onChange={event => setQuery(event.target.value)} maxLength={200} placeholder="Search messages and plans…" />
    <div className="assistant-history-picker"><label className="sr-only" htmlFor="assistant-history-select">Select conversation</label>
      <select id="assistant-history-select" value={selected ?? ''} disabled={a.working || a.loading || loading || !items.length} onChange={event => { a.select(event.target.value); onSelect(); }}>
        <option value="" disabled>{items.length ? 'Choose a conversation' : search ? 'No matching conversations' : 'No conversations yet'}</option>
        {items.map(item => <option value={item.id} key={item.id}>{item.title}</option>)}
      </select>
      <Button variant="ghost" aria-label="Delete conversation" title="Delete conversation" disabled={!selected || a.working || a.status?.busy} onClick={onDelete}><Trash2 aria-hidden /></Button>
    </div>
    <div className="assistant-history-footer"><span role="status">{error || (loading ? 'Searching…' : `${items.length} ${items.length === 1 ? 'conversation' : 'conversations'}`)}</span>
      <Button variant="ghost" aria-label="Export conversation" title="Download the current conversation as Markdown" disabled={!a.conversation?.turns.length || a.loading || a.working} onClick={download}><Download size={14} aria-hidden />Export chat</Button>
    </div>
  </section>;
}
