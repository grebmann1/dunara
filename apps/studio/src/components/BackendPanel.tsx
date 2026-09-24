import { useEffect, useId, useRef, useState } from 'react';
import { Database, ExternalLink, RefreshCw, ShieldCheck } from 'lucide-react';
import type { Backends } from '../../../../packages/core/src/backends';
import { anyBackendPlan, type BackendPlan } from '../../../../packages/core/src/backend-contracts';
import { BackendConfigurationPanel, ConfigurationDiff } from './BackendConfigurationPanel';
import type { EnvironmentName, Operation } from '../../../../packages/platform/src/contracts';
import { useStudioClient } from '../api';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { RecipeUpgradePanel } from './RecipeUpgradePanel';
import '../backend.css';
import { BackendOAuthSettings } from './BackendOAuthSettings';

type Inspection = Awaited<ReturnType<Backends['inspect']>>;
type Catalog = Awaited<ReturnType<Backends['catalog']>>;
const environments: EnvironmentName[] = ['development', 'staging', 'production'];
const stateLabels: Record<Operation['state'], string> = { awaiting_approval: 'Needs your review', queued: 'Queued', running: 'Running', succeeded: 'Completed', failed: 'Failed', cancelled: 'Cancelled', reconciliation_required: 'Check remote outcome' };

export function SupabaseSettings({ disabled, onConnected, compact = false }: { disabled: boolean; onConnected?: () => Promise<void>; compact?: boolean }) {
  const { api, capabilities } = useStudioClient();
  const fieldId = useId(), privacyId = useId();
  const [status, setStatus] = useState<ReturnType<Backends['status']>>();
  const [remember, setRemember] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const token = useRef<HTMLInputElement>(null), alive = useRef(true), operating = useRef(false);
  useEffect(() => {
    alive.current = true; const input = token.current;
    void api<ReturnType<Backends['status']>>('/backend/connection').then(value => { if (alive.current) setStatus(value); }).catch(() => { if (alive.current) setError('Supabase settings unavailable.'); });
    return () => { alive.current = false; if (input) input.value = ''; };
  }, []);
  async function update(action: 'connect' | 'disconnect') {
    if (disabled || operating.current) return;
    operating.current = true; setBusy(true); setError(''); setNotice('');
    try {
      const pending = api<ReturnType<Backends['status']>>('/backend/connection', { action, ...(action === 'connect' ? { token: token.current?.value ?? '', remember } : {}) });
      if (token.current) token.current.value = '';
      const result = await pending;
      if (alive.current && action === 'connect') await onConnected?.();
      if (alive.current) { setStatus(result); setNotice(action === 'connect' ? onConnected ? 'Account saved. Choose your project below to finish connecting this app.' : 'Connection saved. Open Backend to choose or create a project for your app.' : 'Management connection removed. Existing app connections are retained.'); }
    } catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : 'Connection update failed.'); }
    finally { operating.current = false; if (token.current) token.current.value = ''; if (alive.current) setBusy(false); }
  }
  return <>{capabilities.backendOAuth && <BackendOAuthSettings disabled={disabled || busy || !!status?.busy} onChange={async () => { const next = await api<ReturnType<Backends['status']>>('/backend/connection'); if (alive.current) { setStatus(next); if (next.configured) await onConnected?.(); } }} />}<section className="settings-section backend-connection" aria-label="Supabase connection">
    <div className="backend-heading"><Database aria-hidden /><h2>{compact ? 'Connect your account' : 'Supabase'}</h2>{!compact && <span className="backend-badge">{status?.configured ? `${status.source} connection` : 'Connect your account'}</span>}</div>
    {!compact && <p>Connect your account, then choose a project for your app.</p>}
    <details className="supabase-token-help"><summary>How to get a Supabase token</summary><ol className="supabase-connect-steps"><li><a href="https://supabase.com/dashboard" target="_blank" rel="noreferrer">Open Supabase <ExternalLink size={14} aria-hidden /></a> and sign in or create an account.</li><li><a href="https://supabase.com/dashboard/account/tokens" target="_blank" rel="noreferrer">Create a personal access token <ExternalLink size={14} aria-hidden /></a>, give it a name such as “Dunara”, and copy it.</li><li>Paste the token below and save your connection. Next, choose an existing project or create one.</li></ol></details>
    <form autoComplete="off" onSubmit={event => { event.preventDefault(); void update('connect'); }}><fieldset disabled={disabled || busy || !status || status.busy || status.encryption.state === 'unavailable'}>
      <label htmlFor={fieldId}>Personal access token</label>
      <Input id={fieldId} ref={token} type="password" required minLength={16} maxLength={4096} autoComplete="off" spellCheck={false} autoCapitalize="none" aria-describedby={privacyId} />
      <p id={privacyId}>Kept private in Dunara. Never shared with your app or the Assistant.</p>
      <label className="backend-check"><input type="checkbox" checked={remember} disabled={!status?.rememberAvailable} onChange={event => setRemember(event.target.checked)} />Remember with encrypted storage</label>
      {!compact && status?.encryption.state === 'not_configured' && <p>Session storage is available now. Persistent connections require an encryption key in the Dunara service configuration.</p>}
      {status?.encryption.state === 'unavailable' && <p>Saved connections are locked. Restore the original encryption key before changing this connection.</p>}
      <div className="backend-actions"><Button type="submit">Save Supabase connection</Button>{!compact && <Button variant="outline" type="button" disabled={!status?.configured} onClick={() => void update('disconnect')}>Disconnect</Button>}<a href="https://supabase.com/dashboard/account/tokens" target="_blank" rel="noreferrer">Get a token <ExternalLink size={14} aria-hidden /></a></div>
    </fieldset></form>
    {(error || status?.issue) && <p role="alert">{error || status?.issue}</p>}<p role="status">{busy ? 'Updating connection…' : notice}</p>
  </section></>;
}

