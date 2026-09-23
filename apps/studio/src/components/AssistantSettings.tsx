import { useEffect, useRef, useState } from 'react';
import { Check, ExternalLink, KeyRound } from 'lucide-react';
import { type AssistantStatus, useStudioClient } from '../api';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import '../assistant-connections.css';
import { AiCredits } from './AiCredits';
import { activateAssistantConnection } from '../assistant-connection-activation';
import type { DraftSnapshot } from '../../../../packages/assistant/src/drafts';

export function AssistantSettings({ disabled, revision }: { disabled: boolean; revision?: string }) {
  const { api, capabilities } = useStudioClient();
  const [status, setStatus] = useState<AssistantStatus>();
  const [showConnections, setShowConnections] = useState(false);
  const [apiProvider, setApiProvider] = useState('anthropic'), [remember, setRemember] = useState(false), [endpoint, setEndpoint] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const alive = useRef(true), operating = useRef(false), generation = useRef(0), key = useRef<HTMLInputElement>(null), code = useRef<HTMLInputElement>(null);
  const connections = status?.connections ?? [], selected = connections.find(item => item.id === status?.providerId), apiConnection = connections.find(item => item.id === apiProvider);
  const flow = status?.signIn, waiting = flow?.state === 'waiting', locked = disabled || busy || !status?.available || status.busy;
  const ready = !!status?.configured && !!selected?.models.some(item => item.id === status.model);
  useEffect(() => {
    alive.current = true;
    const refresh = async () => {
      if (operating.current) return;
      const version = ++generation.current;
      try {
        const next = await api<AssistantStatus>('/assistant/status');
        if (!alive.current || generation.current !== version) return;
        setStatus(next);
      } catch { if (alive.current && generation.current === version) setError('AI connections are unavailable. Check the local runtime.'); }
    };
    void refresh(); const timer = setInterval(() => void refresh(), 1500);
    return () => { alive.current = false; generation.current++; clearInterval(timer); if (key.current) key.current.value = ''; if (code.current) code.current.value = ''; };
  }, [revision]);
  async function act(path: string, input: unknown, message = '', activate?: string) {
    if (operating.current || disabled) return;
    operating.current = true; generation.current++; setBusy(true); setError(''); setNotice('');
    try {
      const request = api<AssistantStatus>(`/assistant/${path}`, input);
      if (path === 'connections/update' && input && typeof input === 'object' && 'action' in input && input.action === 'connect' && key.current) key.current.value = '';
      if (path === 'connections/answer' && code.current) code.current.value = '';
      const next = await request;
      if (alive.current) { setStatus(next); setNotice(message); }
      if (activate && status) {
        // OAuth continues while the user returns to their app; only this flow may activate it.
        const activation = activateAssistantConnection(api, next, status, activate).then(value => {
          if (alive.current && value) { generation.current++; setStatus(value); setNotice(''); }
        }).catch(cause => { if (alive.current) setError(cause instanceof Error ? cause.message : 'Connected. Select this connection to finish setup.'); });
        if (next.signIn?.provider !== activate || next.signIn.state !== 'waiting') await activation;
      }
    } catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : 'Connection could not be updated.'); }
    finally { operating.current = false; if (alive.current) setBusy(false); }
  }
  const useConnection = (id: string) => {
    const connection = connections.find(item => item.id === id);
    const model = id === status?.providerId && connection?.models.some(item => item.id === status.model) ? status.model : connection?.models[0]?.id;
    if (model) void act('configure', { action: 'model', provider: id, model });
  };
  const disconnect = (id: string) => void act('connections/update', { action: 'disconnect', provider: id, expectedRevision: status?.connectionRevision }, 'Connection removed.');
  if (!status?.available || !connections.length) return <section className="settings-section ai-connections ai-connections-unavailable" aria-label="Assistant configuration">
    <div className="ai-connections-heading"><KeyRound size={18} aria-hidden /><h2>AI connections</h2></div>
    <p role="status">{!status ? error || 'Loading connections…' : status.available ? 'Restart Dunara to load AI connections.' : 'The Assistant requires the desktop app with its optional runtime installed.'}</p>
    {status?.available && <p>The interface has been updated, but the running backend does not provide the connection list. Save unsent drafts, then fully quit and relaunch Dunara. Refreshing this page does not restart the backend.</p>}
  </section>;
  return <section className="settings-section ai-connections" aria-label="Assistant configuration">
    <div className="ai-connections-heading"><KeyRound size={18} aria-hidden /><div><h2>AI connections</h2><p>{status.credits ? 'Start with included credits, or choose your own connection.' : ready ? 'Your Assistant is ready.' : 'Connect once, then start creating.'}</p></div></div>
    <AiCredits balance={status.credits} />
    {status.credits && <p>Credits cover Assistant work and images. Your own API key or ChatGPT connection uses that account’s allowance for Assistant work. Images have a separate connection below.</p>}
    {ready && <div className="ai-active-connection" role="group" aria-label="Active AI connection">
      <div className="ai-connection-title"><strong>{selected?.name}</strong><span><Check size={14} aria-hidden />Ready</span></div>
      <p>{selected?.models.find(item => item.id === status.model)?.label}{selected?.source === 'session' ? ' · This session' : selected?.source === 'saved' ? ' · Remembered' : ''}</p>
      <details className="ai-model-settings"><summary>Change model</summary>
        <label>Assistant model<select aria-label="Assistant model" value={`${status.providerId}:${status.model}`} disabled={locked || waiting} onChange={event => {
          const [provider, ...parts] = event.target.value.split(':');
          void act('configure', { action: 'model', provider, model: parts.join(':') });
        }}>{connections.filter(item => item.configured).map(item => <optgroup key={item.id} label={item.name}>{item.models.map(model => <option key={model.id} value={`${item.id}:${model.id}`}>{model.label}</option>)}</optgroup>)}</select></label>
        <small>Changes are saved automatically. You can also choose a model in chat.</small>
      </details>
    </div>}
    <details className="ai-connection-options" open={!ready || showConnections} onToggle={event => { if (ready) setShowConnections(event.currentTarget.open); }}>
      <summary>{ready ? 'Manage connections' : 'Choose a connection'}</summary>
      <div className="ai-connection-options-body">
      {status.rememberAvailable && <label className="ai-remember"><input type="checkbox" disabled={locked || waiting} checked={remember} onChange={event => setRemember(event.target.checked)} />Remember new connections {capabilities.credentialLocation === 'workspace' ? 'in this workspace' : 'on this computer'}</label>}
      <div className="ai-subscriptions">{connections.filter(item => item.kind === 'oauth' || item.configured).map(item => <section className="ai-connection-card" key={item.id} aria-label={`${item.name} connection`}>
        <div className="ai-connection-title"><strong>{item.name}</strong><span>{item.configured ? <><Check size={13} aria-hidden />{ready && item.id === status.providerId ? 'In use' : 'Connected'}</> : item.locked ? 'Locked' : 'Subscription'}</span></div>
        <p>{item.configured ? item.source === 'saved' ? `Remembered ${capabilities.credentialLocation === 'workspace' ? 'in this workspace' : 'on this computer'}.` : item.kind === 'managed' ? 'Use your included allowance.' : item.source === 'session' ? 'Connected for this session.' : 'Connected and available.' : `Use your ${item.name} account.`}</p>
        {item.configured ? item.id !== status.providerId || !ready ? <Button variant="outline" disabled={locked || waiting || !item.models.length} onClick={() => useConnection(item.id)}>Use {item.name}</Button> : null : <Button disabled={locked || waiting || item.locked} onClick={() => void act('connections/sign-in', { provider: item.id, expectedRevision: status.connectionRevision, remember: remember && status.rememberAvailable }, '', item.id)}>Sign in with {item.name}</Button>}
        {item.kind !== 'managed' && (item.configured || item.locked) && <details className="ai-account-actions"><summary>Connection options</summary><div>
          {item.kind === 'oauth' && <Button variant="outline" disabled={locked || waiting || item.locked} onClick={() => void act('connections/sign-in', { provider: item.id, expectedRevision: status.connectionRevision, remember: remember && status.rememberAvailable })}>Sign in again</Button>}
          {!item.inherited && <Button variant="ghost" disabled={locked || waiting} onClick={() => disconnect(item.id)}>Disconnect {item.name}</Button>}
          {item.inherited && <small>Manage this key under Image generation below.</small>}
        </div></details>}
      </section>)}</div>
      <small>{status.rememberAvailable ? 'New connections are used for your next message.' : 'New connections are used for your next message and last until Dunara closes.'}</small>
    {flow && flow.state !== 'connected' && <div className="ai-sign-in" role="status">
      {waiting ? <><strong>Finish signing in to {connections.find(item => item.id === flow.provider)?.name}</strong>
        {flow.url ? <a href={flow.url} target="_blank" rel="noreferrer">Continue in browser <ExternalLink size={13} aria-hidden /></a> : <p>Preparing secure sign-in…</p>}
        {flow.code && <p>Enter this code: <code>{flow.code}</code></p>}
        {flow.prompt && <details><summary>Having trouble returning?</summary><form onSubmit={event => { event.preventDefault(); void act('connections/answer', { id: flow.id, promptId: flow.prompt?.id, value: code.current?.value ?? '' }); }}><Label htmlFor="ai-sign-in-code">Code or callback URL</Label><Input id="ai-sign-in-code" ref={code} type="password" autoComplete="off" maxLength={4096} required /><Button type="submit" disabled={busy}>Complete sign-in</Button></form></details>}
        <Button variant="ghost" disabled={busy} onClick={() => void act('connections/cancel', { id: flow.id })}>Cancel sign-in</Button></> : <span>{flow.state === 'failed' ? flow.message : 'Sign-in cancelled.'}</span>}
    </div>}
    <details className="ai-api-settings"><summary>API keys & endpoints <span>{connections.filter(item => item.kind === 'api_key' && item.configured).length} connected</span></summary>
      <div className="ai-api-list">{connections.filter(item => item.kind === 'api_key').map(item => <button type="button" key={item.id} aria-pressed={apiProvider === item.id} onClick={() => { setApiProvider(item.id); setEndpoint(item.baseUrl); if (key.current) key.current.value = ''; }}><span>{item.name}</span>{item.configured && <Check size={13} aria-label="Connected" />}</button>)}</div>
      <form onSubmit={event => { event.preventDefault(); void act('connections/update', { action: 'connect', provider: apiProvider, expectedRevision: status?.connectionRevision, key: key.current?.value ?? '', remember: remember && status?.rememberAvailable, ...((endpoint.trim() || apiConnection?.baseUrl) ? { baseUrl: endpoint.trim() || apiConnection?.baseUrl } : {}) }, '', apiProvider); }} autoComplete="off">
        <fieldset disabled={locked || waiting || apiConnection?.locked}>
          <Label htmlFor="assistant-api-key">{apiConnection?.name ?? 'Provider'} API key</Label><Input id="assistant-api-key" ref={key} type="password" required minLength={16} maxLength={4096} autoComplete="off" spellCheck={false} />
          <details><summary>Custom endpoint</summary><Label htmlFor="assistant-api-endpoint">HTTPS API base URL</Label><Input id="assistant-api-endpoint" type="url" value={endpoint} placeholder={apiConnection?.baseUrl} onChange={event => setEndpoint(event.target.value)} /><small>Your key and messages will be sent to this endpoint.</small></details>
          <Button type="submit">Connect &amp; use {apiConnection?.name}</Button>
        </fieldset>
      </form>
      {(apiConnection?.configured && !apiConnection.inherited || apiConnection?.locked) && <Button variant="ghost" disabled={locked || waiting} onClick={() => disconnect(apiProvider)}>Remove {apiConnection?.name} connection</Button>}
      {apiProvider === 'openai' && <small>Without a separate Assistant key, OpenAI uses the image-generation key below. Manage or disconnect that key under Image generation.</small>}
    </details>
      </div>
    </details>
    <details className="ai-privacy-settings"><summary>Privacy &amp; storage</summary><div>
      <small>Messages, recent context and requested tool results go to your selected provider and use that account’s allowance. History stays {capabilities.credentialLocation === 'workspace' ? 'in this workspace' : 'on this computer'}. Connecting does not send a message.</small>
      <DraftPreference disabled={locked || waiting} />
    </div></details>
    {status?.busy && <p role="status">Wait for the current turn to finish or stop it before changing connections.</p>}
    {error && <p role="alert" className="settings-error">{error}</p>}{notice && <p role="status">{notice}</p>}
  </section>;
}

function DraftPreference({ disabled }: { disabled: boolean }) {
  const { api, capabilities } = useStudioClient();
  const [snapshot, setSnapshot] = useState<DraftSnapshot>();
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const location = capabilities.credentialLocation === 'workspace' ? 'in this workspace' : 'on this computer';
  useEffect(() => {
    let alive = true;
    void api<DraftSnapshot>('/assistant/drafts/read', { scope: { projectId: null, conversationId: null } }).then(value => { if (alive) setSnapshot(value); }).catch(() => {});
    return () => { alive = false; };
  }, [api]);
  if (!snapshot) return null;
  return <><label className="ai-remember"><input type="checkbox" checked={snapshot.enabled} disabled={disabled || busy} onChange={event => {
    const enabled = event.target.checked;
    setBusy(true); setError('');
    void api<DraftSnapshot>('/assistant/drafts/configure', { scope: { projectId: null, conversationId: null }, update: { context: snapshot.context, preferenceRevision: snapshot.preferenceRevision, enabled } }).then(setSnapshot).catch(() => setError('Could not save your draft preference. Try again.')).finally(() => setBusy(false));
  }} />Remember drafts {location}</label>{error && <p role="alert">{error}</p>}</>;
}
