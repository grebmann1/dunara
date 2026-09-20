import { useEffect, useRef, useState } from 'react';
import { LockKeyhole } from 'lucide-react';
import type { AssistantSetupRequest } from '../../../../packages/assistant/src/contracts';
import type { Backends } from '../../../../packages/core/src/backends';
import type { BackendConfiguration } from '../../../../packages/core/src/backend-configuration';
import { anyBackendPlan } from '../../../../packages/core/src/backend-contracts';
import { useStudioClient } from '../api';
import { Button } from './ui/button';
import { OperationReview, SupabaseSettings } from './BackendPanel';
import { SecureBackendInput } from './SecureBackendInput';
import '../assistant-setup.css';

type Inspection = Awaited<ReturnType<Backends['inspect']>>;
type Inventory = Awaited<ReturnType<BackendConfiguration['functionEnvironment']>>;
type Catalog = Awaited<ReturnType<Backends['catalog']>>;
type Props = { request: AssistantSetupRequest; disabled: boolean; initialOpen?: boolean; onBackend(): void; onContinue(message: string): void };

export function AssistantSetupCard({ initialOpen = false, ...props }: Props) {
  const [open, setOpen] = useState(initialOpen);
  return <details className="assistant-setup" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary><LockKeyhole size={15} aria-hidden /><span>{props.request.kind === 'supabase' ? 'Connect Supabase' : 'Set up app AI'}<small>{props.request.environment} · Private setup</small></span></summary>
    {open && <SetupForm {...props} />}
  </details>;
}

