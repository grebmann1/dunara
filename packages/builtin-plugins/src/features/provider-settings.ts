import { randomUUID } from 'node:crypto';
import { BuilderError } from "../../../core/src/contracts.js";
import { openAIImages, type ImageProvider } from "../../../core/src/openai-images.js";
import { providerUpdateSchema, type ProviderStatus } from "../../../core/src/provider-contracts.js";
import type { CredentialStore } from "../../../core/src/credentials.js";

export interface ProviderOptions {
  startupKey?: string;
  credentials?: CredentialStore;
  createProvider?: (key: string) => ImageProvider;
}

// Owned only by MediaJobs; callers must hold its approval queue when changing configuration.
export class ProviderSettings {
  #key = '';
  #listeners = new Set<{ changed: () => void; beforeChange: () => void }>();
  #provider?: ImageProvider;
  #startup?: ImageProvider;
  #factory: (key: string) => ImageProvider;
  #source: ProviderStatus['source'];
  #revision = randomUUID();
  #locked = false;
  constructor(provider?: ImageProvider, private options: ProviderOptions = {}) {
    this.#factory = options.createProvider ?? openAIImages;
    this.#startup = options.startupKey ? this.create(options.startupKey) : provider;
    let saved: string | undefined;
    try { saved = options.credentials?.load(); } catch { this.#locked = true; }
    this.#provider = saved ? this.create(saved) : this.#locked ? undefined : this.#startup;
    this.#key = saved ?? (this.#locked ? '' : options.startupKey ?? '');
    this.#source = saved ? 'saved' : this.#provider ? 'environment' : 'none';
  }
  // Backend-only access: callers must never serialize this credential snapshot.
  credential() { return { key: this.#key, source: this.#source, environmentAvailable: !!this.#startup }; }
  subscribe(changed: () => void, beforeChange: () => void) {
    const listener = { changed, beforeChange }; this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }
  private create(key: string) {
    try { return this.#factory(key); }
    catch { throw new BuilderError('INVALID_INPUT', 'Provider configuration failed. No verification request was made.'); }
  }
  status(busy: boolean): ProviderStatus {
    return { configured: !!this.#provider, source: this.#source, revision: this.#revision, busy, environmentAvailable: !!this.#startup, storage: this.#locked ? 'locked' : this.options.credentials?.protection?.kind ?? 'session', rememberAvailable: !this.#locked && !!this.options.credentials?.protection };
  }
  assertRevision(revision: unknown) {
    if (revision !== this.#revision) throw new BuilderError('REVISION_CONFLICT', 'OpenAI configuration changed. Refresh and review the current configuration before approving or saving again.');
  }
  update(input: unknown, busy: boolean) {
    const parsed = providerUpdateSchema.safeParse(input);
    if (!parsed.success) throw new BuilderError('INVALID_INPUT', 'Invalid provider settings. Use a nonempty ASCII token up to 4096 characters, without whitespace, and a current configuration revision.');
    const value = parsed.data;
    this.assertRevision(value.expectedRevision);
    if (this.#locked && value.action !== 'disconnect') throw new BuilderError('INVALID_INPUT', 'Saved credentials are locked. Restore the original protection and restart, or explicitly disconnect to forget them. Saved data was retained.');
    if (busy) throw new BuilderError('INVALID_INPUT', 'Wait for queued or running media work to finish, or cancel and wait for the active request to settle. Charges may already have occurred.');
    for (const listener of this.#listeners) listener.beforeChange();
    if (value.action === 'replace') {
      const provider = this.create(value.key);
      if (value.remember && !this.options.credentials?.protection) throw new BuilderError('INVALID_INPUT', 'Protected credential storage is unavailable. Use this key for the current session.');
      if (value.remember) this.options.credentials?.save(value.key); else this.options.credentials?.remove();
      this.#key = value.key; this.#provider = provider; this.#source = value.remember ? 'saved' : 'session';
    } else if (value.action === 'disconnect') {
      this.options.credentials?.remove(); this.#locked = false; this.#key = ''; this.#provider = undefined; this.#source = 'none';
    } else {
      if (!this.#startup) throw new BuilderError('INVALID_INPUT', 'No startup environment key is available in this Dunara session.');
      this.options.credentials?.remove(); this.#key = this.options.startupKey ?? ''; this.#provider = this.#startup; this.#source = 'environment';
    }
    this.#revision = randomUUID();
    for (const listener of this.#listeners) listener.changed();
    return this.status(false);
  }
  run(...args: Parameters<ImageProvider['run']>) {
    if (!this.#provider) throw new BuilderError('INVALID_INPUT', 'OpenAI image generation is not configured. Connect an image key in Settings → Image generation; OPENAI_API_KEY is an optional startup fallback. No provider call was made.');
    return this.#provider.run(...args);
  }
  close() { this.#key = ''; this.#listeners.clear(); this.#provider = undefined; this.#startup = undefined; this.#source = 'none'; }
}
