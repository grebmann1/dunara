import { useEffect, useRef, useState, type RefObject } from 'react';
import { Check, Image, PanelRight } from 'lucide-react';
import { type MediaState, useStudioClient } from '../api';
import type { Asset } from '../../../../packages/core/src/media-contracts';
import type { IconDiff, IconSelection } from '../../../../packages/core/src/icon-contracts';
import { AssetImage } from './AssetImage';
import { WorkspaceDrawer } from './WorkspaceDrawer';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { FieldSelect } from './ui/field-select';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog';

type Props = { projectId: string; asset?: Asset; data: MediaState; busy: boolean; error: string; perform(operation: () => Promise<unknown>): Promise<boolean>; save(action: string, input: unknown): Promise<boolean>; compact: boolean; reveal: number; onSelect(id: string): void; onAssets(): void };
export function AppIconsPanel({ projectId, asset, data, busy, error, perform, save, compact, reveal, onSelect, onAssets }: Props) {
  const { api } = useStudioClient();
  const [background, setBackground] = useState('#ffffff'), [fit, setFit] = useState('contain'), [foregroundId, setForeground] = useState('');
  const [check, setCheck] = useState<{ available: boolean; reason: string }>(), [diff, setDiff] = useState<IconDiff & { selection: IconSelection }>(), [consent, setConsent] = useState(false);
  const [applyFailed, setApplyFailed] = useState(false), [tone, setTone] = useState<'light' | 'dark'>('light'), [settingsOpen, setSettingsOpen] = useState(false), [applied, setApplied] = useState(false);
  const reviewButton = useRef<HTMLButtonElement>(null), settingsButton = useRef<HTMLButtonElement>(null), drawerReviewButton = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (reveal) setSettingsOpen(true); }, [reveal]);
  useEffect(() => {
    if (!asset) return;
    let active = true;
    void api<{ available: boolean; reason: string }>(`/projects/${projectId}/media/icon-check`, { assetId: asset.id }).then(value => { if (active) setCheck(value); }).catch(e => { if (active) setCheck({ available: false, reason: e.message }); });
    return () => { active = false; };
  }, [projectId, asset?.id, asset?.status]);
  const reset = () => { setDiff(undefined); setConsent(false); setApplyFailed(false); };
  const master = !!asset && asset.status === 'approved' && asset.width === 1024 && asset.height === 1024 && !asset.transparent;
  const stale = !!diff && diff.expectedMediaRevision !== data.revision;
  const settings = (actionRef: RefObject<HTMLButtonElement | null>) => <section className="icon-settings" aria-label="Icon settings">
    <div className="icon-settings-scroll"><h2>Choose your icon</h2><FieldSelect label="Icon source" value={asset?.id || 'none'} onValueChange={value => onSelect(value === 'none' ? '' : value)} disabled={busy} options={[{ value: 'none', label: 'Choose an image' }, ...data.assets.map(item => ({ value: item.id, label: `${item.label} · ${item.status}` }))]} />
      {asset ? <><div className="icon-source-review"><AssetImage projectId={projectId} asset={asset} /><div><strong>{asset.label}</strong><p>{asset.width} × {asset.height} · {asset.transparent ? 'Transparent' : 'Opaque'} · {asset.status}</p></div></div>
      {master ? <ul className="icon-readiness"><li><Check size={14} aria-hidden />1024 × 1024 master</li><li><Check size={14} aria-hidden />Opaque background</li><li><Check size={14} aria-hidden />Approved for integration</li></ul> : <Button disabled={busy || asset.status === 'approved'} onClick={() => void save('approve', { assetId: asset.id, expectedRevision: data.revision })}>{asset.status === 'approved' ? 'Approved for integration' : 'Approve candidate'}</Button>}
      <details className="media-card icon-prepare" open={!master} key={`${asset.id}:${master}`}>
      <summary><span>Crop, fit & background</span><span className="muted">{master ? 'Master ready · prepare another version' : 'Prepare a new version'}</span></summary>
      <p>Create a new version, then select and approve it here before applying.</p>
      <fieldset disabled={busy}><div className="media-fields">
        <FieldSelect label="Icon fit" value={fit} onValueChange={value => { setFit(value); reset(); }} disabled={busy} options={[{ value: 'contain', label: 'Fit entire image' }, { value: 'cover', label: 'Crop to fill square' }]} />
        <Label>Icon background<Input type="color" value={background} onChange={e => { setBackground(e.target.value); reset(); }} /></Label>
      </div><div className="media-actions"><Button variant="outline" disabled={asset.status !== 'approved'} onClick={() => void save('icon-prepare', { assetId: asset.id, expectedRevision: data.revision, kind: 'master', fit, background })}>Prepare 1024px icon master</Button><Button variant="outline" disabled={!check?.available} onClick={() => void save('icon-prepare', { assetId: asset.id, expectedRevision: data.revision, kind: 'adaptive', fit, background })}>Prepare adaptive foreground</Button></div></fieldset>
      {asset.status !== 'approved' && <p>Approve the source before preparing an icon.</p>}
      <p>{check?.reason ?? 'Checking adaptive foreground suitability…'}</p>
      <p>Adaptive foregrounds are separate transparent layers, not flattened photos. Check the mark, shadows and safe-zone composition visually.</p>
    </details>
      {master && <details className="icon-adaptive"><summary>Android adaptive settings</summary><FieldSelect label="Optional approved adaptive foreground" value={foregroundId || 'none'} onValueChange={value => { setForeground(value === 'none' ? '' : value); reset(); }} disabled={busy} options={[{ value: 'none', label: 'Keep current Android adaptive settings' }, ...data.assets.filter(a => a.status === 'approved' && a.transparent && a.width === 1024 && a.height === 1024).map(a => ({ value: a.id, label: a.label }))]} /></details>}
      </> : <p>Choose artwork from your library or generate a new icon.</p>}
      <Button variant="ghost" onClick={onAssets}>Open asset library</Button>
    </div><footer className="icon-settings-footer"><p>{applied ? 'Icon applied to app configuration.' : master ? 'Review the exact changes before applying.' : asset ? 'Prepare and approve a 1024 × 1024 icon with no transparency.' : 'Choose an image to get started.'}</p>
      <Button ref={actionRef} disabled={busy || !master} onClick={async () => { if (!asset || !master) return; setConsent(false); const selection = { masterId: asset.id, ...(foregroundId ? { foregroundId } : {}), background }; let proposal: IconDiff | undefined; const ready = await perform(async () => { proposal = await api<IconDiff>(`/projects/${projectId}/media/icon-preview`, selection); }); if (ready && proposal) setDiff({ ...proposal, selection }); }}>Review icon changes</Button>
    </footer>
  </section>;
  return <section className="icon-workflow" aria-label="App icon workflow">
    <div className="icon-canvas"><div className="icon-canvas-toolbar"><div role="group" aria-label="Icon preview background" className="icon-tone">{(['light', 'dark'] as const).map(value => <Button key={value} variant="ghost" aria-pressed={tone === value} onClick={() => setTone(value)}>{value === 'light' ? 'Light' : 'Dark'}</Button>)}</div>{compact && <Button ref={settingsButton} variant="outline" onClick={() => setSettingsOpen(true)}><PanelRight size={16} aria-hidden />{asset ? 'Icon settings' : 'Choose existing image'}</Button>}</div>
      <div className="icon-canvas-scroll">{asset ? <><div className={`icon-hero ${tone}`}><div className="icon-hero-mask"><AssetImage projectId={projectId} asset={asset} /></div><strong>{asset.label}</strong></div>
        <div className="icon-previews" aria-label="Approximate icon previews">{(['light', 'dark'] as const).map(value => <div className={`icon-wallpaper ${value}`} hidden={value !== tone} key={value}>{[16, 32, 64].map(size => <figure key={size}><div style={{ width: size, height: size }}><AssetImage projectId={projectId} asset={asset} /></div><figcaption>{size}px</figcaption></figure>)}{['rounded', 'circle'].map(mask => <figure key={mask}><div className={`icon-mask ${mask}`} style={{ background }}><AssetImage projectId={projectId} asset={asset} /></div><figcaption>{mask}</figcaption></figure>)}</div>)}</div>
        <p className="icon-preview-note">Approximate small-size and mask previews. Review the final launcher icon in an installed native build.</p></> : <div className="icon-canvas-empty"><Image size={48} aria-hidden /><h2>A small canvas. A lasting impression.</h2><p>Choose an image or generate an original mark to preview its shape and small-size details.</p></div>}</div>
    </div>
    {!compact && settings(reviewButton)}
    <WorkspaceDrawer open={compact && settingsOpen} title="Icon settings" description="Choose, prepare and review your app icon." onOpenChange={setSettingsOpen} restoreFocus={() => settingsButton.current?.focus()} className="icon-settings-drawer">{settings(drawerReviewButton)}</WorkspaceDrawer>
    <Dialog open={!!diff} onOpenChange={open => { if (!open) reset(); }}><DialogContent className="icon-diff max-w-3xl" onCloseAutoFocus={event => { event.preventDefault(); requestAnimationFrame(() => (compact ? drawerReviewButton : reviewButton).current?.focus()); }}>
      <DialogTitle>Proposed app.json change</DialogTitle><DialogDescription>Only these exact configuration contents will be applied. Unused immutable candidates remain in the library.</DialogDescription>
      {diff && <><div className="media-comparison"><div><h4>Before</h4><pre>{diff.before}</pre></div><div><h4>After</h4><pre>{diff.after}</pre></div></div>
        {diff.warnings.map(warning => <p key={warning}>{warning}</p>)}
        {stale && <p role="alert">Library changed. Cancel and review a fresh config proposal before confirming.</p>}
        {applyFailed && <div role="alert" className="error-banner"><p>{error || 'The icon proposal could not be applied.'}</p><p>Cancel this proposal and review the latest app.json changes before trying again.</p></div>}
        <fieldset disabled={busy || stale || applyFailed}><Label className="consent"><input type="checkbox" checked={consent && !stale} onChange={e => setConsent(e.target.checked)} />I reviewed this exact config change and want to apply it.</Label>
          <Button disabled={!consent || stale || applyFailed} onClick={() => void save('icon-apply', { ...diff.selection, expectedConfigRevision: diff.expectedConfigRevision, expectedMediaRevision: diff.expectedMediaRevision, proposedRevision: diff.proposedRevision, confirmed: true }).then(ok => { if (ok) { setApplied(true); reset(); } else { setConsent(false); setApplyFailed(true); } })}>Confirm and apply icon</Button>
        </fieldset><Button variant="outline" disabled={busy} onClick={reset}>Cancel config proposal</Button>
      </>}
    </DialogContent></Dialog>
  </section>;
}
