import { AssetPlacementPreview, type AssetPlacement, type AssetPlacementDraft } from './AssetPlacement';
import type { StudioState } from '../api';
import { useRef, useState, type ReactNode, type RefObject } from 'react';
import type { Asset } from '../../../../packages/core/src/media-contracts';
import { AssetImage } from './AssetImage';
import { Button } from './ui/button';
import { Label } from './ui/label';
import { Textarea } from './ui/textarea';
import { FieldSelect } from './ui/field-select';

export function AssetReview({ projectId, asset, assets, state, comparison, onCompare, placement, onPlacementChange, busy, onApprove, onIcons, onRemix, onIntegrate, headingRef, children }: { projectId: string; asset: Asset; assets: Asset[]; state?: StudioState; comparison?: Asset; onCompare: (id: string) => void; placement: AssetPlacementDraft; onPlacementChange(value: AssetPlacementDraft): void; busy: boolean; onApprove: () => void; onIcons: () => void; onRemix?: () => void; onIntegrate?: (placement: AssetPlacement) => void; headingRef: RefObject<HTMLHeadingElement | null>; children: ReactNode }) {
  const [copyState, setCopyState] = useState<{ id: string; message: string }>();
  const contextRef = useRef<HTMLTextAreaElement>(null);
  const contextDetails = useRef<HTMLDetailsElement>(null);
  const context = JSON.stringify({ version: 1, projectId, assetId: asset.id, path: asset.path, status: asset.status, instruction: 'Integrate this approved local asset through revision-safe project writes. Approval and copying do not edit app screens.' }, null, 2);
  async function copy() {
    try { await navigator.clipboard.writeText(context); setCopyState({ id: asset.id, message: 'Integration context copied.' }); }
    catch { setCopyState({ id: asset.id, message: 'Clipboard unavailable. Select and copy the integration context below.' }); if (contextDetails.current) contextDetails.current.open = true; contextRef.current?.focus(); contextRef.current?.select(); }
  }
  return <section className="media-card asset-review" aria-label="Selected asset">
    <div className="asset-review-scroll"><h2 ref={headingRef} tabIndex={-1}>Review candidate</h2>
    <FieldSelect label="Compare with" value={comparison?.id ?? 'none'} onValueChange={onCompare} options={[{ value: 'none', label: 'No comparison' }, ...assets.filter(other => other.id !== asset.id).map(other => ({ value: other.id, label: `${other.label} · ${other.status}` }))]} />
    <div className="media-comparison" data-comparing={!!comparison}>{[comparison, asset].filter((item): item is Asset => !!item).map(item => <figure key={item.id}>
      <AssetImage projectId={projectId} asset={item} />
      <figcaption><strong>{item.label}</strong><span className="asset-status" data-state={item.status}>{item.status}</span><p>{item.width} × {item.height} · {Math.round(item.bytes / 1024)} KiB · {item.transparent ? 'Transparency' : 'Opaque'} · {item.role}</p><details><summary>Provenance & file details</summary><p>{item.provenance}{item.model ? ` / ${item.model}` : ''} · {item.rightsNote || 'No rights note supplied'}</p><code>{item.path}</code></details></figcaption>
    </figure>)}</div>
    <AssetPlacementPreview projectId={projectId} asset={asset} state={state} value={placement} onChange={onPlacementChange} />
    {asset.parentId && <p>Derived from <strong>{assets.find(parent => parent.id === asset.parentId)?.label ?? asset.parentId}</strong>. Original unchanged; this version is {asset.status}.</p>}
    <Button variant="outline" onClick={onIcons}>Use selected image in App Icons</Button>
    {asset.status === 'approved' && <div className="integration-context"><Button variant="ghost" onClick={() => void copy()}>Copy integration context</Button><p role="status">{copyState?.id === asset.id ? copyState.message : ''}</p><details ref={contextDetails}><summary>Integration context</summary><Label htmlFor="asset-integration-context">Integration context (selectable fallback)</Label><Textarea id="asset-integration-context" ref={contextRef} readOnly rows={4} value={context} onFocus={event => event.currentTarget.select()} /></details></div>}
    {children}
    </div><footer className="asset-review-actions"><Button disabled={busy || asset.status === 'approved'} onClick={onApprove}>{asset.status === 'approved' ? 'Approved for integration' : 'Approve candidate'}</Button>
    {asset.status === 'approved' && <><p>{onIntegrate ? 'Place this artwork with Assistant.' : 'Copy the asset context to your agent.'}</p>{onIntegrate && <Button disabled={busy} onClick={() => onIntegrate(placement)}>Use in my app</Button>}{onRemix && <Button disabled={busy} variant="outline" onClick={onRemix}>Create a variation</Button>}</>}
    </footer>
  </section>;
}
