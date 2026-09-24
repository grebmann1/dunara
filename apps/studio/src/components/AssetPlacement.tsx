import { useEffect, useState } from 'react';
import type { Asset } from '../../../../packages/core/src/media-contracts';
import { type StudioState, useStudioClient } from '../api';
import { AssetImage } from './AssetImage';
import { FieldSelect } from './ui/field-select';

export type AssetPlacement = { route: string; role: 'hero' | 'avatar' | 'background'; fit: 'cover' | 'contain' };
export type AssetPlacementDraft = AssetPlacement & { expanded: boolean };
export function AssetPlacementPreview({ projectId, asset, state, value, onChange }: { projectId: string; asset: Asset; state?: StudioState; value: AssetPlacementDraft; onChange(value: AssetPlacementDraft): void }) {
  const { boardImage } = useStudioClient();
  const capture = state?.boardCaptures?.find(item => item.route === value.route);
  const [screen, setScreen] = useState('');
  useEffect(() => {
    let alive = true, url = ''; setScreen('');
    if (capture) void boardImage(projectId, capture.id).then(value => { url = value; if (alive) setScreen(value); else URL.revokeObjectURL(value); }).catch(() => {});
    return () => { alive = false; if (url) URL.revokeObjectURL(url); };
  }, [projectId, capture?.id, boardImage]);
  return <details className="asset-placement" open={value.expanded} onToggle={event => { if (event.currentTarget.open !== value.expanded) onChange({ ...value, expanded: event.currentTarget.open }); }}><summary>Preview placement & crop</summary>
    <p>A composition mockup using your saved screen. Applying it still requires a reviewed Assistant build.</p>
    {capture?.stale && <p role="status">This screen was captured before the latest source changes. Refresh it in Preview for an up-to-date comparison.</p>}
    <FieldSelect label="Target screen" value={value.route} onValueChange={route => onChange({ ...value, route })} options={(state?.screens?.length ? state.screens : [{ name: 'Home', route: '/' }]).map(screen => ({ value: screen.route, label: screen.name }))} />
    <FieldSelect label="Placement" value={value.role} onValueChange={role => onChange({ ...value, role: role as AssetPlacement['role'] })} options={[{ value: 'hero', label: 'Hero artwork' }, { value: 'avatar', label: 'Character / avatar' }, { value: 'background', label: 'Screen background' }]} />
    <FieldSelect label="Image fit" value={value.fit} onValueChange={fit => onChange({ ...value, fit: fit as AssetPlacement['fit'] })} options={[{ value: 'contain', label: 'Keep the entire image' }, { value: 'cover', label: 'Fill and crop' }]} />
    <div className="asset-placement-phone" data-placement={value.role} style={{ '--placement-fit': value.fit } as React.CSSProperties}>
      {screen ? <img className="asset-placement-screen" src={screen} alt={`Saved screen ${value.route}`} /> : <p>Capture this screen in Preview to compare its composition.</p>}
      <div className="asset-placement-art"><AssetImage projectId={projectId} asset={asset} /></div>
    </div>
    <p>No app files have changed. Close this preview to keep your existing artwork.</p>
  </details>;
}
