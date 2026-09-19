import { useEffect, useRef, useState } from 'react';
import type { BackendConfiguration } from '../../../../packages/core/src/backend-configuration';
import type { ConfigurationPlan } from '../../../../packages/platform/src/configuration';
import type { EnvironmentName } from '../../../../packages/platform/src/contracts';
import { useStudioClient } from '../api';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { SecureBackendInput } from './SecureBackendInput';

type Inventory = Awaited<ReturnType<BackendConfiguration['functionEnvironment']>>;
export function FunctionEnvironmentPanel({ projectId, environment, disabled, rememberAvailable, refresh }: { projectId: string; environment: EnvironmentName; disabled: boolean; rememberAvailable: boolean; refresh(): Promise<void> }) {
  const { api } = useStudioClient();
  const base = `/projects/${projectId}/backend`, alive = useRef(true), active = useRef(false);
  const [inventory, setInventory] = useState<Inventory>(), [name, setName] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function load() { const value = await api<Inventory>(`${base}/function-environment-list`, { environment }); if (alive.current) setInventory(value); }
  useEffect(() => {
    alive.current = true;
    void api<Inventory>(`${base}/function-environment-list`, { environment }).then(value => { if (alive.current) setInventory(value); }).catch(e => { if (alive.current) setError(e instanceof Error ? e.message : 'Variables could not be loaded.'); });
    return () => { alive.current = false; };
  }, [base, environment]);
  async function run(work: () => Promise<unknown>) {
    if (active.current || disabled) return; active.current = true; setBusy(true); setError('');
    try { await work(); await refresh(); }
    catch (e) { if (alive.current) setError(e instanceof Error ? e.message : 'Environment variable request failed.'); }
    finally { active.current = false; if (alive.current) setBusy(false); }
  }
  return <section className="backend-card backend-function-environment" aria-label="Supabase environment variables"><h2>Environment variables</h2><p>Private values for your Supabase Edge Functions · <strong>{environment}</strong></p>
    <ol><li>Add a variable name.</li><li>Save its value in the private field below.</li><li>Review the variables, then approve the pending change in Backend.</li></ol>
    <p>All Edge Functions in the selected Supabase project share these values. Use separate Supabase projects to isolate environments. Your app’s public connection settings stay in its backend connection.</p>
    <form onSubmit={event => { event.preventDefault(); if (!inventory) return; void run(async () => { const value = await api<Inventory>(`${base}/function-environment`, { environment, name, expectedSourceRevision: inventory.sourceRevision }); if (alive.current) { setInventory(value); setName(''); } }); }}>
      <label>Variable name<Input required value={name} onChange={event => setName(event.target.value)} pattern="[A-Z][A-Z0-9_]{0,63}" maxLength={64} placeholder="PAYMENTS_API_KEY" autoCapitalize="characters" spellCheck={false} disabled={disabled || busy || !inventory} aria-describedby="function-variable-help" /></label>
      <p id="function-variable-help">Use uppercase letters, numbers and underscores. SUPABASE_, SB_ and DENO_ prefixes belong to Supabase.</p>
      <Button type="submit" variant="outline" disabled={disabled || busy || !inventory || !name || /^(SUPABASE_|SB_|DENO_)/.test(name)}>Add variable</Button>
    </form>
    {inventory?.variables.length === 0 && <p>No variables added in Dunara yet. Existing Supabase values are never fetched.</p>}
    {inventory?.variables.map(item => <div key={item.name} className="backend-env-variable"><h3><code>{item.name}</code></h3><SecureBackendInput key={`${item.secret}:${item.input.revision}`} base={base} environment={environment} input={{ ...item.input, label: item.name }} disabled={disabled || busy} rememberAvailable={rememberAvailable} onSaved={load} /></div>)}
    <div className="backend-actions"><Button disabled={disabled || busy || !inventory?.variables.length || inventory.variables.some(item => !item.input.available)} onClick={() => void run(async () => { const plan = await api<ConfigurationPlan>(`${base}/plan`, { action: 'function_environment', environment }); await api(`${base}/apply`, { plan, requestId: crypto.randomUUID() }); })}>Review variable changes</Button><Button variant="outline" disabled={disabled || busy} onClick={() => void run(load)}>Refresh variables</Button></div>
    {error && <p role="alert">{error}</p>}
    <details><summary>Use and update a variable</summary><p>Inside an Edge Function, read a value with <code>Deno.env.get("PAYMENTS_API_KEY")</code>. Approved updates take effect without redeploying functions. Review variable changes only publishes variables; it does not change sign-in, storage or function source.</p><p>To replace a value, save a new private input and prepare another review. Removing an input only forgets Dunara’s copy; it does not delete the variable from Supabase. Do not put private values in chat, source files or EXPO_PUBLIC_ app variables.</p></details>
  </section>;
}
