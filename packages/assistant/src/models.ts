import type { Api, Model } from '@earendil-works/pi-ai';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';

// The pinned adapter predates Sol 6.1. Keep this documented Responses model
// available offline until the adapter's built-in catalogue includes it.
// https://developers.openai.com/api/docs/models/gpt-6.1-sol
const sol: Model<'openai-responses'> = {
  id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', provider: 'openai', api: 'openai-responses',
  baseUrl: 'https://api.openai.com/v1', reasoning: true, input: ['text', 'image'],
  contextWindow: 1_050_000, maxTokens: 128_000,
  cost: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  thinkingLevelMap: { off: null, minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' },
};

export function assistantModels(runtime: ModelRuntime, provider: string): readonly Model<Api>[] {
  const models = runtime.getModels(provider);
  return provider === 'openai' && !models.some(model => model.id === sol.id) ? [sol, ...models] : models;
}
