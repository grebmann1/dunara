import { useEffect, useRef, useState } from 'react';
import type { BackendConfiguration } from '../../../../packages/core/src/backend-configuration';
import type { ConfigurationPlan, ConfigurationStep, SecretVersion } from '../../../../packages/platform/src/configuration';
import type { EnvironmentName } from '../../../../packages/platform/src/contracts';
import { useStudioClient } from '../api';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { SecureBackendInput } from './SecureBackendInput';
import type { ServiceRecipe } from '../../../../packages/core/src/service-recipe';

type Progress = Awaited<ReturnType<BackendConfiguration['progress']>>;
type Report = Awaited<ReturnType<BackendConfiguration['validate']>>;
export function BackendConfigurationPanel({ projectId, environment, disabled, rememberAvailable, refresh, onReview }: { projectId: string; environment: EnvironmentName; disabled: boolean; rememberAvailable: boolean; refresh: () => Promise<void>; onReview?: () => void }) {
  const { api } = useStudioClient();
  const [progress, setProgress] = useState<Progress>(), [report, setReport] = useState<Report>(), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [recipe, setRecipe] = useState<Awaited<ReturnType<ServiceRecipe['preview']>>>();
  const [scenario, setScenario] = useState('records'), [target, setTarget] = useState('');
  const alive = useRef(true), active = useRef(false), base = `/projects/${projectId}/backend`;
  useEffect(() => { alive.current = true; void api<{ setup: Progress }>(base).then(s => { if (alive.current && s.setup.environment === environment) setProgress(s.setup); }).catch(() => {}); return () => { alive.current = false; }; }, [base, environment]);
  async function run(fn: () => Promise<unknown>) {
    if (active.current || disabled) return; active.current = true; setBusy(true); setError('');
    try { await fn(); await refresh(); } catch (e) { if (alive.current) setError(e instanceof Error ? e.message : 'Configuration request failed.'); }
    finally { active.current = false; if (alive.current) setBusy(false); }
  }
  async function inputs() {
    const result = await api<{ inputs: SecretVersion[] }>(`${base}/requirements`, { environment });
    if (alive.current) setProgress(old => ({ environment, journeys: [], phase: 'secure_inputs', operations: [], next: 'Prepare a new review after entering credentials.', ...old, inputs: result.inputs }));
  }
  return <section className="backend-card" aria-label="App services configuration"><h2>App services</h2><p>Manage sign-in, email delivery, private uploads, and functions. Ask the Assistant to prepare changes, then review them here.</p>
    <Button variant="outline" disabled={disabled || busy} onClick={() => void run(async () => { const value = await api<Awaited<ReturnType<ServiceRecipe['preview']>>>(`/projects/${projectId}/service-recipe`); if (alive.current) setRecipe(value); })}>Review app services example</Button>
    {recipe && <details open><summary>App services example · {recipe.files.length} new files</summary><ul>{recipe.consequences.map(item => <li key={item}>{item}</li>)}</ul>{recipe.conflicts.map(item => <p key={item} role="alert">{item}</p>)}{recipe.files.map(file => <details key={file.path}><summary>{file.path}</summary><pre tabIndex={0}>{file.content}</pre></details>)}{recipe.files.length > 0 && <Button disabled={disabled || busy || !!recipe.conflicts.length} onClick={() => void run(async () => { await api(`/projects/${projectId}/service-recipe`, { proposedRevision: recipe.proposedRevision, confirmed: true }); if (alive.current) setRecipe(undefined); await inputs(); })}>Add reviewed example files</Button>}{!recipe.files.length && !recipe.conflicts.length && <p>This app already includes the example.</p>}</details>}
    <p>{progress?.next ?? 'Ask the Assistant to prepare your app’s configuration, then review the exact changes here.'}</p>
    <div className="backend-actions"><Button variant="outline" disabled={disabled || busy} onClick={() => void run(inputs)}>Check required inputs</Button><Button disabled={disabled || busy} onClick={() => void run(async () => { const plan = await api<ConfigurationPlan>(`${base}/plan`, { action: 'configure', environment }); await api(`${base}/apply`, { plan, requestId: crypto.randomUUID() }); if (alive.current) onReview?.(); })}>Review service changes</Button><Button variant="outline" disabled={disabled || busy} onClick={() => void run(async () => { const value = await api<Report>(`${base}/validate`, { environment }); if (alive.current) setReport(value); })}>Validate configuration</Button></div>
    {progress?.inputs.filter(input => input.purpose !== 'function').map(input => <SecureBackendInput key={`${environment}:${input.name}:${input.revision}`} base={base} environment={environment} input={input} disabled={disabled || busy} rememberAvailable={rememberAvailable} onSaved={() => run(inputs)} />)}
    {error && <p role="alert">{error}</p>}
    {report && <div className="backend-validation" role="status"><h3>Validation · {report.status}</h3><p>{new Date(report.checkedAt).toLocaleString()} · {report.environment}</p><ul>{report.checks.map(check => <li key={check.name}><strong>{check.name.replaceAll('_', ' ')}: {check.status.replaceAll('_', ' ')}</strong><p>{check.detail}</p></li>)}</ul><p>Read-only validation does not send email or exercise app data. Live checks require their own review.</p></div>}
    {environment === 'development' && <details><summary>Review a live development check</summary><p>These checks use isolated test users and fixed synthetic resources. Enter their sessions in private inputs. Email and function requests may have external effects.</p><label>Check<select value={scenario} onChange={event => { setScenario(event.target.value); setTarget(''); }}><option value="records">Private records</option><option value="storage">Private uploads</option><option value="function">Authenticated function</option><option value="email">Request one email code</option><option value="cleanup">Clean up recorded fixture</option></select></label>{scenario !== 'records' && <label>{scenario === 'email' ? 'Designated recipient' : scenario === 'storage' ? 'Private bucket name' : scenario === 'function' ? 'Function name' : 'Recorded fixture ID'}<Input value={target} type={scenario === 'email' ? 'email' : 'text'} onChange={event => setTarget(event.target.value)} /></label>}<Button disabled={disabled || busy || scenario !== 'records' && !target} onClick={() => void run(async () => { const plan = await api<ConfigurationPlan>(`${base}/plan`, { action: 'verify', environment, scenario, ...(scenario === 'email' ? { recipient: target } : scenario === 'storage' ? { bucket: target } : scenario === 'function' ? { functionSlug: target } : scenario === 'cleanup' ? { fixtureId: target } : {}) }); await inputs(); if (plan.prerequisites.length) throw new Error('Enter the requested isolated test sessions, then prepare this check again.'); await api(`${base}/apply`, { plan, requestId: crypto.randomUUID() }); if (alive.current) onReview?.(); })}>Prepare check for review</Button></details>}
  </section>;
}

