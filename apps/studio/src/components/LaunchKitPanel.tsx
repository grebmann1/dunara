import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { type MediaState, type StudioState, useStudioClient } from '../api';
import { launchKitCreateSchema, kitLimitations, type LaunchKit, type LaunchKitCreate } from '../../../../packages/core/src/launch-kit-contracts';
import { Thumbnail } from './DiagnosticsPanel';
import { AssetImage } from './AssetImage';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Textarea } from './ui/textarea';
import { FieldSelect } from './ui/field-select';

export type LaunchKitDraft = { captureIds: string[]; iconId: string; name: string; summary: string; description: string; supportUrl: string; privacyUrl: string; attribution: string };
export function LaunchKitPanel({ projectId, state, media, active, savedDraft, onDraft }: { projectId: string; state?: StudioState; media: MediaState; active: boolean; savedDraft?: LaunchKitDraft; onDraft: (draft: LaunchKitDraft) => void }) {
  const { api, kitDownload } = useStudioClient();
  const [draft, setDraft] = useState<LaunchKitDraft>(() => savedDraft ?? { captureIds: [], iconId: '', name: state?.project.name ?? '', summary: '', description: '', supportUrl: '', privacyUrl: '', attribution: '' });
  const [kits, setKits] = useState<LaunchKit[]>([]), [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false);
  const [review, setReview] = useState<LaunchKitCreate>(), [confirmed, setConfirmed] = useState(false), [deleting, setDeleting] = useState('');
  const alive = useRef(true), operating = useRef(false), sequence = useRef(0);
  const reviewButton = useRef<HTMLButtonElement>(null), history = useRef<HTMLHeadingElement>(null), reviewHeading = useRef<HTMLHeadingElement>(null);
  const endpoint = `/projects/${projectId}/launch-kits`;
  useLayoutEffect(() => { if (review) reviewHeading.current?.focus(); }, [review]);
  const refresh = useCallback(async () => {
    const version = ++sequence.current;
    const result = await api<{ kits: LaunchKit[] }>(`/projects/${projectId}/launch-kits`);
    if (alive.current && version === sequence.current) setKits(result.kits);
  }, [projectId]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; sequence.current++; }; }, []);
  useEffect(() => {
    if (!active) return;
    const reload = () => { if (!operating.current) void refresh().catch(e => { if (alive.current) setError(e.message); }); };
    reload(); const timer = setInterval(reload, 4000); return () => { clearInterval(timer); sequence.current++; };
  }, [active, refresh]);
  const captures = state?.captures ?? [];
  const missing = draft.captureIds.filter(id => !captures.some(c => c.id === id));
  const icon = media.assets.find(a => a.id === draft.iconId);
  const icons = media.assets.filter(a => a.status === 'approved' && a.width === 1024 && a.height === 1024 && !a.transparent);
  const stale = !!review?.icon && review.icon.expectedRevision !== media.revision;
  useEffect(() => { setConfirmed(false); }, [media.revision]);
  function update(patch: Partial<LaunchKitDraft>) {
    const next = { ...draft, ...patch }; setDraft(next); onDraft(next); setReview(undefined); setConfirmed(false);
  }
  async function perform(operation: () => Promise<void>) {
    if (operating.current) return;
    operating.current = true; sequence.current++; setBusy(true); setError(''); setNotice('');
    try { await operation(); }
    catch (e) { if (alive.current) setError(e instanceof Error ? e.message : 'Launch Kit operation failed'); }
    finally { operating.current = false; if (alive.current) setBusy(false); }
  }
  function prepare() {
    const parsed = launchKitCreateSchema.safeParse({ captureIds: draft.captureIds, ...(draft.iconId ? { icon: { assetId: draft.iconId, expectedRevision: media.revision } } : {}), listing: { name: draft.name, summary: draft.summary, description: draft.description, ...(draft.supportUrl ? { supportUrl: draft.supportUrl } : {}), ...(draft.privacyUrl ? { privacyUrl: draft.privacyUrl } : {}) }, attribution: draft.attribution, confirmed: true });
    if (!parsed.success) { setError(parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')); return; }
    setError(''); setReview(parsed.data); setConfirmed(false);
  }
  return <section hidden={!active} className="launch-kit-panel" aria-label="Launch Kit">
    <header><h2>Launch Kit</h2><p>Keep reviewed web captures and listing drafts as immutable local files. No preview needed to read a saved kit.</p></header>
    <p className="muted">React Native Web — not native App Store screenshots. Fresh-context captures do not reproduce the visible phone’s input or storage state, or prove current source revision.</p>
    {error && <p role="alert" className="error-banner">{error}</p>}<p role="status">{busy ? 'Working…' : notice}</p>
    <fieldset disabled={busy} className="kit-draft">
      <section className="media-card"><h3>1 · Select 1–10 existing captures</h3><p>Review the exact image, route, viewport and capture time. Missing captures require deliberate recapture and review in Preview.</p>
        {missing.length > 0 && <div role="alert"><p>{missing.length} selected capture(s) expired or are unavailable. No replacement is selected automatically.</p><Button variant="outline" onClick={() => update({ captureIds: draft.captureIds.filter(id => !missing.includes(id)) })}>Clear unavailable selections</Button></div>}
        {!captures.length && <p>No retained captures. Capture a route in Preview first.</p>}
        <div className="kit-captures">{captures.map(c => <div key={c.id} className="kit-capture"><Label><input type="checkbox" checked={draft.captureIds.includes(c.id)} disabled={!draft.captureIds.includes(c.id) && draft.captureIds.length >= 10} onChange={e => update({ captureIds: e.target.checked ? [...draft.captureIds, c.id] : draft.captureIds.filter(id => id !== c.id) })} />Select {c.route} · {c.viewport}</Label><Thumbnail projectId={projectId} id={c.id} label={`${c.route} · ${c.width} × ${c.height} · ${c.createdAt}`} /><p>{c.bytes.toLocaleString()} bytes · React Native Web</p><code>{c.id}</code></div>)}</div>
      </section>
      <section className="media-card"><h3>2 · Optional approved icon master</h3><FieldSelect label="Launch Kit icon" value={draft.iconId || 'none'} onValueChange={value => update({ iconId: value === 'none' ? '' : value })} options={[{ value: 'none', label: 'No icon' }, ...icons.map(a => ({ value: a.id, label: a.label }))]} />
        {draft.iconId && !icons.some(a => a.id === draft.iconId) && <p role="alert">Selected icon is no longer an approved opaque 1024 × 1024 master. Select again.</p>}
        {icon && <div className="kit-icon"><AssetImage projectId={projectId} asset={icon} /><p>{icon.label} · {icon.status} · {icon.width} × {icon.height}</p><p>{icon.rightsNote || 'No rights note supplied.'}</p></div>}
      </section>
      <section className="media-card"><h3>3 · Listing and attribution drafts</h3><p>Plain text only, 32 KiB listing limit. Do not include private paths, credentials or unsupported marketing claims. URLs are validated, never fetched.</p>
        <Label>Listing name<Input maxLength={100} value={draft.name} onChange={e => update({ name: e.target.value })} /></Label>
        <Label htmlFor={`kit-summary-${projectId}`}>Short summary</Label><Textarea id={`kit-summary-${projectId}`} maxLength={500} value={draft.summary} onChange={e => update({ summary: e.target.value })} />
        <Label htmlFor={`kit-description-${projectId}`}>Description draft</Label><Textarea id={`kit-description-${projectId}`} maxLength={32768} rows={5} value={draft.description} onChange={e => update({ description: e.target.value })} />
        <Label>Support URL (optional)<Input type="url" value={draft.supportUrl} onChange={e => update({ supportUrl: e.target.value })} /></Label>
        <Label>Privacy URL (optional)<Input type="url" value={draft.privacyUrl} onChange={e => update({ privacyUrl: e.target.value })} /></Label>
        <Label htmlFor={`kit-attribution-${projectId}`}>Screenshot imagery attribution</Label><Textarea id={`kit-attribution-${projectId}`} maxLength={8000} rows={4} value={draft.attribution} onChange={e => update({ attribution: e.target.value })} />
      </section>
      <Button ref={reviewButton} variant="outline" onClick={prepare} disabled={!draft.captureIds.length || !!missing.length || (!!draft.iconId && !icons.some(a => a.id === draft.iconId))}>Review local kit contents</Button>
      {review && <section className="media-card kit-review" aria-label="Exact Launch Kit contents"><h3 ref={reviewHeading} tabIndex={-1}>4 · Confirm local contents</h3>
        <p>{review.captureIds.length} unchanged PNG capture(s){review.icon ? ' and one approved icon master' : ', no icon'}. Includes manifest.json, listing.json, listing.md, credits.md and readiness.md.</p>
        <pre>{JSON.stringify({ ...review, confirmed: undefined }, null, 2)}</pre>
        <ul>{kitLimitations.map(text => <li key={text}>{text}</li>)}</ul>
        <p>5 kits per project · 32 MiB per kit · 256 MiB per Dunara home. Nothing is evicted. Native interaction and human review remain separate gates.</p>
        {stale && <p role="alert">Library changed. Review local kit contents again before confirming.</p>}
        <Label><input type="checkbox" checked={confirmed && !stale} disabled={stale} onChange={e => setConfirmed(e.target.checked)} />I reviewed these exact contents and rights notes and confirm writing a durable local kit.</Label>
        <div className="media-actions"><Button disabled={!confirmed || stale || !!missing.length} onClick={() => void perform(async () => {
          const kit = await api<LaunchKit>(`${endpoint}/create`, review);
          if (!alive.current) return;
          setReview(undefined); setConfirmed(false); setNotice('Local kit created. App source is unchanged.'); setKits(current => [kit, ...current.filter(k => k.manifest.id !== kit.manifest.id)]);
          history.current?.focus();
        })}>Create local kit</Button><Button variant="ghost" onClick={() => { setReview(undefined); setConfirmed(false); reviewButton.current?.focus(); }}>Cancel kit review</Button></div>
      </section>}
    </fieldset>
    <section className="kit-history" aria-label="Saved Launch Kits"><div className="asset-section-heading"><h3 ref={history} tabIndex={-1}>Saved local kits</h3><Button variant="outline" disabled={busy} onClick={() => void perform(refresh)}>Refresh kits</Button></div>
      {!kits.length && <p>No saved kits for this project.</p>}
      {kits.map(kit => <article className="media-card" key={kit.manifest.id}><h4>{kit.manifest.listing.name}</h4><p>{kit.manifest.createdAt}</p><p>Inside your configured Dunara home: <code>{kit.location}</code></p><p>React Native Web · listing and rights drafts · native qualification not implied.</p>
        <ul className="kit-files">{kit.files.map(file => <li key={file.id}><Button variant="outline" disabled={busy} onClick={() => void perform(async () => { const url = await kitDownload(projectId, kit.manifest.id, file.id); if (!alive.current) { URL.revokeObjectURL(url); return; } const link = document.createElement('a'); link.href = url; link.download = file.name.split('/').pop()!; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); })}>Download {file.name}</Button><span>{file.bytes.toLocaleString()} bytes</span><code>{file.sha256}</code></li>)}</ul>
        {deleting === kit.manifest.id ? <div role="group" aria-label="Confirm kit deletion"><p>Delete this owned kit and all its files? Captures and app source are not removed. This cannot be undone.</p><Button disabled={busy} onClick={() => void perform(async () => { await api(`${endpoint}/remove`, { bundleId: kit.manifest.id, confirmed: true }); if (!alive.current) return; setKits(current => current.filter(k => k.manifest.id !== kit.manifest.id)); setDeleting(''); setNotice('Local kit deleted.'); history.current?.focus(); })}>Confirm delete kit</Button><Button variant="ghost" disabled={busy} onClick={() => setDeleting('')}>Keep kit</Button></div> : <Button variant="ghost" disabled={busy} onClick={() => setDeleting(kit.manifest.id)}>Delete kit</Button>}
      </article>)}
    </section>
  </section>;
}