export function BackendPanel({ projectId, disabled, onSettings }: { projectId: string; disabled: boolean; onSettings: () => void }) {
  const { api } = useStudioClient();
  const [connecting, setConnecting] = useState(false);
  const connectionForm = useRef<HTMLDivElement>(null), projectForm = useRef<HTMLElement>(null);
  useEffect(() => { if (connecting) { connectionForm.current?.scrollIntoView({ block: 'start' }); connectionForm.current?.focus({ preventScroll: true }); } }, [connecting]);
  const [state, setState] = useState<Inspection>(), [catalog, setCatalog] = useState<Catalog>();
  const [capabilities, setCapabilities] = useState<Awaited<ReturnType<Backends['capabilities']>>>();
  const [environment, setEnvironment] = useState<EnvironmentName>('development'), [mode, setMode] = useState<'link' | 'create' | 'migration'>('link');
  const [organization, setOrganization] = useState(''), [projectRef, setProjectRef] = useState(''), [name, setName] = useState(''), [region, setRegion] = useState('eu-central-1'), [migration, setMigration] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const alive = useRef(true), operating = useRef(false), version = useRef(0);
  const base = `/projects/${projectId}/backend`;
  async function refresh() { const request = ++version.current; const next = await api<Inspection>(base); if (alive.current && version.current === request) setState(next); }
  useEffect(() => {
    alive.current = true;
    const load = () => { if (!operating.current) void refresh().catch(() => { if (alive.current) setError('Backend status unavailable. Retry when the local service is connected.'); }); };
    load(); const timer = setInterval(load, 2000);
    return () => { alive.current = false; version.current++; clearInterval(timer); };
    // The app keys this panel by project, so drafts cannot cross app boundaries.
  }, [projectId]);
  async function perform(action: () => Promise<unknown>, message = '') {
    if (disabled || operating.current) return;
    operating.current = true; setBusy(true); setError(''); setNotice('');
    try { await action(); await refresh(); if (alive.current) setNotice(message); }
    catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : 'Backend operation failed.'); }
    finally { operating.current = false; if (alive.current) setBusy(false); }
  }
  async function loadCatalog(more = false) {
    const previous = more ? catalog : undefined;
    const input = previous && previous.pagination.nextOffset !== null ? { offset: previous.pagination.nextOffset, expectedRevision: previous.revision } : {};
    const next = await api<Catalog>(`${base}/catalog`, input);
    if (alive.current) {
      setCatalog(previous ? { ...next, organizations: [...previous.organizations, ...next.organizations], projects: [...previous.projects, ...next.projects] } : next);
      if (!previous) { setOrganization(''); setProjectRef(''); }
    }
  }
  async function checkAccess() { const report = await api<Awaited<ReturnType<Backends['capabilities']>>>(`${base}/capabilities`, { environment }); if (alive.current) setCapabilities(report); }
  async function propose() {
    const input = mode === 'link' ? { action: mode, environment, organization, projectRef } : mode === 'create' ? { action: mode, environment, organization, name, region } : { action: mode, environment, path: migration };
    const plan = await api<BackendPlan>(`${base}/plan`, input);
    await api(`${base}/apply`, { plan, requestId: crypto.randomUUID() });
  }
  return <main className="destination backend-workspace">
    <header className="backend-title"><div><p className="backend-eyebrow">DATA & SERVICES</p><h1>Backend</h1><p>A Supabase home for your app’s users, data, and files.</p></div><Button variant="outline" disabled={disabled || busy} onClick={() => void perform(refresh)}><RefreshCw size={16} aria-hidden />Refresh</Button></header>
    {error && <p role="alert" className="backend-alert">{error}</p>}<p role="status">{busy ? 'Working…' : notice}</p>
    {!state ? <p>Loading backend…</p> : <>
      <section className="backend-card backend-setup-guide" aria-label="Supabase setup guide">
        <p className="backend-eyebrow">{state.environments.some(binding => binding.environment === environment) ? 'PROJECT CONNECTED' : !state.connection.configured ? 'STEP 1 OF 3' : catalog ? 'STEP 3 OF 3' : 'STEP 2 OF 3'}</p>
        <h2>{state.environments.some(binding => binding.environment === environment) ? 'Your app has a Supabase home' : !state.connection.configured ? 'Connect Supabase to get started' : catalog ? 'Choose a project, then review' : 'Choose where your app’s data lives'}</h2>
        <p>Use Supabase when your app needs accounts, saved data, or file uploads. Start with development; staging and production can wait.</p>
        <details className="backend-connection-help"><summary>How connection works</summary><ol><li><strong>Connect your account.</strong> Sign in through the browser when available, or use a personal access token.</li><li><strong>Choose or create a project.</strong> Load your organizations and projects below. If you have none, create an organization in the <a href="https://supabase.com/dashboard" target="_blank" rel="noreferrer">Supabase dashboard</a>, then load again.</li><li><strong>Review and connect.</strong> Choose “Prepare for review”, then approve the connection in Changes & reviews. Creating a project may incur Supabase charges.</li></ol></details>
        {!state.connection.configured && <Button onClick={() => setConnecting(true)} disabled={disabled || connecting}>Connect Supabase account</Button>}
        {state.connection.configured && !catalog && <Button disabled={disabled || busy} onClick={() => void perform(() => loadCatalog())}>Choose my Supabase project</Button>}
        <Button variant="ghost" onClick={onSettings} disabled={disabled}>Connection settings</Button>
      </section>
      {connecting && !state.connection.configured && <div ref={connectionForm} className="backend-inline-connection" tabIndex={-1}><SupabaseSettings disabled={disabled || busy} onConnected={async () => {
        await perform(() => loadCatalog(), 'Account connected. Choose a project and prepare it for review below.');
        if (alive.current) { projectForm.current?.scrollIntoView({ block: 'start' }); projectForm.current?.focus({ preventScroll: true }); }
      }} /></div>}
      <details className="backend-card"><summary>Advanced app setup</summary><RecipeUpgradePanel key={projectId} projectId={projectId} disabled={disabled || busy} /></details>
      {state.connection.configured && <>
      <div className="backend-environments">{environments.map(env => { const binding = state.environments.find(value => value.environment === env); return <section key={env} className="backend-card" data-selected={state.activeEnvironment === env}><div className="backend-heading"><h2>{env}</h2>{state.activeEnvironment === env && <span className="backend-badge">Preview</span>}</div><p>{binding ? binding.projectRef : 'No project connected'}</p>{binding ? <><a href={`https://supabase.com/dashboard/project/${binding.projectRef}`} target="_blank" rel="noreferrer">Open Supabase <ExternalLink size={14} aria-hidden /></a><Button variant="outline" disabled={disabled || busy || env === state.activeEnvironment} onClick={() => void perform(() => api(`${base}/environment`, { environment: env, expectedRevision: state.environmentRevision }), 'Preview environment selected. Start the preview to load this configuration.')}>Use for preview</Button></> : <span className="backend-muted">{env === 'development' ? 'Start here for daily development.' : 'Connect when your app needs it.'}</span>}</section>; })}</div>
      <section ref={projectForm} tabIndex={-1} className="backend-card" aria-label="Configure backend"><h2>Configure this app</h2><p>Prepare a change here or ask the Assistant. Every change appears below for review before execution.</p>
        <Button variant="outline" disabled={disabled || busy} onClick={() => void perform(checkAccess)}>Check Supabase access</Button>
        {capabilities && capabilities.environment === environment && capabilities.connectionRevision === state.connection.revision && capabilities.environmentRevision === state.environmentRevision && <div role="status"><p>{capabilities.reads.filter(read => read.permission === 'verified').length} access checks passed for {environment}. Write permissions will be checked when an approved change runs.</p>{capabilities.reads.filter(read => read.error).map(read => <p key={read.id}>{read.id.replaceAll('_', ' ')}: {read.error?.message}</p>)}</div>}
        <form onSubmit={event => { event.preventDefault(); void perform(propose, 'Proposal ready for review.'); }}><fieldset disabled={disabled || busy || !state.connection.configured}>
          <div className="backend-form-grid"><label>Environment<select value={environment} onChange={event => setEnvironment(event.target.value as EnvironmentName)}>{environments.map(env => <option key={env}>{env}</option>)}</select></label><label>Change<select value={mode} onChange={event => setMode(event.target.value as typeof mode)}><option value="link">Connect an existing project</option><option value="create">Create a Supabase project</option><option value="migration">Apply a SQL migration</option></select></label></div>
          {mode === 'migration' ? <label>Migration file<Input required value={migration} onChange={event => setMigration(event.target.value)} placeholder="supabase/migrations/20260917000100_initial.sql" /></label> : <><Button type="button" variant="outline" onClick={() => void perform(() => loadCatalog())}>Load Supabase projects</Button>{catalog && <p>{catalog.organizations.length} of {catalog.pagination.totalOrganizations} organizations · {catalog.projects.length} of {catalog.pagination.totalProjects} projects loaded.{catalog.pagination.truncated && <> More results are available. <Button type="button" variant="outline" onClick={() => void perform(() => loadCatalog(true))}>Load more projects</Button></>}</p>}<div className="backend-form-grid"><label>Organization<select required value={organization} onChange={event => { setOrganization(event.target.value); setProjectRef(''); }}><option value="">Select organization</option>{catalog?.organizations.map(org => <option key={org.slug} value={org.slug}>{org.name}</option>)}</select></label>{mode === 'link' ? <label>Supabase project<select required value={projectRef} onChange={event => setProjectRef(event.target.value)}><option value="">Select project</option>{catalog?.projects.filter(project => project.organization === organization).map(project => <option key={project.ref} value={project.ref}>{project.name} · {project.region}</option>)}</select></label> : <><label>Project name<Input required value={name} maxLength={100} onChange={event => setName(event.target.value)} /></label><label>Region code<Input required value={region} pattern="[a-z0-9-]{2,80}" onChange={event => setRegion(event.target.value)} /></label></>}</div></>}
          {environment === 'production' && <p className="backend-alert">This target is production. Review recovery and compatibility with installed apps before approving SQL.</p>}
          <Button type="submit">Prepare for review</Button>
        </fieldset></form>
      </section>
      {state.environments.some(binding => binding.environment === environment) && <BackendConfigurationPanel key={`${projectId}:${environment}`} projectId={projectId} environment={environment} disabled={disabled || busy} rememberAvailable={state.connection.rememberAvailable} refresh={refresh} />}
      </>}
      {(state.connection.configured || state.operations.length > 0) && <section aria-label="Backend operations"><div className="backend-heading"><ShieldCheck aria-hidden /><h2>Changes & reviews</h2></div>{!state.operations.length && <p>No changes yet. Your connection and migration history will appear here.</p>}{state.operations.map(operation => <OperationReview key={operation.id} operation={operation} disabled={disabled || busy} onApprove={() => void perform(() => api(`${base}/approve`, { operationId: operation.id, planHash: operation.planHash }))} onCancel={() => void perform(() => api(`${base}/cancel`, { operationId: operation.id }))} onReconcile={() => void perform(() => api(`${base}/reconcile`, { operationId: operation.id, planHash: operation.planHash, fence: operation.fence }), 'Checking the existing project and migration history.')} />)}</section>}
    </>}
  </main>;
}