export function ConfigurationDiff({ plan }: { plan: ConfigurationPlan }) {
  return <><p>{plan.steps.length} {plan.steps.length === 1 ? 'change' : 'changes'} · {plan.environment}. Review expires {new Date(plan.expiresAt).toLocaleTimeString()}.</p>{plan.prerequisites.length > 0 && <ul>{plan.prerequisites.map(value => <li key={value}>{value}</li>)}</ul>}
    {plan.steps.map(step => <StepDiff key={step.id} step={step} />)}
    <details><summary>Exact source snapshots ({plan.sources.length})</summary>{plan.sources.map(source => <details key={source.path}><summary>{source.path}</summary><pre tabIndex={0}>{source.content}</pre><p>Revision {source.revision}</p></details>)}</details>
    <details><summary>Credential references and recovery rules</summary><pre tabIndex={0}>{JSON.stringify({ requirements: plan.secrets, capabilities: plan.requiredCapabilities, steps: plan.steps }, null, 2)}</pre></details>
  </>;
}

const authFieldLabels: Record<string, string> = { site_url: 'Site URL', uri_allow_list: 'Allowed redirects', external_email_enabled: 'Email sign-in', disable_signup: 'Disable new signups', mailer_autoconfirm: 'Skip email confirmation', smtp_host: 'SMTP host', smtp_port: 'SMTP port', smtp_admin_email: 'Sender email', smtp_sender_name: 'Sender name', external_google_enabled: 'Google sign-in', external_google_client_id: 'Google client ID', external_google_skip_nonce_check: 'Skip nonce check', mailer_subjects_confirmation: 'Confirmation email subject', mailer_subjects_magic_link: 'Sign-in email subject', mailer_templates_confirmation_content: 'Confirmation email template', mailer_templates_magic_link_content: 'Sign-in email template' };
function StepDiff({ step }: { step: ConfigurationStep }) {
  const value = (item: unknown) => item === null || item === undefined ? 'Not configured' : typeof item === 'boolean' ? item ? 'Enabled' : 'Disabled' : String(item);
  if (step.kind === 'auth') return <section className="backend-step-diff"><h4>Email & sign-in</h4>{Object.entries(step.after).map(([field, after]) => <div className="backend-field-diff" key={field}><strong>{authFieldLabels[field] ?? field.replaceAll('_', ' ')}</strong><span>Current</span><pre tabIndex={0}>{value(step.before[field])}</pre><span>After approval</span><pre tabIndex={0}>{value(after)}</pre></div>)}{step.secrets.map(input => <p key={input.field}>{input.field === 'smtp_pass' ? 'SMTP password' : input.field === 'smtp_user' ? 'SMTP username' : 'Google client secret'}: use the private input “{input.secret}”.</p>)}</section>;
  if (step.kind === 'bucket') return <section className="backend-step-diff"><h4>{step.before ? 'Update' : 'Create'} private bucket: {step.after.id}</h4><p>Only authorized app users can access objects under the reviewed storage policies.</p><p>Maximum file size: {step.before?.file_size_limit ?? 'New bucket'} → {step.after.file_size_limit} bytes</p><p>Allowed types: {step.before?.allowed_mime_types.join(', ') ?? 'New bucket'} → {step.after.allowed_mime_types.join(', ')}</p></section>;
  if (step.kind === 'function') return <section className="backend-step-diff"><h4>Deploy function: {step.slug}</h4><p>{step.before ? `Replace deployed version ${step.before.version}.` : 'Create a new function.'} Token verification remains enabled. Review its exact source below.</p></section>;
  if (step.kind === 'function_secrets') return <section className="backend-step-diff"><h4>Edge Function environment variables</h4><ul>{step.bindings.map(input => <li key={input.name}>{input.name}: use private input “{input.secret}”</li>)}</ul><p>Supabase cannot reveal these values afterward. An unconfirmed update requires recovery.</p></section>;
  return <section className="backend-step-diff"><h4>Development check: {step.scenario}</h4><p>{step.recipient ? `Request one sign-in code for ${step.recipient}.` : `Exercise ${step.bucket ?? step.functionSlug ?? 'the private notes table'} using isolated test users.`}</p><p>Fixture reference: {step.fixtureId}</p>{step.ownerId && <p>Owner: {step.ownerId}</p>}{step.otherId && <p>Second user: {step.otherId}</p>}</section>;
}
