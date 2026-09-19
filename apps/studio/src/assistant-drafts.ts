import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useStudioClient } from './api';
import type { DraftScope, DraftSnapshot, DraftValue } from '../../../packages/assistant/src/drafts';

type Entry = { snapshot: DraftSnapshot; scope: DraftScope; tail: Promise<void>; saved: string; failed: boolean; desired: string };
const keyFor = (scope: DraftScope) => `${scope.projectId ?? 'new'}:${scope.conversationId ?? 'new'}`;
export function useAssistantDraftPersistence(scope: DraftScope, value: DraftValue, ready: boolean, restore: (value: DraftValue) => void) {
  const { api } = useStudioClient();
  const key = keyFor(scope), encoded = JSON.stringify(value);
  const entries = useRef(new Map<string, Entry>()), latest = useRef({ key, value, restore }), mounted = useRef(true);
  const [version, render] = useState(0), [notice, setNotice] = useState(''), [loading, setLoading] = useState(false), [preference, setPreference] = useState<boolean>();
  latest.current = { key, value, restore };
  const entry = entries.current.get(key);
  function notify(message: string, target = key) { if (mounted.current && latest.current.key === target) { setNotice(message); render(version => version + 1); } }
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  // Close the editable frame between history becoming ready and its draft read.
  // Otherwise the first keystroke can land just as the composer becomes read-only.
  useLayoutEffect(() => { setLoading(ready && !entries.current.has(key)); }, [key, ready, version]);
  useEffect(() => {
    if (!ready) { if (entries.current.get(key)?.failed) entries.current.delete(key); return; }
    if (entries.current.has(key)) return;
    let cancelled = false;
    const initial = JSON.stringify(latest.current.value); setLoading(true);
    void api<DraftSnapshot>('/assistant/drafts/read', { scope }).then(snapshot => {
      if (cancelled) return;
      const current = latest.current.value;
      const changed = initial !== JSON.stringify(current);
      const localContent = !!current.text || !!current.attachments.inspector || !!current.attachments.images?.length;
      const conflict = !!snapshot.value && (changed || localContent) && JSON.stringify(snapshot.value) !== JSON.stringify(current);
      entries.current.set(key, { snapshot, scope, tail: Promise.resolve(), saved: JSON.stringify(snapshot.value ?? current), failed: conflict, desired: JSON.stringify(snapshot.value ?? current) });
      if (snapshot.value && !conflict) { latest.current.restore(snapshot.value); setNotice(snapshot.notice ?? 'Draft restored. Review before sending.'); }
      else setNotice(conflict ? 'A saved draft differs from your current text. Current text was kept. Turn remembering off to forget saved drafts before saving this text.' : snapshot.enabled ? 'Draft saving is on. Nothing is sent automatically.' : 'Drafts last for this session.');
      render(value => value + 1);
    }).catch(() => { if (!cancelled) setNotice('Draft storage is unavailable. Current text stays in this session.'); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  // Scope changes are represented by the stable key.
  }, [key, ready, version]);
  function save(target: Entry, next: DraftValue) {
    if (!target.snapshot.enabled || target.failed) return target.tail;
    target.desired = JSON.stringify(next);
    target.tail = target.tail.then(async () => {
      if (!target.snapshot.enabled || target.failed || target.desired !== JSON.stringify(next) || target.saved === JSON.stringify(next)) return;
      try {
        target.snapshot = await api<DraftSnapshot>('/assistant/drafts/save', { scope: target.scope, update: { context: target.snapshot.context, preferenceRevision: target.snapshot.preferenceRevision, expectedRevision: target.snapshot.revision, value: next } });
        target.saved = JSON.stringify(next); if (entries.current.get(keyFor(target.scope)) === target) notify('Draft saved on this computer. Never sent automatically.', keyFor(target.scope));
      } catch { target.failed = true; if (entries.current.get(keyFor(target.scope)) === target) notify('Draft could not be saved because storage or account changed. Current text was kept. Reopen the assistant to review saved content.', keyFor(target.scope)); }
    });
    return target.tail;
  }
  useEffect(() => {
    const target = entries.current.get(key);
    if (!ready || !target?.snapshot.enabled || target.failed || target.saved === encoded) return;
    let flushed = false;
    const flush = () => { if (!flushed) { flushed = true; void save(target, JSON.parse(encoded) as DraftValue); } };
    const timer = setTimeout(flush, 250);
    // Navigation flushes this scope; writes serialize behind its last acknowledged revision.
    return () => { clearTimeout(timer); if (!mounted.current || latest.current.key !== key) flush(); };
  }, [key, encoded, ready, version]);
  async function configure(enabled: boolean) {
    const target = entries.current.get(key); if (!target || preference !== undefined) return;
    setPreference(enabled);
    try {
      await target.tail;
      if (entries.current.get(key) !== target) return;
      const snapshot = await api<DraftSnapshot>('/assistant/drafts/configure', { scope, update: { context: target.snapshot.context, preferenceRevision: target.snapshot.preferenceRevision, enabled } });
      if (entries.current.get(key) !== target) return;
      for (const item of entries.current.values()) {
        item.snapshot = { ...item.snapshot, enabled, preferenceRevision: snapshot.preferenceRevision, ...(!enabled ? { revision: null, value: null } : {}) }; item.failed = false;
      }
      target.snapshot = snapshot; target.saved = ''; notify(enabled ? 'Saving drafts on this computer.' : 'Saved drafts forgotten. Current text remains in this session.');
      if (enabled) await save(target, latest.current.value);
    } catch { notify('Draft preference could not be changed. Current text was kept.'); }
    finally { if (mounted.current) setPreference(undefined); }
  }
  // Call after an accepted send: preserve newer edits, then durably clear only the sent text.
  async function sent(sentValue: DraftValue) {
    const target = entries.current.get(key); if (!target || !target.snapshot.enabled) return;
    const current = latest.current.value;
    if (JSON.stringify(current) !== JSON.stringify(sentValue)) return;
    await save(target, { ...sentValue, text: '', attachments: {} });
  }
  function reset() { for (const item of entries.current.values()) item.failed = true; entries.current.clear(); render(version => version + 1); }
  return { enabled: preference ?? entry?.snapshot.enabled ?? false, available: !!entry && preference === undefined, loading, notice, configure, sent, reset };
}
