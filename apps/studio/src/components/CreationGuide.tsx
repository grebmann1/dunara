import { AppVerification } from './AppVerification';
import { useEffect, useRef, useState } from 'react';
import { ArrowRight, Check, ListChecks } from 'lucide-react';
import { type MediaState, type StudioState, useStudioClient } from '../api';
import type { Backends } from '../../../../packages/core/src/backends';
import type { JourneyState } from '../../../../packages/core/src/journey';
import { journeyPreferencesSchema } from '../../../../packages/core/src/journey-contracts';
import type { Workspace } from './layout/StudioShell';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from './ui/dialog';
import '../creation-guide.css';

type Props = { visible: boolean; projectId: string; state?: StudioState; disabled: boolean; mediaEnabled: boolean; backendEnabled: boolean; assistantEnabled: boolean; buildEnabled: boolean; launchKitEnabled: boolean; onBuild(): void; onPublish(): void; onNavigate(workspace: Workspace): void; onCreate(): void; onBuildBrief(brief: string): void; onPlan(brief: string): void };
type Preferences = { brief?: string; idea?: boolean; assetsLater?: boolean; backendLater?: boolean; tested?: boolean };
export function browserJourney(projectId: string): Preferences {
  try {
    const value = JSON.parse(localStorage.getItem(`builder.creation-guide.v1:${projectId || 'new'}`) ?? '{}');
    if (!value || typeof value !== 'object') return {};
    return Object.fromEntries(['idea', 'assetsLater', 'backendLater'].filter(key => typeof value[key] === 'boolean').map(key => [key, value[key]]));
  } catch { return {}; }
}

