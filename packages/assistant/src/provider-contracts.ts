import { z } from 'zod';

export const assistantProviderSchema = z.enum(['openai', 'chatgpt', 'grok', 'xai', 'anthropic', 'google', 'mistral']);
export type AssistantProvider = z.infer<typeof assistantProviderSchema>;
export const assistantProviders = [
  { id: 'chatgpt', name: 'ChatGPT', runtime: 'openai-codex', kind: 'oauth', baseUrl: 'https://chatgpt.com/backend-api' },
  { id: 'grok', name: 'Grok', runtime: 'xai', kind: 'oauth', baseUrl: 'https://api.x.ai/v1' },
  { id: 'openai', name: 'OpenAI', runtime: 'openai', kind: 'api_key', baseUrl: 'https://api.openai.com/v1' },
  { id: 'anthropic', name: 'Anthropic', runtime: 'anthropic', kind: 'api_key', baseUrl: 'https://api.anthropic.com' },
  { id: 'google', name: 'Google Gemini', runtime: 'google', kind: 'api_key', baseUrl: 'https://generativelanguage.googleapis.com/v1beta' },
  { id: 'mistral', name: 'Mistral', runtime: 'mistral', kind: 'api_key', baseUrl: 'https://api.mistral.ai/v1' },
  { id: 'xai', name: 'xAI', runtime: 'xai', kind: 'api_key', baseUrl: 'https://api.x.ai/v1' },
] as const;
export const providerDefinition = (id: AssistantProvider) => assistantProviders.find(item => item.id === id)!;
