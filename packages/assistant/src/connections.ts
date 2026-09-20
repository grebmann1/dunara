import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AuthInteraction, OAuthAuth, OAuthCredential } from '@earendil-works/pi-ai';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { BuilderError } from '../../core/src/contracts.js';
import { EncryptedSettingsStore, credentialKeySchema, type SecretProtection } from '../../core/src/credentials.js';

import { assistantProviderSchema, assistantProviders, providerDefinition, type AssistantProvider } from './provider-contracts.js';
export { assistantProviderSchema, providerDefinition, type AssistantProvider } from './provider-contracts.js';
const token = z.string().min(1).max(16384).regex(/^[\x21-\x7e]+$/);
const oauthCredential = z.object({ type: z.literal('oauth'), access: token, refresh: z.string().max(16384), expires: z.number().finite() }).catchall(z.unknown());
const credentialSchema = z.discriminatedUnion('type', [z.object({ type: z.literal('api_key'), key: credentialKeySchema }).strict(), oauthCredential]);
const endpointSchema = z.string().max(2048).url().refine(value => { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash; }, 'Use an HTTPS endpoint without credentials, query or fragment');
const savedSchema = z.object({ credential: credentialSchema, baseUrl: endpointSchema.optional() }).strict();
type Saved = z.infer<typeof savedSchema>;
export type AssistantModel = { id: string; label: string };
export type SignIn = { id: string; provider: AssistantProvider; state: 'waiting' | 'connected' | 'failed' | 'cancelled'; url?: string; code?: string; prompt?: { id: string; kind: 'manual_code' | 'text' | 'secret' }; message?: string };
type Flow = { view: SignIn; controller: AbortController; timer: ReturnType<typeof setTimeout>; answer?: (value: string) => void; remember: boolean };
const failure = (message: string) => new BuilderError('INVALID_INPUT', message);

