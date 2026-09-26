import { ProjectImport } from './components/ProjectImport';
import { useStudioClient } from './api';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Camera, Layers3, MessageSquare, Play, RotateCw, SlidersHorizontal, Smartphone, Square, X } from 'lucide-react';
import { projectBuildPrompt } from './project-build';
import { useAssistant } from './assistant';
import { useWorkspaceDrafts } from './workspace-drafts';
import { AssistantPanel } from './components/AssistantPanel';
import { Button } from './components/ui/button';
import { CreateProjectDialog } from './components/CreateProjectDialog';
import { createSchema, type Project } from '../../../packages/core/src/contracts';
import { type StudioState, type StudioSession, type ProviderStatus } from './api';
import type { StudioAction } from '../../../packages/core/src/studio-contracts';
import { PreviewTools } from './components/PreviewTools';
import { StudioShell, type Workspace } from './components/layout/StudioShell';
import { useWorkspaceLayout, WorkspaceDockProvider } from './components/layout/WorkspaceDock';
import { PreviewBoard } from './components/PreviewBoard';
import { initialBoard, type PreviewBoardState, type BoardAction } from './preview-board';
import { DesignPanel } from './components/DesignPanel';
import { StudioConsole } from './components/StudioConsole';
import { AssetsPanel } from './components/AssetsPanel';
import { SettingsPanel } from './components/SettingsPanel';
import { CreationGuide, browserJourney } from './components/CreationGuide';
import { UnavailableProjects } from './components/UnavailableProjects';
import { NativeBuildPanel } from './components/NativeBuildPanel';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './components/ui/dialog';
import type { UnavailableProject } from '../../../packages/core/src/projects';
import type { JourneyState } from '../../../packages/core/src/journey';
import { BackendPanel, type SupabaseTab } from './components/BackendPanel';
import { BackendPluginPanel } from './components/BackendPluginPanel';
import { backendProviders } from './backend-providers';
import { PluginsPanel, usePlugins } from './plugins/PluginsPanel';
import { workspaceOwner } from '../../../packages/builtin-plugins/src/contributions';

