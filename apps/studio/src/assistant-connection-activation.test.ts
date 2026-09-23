import { afterEach, expect, test, vi } from 'vitest';
import type { AssistantStatus, createStudioClient } from './api';
import { activateAssistantConnection } from './assistant-connection-activation';

type Api = ReturnType<typeof createStudioClient>['api'];
const before: AssistantStatus = { available: true, configured: false, busy: false, active: null, epoch: '00000000-0000-4000-8000-000000000001', accountContext: 'account-one', providerId: 'openai', model: 'previous-model' };
const connection = { id: 'chatgpt' as const, name: 'ChatGPT' as const, kind: 'oauth' as const, configured: true, inherited: false, source: 'session', locked: false, baseUrl: '', models: [{ id: 'first-supported', label: 'First supported' }] };
const waiting: AssistantStatus = { ...before, signIn: { id: 'this-login', provider: 'chatgpt', state: 'waiting' } };
const completed: AssistantStatus = { ...before, connections: [connection], signIn: { id: 'this-login', provider: 'chatgpt', state: 'connected' } };
afterEach(() => vi.useRealTimers());

test('uses the connected catalog model without sending a message or persisting credentials', async () => {
  const api = vi.fn().mockResolvedValue({ ...completed, providerId: 'chatgpt', model: 'first-supported', configured: true });
  await activateAssistantConnection(api as Api, completed, before, 'chatgpt');
  expect(api.mock.calls).toEqual([['/assistant/configure', { action: 'model', provider: 'chatgpt', model: 'first-supported' }]]);
});

test.each([
  ['cancelled', { signIn: { ...completed.signIn!, state: 'cancelled' } }],
  ['failed', { signIn: { ...completed.signIn!, state: 'failed' } }],
  ['superseded login', { signIn: { ...completed.signIn!, id: 'another-login' } }],
  ['changed provider', { providerId: 'anthropic' }],
  ['changed model', { model: 'later-choice' }],
  ['changed account', { accountContext: 'account-two' }],
  ['restarted runtime', { epoch: '00000000-0000-4000-8000-000000000002' }],
] as const)('does not activate a %s flow', async (_, changed) => {
  vi.useFakeTimers();
  const api = vi.fn().mockResolvedValue({ ...completed, ...changed });
  const result = activateAssistantConnection(api as Api, waiting, before, 'chatgpt');
  await vi.advanceTimersByTimeAsync(1000); await result;
  expect(api.mock.calls).toEqual([['/assistant/status']]);
});

test('keeps an existing model when reconnecting the selected provider', async () => {
  const previous = { ...before, providerId: 'chatgpt' as const, model: 'preferred-model' };
  const next = { ...completed, ...previous, connections: [{ ...connection, models: [...connection.models, { id: 'preferred-model', label: 'Preferred' }] }] };
  const api = vi.fn();
  await activateAssistantConnection(api as Api, next, previous, 'chatgpt');
  expect(api).not.toHaveBeenCalled();
});

test('reports selection failure without disconnecting or retrying it', async () => {
  const api = vi.fn().mockRejectedValue(new Error('A turn started'));
  await expect(activateAssistantConnection(api as Api, completed, before, 'chatgpt')).rejects.toThrow('A turn started');
  expect(api).toHaveBeenCalledTimes(1);
});
