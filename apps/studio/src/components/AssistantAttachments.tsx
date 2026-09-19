import { useEffect, useRef, useState } from 'react';
import { type MediaState, type StudioState, useStudioClient } from '../api';
import type { AssistantController } from '../assistant';
import type { ImageReference } from '../../../../packages/assistant/src/contracts';
import { Paperclip, X } from 'lucide-react';
import { Button } from './ui/button';

type Choice = ImageReference & { label: string };
export function AssistantAttachments({ controller: a }: { controller: AssistantController }) {
  const { api } = useStudioClient();
  const [choices, setChoices] = useState<Choice[]>([]), [error, setError] = useState(''), [loading, setLoading] = useState(false);
  const [loadedProject, setLoadedProject] = useState<string | null>(null);
  const inspector = a.attachments.inspector, selected = a.attachments.images ?? [];
  const currentChoices = loadedProject === a.projectId ? choices : [];
  const [expanded, setExpanded] = useState(!!inspector || selected.length > 0);
  const picker = useRef<HTMLDetailsElement>(null);
  useEffect(() => { if (inspector) setExpanded(true); }, [inspector]);
  useEffect(() => {
    if (!expanded) return;
    const close = (event: PointerEvent) => { if (event.target instanceof Node && !picker.current?.contains(event.target)) setExpanded(false); };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [expanded]);
  async function load() {
    const projectId = a.projectId; if (!projectId) return;
    setLoading(true); setError('');
    try {
      const [state, media] = await Promise.all([api<StudioState>(`/projects/${projectId}`), api<MediaState>(`/projects/${projectId}/media`)]);
      setChoices([...state.captures.map(capture => ({ projectId, kind: 'capture' as const, id: capture.id, label: `${capture.route} · ${capture.viewport} · ${capture.createdAt}` })), ...media.assets.map(asset => ({ projectId, kind: 'media' as const, id: asset.id, label: asset.label }))]); setLoadedProject(projectId);
    } catch { setError('Image list unavailable. No capture or provider request was made.'); } finally { setLoading(false); }
  }
  return <details ref={picker} className="assistant-attachments" open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}><summary title="Attachments" aria-label="Attachments"><Paperclip size={17} aria-hidden />{inspector || selected.length ? <span>{selected.length + (inspector ? 1 : 0)}</span> : null}</summary><div className="assistant-attachment-picker"><strong>Add context</strong>
    {inspector && <section aria-label="Staged Inspector context"><strong>Inspector · {inspector.selection.pathname}</strong><p>Selected element · {inspector.selection.pathname}</p><details><summary>Review sanitized selection</summary><pre>{JSON.stringify(inspector.selection, null, 2)}</pre></details><Button variant="ghost" disabled={a.working} onClick={() => a.setAttachments({ images: selected })}>Remove Inspector context</Button></section>}
    {selected.map(reference => <section key={`${reference.kind}:${reference.id}`}><AttachmentImage reference={reference} /><small>{reference.kind === 'board' ? 'Saved screen' : reference.kind === 'capture' ? 'Preview screenshot' : 'Project image'}</small><Button variant="ghost" disabled={a.working} onClick={() => a.setAttachments({ ...a.attachments, images: selected.filter(item => item.id !== reference.id || item.kind !== reference.kind) })} aria-label="Remove image" title="Remove image"><X size={14} aria-hidden /></Button></section>)}
    {a.projectId && <><Button variant="ghost" disabled={loading || a.working || a.loading} onClick={() => void load()}>{loading ? 'Loading images…' : 'Choose existing images'}</Button>{loadedProject === a.projectId && <label>Attach image<select aria-label="Attach image" value="" disabled={a.working || selected.length >= 2 || !currentChoices.length} onChange={event => { const choice = currentChoices.find(item => `${item.kind}:${item.id}` === event.target.value); if (choice && selected.length < 2) a.setAttachments({ ...a.attachments, images: [...selected, { projectId: choice.projectId, kind: choice.kind, id: choice.id }] }); }}><option value="">Choose a capture or media asset</option>{currentChoices.filter(choice => !selected.some(item => item.id === choice.id && item.kind === choice.kind)).map(choice => <option key={`${choice.kind}:${choice.id}`} value={`${choice.kind}:${choice.id}`}>{choice.kind} · {choice.label}</option>)}</select></label>}{loadedProject === a.projectId && !currentChoices.length && <p>No images yet. Capture your preview or add an image in Assets.</p>}</>}
    {error && <p role="alert">{error}</p>}<p className="assistant-attachment-hint">{a.projectId ? 'Up to two project images. Sent with your next message.' : 'Select a project to attach screenshots or images.'}</p></div>
  </details>;
}
export function AttachmentImage({ reference }: { reference: ImageReference }) {
  const { image, boardImage, mediaImage } = useStudioClient();
  const [state, setState] = useState<{ key: string; url?: string; error?: string }>();
  const key = `${reference.projectId}:${reference.kind}:${reference.id}`;
  useEffect(() => {
    let alive = true, url = '';
    void (reference.kind === 'capture' ? image : reference.kind === 'board' ? boardImage : mediaImage)(reference.projectId, reference.id).then(value => { url = value; if (alive) setState({ key, url }); else URL.revokeObjectURL(value); }).catch(() => { if (alive) setState({ key, error: 'Visual review blocked: image unavailable or expired.' }); });
    return () => { alive = false; if (url) URL.revokeObjectURL(url); };
  }, [key, reference.projectId, reference.kind, reference.id]);
  return state?.key === key && state.url ? <img className="assistant-attachment-image" src={state.url} alt={`Attached ${reference.kind}`} /> : <p>{state?.key === key && state.error ? state.error : 'Loading local image…'}</p>;
}
