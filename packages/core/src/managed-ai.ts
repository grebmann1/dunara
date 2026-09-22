/** Host-owned, metered OpenAI-compatible transport. Never serialize its credentials. */
export interface ManagedAiConnection {
  label: string;
  apiKey: string;
  baseUrl: string;
  models: { id: string; label: string }[];
  balance?: () => AiCreditBalance;
}
export interface AiCreditBalance {
  remaining: number;
  reserved: number;
  limit: number;
  resetsAt: string;
  reason?: string;
}
export class ManagedAiUnavailable extends Error {}
export function managedAiEndpoint(value: string) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash ||
    !(url.protocol === 'https:' || url.protocol === 'http:' && url.hostname === '127.0.0.1')) throw new Error('Invalid managed AI endpoint');
  return url.href.replace(/\/$/, '');
}
