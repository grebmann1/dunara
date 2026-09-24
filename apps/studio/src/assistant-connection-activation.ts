import type { AssistantStatus, createStudioClient } from './api';

type Api = ReturnType<typeof createStudioClient>['api'];

/** Finish this explicit connect-and-use request, including after Settings closes. */
export async function activateAssistantConnection(api: Api, connected: AssistantStatus, before: AssistantStatus, provider: string) {
  const flow = connected.signIn;
  let next = connected;
  const deadline = Date.now() + 10 * 60_000;
  if (flow?.provider === provider && flow.state === 'waiting') {
    while (next.signIn?.id === flow.id && next.signIn.state === 'waiting' && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      next = await api<AssistantStatus>('/assistant/status');
      if (next.epoch !== before.epoch || next.accountContext !== before.accountContext) return;
    }
    if (next.signIn?.id !== flow.id || next.signIn.state !== 'connected') return;
  }
  // A later choice in another view or account takes precedence over this login.
  if (next.epoch !== before.epoch || next.accountContext !== before.accountContext || next.providerId !== before.providerId || next.model !== before.model) return;
  const connection = next.connections?.find(item => item.id === provider);
  if (!connection?.configured) return;
  const model = next.providerId === provider && connection.models.some(item => item.id === next.model) ? next.model : connection.models[0]?.id;
  if (!model) throw new Error('Connected, but no supported models are available. Choose another connection.');
  if (next.providerId === provider && next.model === model) return next;
  return api<AssistantStatus>('/assistant/configure', { action: 'model', provider, model });
}
