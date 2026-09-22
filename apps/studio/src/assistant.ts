import { MEDIA_BYTES, mediaTypeSchema } from '../../../packages/core/src/media-contracts';
import type { MediaState } from './api';
import { useAssistantDraftPersistence } from './assistant-drafts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { type AssistantConversation, type AssistantConversationList, type AssistantPacket, type AssistantStatus, useStudioClient } from './api';
import type { AssistantAttachments, AssistantMode, InspectorAttachment } from '../../../packages/assistant/src/contracts';

export function useAssistant(ready: boolean, projectId: string | null, open: boolean) {
  const { api, streamAssistant, uploadMedia } = useStudioClient();
  const [status, setStatus] = useState<AssistantStatus>(), [conversation, setConversation] = useState<AssistantConversation>(), [history, setHistory] = useState<AssistantConversationList>([]);
  const [approvals, setApprovals] = useState<AssistantPacket['approvals']>([]), [activity, setActivity] = useState<AssistantPacket['events']>([]);
  const [error, setError] = useState(''), [connectionError, setConnectionError] = useState(''), [historyError, setHistoryError] = useState(''), [working, setWorking] = useState(false), [loading, setLoading] = useState(true), [draft, setDraftState] = useState('');
  const scope = projectId ?? 'new', current = useRef(scope), chosen = useRef(new Map<string, string>()), drafts = useRef(new Map<string, string>());
  const desired = useRef<string | undefined>(undefined), generation = useRef(0), mounted = useRef(true), operating = useRef(false), visible = useRef(open), accountVersion = useRef(0);
  const cursor = useRef({ epoch: null as string | null, sequence: 0 }), snapshot = useRef(status);
  current.current = scope; visible.current = open; snapshot.current = status;
  const draftKey = conversation?.id ?? `project:${scope}`;
  const modes = useRef(new Map<string, AssistantMode>()), [, renderMode] = useState(0);
  const mode = modes.current.get(draftKey) ?? conversation?.turns.at(-1)?.mode ?? 'build';
  const setMode = (value: AssistantMode) => { modes.current.set(draftKey, value); renderMode(value => value + 1); };
  const [uploading, setUploading] = useState(false), [attachmentError, setAttachmentError] = useState('');
  const attachmentDrafts = useRef(new Map<string, AssistantAttachments>());
  const [, renderAttachments] = useState(0);
  const attachments = attachmentDrafts.current.get(draftKey) ?? {};
  const setAttachments = (value: AssistantAttachments) => { attachmentDrafts.current.set(draftKey, value); renderAttachments(value => value + 1); };
  const stageInspector = (inspector: InspectorAttachment) => {
    if (inspector.projectId !== current.current) return;
    setAttachments({ ...attachments, inspector });
  };
  const setDraft = (value: string) => { drafts.current.set(draftKey, value); setDraftState(value); };
  const persistence = useAssistantDraftPersistence({ projectId, conversationId: conversation?.id ?? null }, { text: draft, mode, attachments }, ready && open && !loading && !!status?.available, value => {
    drafts.current.set(draftKey, value.text); modes.current.set(draftKey, value.mode); attachmentDrafts.current.set(draftKey, value.attachments);
    setDraftState(value.text); renderMode(value => value + 1); renderAttachments(value => value + 1);
  });
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; }; }, []);
  const refresh = useCallback(async () => {
    const origin = current.current, version = ++generation.current;
    const list = await api<AssistantConversationList>('/assistant/conversations/list', { projectId: origin === 'new' ? null : origin });
    if (!mounted.current || version !== generation.current || current.current !== origin) return;
    const active = snapshot.current?.active;
    const preferred = desired.current ?? chosen.current.get(origin);
    const id = preferred && list.some(item => item.id === preferred) ? preferred : (active?.projectId === (origin === 'new' ? null : origin) ? active.conversationId : list[0]?.id);
    const record = id ? await api<AssistantConversation>('/assistant/conversations/read', { conversationId: id }) : undefined;
    if (!mounted.current || version !== generation.current || current.current !== origin) return;
    if (record && record.projectId !== (origin === 'new' ? null : origin)) {
      chosen.current.delete(origin); desired.current = undefined; setConversation(undefined); setHistory(list); setLoading(false); setDraftState(drafts.current.get(`project:${origin}`) ?? ''); return;
    }
    setHistory(list); setConversation(record); setLoading(false); setHistoryError('');
    if (!record) { chosen.current.delete(origin); desired.current = undefined; }
    if (record) {
      chosen.current.set(origin, record.id); desired.current = record.id;
      // Context staged from another workspace must survive the first history load.
      const stagingKey = `project:${origin}`, stagedDraft = drafts.current.get(stagingKey);
      const stagedMode = modes.current.get(stagingKey);
      if (stagedMode) { modes.current.set(record.id, stagedMode); modes.current.delete(stagingKey); }
      if (stagedDraft !== undefined) {
        const saved = drafts.current.get(record.id);
        drafts.current.set(record.id, saved && saved !== stagedDraft ? `${saved}\n\n${stagedDraft}` : stagedDraft);
        drafts.current.delete(stagingKey);
      }
      const staged = attachmentDrafts.current.get(stagingKey);
      if (staged) {
        attachmentDrafts.current.set(record.id, { ...attachmentDrafts.current.get(record.id), ...staged });
        attachmentDrafts.current.delete(stagingKey);
      }
    }
    setDraftState(drafts.current.get(record?.id ?? `project:${origin}`) ?? '');
  }, []);
  useEffect(() => {
    const changed = () => {
      accountVersion.current++; generation.current++; drafts.current.clear(); attachmentDrafts.current.clear(); modes.current.clear(); chosen.current.clear(); desired.current = undefined;
      persistence.reset(); setAttachmentError(''); setDraftState(''); setConversation(undefined); setApprovals([]); setLoading(true); void refresh();
    };
    window.addEventListener('builder-account-changed', changed);
    return () => window.removeEventListener('builder-account-changed', changed);
  }, [refresh]);
  const refreshSafely = useCallback(async () => {
    const origin = current.current;
    try { await refresh(); }
    catch { if (mounted.current && origin === current.current) { setLoading(false); setHistoryError('Could not load this conversation. Check your connection and try refreshing.'); } }
  }, [refresh]);
  useEffect(() => {
    generation.current++; desired.current = chosen.current.get(scope); setConversation(undefined); setHistory([]); setError(''); setAttachmentError(''); setHistoryError(''); setLoading(true); setDraftState(drafts.current.get(desired.current ?? `project:${scope}`) ?? '');
  }, [scope]);
  useEffect(() => {
    if (ready && open && status?.available) void refreshSafely();
  }, [scope, ready, open, status?.available, refreshSafely]);
  useEffect(() => {
    if (!ready) return;
    let cancelled = false, refreshTimer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const schedule = () => {
      if (refreshTimer || !visible.current) return;
      refreshTimer = setTimeout(() => { refreshTimer = undefined; if (!cancelled) void refreshSafely(); }, 100);
    };
    const receive = (packet: AssistantPacket) => {
      if (cancelled || (packet.epoch === cursor.current.epoch && packet.sequence < cursor.current.sequence)) return;
      if (snapshot.current?.accountContext && packet.status.accountContext !== snapshot.current.accountContext) window.dispatchEvent(new Event('builder-account-changed'));
      const changed = packet.reset || packet.events.length > 0 || packet.status.active?.conversationId !== snapshot.current?.active?.conversationId;
      cursor.current = { epoch: packet.epoch, sequence: packet.sequence }; snapshot.current = packet.status;
      setStatus(packet.status); setApprovals(packet.approvals); setConnectionError('');
      setActivity(previous => (packet.reset ? packet.events : [...previous, ...packet.events]).slice(-512));
      if (changed) schedule();
    };
    const sleep = () => new Promise<void>(resolve => {
      const done = () => { clearTimeout(timer); controller.signal.removeEventListener('abort', done); resolve(); };
      const timer = setTimeout(done, 1500); controller.signal.addEventListener('abort', done, { once: true }); if (controller.signal.aborted) done();
    });
    void (async () => {
      while (!cancelled) {
        try {
          const next = await api<AssistantStatus>('/assistant/status'); if (cancelled) break;
          snapshot.current = next; setStatus(next);
          if (!next.available) { await sleep(); continue; }
          await streamAssistant(cursor.current.sequence, cursor.current.epoch, receive, controller.signal);
        } catch {
          if (!cancelled) {
            setConnectionError('Reconnecting to Assistant… Your messages are saved.');
            try { receive(await api<AssistantPacket>('/assistant/events', { after: cursor.current.sequence, epoch: cursor.current.epoch })); } catch { /* Retry only local event retrieval, never a turn. */ }
          }
        }
        if (!cancelled) await sleep();
      }
    })();
    return () => { cancelled = true; controller.abort(); clearTimeout(refreshTimer); };
  }, [ready, refreshSafely]);
  async function operate(action: () => Promise<void>) {
    if (operating.current) return;
    operating.current = true; setWorking(true); setError(''); const origin = current.current;
    try { await action(); }
    catch (cause) { if (mounted.current && origin === current.current) setError(cause instanceof Error ? cause.message : 'Assistant action failed.'); }
    finally {
      // Keep the composer locked until the operation's selected history arrives.
      // In particular, a new conversation must not accept text into the old draft.
      if (mounted.current) await refreshSafely();
      operating.current = false;
      if (mounted.current) setWorking(false);
    }
  }
  async function addImages(files: File[]) {
    if (operating.current || loading || persistence.loading || !files.length) return;
    setAttachmentError('');
    if (!projectId) { setAttachmentError('Create or select an app first, then drop your images here.'); return; }
    if (files.length + (attachments.images?.length ?? 0) > 2) { setAttachmentError('You can attach up to two images per message. Remove an image or choose fewer files.'); return; }
    if (files.some(file => !mediaTypeSchema.safeParse(file.type).success || !file.size || file.size > MEDIA_BYTES)) {
      setAttachmentError('Choose PNG, JPEG or WebP images, up to 10 MiB each.'); return;
    }
    const origin = projectId, identity = accountVersion.current;
    const stillHere = () => mounted.current && current.current === origin && accountVersion.current === identity;
    await operate(async () => {
      setUploading(true);
      try {
        let library = await api<MediaState>(`/projects/${origin}/media`);
        for (const file of files) {
          if (!stillHere()) return;
          const previousIds = new Set(library.assets.map(asset => asset.id));
          const next = await uploadMedia(origin, { expectedRevision: library.revision, label: file.name.trim().slice(0, 100) || 'Chat image', role: 'other', mediaType: mediaTypeSchema.parse(file.type) }, file);
          if (!stillHere()) return;
          const imported = next.assets.find(asset => !previousIds.has(asset.id));
          if (!imported) throw new Error('Image was saved in Assets but could not be attached. Choose it from existing images.');
          const key = chosen.current.get(origin) ?? draftKey;
          const latest = attachmentDrafts.current.get(key) ?? {};
          if ((latest.images?.length ?? 0) >= 2) throw new Error('Your message already has two images. The uploaded image is saved in Assets.');
          attachmentDrafts.current.set(key, { ...latest, images: [...(latest.images ?? []), { projectId: origin, kind: 'media', id: imported.id }] });
          renderAttachments(value => value + 1);
          library = { ...library, ...next };
        }
      } catch (cause) { if (stillHere()) setAttachmentError(cause instanceof Error ? cause.message : 'Image upload failed. Try again.'); }
      finally { if (mounted.current) setUploading(false); }
    });
  }
  async function create() {
    setAttachmentError('');
    await operate(async () => {
      const origin = current.current;
      const value = await api<AssistantConversation>('/assistant/conversations/create', { projectId: origin === 'new' ? null : origin });
      chosen.current.set(origin, value.id);
      if (current.current === origin) { desired.current = value.id; drafts.current.set(value.id, ''); setLoading(true); }
    });
  }
  function select(id: string) { if (operating.current) return; generation.current++; desired.current = id; chosen.current.set(current.current, id); setConversation(undefined); setDraftState(drafts.current.get(id) ?? ''); setLoading(true); setError(''); setAttachmentError(''); void refreshSafely(); }
  async function send() {
    const origin = current.current, text = draft, originalDraft = draftKey, identity = accountVersion.current;
    if (persistence.loading || !status?.epoch || !status.available || !status.configured || status.busy || loading || historyError || !text.trim() || new TextEncoder().encode(text).length > (status.limits?.promptBytes ?? 16384)) return;
    const epoch = status.epoch;
    setAttachmentError('');
    await operate(async () => {
      let record = conversation;
      if (!record) {
        record = await api<AssistantConversation>('/assistant/conversations/create', { projectId: origin === 'new' ? null : origin });
        chosen.current.set(origin, record.id);
        if (current.current !== origin || accountVersion.current !== identity) throw new Error('Project or account changed before Send. No prompt was submitted.');
        // Move the draft before selecting its new conversation, including on a failed Send.
        drafts.current.set(record.id, text); attachmentDrafts.current.set(record.id, attachments); modes.current.set(record.id, mode); modes.current.delete(originalDraft);
        desired.current = record.id;
      }
      if (current.current !== origin || accountVersion.current !== identity) throw new Error('Project or account changed before Send. No prompt was submitted.');
      await api('/assistant/turns/start', { epoch, accountContext: status.accountContext, turn: { conversationId: record.id, runId: crypto.randomUUID(), mode, prompt: text, attachments } });
      if (accountVersion.current !== identity) return;
      const cleared = persistence.sent({ text, mode, attachments });
      for (const key of new Set([originalDraft, record.id])) if (drafts.current.get(key) === text) { drafts.current.delete(key); attachmentDrafts.current.delete(key); }
      if (current.current === origin) setDraftState(drafts.current.get(record.id) ?? drafts.current.get(originalDraft) ?? '');
      await cleared;
      // Synchronize busy state even when the event stream is using polling fallback.
      try {
        const statusCursor = cursor.current;
        const next = await api<AssistantStatus>('/assistant/status');
        // An event received during this request is newer than its HTTP snapshot.
        if (mounted.current && identity === accountVersion.current && cursor.current === statusCursor) { snapshot.current = next; setStatus(next); }
      } catch { if (mounted.current) setConnectionError('Message sent. Reconnecting to check its progress…'); }
    });
  }
  async function selectModel(provider: string, model: string) {
    await operate(async () => { const next = await api<AssistantStatus>('/assistant/configure', { action: 'model', provider, model }); if (mounted.current) { setStatus(next); snapshot.current = next; } });
  }
  async function selectReasoning(reasoningEffort: NonNullable<AssistantStatus['reasoningEffort']>) {
    await operate(async () => { const next = await api<AssistantStatus>('/assistant/configure', { action: 'reasoning', reasoningEffort }); if (mounted.current) { setStatus(next); snapshot.current = next; } });
  }
  async function stop() {
    const active = status?.active; if (!active) return;
    await operate(async () => { await api('/assistant/turns/stop', { epoch: active.epoch, conversationId: active.conversationId, runId: active.runId }); });
  }
  async function remove() {
    const record = conversation; if (!record) return;
    const origin = current.current;
    await operate(async () => {
      await api('/assistant/conversations/delete', { conversationId: record.id, confirmed: true });
      chosen.current.delete(origin); drafts.current.delete(record.id); attachmentDrafts.current.delete(record.id); modes.current.delete(record.id);
      if (current.current === origin) { desired.current = undefined; setConversation(undefined); }
    });
  }
  async function approve(review: AssistantPacket['approvals'][number], approve: boolean) {
    await operate(async () => { await api('/assistant/approvals', { id: review.id, epoch: review.epoch, runId: review.runId, conversationId: review.conversationId, projectId: review.projectId, approve }); });
  }
  return { selectModel, selectReasoning, status, conversation, history, approvals, activity, error, connectionError: historyError || connectionError, historyError, loading, working, uploading, attachmentError, addImages, persistence, draft, setDraft, mode, setMode, attachments, setAttachments, stageInspector, projectId, create, select, send, stop, remove, approve, refresh: refreshSafely };
}
export type AssistantController = ReturnType<typeof useAssistant>;