function SetupForm({ request, disabled, onBackend, onContinue }: Omit<Props, 'initialOpen'>) {
  const { api } = useStudioClient();
  const { projectId, environment, kind } = request, base = `/projects/${projectId}/backend`;
  const [state, setState] = useState<Inspection>(), [inventory, setInventory] = useState<Inventory>(), [catalog, setCatalog] = useState<Catalog>();
  const [organization, setOrganization] = useState(''), [projectRef, setProjectRef] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const alive = useRef(true), operating = useRef(false), version = useRef(0);
  const binding = state?.environments.find(item => item.environment === environment);
  const variable = inventory?.variables.find(item => item.name === 'OPENAI_API_KEY');
  const locked = disabled || busy || !!state?.connection.busy || state?.connection.encryption.state === 'unavailable';
  async function load() {
    const revision = ++version.current;
    const [next, variables] = await Promise.all([
      api<Inspection>(base),
      kind === 'app_openai' ? api<Inventory>(`${base}/function-environment-list`, { environment }) : Promise.resolve(undefined),
    ]);
    if (!alive.current || version.current !== revision) return;
    setState(next); setInventory(variables);
    setCatalog(current => current && current.connectionRevision !== next.connection.revision ? undefined : current);
  }
  useEffect(() => {
    alive.current = true;
    const refresh = () => { if (!operating.current) void load().catch(() => { if (alive.current) setError('Setup status is unavailable. Refresh to try again.'); }); };
    refresh(); const timer = setInterval(refresh, 2500);
    return () => { alive.current = false; version.current++; clearInterval(timer); };
    // Parent keys this private form by project, account, environment and request.
  }, []);
  async function run(action: () => Promise<unknown>) {
    if (disabled || operating.current) return;
    operating.current = true; setBusy(true); setError('');
    try { await action(); if (alive.current) await load(); }
    catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : 'Setup failed. Refresh the current state before trying again.'); }
    finally { operating.current = false; if (alive.current) setBusy(false); }
  }
  async function loadCatalog(more = false) {
    const previous = more ? catalog : undefined;
    const next = await api<Catalog>(`${base}/catalog`, previous && previous.pagination.nextOffset !== null ? { offset: previous.pagination.nextOffset, expectedRevision: previous.revision } : {});
    if (!alive.current) return;
    setCatalog(previous ? { ...next, organizations: [...previous.organizations, ...next.organizations], projects: [...previous.projects, ...next.projects] } : next);
    if (!previous) { setOrganization(''); setProjectRef(''); }
  }
  async function propose(input: Record<string, unknown>) {
    const plan = await api(`${base}/plan`, { ...input, environment });
    if (!alive.current) return;
    await api(`${base}/apply`, { plan, requestId: crypto.randomUUID() });
  }
  const operations = state?.operations.filter(op => {
    if (op.environment !== environment) return false;
    const decoded = anyBackendPlan.safeParse(op.plan);
    if (!decoded.success) return false;
    const plan = decoded.data;
    return plan.version === 1 ? ['link', 'create'].includes(plan.action) : kind === 'app_openai' && plan.steps.some(step => step.kind === 'function_secrets' && step.bindings.some(item => item.name === 'OPENAI_API_KEY'));
  }) ?? [];
  const pending = operations.filter(op => ['awaiting_approval', 'queued', 'running', 'reconciliation_required'].includes(op.state));
  const published = !!variable?.input.available && operations.some(op => {
    const decoded = anyBackendPlan.safeParse(op.plan);
    return op.state === 'succeeded' && decoded.success && decoded.data.version === 2 && decoded.data.target.projectRef === binding?.projectRef && decoded.data.secrets.some(secret => secret.name === variable.secret && secret.revision === variable.input.revision);
  });
  const ready = kind === 'supabase' ? !!binding : published;
  const latestOperation = [...operations].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  return <div className="assistant-setup-body">
    <p>{kind === 'supabase' ? 'Connect an account, choose a project, then review the connection here.' : 'Add OpenAI to your app through Supabase. Your Assistant connection stays separate.'}</p>
    <ol className="assistant-setup-steps" aria-label="Setup steps">
      <li data-done={!!binding}>1. Supabase</li><li data-done={kind === 'app_openai' ? !!variable?.input.available : !!binding}>2. {kind === 'app_openai' ? 'Private key' : 'Project'}</li><li data-done={ready}>3. Review</li>
    </ol>
    {disabled && <p role="status">Setup is paused while the Assistant works or Plan mode is selected.</p>}
    {!state ? <p role="status">Loading setup…</p> : <>
      {binding && <p className="assistant-setup-target"><strong>{environment}</strong> · {binding.organization} / {binding.projectRef}</p>}
      {!state.connection.configured ? <SupabaseSettings compact disabled={locked} onConnected={load} /> : !binding && !pending.length && <>
        <Button variant="outline" disabled={locked} onClick={() => void run(() => loadCatalog())}>Load Supabase projects</Button>
        {catalog && <form onSubmit={event => { event.preventDefault(); void run(() => propose({ action: 'link', organization, projectRef })); }}><fieldset disabled={locked}>
          <label>Organization<select required value={organization} onChange={event => { setOrganization(event.target.value); setProjectRef(''); }}><option value="">Choose organization</option>{catalog.organizations.map(item => <option key={item.slug} value={item.slug}>{item.name} · {item.slug}</option>)}</select></label>
          <label>Supabase project<select required value={projectRef} onChange={event => setProjectRef(event.target.value)}><option value="">Choose project</option>{catalog.projects.filter(item => item.organization === organization).map(item => <option key={item.ref} value={item.ref}>{item.name} · {item.ref}</option>)}</select></label>
          {catalog.pagination.truncated && <Button type="button" variant="ghost" onClick={() => void run(() => loadCatalog(true))}>Load more projects</Button>}
          <Button type="submit" disabled={!organization || !projectRef}>Review connection</Button>
        </fieldset></form>}
        <p>Need a new project? <button className="assistant-setup-link" onClick={onBackend}>Create one in Backend</button>, then return here.</p>
      </>}
      {binding && state.connection.configured && kind === 'app_openai' && <>
        <p>After your review, the key is sent to this project and shared with all its Edge Functions.</p>
        {!variable ? <Button disabled={locked || !inventory} onClick={() => void run(async () => {
          const next = await api<Inventory>(`${base}/function-environment`, { name: 'OPENAI_API_KEY', environment, expectedSourceRevision: inventory!.sourceRevision });
          if (alive.current) setInventory(next);
        })}>Add OpenAI key</Button> : <>
          <SecureBackendInput compact key={`${state.connection.revision}:${variable.secret}:${variable.input.revision}`} base={base} environment={environment} input={{ ...variable.input, label: 'App OpenAI API key' }} disabled={locked || pending.length > 0} rememberAvailable={state.connection.rememberAvailable} onSaved={load} />
          {!pending.length && variable.input.available && !published && <Button disabled={locked} onClick={() => void run(() => propose({ action: 'function_environment' }))}>Review sending to Supabase</Button>}
        </>}
        <details><summary>How app AI works</summary><p>Your mobile app calls an authenticated Edge Function. The function reads <code>OPENAI_API_KEY</code> privately and calls OpenAI. Never add it to mobile source or public app variables. API usage is billed to the OpenAI project that owns this key; ChatGPT sign-in does not supply it.</p><a href="https://platform.openai.com/api-keys" target="_blank" rel="noreferrer">Create an OpenAI API key</a><p>Publishing the key does not create or test an AI feature. Ask the Assistant to implement the function with authentication, input limits and usage controls.</p></details>
      </>}
      {pending.map(op => <OperationReview key={op.id} operation={op} disabled={disabled || busy} onApprove={() => void run(() => api(`${base}/approve`, { operationId: op.id, planHash: op.planHash }))} onCancel={() => void run(() => api(`${base}/cancel`, { operationId: op.id }))} onReconcile={() => void run(() => api(`${base}/reconcile`, { operationId: op.id, planHash: op.planHash, fence: op.fence }))} />)}
      {latestOperation?.state === 'failed' && <p role="alert">{latestOperation.error ?? 'The setup operation failed. Check Backend before preparing another review.'}</p>}
      {ready && <p role="status">{kind === 'supabase' ? 'Project connected.' : 'This key was sent to Supabase. App AI still needs implementation and testing.'}</p>}
    </>}
    {error && <p role="alert">{error}</p>}
    <div className="assistant-setup-actions"><Button variant="ghost" disabled={disabled || busy} onClick={() => void run(load)}>Refresh setup</Button><Button variant="outline" disabled={locked || !ready || pending.length > 0} onClick={() => onContinue(`Continue ${kind === 'app_openai' ? 'setting up app AI' : 'the Supabase setup'} for ${environment}. Inspect the current backend configuration and operation results before proceeding; do not assume the app feature is tested.`)}>Continue in chat</Button></div>
    <small className="assistant-setup-privacy">Private fields bypass messages, chat history and the AI model. Continue prepares a message for you to send.</small>
  </div>;
}
