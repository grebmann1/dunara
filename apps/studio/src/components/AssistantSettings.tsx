import { useEffect, useRef, useState } from 'react';
import { Check, ExternalLink, KeyRound } from 'lucide-react';
import { type AssistantStatus, useStudioClient } from '../api';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import '../assistant-connections.css';

export function AssistantSettings({ disabled, revision }: { disabled: boolean; revision?: string }) {
  const { api, capabilities } = useStudioClient();
  const [status, setStatus] = useState<AssistantStatus>(), [provider, setProvider] = useState(''), [model, setModel] = useState('');
  const [apiProvider, setApiProvider] = useState('anthropic'), [remember, setRemember] = useState(false), [endpoint, setEndpoint] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const alive = useRef(true), operating = useRef(false), generation = useRef(0), selectionDirty = useRef(false), key = useRef<HTMLInputElement>(null), code = useRef<HTMLInputElement>(null);
  const connections = status?.connections ?? [], selected = connections.find(item => item.id === provider), apiConnection = connections.find(item => item.id === apiProvider);
  const flow = status?.signIn, waiting = flow?.state === 'waiting', locked = disabled || busy || !status?.available || status.busy;
  useEffect(() => {
    alive.current = true;
    const refresh = async () => {
      if (operating.current) return;
      const version = ++generation.current;
      try {
        const next = await api<AssistantStatus>('/assistant/status');
        if (!alive.current || generation.current !== version) return;
        setStatus(next); if (!selectionDirty.current) { setProvider(next.providerId || 'openai'); setModel(next.model || ''); }
      } catch { if (alive.current && generation.current === version) setError('AI connections are unavailable. Check the local runtime.'); }
    };
    void refresh(); const timer = setInterval(() => void refresh(), 1500);
    return () => { alive.current = false; generation.current++; clearInterval(timer); if (key.current) key.current.value = ''; if (code.current) code.current.value = ''; };
  }, [revision]);
  async function act(path: string, input: unknown, message = '') {
    if (operating.current || disabled) return;
    operating.current = true; generation.current++; setBusy(true); setError(''); setNotice('');
    try {
      const request = api<AssistantStatus>(`/assistant/${path}`, input);
      if (path === 'connections/update' && input && typeof input === 'object' && 'action' in input && input.action === 'connect' && key.current) key.current.value = '';
      if (path === 'connections/answer' && code.current) code.current.value = '';
      const next = await request;
      if (alive.current) { setStatus(next); setNotice(message); if (path === 'configure') { selectionDirty.current = false; setProvider(next.providerId || 'openai'); setModel(next.model || ''); } }
    } catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : 'Connection could not be updated.'); }
    finally { operating.current = false; if (alive.current) setBusy(false); }
  }
  const choose = (id: string) => { selectionDirty.current = true; setProvider(id); setModel(connections.find(item => item.id === id)?.models[0]?.id ?? ''); };
  const disconnect = (id: string) => void act('connections/update', { action: 'disconnect', provider: id, expectedRevision: status?.connectionRevision }, 'Connection removed. Other providers remain connected.');
  return <section className="settings-section ai-connections" aria-label="Assistant configuration">
    <div className="ai-connections-heading"><KeyRound size={18} aria-hidden /><div><h2>AI connections</h2><p>Connect your accounts, then choose a model for the Assistant.</p></div></div>
    {!status?.available && <p role="status">{status ? 'The Assistant is available in the desktop app.' : 'Loading connections…'}</p>}
    <div className="ai-subscriptions">{connections.filter(item => item.kind === 'oauth').map(item => <section className="ai-connection-card" key={item.id} aria-label={`${item.name} connection`}>
      <div className="ai-connection-title"><strong>{item.name}</strong><span>{item.configured ? <><Check size={13} aria-hidden />Connected</> : item.locked ? 'Locked' : 'Subscription'}</span></div>
      <p>{item.configured ? `${item.source === 'saved' ? 'Remembered' : 'This session'} · ready to select below` : `Sign in with your ${item.name} account.`}</p>
      <Button variant={item.configured ? 'outline' : 'default'} disabled={locked || waiting || item.locked} onClick={() => void act('connections/sign-in', { provider: item.id, expectedRevision: status?.connectionRevision, remember: remember && status?.rememberAvailable })}>{item.configured ? 'Sign in again' : `Sign in with ${item.name}`}</Button>
      {(item.configured || item.locked) && <Button variant="ghost" disabled={locked || waiting} onClick={() => disconnect(item.id)}>Disconnect</Button>}
    </section>)}</div>
    {status?.rememberAvailable && <label className="ai-remember"><input type="checkbox" disabled={locked || waiting || !status?.rememberAvailable} checked={remember && !!status?.rememberAvailable} onChange={event => setRemember(event.target.checked)} />Remember new connections {capabilities.credentialLocation === 'workspace' ? 'in this workspace' : 'on this computer'}</label>}
    {!status?.rememberAvailable && <small>Connections last for this session. Protected storage is unavailable.</small>}
    {flow && <div className="ai-sign-in" role="status">
      {waiting ? <><strong>Finish signing in to {connections.find(item => item.id === flow.provider)?.name}</strong>
        {flow.url ? <a href={flow.url} target="_blank" rel="noreferrer">Continue in browser <ExternalLink size={13} aria-hidden /></a> : <p>Preparing secure sign-in…</p>}
        {flow.code && <p>Enter this code: <code>{flow.code}</code></p>}
        {flow.prompt && <details><summary>Having trouble returning?</summary><form onSubmit={event => { event.preventDefault(); void act('connections/answer', { id: flow.id, promptId: flow.prompt?.id, value: code.current?.value ?? '' }); }}><Label htmlFor="ai-sign-in-code">Code or callback URL</Label><Input id="ai-sign-in-code" ref={code} type="password" autoComplete="off" maxLength={4096} required /><Button type="submit" disabled={busy}>Complete sign-in</Button></form></details>}
        <Button variant="ghost" disabled={busy} onClick={() => void act('connections/cancel', { id: flow.id })}>Cancel sign-in</Button></> : <span>{flow.state === 'connected' ? 'Connected. Choose this provider below when you’re ready.' : flow.state === 'failed' ? flow.message : 'Sign-in cancelled.'}</span>}
    </div>}
    <details className="ai-api-settings"><summary>API keys & endpoints <span>{connections.filter(item => item.kind === 'api_key' && item.configured).length} connected</span></summary>
      <div className="ai-api-list">{connections.filter(item => item.kind === 'api_key').map(item => <button type="button" key={item.id} aria-pressed={apiProvider === item.id} onClick={() => { setApiProvider(item.id); setEndpoint(item.baseUrl); if (key.current) key.current.value = ''; }}><span>{item.name}</span>{item.configured && <Check size={13} aria-label="Connected" />}</button>)}</div>
      <form onSubmit={event => { event.preventDefault(); void act('connections/update', { action: 'connect', provider: apiProvider, expectedRevision: status?.connectionRevision, key: key.current?.value ?? '', remember: remember && status?.rememberAvailable, ...((endpoint.trim() || apiConnection?.baseUrl) ? { baseUrl: endpoint.trim() || apiConnection?.baseUrl } : {}) }, 'API key saved. No provider request was made.'); }} autoComplete="off">
        <fieldset disabled={locked || waiting || apiConnection?.locked}>
          <Label htmlFor="assistant-api-key">{apiConnection?.name ?? 'Provider'} API key</Label><Input id="assistant-api-key" ref={key} type="password" required minLength={16} maxLength={4096} autoComplete="off" spellCheck={false} />
          <details><summary>Custom endpoint</summary><Label htmlFor="assistant-api-endpoint">HTTPS API base URL</Label><Input id="assistant-api-endpoint" type="url" value={endpoint} placeholder={apiConnection?.baseUrl} onChange={event => setEndpoint(event.target.value)} /><small>Your key and messages will be sent to this endpoint.</small></details>
          <Button type="submit">Save API connection</Button>
        </fieldset>
      </form>
      {(apiConnection?.configured && !apiConnection.inherited || apiConnection?.locked) && <Button variant="ghost" disabled={locked || waiting} onClick={() => disconnect(apiProvider)}>Remove {apiConnection?.name} connection</Button>}
      {apiProvider === 'openai' && <small>Without a separate Assistant key, OpenAI uses the image-generation key below. Manage or disconnect that key under Image generation.</small>}
    </details>
    {connections.some(item => item.configured) && <form className="ai-model-form" onSubmit={event => { event.preventDefault(); void act('configure', { action: 'model', provider, model }, 'Assistant model saved for future messages. No provider request was made.'); }}>
      <fieldset disabled={locked || waiting}>
        <div className="ai-model-fields"><label>Assistant provider<select aria-label="Assistant provider" value={provider} onChange={event => choose(event.target.value)}>{connections.map(item => <option key={item.id} value={item.id}>{item.name}{item.configured ? '' : ' · not connected'}</option>)}</select></label>
          <label>Assistant model<select aria-label="Assistant model" value={model} onChange={event => { selectionDirty.current = true; setModel(event.target.value); }}>{model && !selected?.models.some(item => item.id === model) && <option value={model} disabled>{model} (unavailable)</option>}{selected?.models.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label></div>
        <Button type="submit" disabled={!selected?.configured || !selected.models.some(item => item.id === model) || provider === status?.providerId && model === status?.model}>Save assistant model</Button>
      </fieldset>
    </form>}
    <small>Messages and requested app content go to the selected provider. Model access depends on your account.</small>
    {status?.busy && <p role="status">Wait for the current turn to finish or stop it before changing connections.</p>}
    {error && <p role="alert" className="settings-error">{error}</p>}{notice && <p role="status">{notice}</p>}
  </section>;
}
