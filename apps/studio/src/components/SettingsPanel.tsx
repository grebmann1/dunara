import { useEffect, useRef, useState } from 'react';
import { type AssistantStatus, type ProviderStatus, type ProviderUpdate, useStudioClient } from '../api';
import type { Project } from '../../../../packages/core/src/contracts';
import { KeyRound, ShieldCheck } from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { SupabaseSettings } from './BackendPanel';
import { AccountSettings } from './AccountSettings';

export function SettingsPanel({ enabledPlugins, settings, onSettings, disabled, project }: { enabledPlugins?: string[]; project?: Project; settings?: ProviderStatus; onSettings: (value: ProviderStatus) => void; disabled: boolean }) {
  const { api, capabilities } = useStudioClient();
  const enabled = (id: string) => !enabledPlugins || enabledPlugins.includes(id);
  const input = useRef<HTMLInputElement>(null), operating = useRef(false), alive = useRef(true);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [remember, setRemember] = useState(false);
  useEffect(() => {
    alive.current = true;
    const field = input.current;
    return () => { alive.current = false; if (field) field.value = ''; };
  }, []);
  async function update(action: ProviderUpdate['action']) {
    if (!settings || disabled || operating.current || settings.busy) return;
    operating.current = true; setBusy(true); setError(''); setNotice('');
    try {
      const pending = api<ProviderStatus>('/settings', { action, expectedRevision: settings.revision, ...(action === 'replace' ? { key: input.current?.value ?? '', remember: remember && settings.rememberAvailable } : {}) });
      if (input.current) input.current.value = '';
      const next = await pending;
      onSettings(next);
      if (alive.current) setNotice(next.configured ? 'Configuration saved. Not verified; no provider request was made.' : 'OpenAI disconnected for image generation and the assistant. Offline tools remain available.');
    } catch (cause) {
      if (alive.current) setError(cause instanceof Error ? cause.message : 'Settings could not be updated. Re-enter the key to try again.');
      try { onSettings(await api<ProviderStatus>('/settings')); } catch { /* Keep the operation failure visible. */ }
    } finally {
      if (input.current) input.current.value = '';
      operating.current = false;
      if (alive.current) setBusy(false);
    }
  }
  return <main className="destination settings-workspace">
    <header><h1>Settings</h1><p>Your project and connected services.</p></header>
    {capabilities.accountSettings && enabled('builder.account') && <AccountSettings disabled={disabled} projectId={project?.id} />}
    {project && <section className="settings-section project-settings" aria-label="Project details"><h2>Project details</h2><dl><div><dt>Name</dt><dd>{project.name}</dd></div><div><dt>Project ID</dt><dd><code>{project.id}</code></dd></div>{capabilities.localPaths && <div><dt>Source folder</dt><dd><code>{project.root}</code></dd></div>}</dl></section>}
    {enabled('builder.media') && <><h2>OpenAI setup</h2>
    <section className="settings-section" aria-label="OpenAI configuration">
      <div className="flex items-center gap-3"><KeyRound size={20} aria-hidden="true" /><h2 className="m-0">{settings?.configured ? 'Configured · not verified' : 'Not configured'}</h2></div>
      <p>One key powers image generation and the AI assistant. Credential source: <strong>{settings?.source ?? 'Loading…'}</strong>. Settings never probes OpenAI. The first separately approved paid request checks live capability.</p>
      <form autoComplete="off" onSubmit={event => { event.preventDefault(); void update('replace'); }}>
        <fieldset className="m-0 min-w-0 border-0 p-0" disabled={disabled || busy || !settings || settings.busy || settings.storage === 'locked'}>
          <Label htmlFor="openai-session-key">OpenAI API key</Label>
          <Input id="openai-session-key" className="mt-2" ref={input} type="password" name="openai-session-key" required maxLength={4096} autoComplete="off" autoCorrect="off" autoCapitalize="none" spellCheck={false} aria-describedby="key-lifetime key-privacy" />
          <p id="key-lifetime">Session-only unless you choose to remember it. The field clears on submission and navigation. No validation call, generation or automatic retry.</p>
          <label className="flex items-center gap-2"><input className="h-[44px] w-[44px] shrink-0" type="checkbox" disabled={!settings?.rememberAvailable} checked={remember && !!settings?.rememberAvailable} onChange={event => setRemember(event.target.checked)} />{capabilities.credentialLocation === 'workspace' ? 'Remember in this workspace' : 'Remember on this computer'}</label>
          <p id="key-privacy">{settings?.storage === 'os' ? 'Remembered keys are encrypted using this computer’s protected storage.' : settings?.storage === 'configured' ? 'Remembered keys are encrypted with the configured Dunara encryption key.' : settings?.storage === 'locked' ? 'Saved credentials are locked or storage is unsafe. Restore the original protection and restart, or disconnect to forget the saved key.' : 'Protected storage is unavailable. Keys can be used for this session only.'} Keys stay in the Dunara service. Saving session-only or disconnecting removes the saved key.</p>
          <div className="flex flex-wrap gap-2"><Button type="submit">{remember && settings?.rememberAvailable ? (capabilities.credentialLocation === 'workspace' ? 'Save in this workspace' : 'Save on this computer') : 'Save for this Dunara session'}</Button><Button variant="outline" type="button" onClick={() => { if (input.current) input.current.value = ''; setError(''); setNotice('Key entry cleared.'); }}>Cancel key entry</Button></div>
        </fieldset>
      </form>
      <div className="mt-6 flex flex-wrap gap-2 border-0 border-t border-solid border-border pt-4">
        <Button variant="outline" disabled={disabled || busy || !settings || settings.busy || (!settings.configured && settings.storage !== 'locked')} onClick={() => void update('disconnect')}>Disconnect OpenAI</Button>
        {settings?.environmentAvailable && <Button variant="outline" disabled={disabled || busy || settings.busy} onClick={() => void update('environment')}>Use startup environment key</Button>}
      </div>
      {settings?.busy && <p role="status">A request is queued or running. Wait for it to finish, or review cancellation in Assets. Cancellation cannot guarantee that charges stop.</p>}
      {error && <p role="alert" className="settings-error">{error}</p>}
      <p role="status">{busy ? 'Updating configuration…' : notice}</p>
    </section>
    </>}
    {enabled('builder.supabase') && <SupabaseSettings disabled={disabled} />}
    {enabled('builder.assistant') && <AssistantSettings disabled={disabled} revision={settings?.revision} />}
    <section className="settings-section"><div className="flex items-center gap-3"><ShieldCheck size={20} aria-hidden="true" /><h2 className="m-0">Lifetime and spending</h2></div><p>Saved keys take precedence over startup environment keys. Session-only replacement removes the saved key. Disconnect deletes the saved key and disables OpenAI for both features until you reconnect or restart; it never edits your environment or .env file.</p><p>Dunara reads <code>OPENAI_API_KEY</code> from its startup environment or .env file. Existing saved OpenAI keys are reused for both features. Restart reloads saved or startup keys without making a provider request.</p><p>Changing configuration invalidates previous consent. Every billable request still requires its exact prompt, references and model disclosure plus fresh approval in Assets. “Configured” does not mean the key, account or model has been verified.</p></section>
  </main>;
}

