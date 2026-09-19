import { useEffect, useState } from 'react';
import type { BackendOAuth } from '../../../../packages/core/src/backend-oauth';
import { useStudioClient } from '../api';
import { Button } from './ui/button';
import { Input } from './ui/input';

type Status = ReturnType<BackendOAuth['status']>;
export function BackendOAuthSettings({ disabled, onChange }: { disabled: boolean; onChange: () => Promise<void> }) {
  const { api } = useStudioClient();
  const [status, setStatus] = useState<Status>(), [workspaces, setWorkspaces] = useState<{ id: string; name: string }[]>([]), [workspace, setWorkspace] = useState(''), [organization, setOrganization] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => { let alive = true; void api<Status>('/backend/oauth/status').then(value => { if (alive) setStatus(value); if (value.signedIn) return api<{ id: string; name: string }[]>('/account/workspaces').then(rows => { if (alive) setWorkspaces(rows); }); }).catch(() => {}); return () => { alive = false; }; }, []);
  async function update(action: 'start' | 'poll' | 'disconnect') {
    if (disabled || busy) return; setBusy(true); setError('');
    try { await api(`/backend/oauth/${action}`, action === 'start' ? { workspaceId: workspace, organization } : {}); setStatus(await api<Status>('/backend/oauth/status')); await onChange(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Supabase connection failed.'); }
    finally { setBusy(false); }
  }
  if (!status?.available) return null;
  return <section className="settings-section backend-connection" aria-label="Connect Supabase with OAuth"><h2>Connect your Supabase account</h2>
    {!status.signedIn ? <p>Sign in to your Dunara account, then reopen Settings to connect Supabase.</p> : <>
      <p>{status.connected ? `Connected to ${status.connection?.organization}. Your connection is stored securely.` : 'Choose your Dunara workspace and Supabase organization, then authorize in your browser.'}</p>
      <form onSubmit={event => { event.preventDefault(); void update('start'); }}><fieldset disabled={disabled || busy}><label>Dunara workspace<select required value={workspace} onChange={event => setWorkspace(event.target.value)}><option value="">Choose workspace</option>{workspaces.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label>Supabase organization slug<Input value={organization} onChange={event => setOrganization(event.target.value)} required maxLength={100} pattern="[A-Za-z0-9_-]+" /></label><Button type="submit">{status.connection ? 'Reconnect Supabase' : 'Prepare account connection'}</Button></fieldset></form>
      {status.pending && <div className="backend-actions"><a href={status.pending.authorizationUrl} target="_blank" rel="noreferrer">Continue in your browser</a><Button disabled={disabled || busy} onClick={() => void update('poll')}>Finish connecting</Button><p>The connection request expires {new Date(status.pending.expiresAt).toLocaleTimeString()}.</p></div>}
      {(status.connected || status.pending || status.connection) && <Button variant="outline" disabled={disabled || busy} onClick={() => void update('disconnect')}>Disconnect account</Button>}
    </>}{error && <p role="alert">{error}</p>}</section>;
}