export function App() {
  const { api, authenticate, subscribe, capabilities } = useStudioClient();
  const dock = useWorkspaceLayout();
  const [consolePanel, setConsolePanel] = useState<'diagnostics' | 'captures' | null>(null);
  const [ready, setReady] = useState(false), [authFailed, setAuthFailed] = useState(false);
  const pluginCatalog = usePlugins(ready);
  const enabledPlugins = pluginCatalog.state?.plugins.filter(plugin => plugin.status === 'active').map(plugin => plugin.id);
  const pluginEnabled = (id: string) => !enabledPlugins || enabledPlugins.includes(id);
  const hiddenDestinations = pluginCatalog.state ? Object.entries(workspaceOwner).filter(([, owner]) => !pluginCatalog.state!.plugins.some(plugin => plugin.id === owner && plugin.status === 'active')).map(([workspace]) => workspace) : [];
  const [connected, setConnected] = useState(false), [available, setAvailable] = useState(false), [connectionError, setConnectionError] = useState('');
  const [projects, setProjects] = useState<Project[]>([]), [selected, setSelected] = useState('');
  const providers = backendProviders(pluginCatalog.state?.plugins);
  const [backendSelection, setBackendSelection] = useState<{ projectId: string; providerId: string; tab?: SupabaseTab }>();
  const backendProvider = providers.find(provider => backendSelection?.projectId === selected && provider.id === backendSelection.providerId) ?? providers[0];
  const [unavailableProjects, setUnavailableProjects] = useState<UnavailableProject[]>([]), [buildOpen, setBuildOpen] = useState(false);
  const buildTitle = useRef<HTMLHeadingElement>(null);
  const [assistantOpen, setAssistantOpen] = useState(false), assistantButton = useRef<HTMLButtonElement>(null);
  const assistantEnabled = pluginEnabled('builder.assistant');
  const assistant = useAssistant(ready && assistantEnabled, selected || null, assistantOpen && assistantEnabled);
  const creativeDrafts = useWorkspaceDrafts(selected, ready);
  const [state, setState] = useState<StudioState>(), [error, setError] = useState('');
  const [busy, setBusy] = useState(''), [busyProject, setBusyProject] = useState('');
  const [boards, setBoards] = useState<Record<string, PreviewBoardState>>({});
  const [controlBusy, setControlBusy] = useState(false);
  const board = boards[selected];
  const activeView = board?.views.find(view => view.id === board.activeId);
  const route = activeView?.route ?? '/', viewport = activeView?.viewport ?? 'compact';
  function changeBoard(projectId: string, action: BoardAction) { return projectId === selection.current ? control(action) : Promise.resolve(false); }
  const setRoute = (route: string) => {
    if (activeView) changeBoard(selected, board?.mode === 'overview' ? { type: 'focus-screen', route } : { type: 'update', id: activeView.id, patch: { route } });
  };
  const setViewport = (viewport: 'compact' | 'large') => { if (activeView) changeBoard(selected, { type: 'update', id: activeView.id, patch: { viewport } }); };
  const [importing, setImporting] = useState(false);
  const [creating, setCreating] = useState(false), [name, setName] = useState('My app'), [slug, setSlug] = useState('my-app');
  const [trusted, setTrusted] = useState(false);
  const [settings, setSettings] = useState<ProviderStatus>();
  const [pendingReview, setPendingReview] = useState(0);
  const [workspace, setLocalWorkspace] = useState<Workspace>('preview');
  const workspaceUnavailable = hiddenDestinations.includes(workspace);
  const [designOpen, setLocalDesignOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<'images' | undefined>(undefined);
  const setWorkspace = (workspace: Workspace, section?: 'images') => { setSettingsSection(section); if (!selection.current) setLocalWorkspace(workspace); else void control({ type: 'navigate', workspace }); };
  const openSupabase = (tab: SupabaseTab = 'overview') => { setBackendSelection({ projectId: selection.current, providerId: 'builder.supabase', tab }); setWorkspace('backend'); };
  const showAssistant = () => setAssistantOpen(true);
  const setDesignOpen = (open: boolean) => { if (open && !dock.desktop) setAssistantOpen(false); void control({ type: 'design', open }); };
  const closePanelsForDialog = () => { setAssistantOpen(false); if (designOpen) { setLocalDesignOpen(false); setDesignOpen(false); } };
  const workspaceContent = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { workspaceContent.current?.scrollTo(0, 0); }, [workspace, selected]);
  const [assetsTab, setLocalAssetsTab] = useState<'library' | 'launch-kit'>('library');
  const setAssetsTab = (tab: 'library' | 'launch-kit') => { void control({ type: 'assets-tab', tab }); };
  const openLaunchKit = () => setAssetsTab('launch-kit');
  const session = useRef<StudioSession | undefined>(undefined);
  const controlQueue = useRef<Promise<unknown>>(Promise.resolve());
  const pendingControls = useRef(0);
  const generation = useRef(0), selection = useRef(''), selectionVersion = useRef(0), operating = useRef(false);
  const designButton = useRef<HTMLButtonElement>(null);
  const reconciliation = useRef<Promise<void>>(Promise.resolve());
  const selectProject = useCallback((id: string) => {
    generation.current++; selectionVersion.current++; selection.current = id;
    setBoards(current => current[id] ? current : { ...current, [id]: initialBoard(crypto.randomUUID()) });
    setSelected(id); setState(undefined); setPendingReview(0); setError('');
    setConsolePanel(null); setBuildOpen(false);
  }, []);
  const applySession = useCallback((value: StudioSession) => {
    if (session.current?.revision === value.revision) return;
    session.current = value;
    if (value.projectId && value.studio) {
      if (selection.current !== value.projectId) selectProject(value.projectId);
      const id = value.projectId, studio = value.studio;
      setBoards(current => ({ ...current, [id]: studio.board }));
      setLocalWorkspace(studio.workspace); setLocalDesignOpen(studio.designOpen); setLocalAssetsTab(studio.assetsTab);
    } else if (selection.current) {
      selectProject(''); setLocalWorkspace('preview'); setLocalDesignOpen(false);
    }
  }, [selectProject]);
  function control(action: StudioAction): Promise<boolean> {
    const projectId = selection.current;
    pendingControls.current++; setControlBusy(true);
    const pending = controlQueue.current.then(async () => {
      if (!session.current || (action.type !== 'select-project' && selection.current !== projectId)) throw new Error('Studio changed; try the action again in the selected project.');
      applySession(await api<StudioSession>('/studio', { expectedRevision: session.current.revision, action }));
      return true;
    }).catch(e => { setError(e instanceof Error ? e.message : 'Studio action failed'); return false; }).finally(() => { pendingControls.current--; setControlBusy(pendingControls.current > 0); });
    controlQueue.current = pending;
    void pending.then(() => reconcile());
    return pending;
  }
  useEffect(() => { void authenticate().then(() => setReady(true)).catch(e => { setAuthFailed(true); setConnectionError(e.message); }); }, []);
  const reconcile = useCallback(async () => {
    let pending = (async () => {
    const version = ++generation.current;
    try {
      const [catalog, provider, shared] = await Promise.all([api<{ projects: Project[]; unavailable?: UnavailableProject[]; trusted: boolean }>('/projects'), api<ProviderStatus>('/settings'), api<StudioSession>('/studio')]);
      if (version !== generation.current) return;
      setProjects(catalog.projects); setUnavailableProjects(catalog.unavailable ?? []); setTrusted(catalog.trusted); setSettings(provider);
      if (!pendingControls.current) applySession(shared);
      const id = selection.current;
      const current = generation.current;
      if (id) {
        const result = await api<StudioState>(`/projects/${id}`);
        if (current !== generation.current || selection.current !== id) return;
        setState(result);
      }
      setAvailable(true); setConnectionError('');
    } catch (e) {
      if (version === generation.current) { setAvailable(false); setConnectionError(`${e instanceof Error ? e.message : 'Connection failed'}. Check the builder process; restart/relaunch Studio for a fresh session if needed.`); }
    }
    })();
    reconciliation.current = pending;
    // A WebSocket event can supersede an action's refresh; keep controls busy until its replacement settles.
    for (;;) {
      await pending;
      if (pending === reconciliation.current) return;
      pending = reconciliation.current;
    }
  }, [applySession]);
  useEffect(() => {
    if (!ready) return;
    const unsubscribe = subscribe(() => { void reconcile(); }, setConnected);
    const interval = setInterval(() => { void reconcile(); }, 4000);
    void reconcile(); return () => { generation.current++; unsubscribe(); clearInterval(interval); };
  }, [ready, reconcile]);
  useEffect(() => { if (ready && selected) void reconcile(); }, [ready, selected, reconcile]);
  async function perform(label: string, operation: () => Promise<unknown>) {
    if (operating.current) return false;
    operating.current = true;
    const version = selectionVersion.current;
    setBusy(label); setBusyProject(selection.current); setError('');
    try { await operation(); await reconcile(); return true; }
    catch (e) { if (version === selectionVersion.current) setError(e instanceof Error ? e.message : 'Operation failed'); await reconcile(); return false; }
    finally { operating.current = false; setBusy(''); }
  }
  const action = (label: string, action: string, input: unknown = {}) => perform(label, () => api(`/projects/${selected}/${action}`, input));
  const usable = ready && available;
  const connectionLabel = authFailed ? 'Session unavailable' : !ready ? 'Connecting' : !available ? 'Workspace unavailable' : connected ? (capabilities.connectionLabel) : 'Connected · polling';
  const errorBanner = error && <div className="error-banner" role="alert"><span>{error}</span><Button variant="ghost" aria-label="Dismiss error" onClick={() => setError('')}><X aria-hidden /></Button></div>;
  const previewToolbar = (screenActions: ReactNode) => state && <div className="toolbar" data-canvas-mode={board?.mode}>
          <Button hidden={!pluginEnabled('builder.design')} ref={designButton} className="labelled-action" variant="ghost" aria-label="Design" title="Design" aria-expanded={designOpen && (dock.desktop ? dock.active[dock.layout.positions.design] === 'design' : !assistantOpen)} aria-controls="design-tools" onClick={() => { if (dock.desktop && designOpen && dock.active[dock.layout.positions.design] !== 'design') dock.activate('design', dock.layout.positions.design); else setDesignOpen(!designOpen || (!dock.desktop && assistantOpen)); }}><SlidersHorizontal aria-hidden /><span className="action-label">Design</span></Button>
          <Button hidden={board?.mode === 'overview'} variant="ghost" aria-label="Reload preview" title="Reload active view" disabled={!usable || controlBusy || state?.preview.status !== 'ready' || !!busy} onClick={() => { if (activeView) changeBoard(selected, { type: 'reload', id: activeView.id }); }}><RotateCw aria-hidden /></Button>
          <Button hidden={board?.mode === 'overview'} variant="ghost" className="labelled-action" aria-label="Capture" title="Capture requested route" disabled={!usable || controlBusy || !state || !!busy || state.preview.status !== 'ready'} onClick={() => void action('Capturing', 'capture', { route, viewport })}><Camera aria-hidden /><span className="action-label">Capture</span></Button>
          <Button variant="ghost" className="labelled-action preview-run" data-running={state.preview.status === 'ready'} aria-label={state.preview.status === 'ready' ? 'Stop preview' : 'Start preview'} title={state.preview.status === 'ready' ? 'Stop preview' : 'Start preview'} disabled={!usable || !state || !!busy || (!trusted && state.preview.status !== 'ready')} onClick={() => void action(state?.preview.status === 'ready' ? 'Stopping' : 'Starting', state?.preview.status === 'ready' ? 'stop' : 'start')}>{state?.preview.status === 'ready' ? <Square aria-hidden /> : <Play aria-hidden />}<span className="action-label">{state.preview.status === 'ready' ? 'Stop' : 'Start preview'}</span></Button>
          <PreviewTools key={`tools:${selected}`} state={state} route={route} viewport={viewport} screenActions={screenActions} onRoute={setRoute} onRefresh={() => { void reconcile(); }} onSettings={() => setWorkspace('settings')} onOpenDialog={closePanelsForDialog} />
        </div>;

  const phoneControls = state && <div className="phone-sizes" hidden={board?.mode === 'overview' || (board?.mode === 'compare' && board.comparison === 'sizes')} role="group" aria-label="Phone size">{(['compact', 'large'] as const).map(v => <Button variant="ghost" className="flex-col gap-0.5 px-2.5 py-1 text-[12px] leading-4 text-muted-foreground aria-pressed:border-border aria-pressed:bg-card aria-pressed:text-foreground" key={v} aria-label={v === 'compact' ? 'Compact phone' : 'Large phone'} title={v === 'compact' ? 'Compact phone · 375 × 812' : 'Large phone · 430 × 932'} aria-pressed={viewport === v} onClick={() => setViewport(v)}><span>{v === 'compact' ? 'Compact' : 'Large'}</span><small>{v === 'compact' ? '375 × 812' : '430 × 932'}</small></Button>)}</div>;
  return <WorkspaceDockProvider value={{ ...dock, panes: [
    { id: 'design', label: 'Design', open: pluginEnabled('builder.design') && !!state && designOpen && (dock.desktop || !assistantOpen) && workspace === 'preview' && !creating },
    { id: 'console', label: 'Console', open: !!state && consolePanel !== null },
  ] }}><StudioShell projects={projects} selected={selected} workspace={workspace} backendProviders={providers} backendProvider={backendProvider?.id} onBackendProvider={providerId => { setBackendSelection({ projectId: selected, providerId }); setWorkspace('backend'); }} hiddenDestinations={hiddenDestinations} usable={usable} busy={!!busy} connectionLabel={connectionLabel} pendingReview={pendingReview} contentRef={workspaceContent} onSelect={projectId => { void control({ type: 'select-project', projectId }); }} onNavigate={destination => { setWorkspace(destination); setError(''); }} onCreate={() => setCreating(true)}
    footer={state && <StudioConsole key={selected} state={state} panel={consolePanel} onPanel={setConsolePanel} onLaunchKit={openLaunchKit} onCaptureOpen={closePanelsForDialog} />}
    assistantControl={assistantEnabled && assistant.status?.available && <Button ref={assistantButton} variant="ghost" className="assistant-toggle" aria-label="Assistant" title={assistant.approvals.length ? 'Assistant · waiting for review' : assistant.status.busy ? 'Assistant · working' : 'Assistant'} aria-expanded={assistantOpen} aria-controls="assistant-panel" onClick={() => setAssistantOpen(value => !value)}><MessageSquare aria-hidden /><span className="assistant-label">Assistant</span>{(assistant.status.busy || assistant.error || assistant.connectionError) && <i aria-hidden data-state={assistant.approvals.length ? 'waiting' : assistant.error || assistant.connectionError ? 'error' : 'running'} />}<span className="sr-only" role="status">{assistant.approvals.length ? 'Waiting for review' : assistant.status.busy ? 'Working' : assistant.error || assistant.connectionError ? 'Error' : ''}</span></Button>}
    assistant={{ open: assistantOpen && assistantEnabled && !creating, desktop: dock.desktop, render: host => <AssistantPanel controller={assistant} open={assistantOpen && assistantEnabled && !creating} desktop={dock.desktop} container={host} onOpenChange={setAssistantOpen} trigger={assistantButton} preview={state?.preview} previewDisabled={!usable || controlBusy || !!busy || (!trusted && state?.preview.status !== 'ready')}
      onPreview={async mode => {
        const origin = selected;
        if (!await control({ type: 'navigate', workspace: 'preview' }) || selection.current !== origin) return;
        if (!await changeBoard(origin, { type: 'canvas-mode', mode }) || selection.current !== origin) return;
        if (mode === 'focus' && state?.preview.status !== 'ready') {
          if (!await perform('Starting preview', () => api(`/projects/${origin}/start`, {})) || selection.current !== origin) return;
        }
        if (!dock.desktop) setAssistantOpen(false);
      }} backendEnabled={pluginEnabled('builder.supabase')} onBackend={() => openSupabase('reviews')} projectName={projects.find(project => project.id === selected)?.name} onSettings={() => setWorkspace('settings')} /> }}
    projectStatus={state && <div className="preview-status" data-state={busyProject === selected && busy ? 'busy' : state.preview.status} role="status"><i aria-hidden="true" />{(busyProject === selected && busy) || state.preview.status}</div>}
    banners={<>{connectionError && <div className="error-banner" role="alert">{connectionError}</div>}{!creating && errorBanner}{selected && creativeDrafts.notice && ['assets', 'icons'].includes(workspace) && <p className="draft-storage-notice" role="status">{creativeDrafts.notice}</p>}</>}
    overlays={<><ProjectImport open={importing} onOpenChange={setImporting} onImported={async project => { await reconcile(); await control({ type: 'select-project', projectId: project.id }); }} /><Dialog open={buildOpen && !!state} onOpenChange={setBuildOpen}><DialogContent placement="drawer" className="preview-tool-dialog" data-tool="build" onOpenAutoFocus={event => { event.preventDefault(); buildTitle.current?.focus(); }} onCloseAutoFocus={event => { event.preventDefault(); workspaceContent.current?.querySelector<HTMLButtonElement>('.creation-guide-trigger')?.focus({ preventScroll: true }); }}><header><DialogTitle ref={buildTitle} tabIndex={-1}>Build setup</DialogTitle><DialogDescription>Prepare an installable version of your app.</DialogDescription></header><div className="preview-tool-body">{state && <NativeBuildPanel key={selected} projectId={selected} onRefresh={() => void reconcile()} />}</div></DialogContent></Dialog><CreateProjectDialog onImport={() => { setCreating(false); setImporting(true); }} open={creating} onOpenChange={setCreating} busy={!!busy} backendEnabled={pluginEnabled('builder.supabase')} assistantEnabled={assistantEnabled && !!assistant.status?.available && !!assistant.status?.configured && !assistant.status?.busy} name={name} slug={slug} onName={value => { setName(value); setSlug(value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')); }} onSlug={setSlug} error={errorBanner} onSubmit={async setup => {
      const result = createSchema.safeParse({ name, slug, recipe: 'wellness', preset: 'sage' });
      if (!result.success) { setError('Use a name with letters, numbers, spaces, periods, apostrophes or hyphens and a lowercase directory slug.'); return false; }
      let briefSaved = false;
      const created = await perform('Creating app', async () => { const project = await api<Project>('/projects', result.data);
        if (assistantEnabled && assistant.status?.available && setup.brief) assistant.stageProjectBuild(project.id, projectBuildPrompt(project.name, setup.brief));
        applySession(await api<StudioSession>('/studio')); await control({ type: 'select-project', projectId: project.id });
        setCreating(false);
        if (selection.current === project.id && assistantEnabled && assistant.status?.available) showAssistant();
        try {
          const previous = { ...browserJourney(''), brief: setup.brief, idea: true, backendLater: setup.backend === 'none' };
          const progress = await api<JourneyState>(`/projects/${project.id}/journey`);
          await api(`/projects/${project.id}/journey`, { expectedRevision: progress.revision, patch: previous }); briefSaved = true;
        } catch { setError('Your app was created, but its brief could not be saved. Add it in Your app journey.'); }
        if (setup.build && briefSaved) {
          try { await assistant.buildProject(project.id, projectBuildPrompt(project.name, setup.brief)); }
          catch (cause) { setError(cause instanceof Error ? cause.message : 'Your app is created. Review Assistant history before retrying the first build.'); }
        }
        if (setup.backend === 'supabase' && selection.current === project.id) await control({ type: 'navigate', workspace: 'backend' }); });
      return created && briefSaved;
    }} /></>}>
      {ready && <UnavailableProjects entries={unavailableProjects} localPaths={capabilities.localPaths} disabled={!usable || !!busy} onRetry={() => void reconcile()} onRemove={entry => perform('Removing registration', () => api(`/projects/${entry.project.id}/remove-unavailable`, { expectedRoot: entry.project.root }))} />}
      {ready && !!state && <CreationGuide visible={workspace === 'preview'} key={`guide:${selected}`} projectId={selected} state={state} disabled={!usable || !!busy} mediaEnabled={pluginEnabled('builder.media')} backendEnabled={pluginEnabled('builder.supabase')} assistantEnabled={assistantEnabled && !!assistant.status?.available} buildEnabled={pluginEnabled('builder.expo')} launchKitEnabled={pluginEnabled('builder.launch-kit') && pluginEnabled('builder.media')} onBuild={() => { closePanelsForDialog(); setBuildOpen(true); }} onPublish={() => { void control({ type: 'assets-tab', tab: 'launch-kit' }); }} onNavigate={destination => destination === 'backend' ? openSupabase() : setWorkspace(destination)} onCreate={() => setCreating(true)} onBuildBrief={brief => { assistant.stageProjectBuild(selected, projectBuildPrompt(state.project.name, brief)); showAssistant(); }} onPlan={brief => {
        assistant.setMode('plan');
        if (!assistant.draft.trim()) assistant.setDraft(`${brief.trim() ? `My app idea: ${brief.trim()}\n\n` : ''}Help me define my app idea step by step: who it is for, the problem it solves, the main screens, and its visual direction. Ask me one question at a time.`);
        showAssistant();
      }} />}
      {workspaceUnavailable && <main className="destination"><h1>This feature is disabled</h1><p>Enable its plugin to return to this workspace. Your app source and saved settings are still available.</p><Button onClick={() => setWorkspace('plugins')}>Open Plugins</Button></main>}
      <main hidden={workspace !== 'preview' || workspaceUnavailable} className="main" onKeyDown={event => {
        if (event.key !== 'Escape' || !(event.target instanceof Element)) return;
        const disclosure = event.target.closest('details[open]');
        if (disclosure instanceof HTMLDetailsElement) { event.preventDefault(); event.stopPropagation(); disclosure.open = false; disclosure.querySelector('summary')?.focus(); }
      }}>
        {!trusted && ready && <p className="trust-note">Preview execution is locked. Restart with <code>--trust-execution</code> after reviewing the local-code trust boundary.</p>}
        <div className="preview-workbench">
          <div className="preview-canvas">{state ? <PreviewBoard renderTools={previewToolbar} phoneControls={phoneControls} candidates={state.routeCandidates.candidates.filter(route => route.kind === 'static' && !route.ambiguous).map(route => route.path)} screens={state.screens ?? []} captures={state.boardCaptures ?? []} capturePaused={assistant.status?.active?.projectId === selected} sourceRevision={state.sourceRevision ?? ''} onAskScreens={assistant.status?.available ? screens => {
            const message = `Review ${screens.length === 1 ? 'this screen' : 'these screens'} in ${state.project.name}: ${screens.map(screen => `${screen.name} (${screen.route})`).join(', ')}. Focus your review on this selection. Inspect current source and preview captures before proposing revision-safe changes.`;
            assistant.setDraft(assistant.draft.trim() ? `${assistant.draft}\n\n${message}` : message);
            const images = (state.boardCaptures ?? []).filter(capture => screens.some(screen => screen.route === capture.route)).slice(0, 2).map(capture => ({ projectId: selected, kind: 'board' as const, id: capture.id }));
            assistant.setAttachments({ images });
            showAssistant();
          } : undefined} onAskAssistant={assistant.status?.available ? attachment => { assistant.stageInspector(attachment); showAssistant(); } : undefined} key={`preview:${selected}`} suppressContext={assistantOpen} onRevealContext={() => setAssistantOpen(false)} preview={state.preview} project={state.project} board={board!} onChange={action => changeBoard(selected, action)} active={workspace === 'preview' && !creating} disabled={!usable || controlBusy || !!busy} perform={perform} /> : <div className="empty-workspace"><div className="empty-workspace-mark" aria-hidden><Layers3 /></div><h1>{authFailed ? 'Open a fresh Studio session.' : ready && !projects.length ? 'Create your first app' : 'Preparing your workspace…'}</h1><p>{authFailed ? 'Relaunch Studio from your Dunara runtime. Refresh cannot restore the lost authorization token.' : 'A little idea. A real app. Start with three working screens, then make every detail your own.'}</p><Button disabled={!usable || !!busy} onClick={() => setCreating(true)}>Create your first app</Button>{ready && !projects.length && <div className="empty-workspace-steps"><span><Smartphone aria-hidden />Live preview</span><span><SlidersHorizontal aria-hidden />Your design</span><span><Layers3 aria-hidden />Source you own</span></div>}</div>}</div>
          {state && creativeDrafts.loaded && pluginEnabled('builder.design') && <DesignPanel key={selected} design={state.design} savedDraft={creativeDrafts.value.design} onDraft={draft => creativeDrafts.update({ design: draft })} disabled={!usable || !!busy} onApply={update => action('Applying design', 'design', update)} open={designOpen && (dock.desktop || !assistantOpen) && workspace === 'preview' && !creating} onOpenChange={setDesignOpen} trigger={designButton} />}
        </div>
      </main>
      {ready && selected && creativeDrafts.loaded && pluginEnabled('builder.media') && !workspaceUnavailable && <AssetsPanel assistantStatus={assistant.status} launchKitEnabled={pluginEnabled('builder.launch-kit')} key={`assets:${selected}`} projectId={selected} destination={workspace} settings={settings} state={state} savedBrief={creativeDrafts.value.brief} onBrief={draft => creativeDrafts.update({ brief: draft })} onNavigate={(destination, section) => destination === 'backend' ? openSupabase('reviews') : setWorkspace(destination, section)} onPending={setPendingReview} assetsTab={assetsTab} onAssetsTab={setAssetsTab} savedGeneration={creativeDrafts.value.generation} onGenerationDraft={(scope, draft) => creativeDrafts.update({ generation: { ...creativeDrafts.value.generation, [scope]: draft } })} onIntegrate={assistant.status?.available ? (asset, placement) => {
        const message = `Use the approved ${asset.role} asset "${asset.label}" in my app. Project: ${selected}. Asset ID: ${asset.id}. Local path: ${asset.path}. ${placement ? `Inspect the screen ${placement.route} and place it as ${placement.role} artwork using ${placement.fit} fit.` : 'Inspect the screens and integrate this asset where it fits its intended purpose.'} Preserve its aspect ratio and the existing visual language. Use revision-safe writes.`;
        assistant.stageProjectBuild(selected, message);
        showAssistant();
      } : undefined} savedKitDraft={creativeDrafts.value.kit} onKitDraft={draft => creativeDrafts.update({ kit: draft })} />}
      {workspace === 'settings' && <SettingsPanel initialSection={settingsSection} enabledPlugins={enabledPlugins} project={state?.project} settings={settings} onSettings={setSettings} disabled={!usable} />}
      {workspace === 'plugins' && <PluginsPanel catalog={pluginCatalog} projectId={selected || null} />}
      {workspace === 'backend' && (selected && backendProvider ? backendProvider.id === 'builder.supabase' ? <BackendPanel key={`backend:${selected}`} projectId={selected} disabled={!usable} navigation={backendSelection?.projectId === selected && backendSelection.providerId === 'builder.supabase' ? backendSelection : undefined} /> : <BackendPluginPanel key={`${selected}:${backendProvider.id}`} plugin={backendProvider} projectId={selected} catalog={pluginCatalog} disabled={!usable} /> : <main className="destination backend-workspace"><p className="backend-eyebrow">DATA & SERVICES</p><h1>Backend</h1>{!selected ? <p>Select or create an app to manage its backends.</p> : !pluginCatalog.state ? <p role="status">Loading backend providers…</p> : <><p>No backend providers are enabled. Enable Supabase or install a backend plugin to get started.</p><Button onClick={() => setWorkspace('plugins')}>Open Plugins</Button></>}</main>)}
      {['assets', 'icons', 'activity'].includes(workspace) && !selected && <main className="destination"><h1>{workspace === 'icons' ? 'App Icons' : workspace === 'activity' ? 'Activity' : 'Assets'}</h1><p>Select or create a project to use this workspace. Settings is available without a project.</p></main>}

  </StudioShell></WorkspaceDockProvider>;
}
