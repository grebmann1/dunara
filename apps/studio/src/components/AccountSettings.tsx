import { useEffect, useRef, useState } from 'react';
import { UserRound } from 'lucide-react';
import type { AccountSession } from '../../../../packages/platform/src/accounts';
import { useStudioClient } from '../api';
import { Button } from './ui/button';
import { Input } from './ui/input';
type Status = ReturnType<AccountSession['status']>;
type Workspaces = Awaited<ReturnType<AccountSession['workspaces']>>;
export function AccountSettings({ disabled, projectId }: { disabled: boolean; projectId?: string }) {
  const { api } = useStudioClient();
  const [status, setStatus] = useState<Status>(), [email, setEmail] = useState(''), [sent, setSent] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [workspaces, setWorkspaces] = useState<Workspaces>([]), [workspaceId, setWorkspaceId] = useState(''), [name, setName] = useState(''), [remember, setRemember] = useState(false);
  const code = useRef<HTMLInputElement>(null), alive = useRef(true), operating = useRef(false);
  async function refresh() { const value = await api<Status>('/account/status'); if (!alive.current) return; setStatus(value); setWorkspaces([]); setWorkspaceId(''); if (value.signedIn) { const rows = await api<Workspaces>('/account/workspaces'); if (alive.current) setWorkspaces(rows); } }
  useEffect(() => { alive.current = true; const field = code.current; void refresh().catch(() => { if (alive.current) setError('Account status unavailable.'); }); return () => { alive.current = false; if (field) field.value = ''; }; }, []);
  async function perform(action: () => Promise<unknown>, message: string) {
    if (disabled || operating.current) return;
    operating.current = true; setBusy(true); setError(''); setNotice('');
    try { await action(); await refresh(); if (alive.current) setNotice(message); }
    catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : 'Account request failed.'); await refresh().catch(() => {}); }
    finally { operating.current = false; if (code.current) code.current.value = ''; if (alive.current) setBusy(false); }
  }
  if (status && !status.available && status.restoration !== 'locked') return null;
  return <section className="settings-section" aria-label="Dunara account"><div className="backend-heading"><UserRound aria-hidden /><h2>Dunara account</h2><span className="backend-badge">{status?.signedIn ? 'Signed in' : 'Local workspace'}</span></div>
    <p>Your Dunara identity and workspaces are separate from the users of your mobile apps.</p>
    {!status?.available ? <p>The account service has not been configured. Local projects remain available. Configure the dedicated Dunara account Supabase project to enable sign-in.</p> : !status.signedIn ? <form onSubmit={event => { event.preventDefault(); void perform(async () => { if (sent) { const pending = api('/account/verify-code', { email, code: code.current?.value ?? '', remember: remember && status.rememberAvailable }); if (code.current) code.current.value = ''; await pending; window.dispatchEvent(new Event('builder-account-changed')); } else { await api('/account/request-code', { email }); if (alive.current) setSent(true); } }, sent ? (remember && status.rememberAvailable ? 'Signed in and remembered on this computer.' : 'Signed in for this Dunara session.') : 'Check your email for a sign-in code.'); }}><fieldset disabled={disabled || busy}>
      <label htmlFor="builder-account-email">Email</label><Input id="builder-account-email" type="email" required maxLength={254} value={email} autoComplete="email" onChange={event => { setEmail(event.target.value); setSent(false); }} />
      {sent && <><label htmlFor="builder-account-code">Email code</label><Input id="builder-account-code" ref={code} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6,10}" minLength={6} maxLength={10} required /></>}
      <label className="flex items-center gap-2"><input type="checkbox" className="h-[44px] w-[44px] shrink-0" disabled={!status.rememberAvailable} checked={remember && status.rememberAvailable} onChange={event => setRemember(event.target.checked)} />Remember my Dunara account on this computer</label>
      <p>{status.rememberAvailable ? 'Optional. The refresh token is encrypted; signing out removes it.' : 'Protected storage is unavailable. Sign-in lasts for this session.'}</p>
      <div className="backend-actions"><Button type="submit">{sent ? 'Sign in to Dunara' : 'Send sign-in code'}</Button>{sent && <Button type="button" variant="outline" onClick={() => setSent(false)}>Use another code</Button>}</div>
    </fieldset></form> : <><p>Signed in as <strong>{status.user?.email}</strong>. {status.lifetime === 'remembered' ? 'Remembered on this computer with encrypted storage. Sign out to remove this saved session.' : 'Signed in for this session. Restart signs you out.'}</p><Button variant="outline" disabled={disabled || busy} onClick={() => void perform(async () => { try { await api('/account/sign-out', {}); } finally { window.dispatchEvent(new Event('builder-account-changed')); } }, 'Signed out on this computer.')}>Sign out</Button>
      <h3 className="account-workspaces-title">Workspaces</h3><form className="account-workspaces-form" onSubmit={event => { event.preventDefault(); void perform(() => api('/account/create-workspace', { name }), 'Workspace created.'); }}><label htmlFor="builder-workspace-name">New workspace name</label><Input id="builder-workspace-name" value={name} required maxLength={100} onChange={event => setName(event.target.value)} /><Button disabled={disabled || busy}>Create workspace</Button></form>
      {projectId && workspaces.length > 0 && <form onSubmit={event => { event.preventDefault(); void perform(() => api('/account/register-app', { projectId, workspaceId }), 'App metadata registered. Source and execution remain on this computer.'); }}><label htmlFor="builder-account-workspace">Workspace for this app</label><select id="builder-account-workspace" required value={workspaceId} onChange={event => setWorkspaceId(event.target.value)}><option value="">Select workspace</option>{workspaces.map(workspace => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}</select><Button disabled={disabled || busy}>Register app metadata</Button></form>}
    </>}
    {status?.restoration === 'locked' && <p role="alert">Saved account data is locked or belongs to another account service. Restore the original configuration, or forget it before signing in again. <Button variant="outline" disabled={disabled || busy} onClick={() => void perform(async () => { try { await api('/account/sign-out', {}); } finally { window.dispatchEvent(new Event('builder-account-changed')); } }, 'Saved account forgotten.')}>Forget saved account</Button></p>}
    {status?.restoration === 'expired' && <p>Your saved session expired or was revoked. Sign in again.</p>}
    {status?.restoration === 'unavailable' && <p>The saved session could not be restored. Its encrypted data was retained; check your connection before restarting or sign in again.</p>}
    {error && <p role="alert">{error}</p>}<p role="status">{busy ? 'Contacting account service…' : notice}</p>
  </section>;
}