/** Owns credentials in the service. Only redacted connection metadata reaches Studio. */
export class AssistantConnections {
  private records = new Map<AssistantProvider, Saved>();
  private sources = new Map<AssistantProvider, 'saved' | 'session'>();
  private locked = new Set<AssistantProvider>();
  private stores = new Map<AssistantProvider, EncryptedSettingsStore<Saved>>();
  private runtime?: ModelRuntime;
  private flow?: Flow;
  private closed = false;
  private revision = randomUUID();
  constructor(home: string, private protection: SecretProtection | undefined, private changed: () => void, private idle: () => void, private oauthOverride?: (provider: AssistantProvider) => OAuthAuth) {
    for (const { id } of assistantProviders) {
      const store = new EncryptedSettingsStore(home, `assistant-connection-${id}`, savedSchema, protection); this.stores.set(id, store);
      try { const value = store.load(); if (value) { this.records.set(id, value); this.sources.set(id, 'saved'); } }
      catch { this.locked.add(id); }
    }
  }
  async initialize() {
    const { ModelRuntime } = await import('@earendil-works/pi-coding-agent');
    this.runtime = await ModelRuntime.create({ credentials: { async read() {}, async list() { return []; }, async modify() { throw new Error('Credential persistence disabled'); }, async delete() {} }, modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  }
  models(id: AssistantProvider): AssistantModel[] {
    return this.runtime?.getModels(providerDefinition(id).runtime).filter(model => model.input.includes('image') && !/chat-latest|realtime/.test(model.id)).map(model => ({ id: model.id, label: model.name })) ?? (id === 'openai' ? [{ id: 'gpt-6-astra', label: 'GPT-6 Astra' }] : []);
  }
  status(legacy: { key: string; source: string }) {
    return { connectionRevision: this.revision, rememberAvailable: !!this.protection, signIn: this.flow?.view ?? null, connections: assistantProviders.map(item => {
      const record = this.records.get(item.id), useLegacy = item.id === 'openai' && !record && !this.locked.has(item.id);
      return { id: item.id, name: item.name, kind: item.kind, inherited: useLegacy && !!legacy.key, configured: !!record || useLegacy && !!legacy.key, source: record ? this.sources.get(item.id)! : useLegacy ? legacy.source : 'none', locked: this.locked.has(item.id), baseUrl: record?.baseUrl ?? item.baseUrl, models: this.models(item.id) };
    }) };
  }
  credential(id: AssistantProvider, legacy: { key: string; source: string }): { key: string; source: string; baseUrl?: string } {
    const record = this.records.get(id);
    return record ? { key: record.credential.type === 'oauth' ? record.credential.access : record.credential.key, source: this.sources.get(id)!, baseUrl: record.baseUrl } : id === 'openai' && !this.locked.has(id) ? legacy : { key: '', source: 'none' };
  }
  private checkRevision(revision: string) { if (revision !== this.revision) throw new BuilderError('REVISION_CONFLICT', 'AI connections changed. Refresh and try again.'); }
  private publish() { this.revision = randomUUID(); this.changed(); }
  private save(id: AssistantProvider, record: Saved, remember: boolean) {
    if (this.closed) throw failure('Assistant connections are closed.');
    if (this.locked.has(id)) throw failure('This connection is locked. Restore protected storage or disconnect it first.');
    if (remember && !this.protection) throw failure('Protected storage is unavailable. Connect for this session only.');
    if (remember) this.stores.get(id)!.save(record); else this.stores.get(id)!.remove();
    this.records.set(id, record); this.sources.set(id, remember ? 'saved' : 'session'); this.publish();
  }
  update(input: unknown) {
    this.idle();
    const value = z.discriminatedUnion('action', [
      z.object({ action: z.literal('connect'), provider: assistantProviderSchema, expectedRevision: z.uuid(), key: credentialKeySchema, remember: z.boolean(), baseUrl: endpointSchema.optional() }).strict(),
      z.object({ action: z.literal('disconnect'), provider: assistantProviderSchema, expectedRevision: z.uuid() }).strict(),
    ]).parse(input);
    this.checkRevision(value.expectedRevision);
    if (this.pending()) throw failure('Finish or cancel sign-in before changing connections.');
    if (value.action === 'disconnect') { this.stores.get(value.provider)!.remove(); this.records.delete(value.provider); this.sources.delete(value.provider); this.locked.delete(value.provider); this.publish(); }
    else {
      if (providerDefinition(value.provider).kind !== 'api_key') throw failure('Use subscription sign-in for this provider.');
      this.save(value.provider, { credential: { type: 'api_key', key: value.key }, baseUrl: value.baseUrl }, value.remember);
    }
  }
  private oauth(id: AssistantProvider) { const auth = this.oauthOverride?.(id) ?? this.runtime?.getProvider(providerDefinition(id).runtime)?.auth.oauth; if (!auth) throw failure('Sign-in is unavailable. Install the optional Assistant runtime.'); return auth; }
  pending() { return this.flow?.view.state === 'waiting'; }
  async begin(input: unknown) {
    this.idle();
    const value = z.object({ provider: z.enum(['chatgpt', 'grok']), expectedRevision: z.uuid(), remember: z.boolean() }).strict().parse(input);
    this.checkRevision(value.expectedRevision);
    if (this.pending()) throw failure('Finish or cancel the current sign-in first.');
    if (value.remember && !this.protection) throw failure('Protected storage is unavailable. Connect for this session only.');
    if (this.locked.has(value.provider)) throw failure('Disconnect the locked connection before signing in.');
    const auth = this.oauth(value.provider), controller = new AbortController();
    const flow: Flow = { view: { id: randomUUID(), provider: value.provider, state: 'waiting' }, controller, remember: value.remember, timer: setTimeout(() => this.cancel(), 10 * 60_000) }; flow.timer.unref(); this.flow = flow; this.changed();
    const interaction: AuthInteraction = {
      signal: controller.signal,
      notify: event => {
        if (this.flow !== flow || controller.signal.aborted) return;
        if (event.type === 'auth_url' || event.type === 'device_code') {
          const url = new URL(event.type === 'auth_url' ? event.url : event.verificationUri);
          const hosts = value.provider === 'chatgpt' ? ['auth.openai.com'] : ['auth.x.ai', 'accounts.x.ai', 'grok.com', 'x.ai'];
          if (url.protocol !== 'https:' || !!url.port || !hosts.includes(url.hostname) || url.username || url.password) { throw failure('The provider returned an unsupported sign-in address.'); }
          flow.view = { ...flow.view, url: url.href, code: event.type === 'device_code' ? event.userCode.slice(0, 128) : undefined };
          this.changed();
        }
      },
      prompt: async prompt => {
        if (prompt.type === 'select') { if (prompt.options.some(option => option.id === 'browser')) return 'browser'; throw failure('Unsupported sign-in step.'); }
        const signal = prompt.signal ? AbortSignal.any([controller.signal, prompt.signal]) : controller.signal; signal.throwIfAborted();
        return new Promise<string>((resolve, reject) => {
          const id = randomUUID(); flow.view = { ...flow.view, prompt: { id, kind: prompt.type } };
          const clear = () => { signal.removeEventListener('abort', abort); flow.answer = undefined; delete flow.view.prompt; this.changed(); };
          const abort = () => { clear(); reject(new Error('Sign-in cancelled')); };
          flow.answer = answer => { clear(); resolve(answer); }; signal.addEventListener('abort', abort, { once: true }); this.changed();
        });
      },
    };
    void auth.login({ ...interaction, signal: controller.signal }).then(credential => {
      if (this.flow !== flow || controller.signal.aborted || this.closed) return;
      this.idle(); this.save(value.provider, { credential: oauthCredential.parse(credential) }, flow.remember);
      flow.view = { id: flow.view.id, provider: value.provider, state: 'connected' }; this.changed();
    }).catch(() => {
      if (this.flow !== flow || controller.signal.aborted || this.closed) return;
      flow.view = { id: flow.view.id, provider: value.provider, state: 'failed', message: 'Sign-in did not complete. Try again or use an API key.' }; this.changed();
    }).finally(() => { clearTimeout(flow.timer); flow.answer = undefined; });
    return this.flow.view;
  }
  answer(input: unknown) {
    const value = z.object({ id: z.uuid(), promptId: z.uuid(), value: z.string().trim().min(1).max(4096) }).strict().parse(input);
    if (!this.pending() || this.flow?.view.id !== value.id || this.flow.view.prompt?.id !== value.promptId || !this.flow.answer) throw failure('This sign-in step expired. Start again.');
    this.flow.answer(value.value);
  }
  cancel(id?: string) {
    if (id && this.flow?.view.id !== id) throw failure('This sign-in is no longer active.');
    if (!this.flow || !this.pending()) return;
    this.flow.controller.abort(); clearTimeout(this.flow.timer);
    this.flow.view = { id: this.flow.view.id, provider: this.flow.view.provider, state: 'cancelled' }; this.changed();
  }
  async prepare(id: AssistantProvider) {
    const record = this.records.get(id); if (!record || record.credential.type !== 'oauth') return;
    if (record.credential.expires > Date.now() + 60_000) return;
    try {
      const credential = await this.oauth(id).refresh(record.credential as OAuthCredential, AbortSignal.timeout(20_000));
      if (this.closed || this.records.get(id) !== record) throw new Error('Connection changed');
      this.save(id, { ...record, credential: oauthCredential.parse(credential) }, this.sources.get(id) === 'saved');
    } catch { throw failure('Your subscription session expired. Sign in again in AI connections.'); }
  }
  secrets() { return [...this.records.values()].flatMap(record => record.credential.type === 'api_key' ? [record.credential.key] : [record.credential.access, record.credential.refresh]).filter(Boolean); }
  close() { this.cancel(); this.closed = true; this.records.clear(); }
}
