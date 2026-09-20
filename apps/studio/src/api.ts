import type { Engine } from '../../../packages/core/src/engine';
import type { Diagnostics } from '../../../packages/core/src/diagnostics';
import type { AssistantService } from '../../../packages/assistant/src/service';
export type AssistantPacket = ReturnType<AssistantService['events']>;
export type AssistantStatus = Pick<AssistantPacket['status'], 'available' | 'configured' | 'busy' | 'active'> & Partial<Pick<AssistantPacket['status'], 'epoch' | 'sourceChanges' | 'accountContext' | 'provider' | 'providerId' | 'connections' | 'connectionRevision' | 'rememberAvailable' | 'signIn' | 'model' | 'models' | 'limits' | 'source' | 'environmentAvailable'>>;
export type AssistantConversation = Awaited<ReturnType<AssistantService['conversation']>>;
export type AssistantConversationList = Awaited<ReturnType<AssistantService['conversations']>>;
export type StudioSession = Awaited<ReturnType<Engine['studio']['snapshot']>>;
export type StudioState = Awaited<ReturnType<Engine['inspect']>> & { diagnostics: ReturnType<Diagnostics['read']> };
export type { ProviderStatus, ProviderUpdate } from '../../../packages/core/src/provider-contracts';
export type MediaState = Awaited<ReturnType<Engine['assets']['list']>> & Awaited<ReturnType<Engine['mediaJobs']['list']>>;
import { createContext, useContext } from 'react';

const studioClientBrand = Symbol('StudioClient');
export const STUDIO_PROTOCOL_VERSION = 1;
export interface StudioCapabilities {
  managePlugins: boolean;
  localPaths: boolean;
  accountSettings: boolean;
  backendOAuth: boolean;
  privatePreview: boolean;
  connectionLabel: string;
  credentialLocation: 'computer' | 'workspace';
}
export const localCapabilities: Readonly<StudioCapabilities> = Object.freeze({
  managePlugins: true, localPaths: true, accountSettings: true, backendOAuth: true,
  privatePreview: false, connectionLabel: 'Local workspace', credentialLocation: 'computer',
});
export interface StudioClientOptions {
  origin?: string;
  auth: { kind: 'launch-ticket'; takeTicket?: () => string } | { kind: 'token'; token: string };
  capabilities?: Readonly<StudioCapabilities>;
  fetch?: typeof fetch;
  webSocket?: typeof WebSocket;
}