function AssistantSettings({ disabled, revision }: { disabled: boolean; revision?: string }) {
  const { api } = useStudioClient();
  const alive = useRef(true), operating = useRef(false), version = useRef(0);
  const [status, setStatus] = useState<AssistantStatus>(), [selected, setSelected] = useState(''), [busy, setBusy] = useState(false), [notice, setNotice] = useState(''), [error, setError] = useState('');
  useEffect(() => {
    alive.current = true;
    const refresh = async () => {
      if (operating.current) return;
      const request = ++version.current;
      try { const value = await api<AssistantStatus>('/assistant/status'); if (alive.current && request === version.current) { setStatus(value); setSelected(previous => previous || value.model || ''); } }
      catch { if (alive.current && request === version.current) setError('Assistant status unavailable. Check the local runtime.'); }
    };
    void refresh(); const timer = setInterval(() => void refresh(), 5000);
    return () => { alive.current = false; version.current++; clearInterval(timer); };
  }, [revision]);
  async function update() {
    if (disabled || operating.current || !status?.available || status.busy || !selected) return;
    operating.current = true; version.current++; setBusy(true); setError(''); setNotice('');
    try {
      const next = await api<AssistantStatus>('/assistant/configure', { action: 'model', model: selected });
      if (alive.current) { setStatus(next); setNotice('Assistant model saved for future messages. No provider request was made.'); }
    } catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : 'Assistant configuration failed.'); }
    finally { operating.current = false; if (alive.current) setBusy(false); }
  }
  return <section className="settings-section" aria-label="Assistant configuration">
    <div className="flex items-center gap-3"><KeyRound size={20} aria-hidden="true" /><h2 className="m-0">AI assistant</h2></div>
    <p>{!status ? 'Loading assistant availability…' : !status.available ? 'The AI assistant is available in the desktop app.' : status.configured ? `Uses your OpenAI key · ${status.source ?? 'session'}` : 'Add your OpenAI API key above to start using the assistant.'}</p>
    <form onSubmit={event => { event.preventDefault(); void update(); }}>
      <fieldset className="m-0 min-w-0 border-0 p-0" disabled={disabled || busy || !status?.available || status.busy}>
        <Label htmlFor="assistant-model">Assistant model</Label>
        <select id="assistant-model" value={selected} required onChange={event => { setSelected(event.target.value); setNotice(''); }} aria-describedby="assistant-model-help">
          {!selected && <option value="" disabled>Select a model</option>}
          {selected && !status?.models?.some(model => model.id === selected) && <option value={selected} disabled>{selected} (unavailable)</option>}
          {status?.models?.map(model => <option key={model.id} value={model.id}>{model.label} · {model.id}</option>)}
        </select>
        <p id="assistant-model-help">Choose a model for future messages in all conversations. Your choice is remembered on this computer. Models come from the installed assistant; access depends on your OpenAI account.</p>
        <Button type="submit" disabled={selected === status?.model || !status?.models?.some(model => model.id === selected)}>Save assistant model</Button>
      </fieldset>
    </form>
    <p>Sending a message may incur charges and shares your message, recent conversation and requested app content with OpenAI. Image generation requires its own approval.</p>
    <p>Conversation history stays on this computer. Delete it in the assistant panel.</p>
    {status?.busy && <p role="status">An assistant turn is active. Wait for it to finish or stop it before changing the model or OpenAI key.</p>}
    {error && <p role="alert" className="settings-error">{error}</p>}
    <p role="status">{busy ? 'Saving assistant model…' : notice}</p>
  </section>;
}