export function CreationGuide({ visible, projectId, state, disabled, mediaEnabled, backendEnabled, assistantEnabled, buildEnabled, launchKitEnabled, onBuild, onPublish, onNavigate, onCreate, onPlan, onBuildBrief }: Props) {
  const { api } = useStudioClient();
  const [progress, setProgress] = useState<JourneyState>();
  const [local, setLocal] = useState(() => journeyPreferencesSchema.parse(browserJourney('')));
  const [brief, setBrief] = useState(''), dirty = useRef(false);
  const [draftRevision, setDraftRevision] = useState<string>();
  const [saving, setSaving] = useState(false), operating = useRef(false), alive = useRef(true), version = useRef(0);
  const [error, setError] = useState('');
  const [media, setMedia] = useState<MediaState>(), [backend, setBackend] = useState<Awaited<ReturnType<Backends['inspect']>>>();
  const [unavailable, setUnavailable] = useState(false), [selected, setSelected] = useState<number>(), [expanded, setExpanded] = useState(false);
  useEffect(() => { if (!visible) setExpanded(false); }, [visible]);
  const preferences = projectId ? progress?.preferences ?? journeyPreferencesSchema.parse({}) : local;
  const tested = !!preferences.testedSourceRevision && preferences.testedSourceRevision === state?.sourceRevision;
  const stale = !!preferences.testedSourceRevision && !tested;
  const legacy = projectId && progress && !progress.saved ? browserJourney(projectId) : {};
  const conflict = dirty.current && !!progress && draftRevision !== progress.revision;
  const locked = disabled || saving || (!!projectId && !progress);
  async function remember(patch: Preferences) {
    if (operating.current) return false;
    if (!projectId) {
      const next = { ...local, ...patch }; setLocal(next);
      try { localStorage.setItem('builder.creation-guide.v1:new', JSON.stringify(next)); } catch { /* Pre-project progress is optional. */ }
      return true;
    }
    if (!progress) return false;
    operating.current = true; version.current++; setSaving(true); setError('');
    try {
      const next = await api<JourneyState>(`/projects/${projectId}/journey`, { expectedRevision: patch.brief !== undefined && dirty.current ? draftRevision : progress.revision, patch, ...(patch.tested ? { sourceRevision: state?.sourceRevision } : {}) });
      if (alive.current) { setProgress(next); if (patch.brief !== undefined) { dirty.current = false; setDraftRevision(next.revision); setBrief(next.preferences.brief); } }
      return true;
    } catch (cause) {
      if (alive.current) setError(cause instanceof Error ? cause.message : 'Progress could not be saved. Try again.');
      try { const current = await api<JourneyState>(`/projects/${projectId}/journey`); if (alive.current) setProgress(current); } catch { /* Retain the draft and visible error. */ }
      return false;
    } finally { operating.current = false; if (alive.current) setSaving(false); }
  }
  useEffect(() => {
    alive.current = true;
    if (!projectId || disabled) return () => { alive.current = false; };
    let mounted = true, pending = false;
    async function load() {
      if (pending || operating.current) return; pending = true;
      const request = ++version.current;
      const results = await Promise.allSettled([
        api<JourneyState>(`/projects/${projectId}/journey`),
        mediaEnabled ? api<MediaState>(`/projects/${projectId}/media`) : Promise.resolve(undefined),
        backendEnabled ? api<Awaited<ReturnType<Backends['inspect']>>>(`/projects/${projectId}/backend`) : Promise.resolve(undefined),
      ]);
      if (mounted && request === version.current) {
        if (results[0].status === 'fulfilled') { const next = results[0].value; setProgress(next); if (!dirty.current) setBrief(next.preferences.brief); }
        setMedia(results[1].status === 'fulfilled' ? results[1].value : undefined);
        setBackend(results[2].status === 'fulfilled' ? results[2].value : undefined);
        setUnavailable(results.some(result => result.status === 'rejected'));
      }
      pending = false;
    }
    void load(); const timer = setInterval(() => void load(), 4000);
    return () => { mounted = false; alive.current = false; clearInterval(timer); };
  }, [projectId, disabled, mediaEnabled, backendEnabled, api]);
  const linked = !!backend?.environments.some(binding => binding.environment === backend.activeEnvironment);
  const steps = [
    { id: 'idea', title: 'Ideate', complete: preferences.idea, later: false, description: 'Describe who your app helps and what it should do.', action: 'Plan with Assistant', run: () => onPlan(brief), blocked: !assistantEnabled },
    { id: 'backend', title: 'Connect Supabase', complete: linked, later: !!preferences.backendLater || !backendEnabled, description: linked ? 'Your backend is connected. Manage sign-in, data, and storage in Backend.' : 'Need accounts or shared data? Connect Supabase before building those features. You can also continue without a backend.', action: linked ? 'Open Backend' : 'Set up Supabase', run: () => projectId ? onNavigate('backend') : onCreate(), blocked: !backendEnabled },
    { id: 'create', title: 'Create', complete: !!state, later: false, description: state ? 'Your workspace is ready. Shape your app with the Assistant.' : 'Name your app and describe the idea. Backend setup is optional.', action: state ? 'Open workspace' : 'Create your app', run: () => state ? onNavigate('preview') : onCreate(), blocked: false },
    { id: 'assets', title: 'Add assets', complete: !!media?.assets.length, later: !!preferences.assetsLater || !mediaEnabled, description: 'Bring in a logo, photos, or visual references. You can also attach images in the Assistant.', action: 'Open Assets', run: () => onNavigate('assets'), blocked: !mediaEnabled || !projectId },
    { id: 'test', title: 'Preview & test', complete: tested, later: false, description: stale ? 'Your app changed since your last recorded checks. Test this version again.' : tested ? 'You recorded checks for this version. This is your report, not automatic device verification.' : 'Walk through your screens and try the app on your phone. Record your checks when you finish.', action: 'Open preview', run: () => onNavigate('preview'), blocked: !projectId },
    { id: 'build', title: 'Build', complete: false, later: false, description: 'Prepare your app, build an iPhone or Android preview app with local tools, then review installation on your phone. Finish by checking the installed app with the preview server stopped.', action: 'Open build setup', run: onBuild, blocked: !buildEnabled || !projectId },
    { id: 'publish', title: 'Publish', complete: false, later: false, description: 'Prepare screenshots, an icon, and listing copy. A Launch Kit does not publish your app. Deployment and store submission are still separate steps.', action: 'Open Launch Kit', run: onPublish, blocked: !launchKitEnabled || !projectId },
  ];
  const current = steps.findIndex(step => !step.complete && !step.later);
  const active = selected ?? (current < 0 ? steps.length - 1 : current), step = steps[active]!;
  const count = steps.filter(step => step.complete).length;
  const launch = () => { setExpanded(false); step.run(); };
  return <div className="creation-guide" hidden={!visible}>
    <Dialog open={expanded} onOpenChange={setExpanded}>
      <DialogTrigger asChild><button className="creation-guide-trigger"><ListChecks size={15} aria-hidden /><strong>Your app journey</strong><span className="creation-guide-next">{current < 0 ? 'Keep building' : `Next: ${steps[current]!.title}`}</span><span className="creation-guide-count">{count}/{steps.length} done</span><ArrowRight size={14} aria-hidden /></button></DialogTrigger>
      <DialogContent placement="drawer" className="creation-guide-panel" onCloseAutoFocus={event => { if (!expanded && document.querySelector('[role="dialog"]:not(.creation-guide-panel)')) event.preventDefault(); }}>
        <header className="creation-guide-heading"><DialogTitle>Your app journey</DialogTitle><DialogDescription>One step at a time. Pick up wherever you need.</DialogDescription></header>
        <ol aria-label="App creation stages">{steps.map((item, index) => <li key={item.id}><button type="button" aria-current={index === current ? 'step' : undefined} aria-pressed={active === index} onClick={() => setSelected(index)}><span className="creation-step-number" data-complete={item.complete}>{item.complete ? <Check size={12} aria-hidden /> : index + 1}</span><span>{item.title}<small>{item.complete ? 'Done' : item.later ? 'Later · optional' : item.id === 'test' && stale ? 'Check again' : index === current ? 'Up next' : 'To do'}</small></span></button></li>)}</ol>
        {error && <p role="alert">{error}</p>}
        {conflict && <div className="creation-brief-conflict" role="status"><p>Progress changed while you were editing. Your draft is kept. Latest saved brief: {progress?.preferences.brief || 'No brief saved.'}</p><Button variant="outline" disabled={locked} onClick={() => { setDraftRevision(progress?.revision); setError(''); }}>Review my draft against latest progress</Button><Button variant="ghost" disabled={locked} onClick={() => { dirty.current = false; setBrief(progress?.preferences.brief ?? ''); setDraftRevision(progress?.revision); setError(''); }}>Use saved brief</Button></div>}
        {Object.keys(legacy).length > 0 && <Button variant="outline" disabled={locked} onClick={() => void remember(legacy)}>Import saved browser progress</Button>}
        <section className="creation-guide-detail" aria-label={`${step.title} guidance`}>
          <h2>{step.id === 'idea' ? 'What are you making?' : step.title}</h2><p>{step.description}</p>
          {step.id === 'idea' && projectId && <label className="creation-brief">Your app brief<textarea value={brief} maxLength={2000} rows={3} disabled={locked} onChange={event => { if (!dirty.current) setDraftRevision(progress?.revision); dirty.current = true; setBrief(event.target.value); }} placeholder="An app for… that helps them…" /><small>Saved with your project. No passwords or private keys.</small></label>}
          {unavailable && <p role="status">Some progress is unavailable. Reconnecting…</p>}
          {step.id === 'test' && state && <AppVerification state={state} />}
          <div className="creation-guide-actions">
            {step.id === 'idea' ? <>
              <Button disabled={locked || conflict} onClick={async () => { if (await remember({ idea: true, ...(projectId ? { brief } : {}) })) setSelected(1); }}>Save & continue<ArrowRight size={14} aria-hidden /></Button>
              <Button variant="outline" disabled={locked || step.blocked} onClick={launch}>{step.action}</Button>
              {projectId && assistantEnabled && <Button variant="outline" disabled={locked || conflict || !brief.trim()} onClick={async () => { if (await remember({ brief, idea: true }) && alive.current) { setExpanded(false); onBuildBrief(brief); } }}>Build from brief</Button>}
              {projectId && brief.trim() !== preferences.brief && <Button variant="ghost" disabled={locked || conflict} onClick={() => void remember({ brief })}>Save brief</Button>}
            </> : <>
              <Button disabled={locked || step.blocked} onClick={launch}>{step.action}<ArrowRight size={14} aria-hidden /></Button>
              {step.id === 'test' && <Button variant="ghost" disabled={locked || !state || (!tested && state.preview.status !== 'ready')} onClick={() => void remember({ tested: !tested })}>{tested ? 'Test again' : 'I’ve tested my app'}</Button>}
              {(step.id === 'assets' || step.id === 'backend') && !step.complete && <Button variant="ghost" disabled={locked} onClick={() => { void remember(step.id === 'assets' ? { assetsLater: !preferences.assetsLater } : { backendLater: !preferences.backendLater }); setSelected(undefined); }}>{step.later ? 'Include this step' : 'Do this later'}</Button>}
            </>}
          </div>
        </section>
      </DialogContent>
    </Dialog>
  </div>;
}