/** Credentials, protocol negotiation and cancellation belong to one mounted workspace. */
export function createStudioClient(options: StudioClientOptions) {
  const origin = new URL(options.origin ?? location.origin).origin;
  const transport = options.fetch ?? fetch;
  const Socket = options.webSocket ?? globalThis.WebSocket;
  const controller = new AbortController();
  const defaults: Readonly<StudioCapabilities> = options.auth.kind === 'launch-ticket' ? localCapabilities : { managePlugins: false, localPaths: false, accountSettings: false, backendOAuth: false, privatePreview: true, connectionLabel: 'Cloud workspace', credentialLocation: 'workspace' };
  const capabilities = Object.freeze({ ...defaults, ...options.capabilities });
  let token = options.auth.kind === 'token' ? options.auth.token : '';
  let compatible = false;
const sessionMessage = options.auth.kind === 'token' ? 'Your workspace session ended. Sign in again.' : 'Session unavailable. Relaunch mobile-builder --studio and open its fresh authorized launch window. Reloading or retrying this page cannot restore the lost session.';
async function request(input: string, init?: RequestInit) {
  if (!compatible && input !== '/api/bootstrap' && input !== '/api/protocol') throw new Error('Authenticate a compatible Studio session before using the runtime.');
  try { return await transport(new URL(input, origin).href, { cache: 'no-store', ...init, signal: init?.signal ? AbortSignal.any([controller.signal, init.signal]) : controller.signal }); }
  catch { throw new Error('Dunara is unreachable. Check that the local Dunara process is running, then retry this operation.'); }
}
async function result(response: Response) {
  let value;
  try { value = await response.json(); }
  catch { throw new Error(`Dunara returned an unreadable response (${response.status}). Check the local process and retry this operation.`); }
  if (!response.ok) {
    if ((response.status === 401 || response.status === 403) && !value.error?.code) throw new Error(sessionMessage);
    const applied = value.error?.details?.applied;
    const partial = Array.isArray(applied) ? ` Applied files: ${applied.map((file: { path: string }) => file.path).join(', ') || 'none'}. Review a fresh proposal before retrying.` : '';
    throw new Error((value.error?.message ?? 'Request failed. Check the local Dunara process.') + partial);
  }
  return value;
}
let authentication: Promise<void> | undefined;
function authenticate(): Promise<void> {
  return authentication ??= (async () => {
    if (options.auth.kind === 'token') {
      if (!token) throw new Error(sessionMessage);
    } else {
      const ticket = options.auth.takeTicket ? options.auth.takeTicket() : location.hash.slice(1);
      if (!options.auth.takeTicket) history.replaceState(null, '', location.pathname);
      if (!ticket) throw new Error('Open the studio using the browser window launched by mobile-builder --studio. Restart it if the launch link expired.');
      token = (await result(await request('/api/bootstrap', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket }) }))).token;
    }
    const protocol = await result(await request('/api/protocol', { headers: { Authorization: `Bearer ${token}` } }));
    if (protocol.version !== STUDIO_PROTOCOL_VERSION) throw new Error('This Studio and runtime version are incompatible. Update them together before continuing.');
    compatible = true;
  })();
}
async function api<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  if (!compatible) throw new Error('Authenticate a compatible Studio session before using the runtime.');
  return result(await request(`/api${path}`, { signal, method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
}
async function boardImage(projectId: string, id: string) {
  const response = await request(`/api/projects/${projectId}/board-captures/${id}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) { await result(response); throw new Error('Screen image unavailable'); }
  return URL.createObjectURL(await response.blob());
}
async function streamAssistant(after: number, epoch: string | null, onPacket: (packet: AssistantPacket) => void, signal: AbortSignal) {
  const response = await request('/api/assistant/events', { method: 'POST', signal, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ after, epoch, stream: true }) });
  if (!response.ok) { await result(response); return; }
  if (!response.body || response.headers.get('content-type') !== 'application/x-ndjson') throw new Error('Assistant stream unavailable. Reconnecting with polling.');
  const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '';
  try {
    while (!signal.aborted) {
      const chunk = await reader.read(); if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      if (buffer.length > 3 * 1024 * 1024) throw new Error('Assistant event buffer limit reached. Reopen the conversation to resynchronize.');
      let end: number;
      while ((end = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (line && !signal.aborted) onPacket(JSON.parse(line));
      }
    }
    if (buffer.trim() && !signal.aborted) throw new Error('Assistant stream interrupted. Reconnecting from the last event.');
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
async function image(projectId: string, id: string) {
  const response = await request(`/api/projects/${projectId}/artifacts/${id}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) {
    const result = await response.json().catch(() => undefined);
    throw new Error(response.status === 404 || result?.error?.message === 'Capture not found or expired' ? 'Screenshot expired' : 'Screenshot unavailable');
  }
  return URL.createObjectURL(await response.blob());
}
async function kitDownload(projectId: string, bundleId: string, fileId: string) {
  const response = await request(`/api/projects/${projectId}/launch-kits/${bundleId}/files/${fileId}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) { await result(response); throw new Error('Kit download failed'); }
  return URL.createObjectURL(await response.blob());
}
async function projectDownload(projectId: string, signal?: AbortSignal) {
  const response = await request(`/api/projects/${projectId}/download`, { signal, headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) { await result(response); throw new Error('Project download failed'); }
  if (response.headers.get('Content-Type') !== 'application/zip') throw new Error('Dunara returned an invalid project archive. Try again.');
  const filename = /filename="([a-z0-9-]+\.zip)"/.exec(response.headers.get('Content-Disposition') ?? '')?.[1];
  if (!filename) throw new Error('Project download filename is unavailable. Try again.');
  return { filename, blob: await response.blob() };
}
async function mediaImage(projectId: string, id: string) {
  const response = await request(`/api/projects/${projectId}/media/images/${id}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error('Asset image unavailable. Refresh the library or repair the local file.');
  return URL.createObjectURL(await response.blob());
}
async function uploadMedia(projectId: string, metadata: import('../../../packages/core/src/media-contracts').ImportInput, file: File): Promise<import('../../../packages/core/src/media-contracts').MediaLibrary> {
  return result(await request(`/api/projects/${projectId}/media/import`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': metadata.mediaType, 'X-Builder-Media': encodeURIComponent(JSON.stringify(metadata)) }, body: file }));
}
function subscribe(onChange: () => void, onStatus: (connected: boolean) => void) {
  if (!compatible) throw new Error('Authenticate before subscribing to Studio events.');
  let stopped = false, socket: WebSocket | undefined, timer: ReturnType<typeof setTimeout>;
  function connect() {
    socket = new Socket(`${origin.replace(/^http/, 'ws')}/events`, ['builder', token]);
    socket.onopen = () => { onStatus(true); onChange(); }; socket.onmessage = onChange;
    socket.onclose = () => { onStatus(false); if (!stopped) timer = setTimeout(connect, 2000); };
  }
  const stop = () => { stopped = true; clearTimeout(timer); socket?.close(); controller.signal.removeEventListener('abort', stop); };
  controller.signal.addEventListener('abort', stop, { once: true });
  if (!controller.signal.aborted) connect(); return stop;
}

  return { [studioClientBrand]: true as const, capabilities, origin, authenticate, api, boardImage, streamAssistant, image, kitDownload, projectDownload, mediaImage, uploadMedia, subscribe,
    dispose() { compatible = false; token = ''; controller.abort(); },
  };
}
export type StudioClient = ReturnType<typeof createStudioClient>;
export const StudioClientContext = createContext<StudioClient | null>(null);
export function useStudioClient(): StudioClient {
  const client = useContext(StudioClientContext);
  if (!client) throw new Error('Studio must be mounted with a Studio client.');
  return client;
}
