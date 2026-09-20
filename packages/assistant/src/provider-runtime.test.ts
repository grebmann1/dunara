import { afterEach, expect, it, vi } from 'vitest';
import { createAssistantRuntime } from './provider-runtime.js';
import { assistantProviders } from './provider-contracts.js';
import { AssistantConnections } from './connections.js';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
it('routes all seven connections through the installed adapters and only the supplied credential', async () => {
  for (const name of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'XAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'MISTRAL_API_KEY', 'BUILDER_ASSISTANT_API_KEY']) vi.stubEnv(name, 'UNTRUSTED-AMBIENT-KEY');
  const home = await mkdtemp(path.join(os.tmpdir(), 'assistant-runtime-')); roots.push(home);
  const connections = new AssistantConnections(home, undefined, () => {}, () => {}); await connections.initialize();
  for (const provider of assistantProviders) {
    const model = connections.models(provider.id)[0]!.id;
    const { runtime, model: selected } = await createAssistantRuntime({ provider: provider.id, model, apiKey: 'fixture-selected-credential' });
    expect(selected.provider).toBe(provider.runtime); expect(selected.id).toBe(model);
    expect((await runtime.getAuth(selected))?.auth.apiKey).toBe('fixture-selected-credential');
    expect(new URL(selected.baseUrl).origin).toBe(new URL(provider.baseUrl).origin);
  }
  connections.close();
});
it('allows explicit API endpoints, refuses subscription redirects and rejects unsupported models', async () => {
  const input = { provider: 'openai' as const, model: 'gpt-6-astra', apiKey: 'fixture-selected-credential' };
  const { model, runtime } = await createAssistantRuntime({ ...input, baseUrl: 'https://gateway.example/v1/' });
  expect(model.baseUrl).toBe('https://gateway.example/v1'); expect((await runtime.getAuth(model))?.auth.apiKey).toBe(input.apiKey);
  await expect(createAssistantRuntime({ ...input, provider: 'chatgpt', baseUrl: 'https://gateway.example/v1' })).rejects.toThrow('endpoint');
  await expect(createAssistantRuntime({ ...input, model: 'unknown-model' })).rejects.toThrow('unavailable');
});