export function OperationReview({ operation: op, disabled, onApprove, onCancel, onReconcile }: { operation: Operation & { steps?: { name: string; state: string }[] }; disabled: boolean; onApprove: () => void; onCancel: () => void; onReconcile: () => void }) {
  const decoded = anyBackendPlan.safeParse(op.plan);
  if (!decoded.success) return <article className="backend-card"><h3>Unsupported operation</h3><p>{op.error ?? 'Update Dunara or prepare a new supported plan. This operation cannot execute.'}</p></article>;
  const plan = decoded.data;
  return <article className="backend-card backend-operation"><div className="backend-heading"><h3>{plan.version === 2 ? 'Configure app services' : plan.action === 'migration' ? 'Apply migration' : plan.action === 'create' ? 'Create project' : 'Connect project'}</h3><span className="backend-badge">{stateLabels[op.state]}</span></div><p><strong>{op.environment}</strong> · {plan.target.organization} · {plan.target.projectRef ?? (plan.version === 1 ? plan.target.name : '')} {plan.version === 1 && plan.target.region && `· ${plan.target.region}`}</p>
    <ul>{plan.consequences.map((item, index) => <li key={index}>{item}</li>)}</ul>
    {plan.version === 2 && <ConfigurationDiff plan={plan} />}
    {op.steps?.length ? <ol>{op.steps.map(step => <li key={step.name}>{step.name} · {step.state.replaceAll('_', ' ')}</li>)}</ol> : null}
    {plan.version === 1 && plan.migration && <details open={op.state === 'awaiting_approval'}><summary>{plan.migration.path}</summary><pre tabIndex={0}>{plan.migration.query}</pre></details>}
    {op.error && <p role="alert">{op.error}</p>}{op.state === 'reconciliation_required' && <><p>Execution stopped with an uncertain outcome. Check the existing project to recover confirmed work. Further changes remain paused until its outcome is verified.</p><Button variant="outline" disabled={disabled} onClick={onReconcile}>Check recovery</Button></>}
    {op.state === 'awaiting_approval' && <div className="backend-actions"><Button disabled={disabled} onClick={onApprove}>{plan.version === 2 ? `Approve configuration on ${op.environment}` : plan.action === 'create' ? 'Approve project creation' : plan.action === 'migration' ? `Approve SQL on ${op.environment}` : 'Approve connection'}</Button><Button variant="outline" disabled={disabled} onClick={onCancel}>Discard</Button></div>}
    {['queued', 'running'].includes(op.state) && <Button variant="outline" disabled={disabled} onClick={onCancel}>Stop further execution</Button>}
  </article>;
}
