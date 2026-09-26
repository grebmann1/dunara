import type { AssetPlacement, AssetPlacementDraft } from './AssetPlacement';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Activity, Palette, PanelRight, RefreshCw, Sparkles, Upload } from 'lucide-react';
import { type AssistantStatus, type MediaState, type ProviderStatus, type StudioState, useStudioClient } from '../api';
import { MEDIA_BYTES, mediaTypeSchema, roleSchema, type Asset } from '../../../../packages/core/src/media-contracts';
import type { JobRequest } from '../../../../packages/core/src/media-job-contracts';
import type { CreativeDraft, CreativeSeed } from '../creative';
import { AssetGenerator } from './AssetGenerator';
import { BriefForm, type BriefDraft } from './BriefForm';
import { JobCard } from './JobCard';
import { AppIconsPanel } from './AppIconsPanel';
import { ActivityPanel } from './ActivityPanel';
import { AssetLibrary } from './AssetLibrary';
import { AssetReview } from './AssetReview';
import { LaunchKitPanel, type LaunchKitDraft } from './LaunchKitPanel';
import { WorkspaceDrawer } from './WorkspaceDrawer';
import { Button } from './ui/button';
import { SectionTab } from './ui/section-tab';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Textarea } from './ui/textarea';
import { FieldSelect } from './ui/field-select';

type Tool = '' | 'import' | 'generate' | 'icon-generate' | 'brief' | 'request';
type Props = { launchKitEnabled?: boolean; projectId: string; destination: string; settings?: ProviderStatus; state?: StudioState; assistantStatus?: AssistantStatus; savedBrief?: BriefDraft; onBrief(draft: BriefDraft | undefined): void; onNavigate(destination: 'assets' | 'icons' | 'activity' | 'settings' | 'backend', section?: 'images'): void; onPending(count: number): void; assetsTab: 'library' | 'launch-kit'; onAssetsTab(tab: 'library' | 'launch-kit'): void; savedKitDraft?: LaunchKitDraft; onKitDraft(draft: LaunchKitDraft): void; savedGeneration?: { assets?: CreativeDraft; icons?: CreativeDraft }; onGenerationDraft?(scope: 'assets' | 'icons', draft: CreativeDraft): void; onIntegrate?(asset: Asset, placement?: AssetPlacement): void };

