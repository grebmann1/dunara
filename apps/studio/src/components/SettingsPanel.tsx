import { useEffect, useRef, useState } from 'react';
import { type ProviderStatus, type ProviderUpdate, useStudioClient } from '../api';
import type { Project } from '../../../../packages/core/src/contracts';
import { KeyRound, ShieldCheck } from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { SupabaseSettings } from './BackendPanel';
import { AssistantSettings } from './AssistantSettings';
import { AccountSettings } from './AccountSettings';
import { AiCredits } from './AiCredits';

export function SettingsPanel({ initialSection, enabledPlugins, settings, onSettings, disabled, project }: { initialSection?: 'images'; enabledPlugins?: string[]; project?: Project; settings?: ProviderStatus; onSettings: (value: ProviderStatus) => void; disabled: boolean }) {
  const { api, capabilities } = useStudioClient();
  const enabled = (id: string) => !enabledPlugins || enabledPlugins.includes(id);
  const imageSection = useRef<HTMLElement>(null);
  useEffect(() => {
    if (initialSection !== 'images') return;
    imageSection.current?.scrollIntoView({ block: 'start' });
    imageSection.current?.focus({ preventScroll: true });
  }, [initialSection]);
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
      if (alive.current) setNotice(next.configured ? 'Configuration saved. Not verified; no provider request was made.' : 'Image-generation OpenAI key disconnected. Separate Assistant connections remain available. Offline tools remain available.');
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
    {enabled('builder.assistant') && <AssistantSettings disabled={disabled} revision={settings?.revision} />}
    {capabilities.accountSettings && enabled('builder.account') && <AccountSettings disabled={disabled} projectId={project?.id} />}
    {project && <section className="settings-section project-settings" aria-label="Project details"><details><summary>Project details</summary><dl><div><dt>Name</dt><dd>{project.name}</dd></div><div><dt>Project ID</dt><dd><code>{project.id}</code></dd></div>{capabilities.localPaths && <div><dt>Source folder</dt><dd><code>{project.root}</code></dd></div>}</dl></details></section>}
    {enabled('builder.media') && <><h2>Image generation</h2>
    <section ref={imageSection} tabIndex={-1} className="settings-section" aria-label="OpenAI configuration">
      <div className="flex items-center gap-3"><KeyRound size={20} aria-hidden="true" /><h2 className="m-0">{settings?.chatgpt?.selected ? 'ChatGPT' : settings?.managed?.selected ? settings.managed.label : settings?.configured ? 'Configured · not verified' : 'Not configured'}</h2></div>
      {settings?.managed && <><AiCredits balance={settings.managed.balance} /><div className="flex flex-wrap gap-2"><Button disabled={disabled || busy || settings.busy || settings.managed.selected} onClick={() => void update('managed')}>Use {settings.managed.label}</Button><Button variant="outline" disabled={disabled || busy || settings.busy || !settings.managed.personalConfigured || !settings.managed.selected && !settings.chatgpt?.selected && settings.configured} onClick={() => void update('personal')}>Use personal image key</Button></div><p>Saving a personal key keeps your selected funding source. Use the buttons above to switch.</p></>}
      {settings?.chatgpt && <div><p>{settings.chatgpt.available ? 'Your ChatGPT connection can create images using your ChatGPT/Codex allowance. No API key needed.' : settings.chatgpt.reason}</p><div className="flex flex-wrap gap-2"><Button disabled={disabled || busy || settings.busy || !settings.chatgpt.available || settings.chatgpt.selected} onClick={() => void update('chatgpt')}>{settings.chatgpt.selected ? 'ChatGPT selected' : 'Use ChatGPT for images'}</Button>{!settings.managed && settings.personalConfigured && <Button variant="outline" disabled={disabled || busy || settings.busy || !settings.chatgpt.selected} onClick={() => void update('personal')}>Use personal image key</Button>}</div></div>}
      <p>An OpenAI API key is optional and billed separately from your ChatGPT subscription. Image requests always use the selected connection; they never switch automatically after a limit or error.</p><p>Image connection: <strong>{settings?.source === 'chatgpt' ? 'ChatGPT' : settings?.source ?? 'Loading…'}</strong>. Choose the Assistant provider and model in AI connections.</p>
      <details open={settings?.chatgpt?.selected || settings?.managed?.selected ? undefined : true}><summary>Use another image connection</summary>
      {!settings?.managed && <details className="provider-startup-details"><summary>OpenAI fallback and startup settings</summary><p>The OpenAI Assistant connection can reuse this image key when it has no separate key. Other Assistant providers use their own connections and do not require <code>OPENAI_API_KEY</code>.</p><p>An optional <code>OPENAI_API_KEY</code> in the startup environment or Dunara .env file supplies this image key. A saved image key takes precedence. Disconnect disables this fallback until you reconnect or restart; it never edits your environment or .env file. Separate Assistant connections are unchanged.</p></details>}
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
        <Button variant="outline" disabled={disabled || busy || !settings || settings.busy || (!settings.personalConfigured && settings.storage !== 'locked')} onClick={() => void update('disconnect')}>Disconnect OpenAI</Button>
        {settings?.environmentAvailable && <Button variant="outline" disabled={disabled || busy || settings.busy} onClick={() => void update('environment')}>Use startup environment key</Button>}
      </div>
      </details>
      {settings?.busy && <p role="status">A request is queued or running. Wait for it to finish, or review cancellation in Assets. Cancellation cannot guarantee that charges stop.</p>}
      {error && <p role="alert" className="settings-error">{error}</p>}
      <p role="status">{busy ? 'Updating configuration…' : notice}</p>
    </section>
    </>}
    {enabled('builder.supabase') && <SupabaseSettings disabled={disabled} />}
    <section className="settings-section" aria-label="Connections and spending"><div className="flex items-center gap-3"><ShieldCheck size={20} aria-hidden="true" /><h2 className="m-0">Connections and spending</h2></div><p>Each Assistant provider has its own connection. Messages use your selected provider and model. Disconnecting one provider leaves other connections available.</p><p>Remembered connections use encrypted storage when available. Session-only credentials last until Dunara closes. Replacing a remembered connection with a session-only one removes its saved credentials.</p><p>Sending an Assistant message authorizes that turn. Image generation has separate settings and requires approval in Assets; changing those settings invalidates previous image-request approval. Saving a key makes no provider request. Subscription sign-in and refresh contact that provider. “Connected” does not mean every model is available to your account.</p></section>
  </main>;
}
