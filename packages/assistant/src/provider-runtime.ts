import type { ModelRuntime as Runtime } from '@earendil-works/pi-coding-agent';
import type { HarnessInput } from './contracts.js';
import { providerDefinition } from './provider-contracts.js';
import type { PiFixture } from './pi.js';
import { managedAiEndpoint } from '../../core/src/managed-ai.js';

/** Each worker receives one frozen credential, with no ambient credentials or refresh tokens. */
export async function createAssistantRuntime(input: Pick<HarnessInput, 'provider' | 'model' | 'apiKey' | 'baseUrl'>, fixture?: PiFixture) {
  const { ModelRuntime } = await import('@earendil-works/pi-coding-agent');
  const definition = providerDefinition(input.provider ?? 'openai');
  if (definition.kind === 'managed' && !input.baseUrl) throw new Error('Managed AI transport is unavailable');
  const runtime: Runtime = await ModelRuntime.create({ credentials: {
    async read(id) {
      // Codex has OAuth-only auth: supplying a runtime API key cannot authenticate it.
      // Refresh happens in the parent before dispatch; this worker cannot renew a token.
      if (!fixture && definition.runtime === 'openai-codex' && id === definition.runtime) return { type: 'oauth' as const, access: input.apiKey, refresh: '', expires: Number.MAX_SAFE_INTEGER };
    },
    async list() { return []; }, async modify() { throw new Error('Credential persistence disabled'); }, async delete() {},
  }, modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  let provider: string = definition.runtime, modelId = input.model ?? 'gpt-6-astra';
  if (fixture) {
    if (input.apiKey !== 'offline-worker-credential-sentinel') throw new Error('Offline fixtures accept only the public test sentinel, never provider credentials');
    const url = new URL(fixture.baseUrl);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password) throw new Error('Fixture provider must be local');
    provider = 'builder-fixture'; modelId = fixture.model;
    runtime.registerProvider(provider, { api: 'openai-responses', baseUrl: fixture.baseUrl, models: [{ id: modelId, name: 'Offline fixture', reasoning: fixture.reasoning ?? false, input: ['text', 'image'], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] });
  }
  let model = runtime.getModel(provider, modelId);
  if (!model || !model.input.includes('image')) throw new Error('Selected assistant model is unavailable');
  if (input.baseUrl && !fixture) {
    const url = new URL(input.baseUrl);
    if (definition.kind === 'managed') managedAiEndpoint(input.baseUrl);
    else if (definition.kind !== 'api_key' || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Invalid provider endpoint');
    model = { ...model, baseUrl: url.href.replace(/\/$/, '') };
  }
  if (provider !== 'openai-codex') await runtime.setRuntimeApiKey(provider, input.apiKey);
  return { runtime, model };
}