export function AssetsPanel({ launchKitEnabled = true, projectId, destination, settings, state, assistantStatus, savedBrief, onBrief, onNavigate, onPending, assetsTab, onAssetsTab, savedKitDraft, onKitDraft, savedGeneration, onGenerationDraft, onIntegrate }: Props) {
  const { api, uploadMedia } = useStudioClient();
  const [placements, setPlacements] = useState<Record<string, AssetPlacementDraft>>({});
  const [library, setData] = useState<MediaState>(), [error, setError] = useState(''), [notice, setNotice] = useState<{ destination: string; message: string }>(), [busy, setBusy] = useState(false);
  const data = library && settings ? { ...library, capabilities: { ...library.capabilities, available: library.capabilities.available && settings.configured, provider: settings } } : library;
  const [tool, setTool] = useState<Tool>(''), [selected, setSelected] = useState(''), [iconSelected, setIconSelected] = useState(''), [compare, setCompare] = useState(''), [selectedJob, setSelectedJob] = useState('');
  const [generationSeed, setGenerationSeed] = useState<CreativeSeed>(), [drafts, setDrafts] = useState(savedGeneration), [briefDraft, setBriefDraft] = useState(savedBrief);
  const [compact, setCompact] = useState(false), [reviewOpen, setReviewOpen] = useState(false), [iconReveal, setIconReveal] = useState(0);
  const workspace = useRef<HTMLElement>(null), reviewHeading = useRef<HTMLHeadingElement>(null), returnFocus = useRef<HTMLElement | null>(null), focusReview = useRef(false), revealAfterNavigation = useRef(false);
  const alive = useRef(true), operating = useRef(false), sequence = useRef(0);
  const [file, setFile] = useState<File>(), [label, setLabel] = useState(''), [role, setRole] = useState<Asset['role']>('illustration'), [rights, setRights] = useState('');
  const [width, setWidth] = useState(1024), [height, setHeight] = useState(1024), [fit, setFit] = useState('cover'), [focalX, setFocalX] = useState(0.5), [focalY, setFocalY] = useState(0.5), [background, setBackground] = useState('#ffffff');
  const pending = library?.jobs.filter(job => job.state === 'awaiting-approval').length ?? 0;
  const running = library?.jobs.filter(job => ['queued', 'running'].includes(job.state)).length ?? 0;
  useEffect(() => { onPending(pending); }, [pending, onPending]);
  useEffect(() => {
    const node = workspace.current; if (!node) return;
    const observer = new ResizeObserver(([entry]) => { if (entry && entry.contentRect.width > 0) setCompact(entry.contentRect.width < 850); });
    observer.observe(node); return () => observer.disconnect();
  }, []);
  useEffect(() => { setTool(''); setReviewOpen(revealAfterNavigation.current); revealAfterNavigation.current = false; setGenerationSeed(undefined); }, [destination, assetsTab]);
  const refresh = useCallback(async () => {
    const request = ++sequence.current;
    const result = await api<MediaState>(`/projects/${projectId}/media`);
    if (alive.current && request === sequence.current) setData(result);
  }, [projectId]);
  useEffect(() => {
    alive.current = true;
    const reload = () => { if (!operating.current) void refresh().catch(e => { if (alive.current) setError(e.message); }); };
    reload(); const timer = setInterval(reload, 3000);
    return () => { alive.current = false; sequence.current++; clearInterval(timer); };
  }, [refresh]);
  useEffect(() => { if (settings) void refresh().catch(() => {}); }, [settings, refresh]);
  async function perform(operation: () => Promise<unknown>) {
    if (operating.current) return false;
    operating.current = true; sequence.current++; setBusy(true); setError(''); setNotice({ destination, message: 'Saving…' });
    try { await operation(); await refresh(); if (alive.current) setNotice({ destination, message: 'Saved.' }); return true; }
    catch (e) { if (alive.current) { setNotice(undefined); setError(e instanceof Error ? e.message : 'Media operation failed'); await refresh().catch(() => {}); } return false; }
    finally { operating.current = false; if (alive.current) setBusy(false); }
  }
  const save = (action: string, input: unknown) => perform(() => api(`/projects/${projectId}/media/${action}`, input));
  function openTool(next: Tool) { setReviewOpen(false); returnFocus.current = document.activeElement as HTMLElement; setTool(next); }
  function closeTool() { setTool(''); setGenerationSeed(undefined); }
  function restoreFocus() {
    requestAnimationFrame(() => {
      if (focusReview.current) { reviewHeading.current?.focus({ preventScroll: true }); focusReview.current = false; }
      else if (returnFocus.current?.isConnected) returnFocus.current.focus({ preventScroll: true });
      else workspace.current?.focus({ preventScroll: true });
    });
  }
  function saveDraft(scope: 'assets' | 'icons', draft: CreativeDraft) { setDrafts(previous => previous?.[scope] === draft ? previous : { ...previous, [scope]: draft }); onGenerationDraft?.(scope, draft); }
  async function stage(request: JobRequest) {
    let created: { id: string } | undefined;
    const saved = await perform(async () => { created = await api(`/projects/${projectId}/media/job-request`, request); });
    if (saved && created) { setSelectedJob(created.id); setGenerationSeed(undefined); setTool('request'); }
    return saved;
  }
  async function addScreenReference(captureId: string) {
    let assetId: string | undefined;
    await perform(async () => { const result = await api<{ assetId: string }>(`/projects/${projectId}/media/screen-reference`, { captureId, expectedRevision: data?.revision ?? null }); assetId = result.assetId; });
    return assetId;
  }
  function selectAsset(id: string) { setSelected(id); setCompare(''); setReviewOpen((workspace.current?.clientWidth ?? 850) < 850); focusReview.current = tool === 'request'; requestAnimationFrame(() => { reviewHeading.current?.focus({ preventScroll: true }); }); }
  function revealAsset(id: string) { revealAfterNavigation.current = destination !== 'assets' || assetsTab !== 'library'; onAssetsTab('library'); onNavigate('assets'); selectAsset(id); }
  function remix(asset: Asset) { setGenerationSeed({ key: Date.now(), referenceId: asset.id, label: asset.label, role: asset.role }); setReviewOpen(false); openTool(destination === 'icons' ? 'icon-generate' : 'generate'); }
  const asset = data?.assets.find(a => a.id === selected), iconAsset = data?.assets.find(a => a.id === iconSelected);
  const comparison = data?.assets.find(a => a.id === compare || (!compare && a.id === asset?.parentId));
  const job = data?.jobs.find(item => item.id === selectedJob);
  const review = data && asset && <AssetReview key={asset.id} state={state} projectId={projectId} asset={asset} placement={placements[asset.id] ?? { route: state?.screens?.[0]?.route ?? '/', role: 'hero', fit: 'contain', expanded: false }} onPlacementChange={value => setPlacements(previous => ({ ...previous, [asset.id]: value }))} assets={data.assets} comparison={comparison} onCompare={setCompare} busy={busy} onApprove={() => void save('approve', { assetId: asset.id, expectedRevision: data.revision })} onIcons={() => { setIconSelected(asset.id); setReviewOpen(false); setIconReveal(value => value + 1); onNavigate('icons'); }} onRemix={() => remix(asset)} onIntegrate={onIntegrate ? placement => { setReviewOpen(false); onIntegrate(asset, placement); } : undefined} headingRef={reviewHeading}>
    <details><summary>Crop and resize a new version</summary><form onSubmit={e => { e.preventDefault(); void save('transform', { assetId: asset.id, expectedRevision: data.revision, width, height, fit, focalX, focalY, background }); }}>
              <h3>Crop and resize a new version</h3><p>Creates an unapproved candidate linked to this source. No provider call.</p><fieldset disabled={busy}><div className="media-fields">
                <Label>Width<Input type="number" required min={16} max={4096} value={width} onChange={e => setWidth(Number(e.target.value))} /></Label>
                <Label>Height<Input type="number" required min={16} max={4096} value={height} onChange={e => setHeight(Number(e.target.value))} /></Label>
                <FieldSelect label="Fit" value={fit} onValueChange={setFit} disabled={busy} options={[{ value: 'cover', label: 'Crop to fill' }, { value: 'contain', label: 'Fit with background' }]} />
                <Label>Background<Input type="color" value={background} onChange={e => setBackground(e.target.value)} /></Label>
                <Label>Horizontal focal point<Input type="range" min={0} max={1} step={0.05} value={focalX} onChange={e => setFocalX(Number(e.target.value))} /></Label>
                <Label>Vertical focal point<Input type="range" min={0} max={1} step={0.05} value={focalY} onChange={e => setFocalY(Number(e.target.value))} /></Label>
              </div><Button type="submit" variant="outline">Create transformed candidate</Button></fieldset>
            </form></details>
  </AssetReview>;
  const toolTitles = { '': '', generate: 'Create with AI', 'icon-generate': 'Generate an icon', import: 'Import artwork', brief: 'Art direction', request: 'Image request' };
  return <main ref={workspace} tabIndex={-1} hidden={!['assets', 'icons', 'activity'].includes(destination)} className="assets-workspace media-workbench" data-compact={compact} data-destination={destination} data-launch-kit={destination === 'assets' && assetsTab === 'launch-kit'} aria-label={`${destination === 'icons' ? 'App Icons' : destination === 'activity' ? 'Activity' : 'Assets'} workspace`}>
    {destination === 'assets' && <header className="asset-heading"><div><h1>Assets</h1><p>The artwork that makes your app feel like yours.</p></div><div className="media-actions asset-tools"><Button id="asset-tool-import" variant="outline" onClick={() => openTool('import')}><Upload size={16} aria-hidden />Import</Button><Button id="asset-tool-generate" onClick={() => openTool('generate')}><Sparkles size={16} aria-hidden />Generate</Button></div></header>}
    {destination === 'icons' && <header className="asset-heading"><div><h1>App Icons</h1><p>Make it recognizable, even at a glance.</p></div><Button id="icon-generate" onClick={() => openTool('icon-generate')}><Sparkles size={16} aria-hidden />Generate an icon</Button></header>}
    {destination === 'assets' && <div className="media-workspace-toolbar"><div className="section-tabs" role="group" aria-label="Assets sections"><SectionTab selected={assetsTab === 'library'} aria-pressed={assetsTab === 'library'} onClick={() => onAssetsTab('library')}>Asset library</SectionTab><SectionTab disabled={!launchKitEnabled} selected={assetsTab === 'launch-kit'} aria-pressed={assetsTab === 'launch-kit'} onClick={() => onAssetsTab('launch-kit')}>Launch Kit</SectionTab></div><div className="media-actions"><Button id="asset-tool-brief" variant="ghost" onClick={() => openTool('brief')}><Palette size={16} aria-hidden />Art direction</Button>{compact && asset && assetsTab === 'library' && <Button variant="outline" onClick={() => { returnFocus.current = document.activeElement as HTMLElement; setReviewOpen(true); }}><PanelRight size={16} aria-hidden />Details</Button>}<Button variant="ghost" aria-label="Refresh library" title="Refresh library" onClick={() => void refresh().catch(e => setError(e.message))}><RefreshCw size={16} aria-hidden /></Button></div></div>}
    {error && !tool && <div className="error-banner" role="alert">{error}<Button variant="outline" onClick={() => { setError(''); void refresh().catch(e => setError(e.message)); }}>Refresh library</Button></div>}
    {!launchKitEnabled && destination === 'assets' && assetsTab === 'launch-kit' && <p role="status">Launch Kit is disabled. Enable it in Plugins or open Asset library.</p>}
    <p className="media-save-status" role="status" hidden={notice?.destination !== destination || !!tool}>{notice?.destination === destination ? notice.message : ''}</p>
    {!data ? <p className="workspace-loading">Loading media library…</p> : <>
      {destination === 'activity' && <ActivityPanel onBackend={() => onNavigate('backend')} projectId={projectId} data={data} state={state} onAssets={() => { onAssetsTab('library'); onNavigate('assets'); }} onLaunchKit={() => { onAssetsTab('launch-kit'); onNavigate('assets'); }} onReview={id => { setSelectedJob(id); openTool('request'); }} onResult={revealAsset} />}
      {destination === 'icons' && <AppIconsPanel key={iconAsset?.id ?? 'empty'} projectId={projectId} asset={iconAsset} data={data} busy={busy} error={error} perform={perform} save={save} compact={compact} reveal={iconReveal} onSelect={setIconSelected} onAssets={() => { onAssetsTab('library'); onNavigate('assets'); }} />}
      {state && launchKitEnabled && <div className="launch-kit-scroll" hidden={destination !== 'assets' || assetsTab !== 'launch-kit'}><LaunchKitPanel projectId={projectId} state={state} media={data} active={destination === 'assets' && assetsTab === 'launch-kit'} savedDraft={savedKitDraft} onDraft={onKitDraft} /></div>}
      <div hidden={destination !== 'assets' || assetsTab !== 'library'} className="asset-browser" data-selected={!!asset && !compact}>
        <AssetLibrary projectId={projectId} assets={data.assets} selected={selected} onSelect={id => { returnFocus.current = document.activeElement as HTMLElement; selectAsset(id); }} />
        {!compact && review}
      </div>
      {destination !== 'activity' && <footer className="media-workspace-footer"><span>{pending ? `${pending} ${pending === 1 ? 'request' : 'requests'} awaiting approval` : running ? `${running} ${running === 1 ? 'request' : 'requests'} creating artwork` : data.capabilities.available ? 'Your creative workspace' : 'Asset library ready · Image generation needs setup'}</span><Button variant="ghost" onClick={() => onNavigate('activity')}><Activity size={16} aria-hidden />View activity{pending + running > 0 ? ` · ${pending + running}` : ''}</Button></footer>}
      <WorkspaceDrawer open={!!tool} title={toolTitles[tool]} description={tool === 'request' ? 'Review the request, its status and generated images.' : 'Your library stays in place while you work.'} onOpenChange={open => { if (!open) closeTool(); }} restoreFocus={restoreFocus} className={tool === 'generate' || tool === 'icon-generate' ? 'generation-drawer' : ''}>
        {error && <div role="alert" className="error-banner">{error}</div>}
        {notice?.destination === destination && <p className="drawer-notice" role="status">{notice.message}</p>}
        {tool === 'brief' && <section aria-label="Art direction form"><BriefForm data={data} save={save} disabled={busy} savedDraft={briefDraft} onDraft={draft => { setBriefDraft(draft); onBrief(draft); }} onClose={closeTool} /></section>}
        {tool === 'import' && <form id="asset-form-import"  className="media-card asset-form" onSubmit={e => {
          e.preventDefault(); if (!file) return;
          const mime = mediaTypeSchema.safeParse(file.type);
          if (!mime.success || file.size > MEDIA_BYTES) { setError('Choose a PNG, JPEG or WebP no larger than 10 MiB.'); return; }
          void perform(() => uploadMedia(projectId, { expectedRevision: data.revision, label, role, rightsNote: rights, mediaType: mime.data }, file));
        }}>
          <div className="asset-section-heading"><h2>Import an original</h2><Button variant="ghost" onClick={closeTool}>Close import</Button></div>
          <p>PNG, JPEG, WebP · 10 MiB · 16 megapixels. Metadata is stripped; the original file is unchanged.</p>
          <fieldset disabled={busy}>
            <Label>Image file<Input type="file" accept="image/png,image/jpeg,image/webp" required={!file} onChange={e => { const value = e.target.files?.[0]; setFile(value); if (value) setLabel(value.name.slice(0, 100)); }} /></Label>{file && <p className="muted">Selected file: {file.name}</p>}
            <Label>Asset label<Input required maxLength={100} value={label} onChange={e => setLabel(e.target.value)} /></Label>
            <FieldSelect label="Intended use" value={role} onValueChange={value => setRole(roleSchema.parse(value))} disabled={busy} options={roleSchema.options.map(value => ({ value, label: value }))} />
            <Label>Provenance / rights note<Textarea maxLength={2000} value={rights} onChange={e => setRights(e.target.value)} /></Label>
            <Button type="submit" disabled={!file}>Import candidate</Button>
          </fieldset>
        </form>}
        {(tool === 'generate' || tool === 'icon-generate') && <AssetGenerator key={tool} projectId={projectId} data={data} state={state} assistantStatus={assistantStatus} busy={busy} active iconOnly={tool === 'icon-generate'} seed={generationSeed} savedDraft={drafts?.[tool === 'icon-generate' ? 'icons' : 'assets']} onDraft={draft => saveDraft(tool === 'icon-generate' ? 'icons' : 'assets', draft)} onClose={closeTool} onSettings={section => { closeTool(); onNavigate('settings', section); }} onStage={stage} onScreenReference={addScreenReference} />}
        {tool === 'request' && (job ? <JobCard key={`${job.id}:${data.capabilities.provider.revision}`} job={job} data={data} projectId={projectId} focused disabled={busy} save={save} onRemix={remix} onResult={id => { closeTool(); if (destination === 'icons') { setIconSelected(id); setIconReveal(value => value + 1); } else revealAsset(id); }} /> : <p>This request is no longer retained. Open Activity to see available requests.</p>)}
      </WorkspaceDrawer>
      <WorkspaceDrawer open={compact && reviewOpen && destination === 'assets' && assetsTab === 'library' && !tool} title="Asset details" description="Review this image and choose how to use it." onOpenChange={setReviewOpen} restoreFocus={() => { focusReview.current = false; returnFocus.current?.focus({ preventScroll: true }); }} className="asset-details-drawer">{review}</WorkspaceDrawer>
    </>}
  </main>;
}
