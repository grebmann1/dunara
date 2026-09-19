import { useState } from 'react';
import type { MediaState } from '../api';
import type { Brief } from '../../../../packages/core/src/media-contracts';
import { Button } from './ui/button';
import { Label } from './ui/label';
import { Textarea } from './ui/textarea';

export type BriefDraft = { value: Brief; base: string | null };
export function BriefForm({ data, save, disabled, savedDraft, onDraft, onClose }: { data: MediaState; save: (action: string, input: unknown) => Promise<boolean>; disabled: boolean; savedDraft?: BriefDraft; onDraft: (draft: BriefDraft | undefined) => void; onClose: () => void }) {
  const [draft, setLocalDraft] = useState(savedDraft);
  const setDraft = (value: BriefDraft | undefined) => { setLocalDraft(value); onDraft(value); };
  const brief = draft?.value ?? data.brief, conflict = !!draft && draft.base !== data.revision;
  const update = (patch: Partial<Brief>) => setDraft({ value: { ...brief, ...patch }, base: draft ? draft.base : data.revision });
  return <form className="media-card" onSubmit={e => { e.preventDefault(); if (draft) void save('brief', { expectedRevision: draft.base, brief: draft.value }).then(ok => { if (ok) setDraft(undefined); }); }}>
    <div className="asset-section-heading"><h2>Art direction</h2><Button variant="ghost" onClick={onClose}>Close art direction</Button></div>
    <p>Your app’s visual direction. Included in generation prompts when “Match my app’s art direction” is on; image references are selected separately.</p>
    <fieldset disabled={disabled}><div className="media-fields">{(['audience', 'purpose', 'mood', 'palette', 'imageStyle', 'avoid'] as const).map(key => <Label key={key}>{({ audience: 'Audience', purpose: 'Purpose', mood: 'Mood', palette: 'Palette', imageStyle: 'Image style', avoid: 'Things to avoid' })[key]}<Textarea maxLength={1000} rows={2} value={brief[key]} onChange={e => update({ [key]: e.target.value })} /></Label>)}</div>
    <div className="media-checks"><p>Approved direction references · {brief.referenceIds.length} of 10 selected</p>{data.assets.filter(a => a.status === 'approved').map(a => <Label key={a.id}><input type="checkbox" checked={brief.referenceIds.includes(a.id)} disabled={!brief.referenceIds.includes(a.id) && brief.referenceIds.length >= 10} onChange={e => update({ referenceIds: e.target.checked ? [...brief.referenceIds, a.id] : brief.referenceIds.filter(id => id !== a.id) })} />{a.label}</Label>)}</div>
    {conflict && <div role="alert">Library changed. Your brief draft is preserved. Review the latest saved direction before applying.<details><summary>Latest saved direction</summary><pre>{JSON.stringify(data.brief, null, 2)}</pre></details><Button variant="outline" onClick={() => setDraft({ value: brief, base: data.revision })}>Review brief against latest revision</Button></div>}
    <div className="media-actions"><Button type="submit" disabled={!draft || conflict}>Save brief</Button><Button variant="outline" disabled={!draft} onClick={() => setDraft(undefined)}>Discard brief draft</Button></div></fieldset>
  </form>;
}
