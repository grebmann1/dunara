import { useEffect, useRef, useState } from 'react';
import type { AssistantDrafts } from '../../../packages/assistant/src/drafts';
import type { WorkspaceDraft } from '../../../packages/core/src/workspace-draft-contracts';
import { useStudioClient } from './api';

type Snapshot = ReturnType<AssistantDrafts['readWorkspace']>;
type Entry = { value: WorkspaceDraft; snapshot: Snapshot; tail: Promise<void>; failed: boolean };
export function useWorkspaceDrafts(projectId: string, ready: boolean) {
  const { api } = useStudioClient();
  const entries = useRef(new Map<string, Entry>()), identity = useRef(0), active = useRef(projectId);
  const [version, render] = useState(0), [notice, setNotice] = useState('');
  active.current = projectId;
  useEffect(() => {
    const reset = () => { identity.current++; entries.current.clear(); setNotice(''); render(v => v + 1); };
    const preference = () => {
      const account = identity.current;
      for (const [id, item] of entries.current) {
        item.failed = true;
        item.tail = item.tail.then(async () => {
          try {
            const snapshot = await api<Snapshot>('/workspace-drafts/read', { projectId: id });
            if (account !== identity.current) return;
            item.snapshot = snapshot;
            if (snapshot.enabled) item.snapshot = await api<Snapshot>('/workspace-drafts/save', { projectId: id, update: { context: snapshot.context, preferenceRevision: snapshot.preferenceRevision, expectedRevision: snapshot.revision, value: item.value } });
            if (account !== identity.current) return;
            item.failed = false;
            if (active.current === id) setNotice(snapshot.enabled ? 'Unfinished work saved.' : 'Saved creative drafts forgotten. Current edits stay in this session.');
          } catch { if (account === identity.current && active.current === id) setNotice('Could not update draft storage. Current edits stay in this session.'); }
        });
      }
    };
    window.addEventListener('builder-account-changed', reset);
    window.addEventListener('builder-draft-preference-changed', preference);
    return () => { window.removeEventListener('builder-account-changed', reset); window.removeEventListener('builder-draft-preference-changed', preference); };
  }, []);
  useEffect(() => {
    if (!ready || !projectId || entries.current.has(projectId)) return;
    let cancelled = false; const account = identity.current;
    setNotice('Restoring unfinished work…');
    void api<Snapshot>('/workspace-drafts/read', { projectId }).then(snapshot => {
      if (cancelled || account !== identity.current) return;
      entries.current.set(projectId, { value: snapshot.value ?? {}, snapshot, tail: Promise.resolve(), failed: false });
      setNotice(snapshot.enabled ? snapshot.value ? 'Unfinished work restored.' : 'Creative drafts will be remembered.' : 'Creative drafts last for this session. Enable Remember drafts in Settings to keep them.'); render(v => v + 1);
    }).catch(() => {
      if (cancelled || account !== identity.current) return;
      entries.current.set(projectId, { value: {}, snapshot: { context: '', enabled: false, preferenceRevision: null, revision: null, value: null }, tail: Promise.resolve(), failed: true });
      setNotice('Draft storage unavailable. Edits stay in this session; reopen the app to retry.'); render(v => v + 1);
    });
    return () => { cancelled = true; };
  }, [projectId, ready, version, api]);
  function update(patch: Partial<WorkspaceDraft>) {
    const target = entries.current.get(projectId); if (!target) return;
    const next = { ...target.value, ...patch };
    if (JSON.stringify(next) === JSON.stringify(target.value)) return;
    target.value = next;
    if (!target.snapshot.enabled || target.failed) return;
    setNotice('Saving unfinished work…');
    const account = identity.current;
    // Queue immediately, including the last keystroke before navigation. Each
    // write uses the revision acknowledged by the preceding write.
    target.tail = target.tail.then(async () => {
      if (account !== identity.current || target.failed) return;
      try {
        target.snapshot = await api<Snapshot>('/workspace-drafts/save', { projectId, update: { context: target.snapshot.context, preferenceRevision: target.snapshot.preferenceRevision, expectedRevision: target.snapshot.revision, value: next } });
        if (account === identity.current && active.current === projectId) setNotice('Unfinished work saved.');
      } catch {
        target.failed = true;
        if (account === identity.current && active.current === projectId) setNotice('Could not save: storage or another session changed. Your edits remain here. Copy unfinished text before reopening.');
      }
    });
  }
  return { loaded: !!entries.current.get(projectId), get value() { return entries.current.get(projectId)?.value ?? {}; }, update, notice };
}
