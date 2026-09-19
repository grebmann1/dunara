import type { Asset } from '../../../../packages/core/src/media-contracts';
import { AssetImage } from './AssetImage';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { FieldSelect } from './ui/field-select';
import { useState } from 'react';

export function AssetLibrary({ projectId, assets, selected, onSelect }: { projectId: string; assets: Asset[]; selected: string; onSelect: (id: string) => void }) {
  const [query, setQuery] = useState(''), [filter, setFilter] = useState('all');
  const matches = assets.filter(asset => `${asset.label} ${asset.role}`.toLowerCase().includes(query.trim().toLowerCase()) && (filter === 'all' || asset.status === filter));
  return <section className="media-card asset-library" aria-label="Asset library">
    <div className="library-toolbar"><h2 className="sr-only">Asset library</h2><Input type="search" aria-label="Search assets" placeholder="Search assets…" value={query} onChange={event => setQuery(event.target.value)} /><FieldSelect label="Asset status" value={filter} onValueChange={setFilter} options={[{ value: 'all', label: 'All assets' }, { value: 'approved', label: 'Approved' }, { value: 'candidate', label: 'Candidates' }]} /><span>{matches.length} of {assets.length}</span></div>
    <div className="library-scroll"><div className="media-grid">{matches.map(asset => <article key={asset.id} className={`asset-tile ${asset.id === selected ? 'selected' : ''}`}>
      <AssetImage projectId={projectId} asset={asset} />
      <Button variant="ghost" data-asset-id={asset.id} aria-pressed={asset.id === selected} onClick={() => onSelect(asset.id)}>{asset.label}</Button>
      <span>{asset.status} · {asset.width} × {asset.height} · {asset.role}</span>
    </article>)}</div>
    {!assets.length && <p>No assets yet. Import an image to begin, with or without AI.</p>}
    {!!assets.length && !matches.length && <div className="activity-empty"><strong>No matching assets</strong><Button variant="outline" onClick={() => { setQuery(''); setFilter('all'); }}>Clear filters</Button></div>}
    <p className="library-capacity">{assets.length} / 100 versions · {Math.round(assets.reduce((n, asset) => n + asset.bytes, 0) / 1024)} KiB of 100 MiB</p></div>
  </section>;
}
