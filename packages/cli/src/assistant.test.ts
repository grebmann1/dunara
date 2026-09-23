import { randomUUID } from 'node:crypto';
import { get, ServerResponse } from 'node:http';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AssistantService } from '../../assistant/src/service.js';
import { McpGateway } from '../../assistant/src/mcp-bridge.js';
import type { Conversation, RunHarness } from '../../assistant/src/contracts.js';
import { Engine } from '../../core/src/engine.js';
import { Projects } from '../../core/src/projects.js';
import { startDesktopMcp } from '../../mcp/src/socket.js';
import { startStudio } from './studio-server.js';

let root: string, engine: Engine, assistant: AssistantService, studio: Awaited<ReturnType<typeof startStudio>>, endpoint: Awaited<ReturnType<typeof startDesktopMcp>>, headers: Record<string, string>;
let behavior: RunHarness['run'];
const invoked = vi.fn(), secret = 'assistant-session-only-credential-sentinel';
const controllers: AbortController[] = [];
type Packet = ReturnType<AssistantService['events']>;
const post = (action: string, input: unknown, extra: Record<string, string> = {}) => fetch(`${studio.origin}/api/assistant/${action}`, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(input) });
const settings = (action: string, key?: string) => fetch(`${studio.origin}/api/settings`, { method: 'POST', headers, body: JSON.stringify({ action, expectedRevision: engine.mediaJobs.providerStatus().revision, ...(key ? { key } : {}) }) });
const poll = async (after = 0, epoch: string | null = assistant.epoch): Promise<Packet> => (await post('events', { after, epoch })).json();
async function create(): Promise<Conversation> { return (await post('conversations/create', { projectId: null })).json(); }
async function start(conversation: Conversation, prompt = 'Build an app') {
  const turn = { conversationId: conversation.id, runId: randomUUID(), prompt };
  expect((await post('turns/start', { epoch: assistant.epoch, turn })).status).toBe(200); return turn;
}
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'assistant-api-'));
  engine = new Engine(await Projects.open(path.join(root, 'apps'), path.join(root, 'home')), false);
  endpoint = await startDesktopMcp(engine);
  invoked.mockReset(); behavior = async (_, callbacks) => { callbacks.text('A streamed answer.'); };
  assistant = new AssistantService({ home: path.join(root, 'home'), createHarness: () => ({ async run(...args) { invoked(); await behavior(...args); }, async close() {} }), createGateway: (binding, signal, context) => McpGateway.open(endpoint.socketPath, binding, signal, context) });
  studio = await startStudio(engine, path.resolve('dist/studio'), assistant);
  const auth = await fetch(`${studio.origin}/api/bootstrap`, { method: 'POST', headers: { Origin: studio.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket: new URL(studio.launchUrl).hash.slice(1) }) });
  headers = { Origin: studio.origin, Authorization: `Bearer ${(await auth.json()).token}`, 'Content-Type': 'application/json' };
});
afterEach(async () => { for (const controller of controllers.splice(0)) controller.abort(); await assistant.close(); await endpoint.close(); await studio.close(); await engine.close(); await rm(root, { recursive: true, force: true }); });

it('exposes optional unavailable status without changing headless behavior', async () => {
  const headless = await startStudio(engine, path.resolve('dist/studio'));
  try {
    const auth = await fetch(`${headless.origin}/api/bootstrap`, { method: 'POST', headers: { Origin: headless.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket: new URL(headless.launchUrl).hash.slice(1) }) });
    const authHeaders = { ...headers, Origin: headless.origin, Authorization: `Bearer ${(await auth.json()).token}` };
    expect(await (await fetch(`${headless.origin}/api/assistant/status`, { headers: authHeaders })).json()).toMatchObject({ available: false, configured: false });
    expect((await fetch(`${headless.origin}/api/assistant/configure`, { method: 'POST', headers: authHeaders, body: JSON.stringify({ action: 'connect', key: secret }) })).status).toBe(503);
    expect(invoked).not.toHaveBeenCalled();
  } finally { await headless.close(); }
});
it('rejects missing authentication, forged Origin/Host, URL credentials, methods, oversized input and secret-bearing schema errors', async () => {
  const value = { action: 'connect', key: secret };
  for (const action of ['connections/update', 'connections/sign-in', 'connections/answer', 'connections/cancel', 'configure', 'events', 'conversations/read', 'approvals', 'turns/start', 'drafts/read', 'drafts/save', 'drafts/configure']) {
    expect((await post(action, value, { Authorization: '' })).status).toBe(401);
    expect((await post(action, value, { Origin: 'null' })).status).toBe(403);
    expect((await post(action, value, { Origin: '' })).status).toBe(403);
    expect((await fetch(`${studio.origin}/api/assistant/${action}`, { headers })).status).toBe(405);
  }
  const status = await new Promise<number | undefined>((resolve, reject) => { get(`${studio.origin}/api/assistant/status`, { headers: { ...headers, Host: 'hostile.example' } }, response => { response.resume(); resolve(response.statusCode); }).on('error', reject); });
  expect(status).toBe(403);
  expect((await fetch(`${studio.origin}/api/assistant/events?token=${secret}`, { headers })).status).toBe(400);
  for (const input of [{ ...value, [secret]: true }, { ...value, key: `bad ${secret}` }, { ...value, key: 'x'.repeat(9000) }]) {
    const response = await post('configure', input); expect(response.status).toBe(400); expect(await response.text()).not.toContain(secret);
  }
  const invalidHeaders: Record<string, string>[] = [{ 'Content-Type': 'text/plain' }, { 'Content-Encoding': 'gzip' }];
  for (const extra of invalidHeaders) expect((await post('configure', value, extra)).status).toBe(400);
  const malformed = await fetch(`${studio.origin}/api/assistant/configure`, { method: 'POST', headers, body: `{"key":"${secret}` });
  expect(malformed.status).toBe(400); expect(await malformed.text()).not.toContain(secret);
  expect((await post('conversations/read', { conversationId: '../escape' })).status).toBe(400);
  expect((await post('events', { after: -1, epoch: null })).status).toBe(400);
  expect((await post('conversations/create', { projectId: randomUUID() })).status).toBe(400);
  expect(assistant.status().configured).toBe(false); expect(invoked).not.toHaveBeenCalled();
});
it('shares OpenAI credentials, persists bounded history, rejects duplicate/old-epoch turns, and deletes only on confirmation', async () => {
  const configured = await settings('replace', secret); expect(configured.headers.get('cache-control')).toBe('no-store'); expect(await configured.text()).not.toContain(secret);
  expect(engine.mediaJobs.providerStatus().configured).toBe(true);
  const conversation = await create();
  expect((await post('turns/start', { epoch: randomUUID(), turn: { conversationId: conversation.id, runId: randomUUID(), prompt: 'stale' } })).status).toBe(400);
  expect((await post('turns/start', { epoch: assistant.epoch, turn: { conversationId: conversation.id, runId: randomUUID(), prompt: 'x'.repeat(16385) } })).status).toBe(400);
  const turn = await start(conversation, `Build ${secret}`); await vi.waitFor(() => expect(assistant.status().busy).toBe(false), { timeout: 10_000 });
  expect((await post('turns/start', { epoch: assistant.epoch, turn })).status).toBe(400);
  const read = await post('conversations/read', { conversationId: conversation.id }); const text = await read.text();
  expect(text).not.toContain(secret); expect(JSON.parse(text)).toMatchObject({ turns: [{ prompt: 'Build [redacted]', response: 'A streamed answer.', state: 'completed' }] });
  expect(await (await post('conversations/list', { projectId: null })).json()).toEqual([expect.objectContaining({ id: conversation.id, turns: 1, state: 'completed' })]);
  expect((await poll()).events.map(event => event.text).join('')).toContain('A streamed answer.');
  expect((await poll(0, randomUUID())).reset).toBe(true); expect((await poll(Number.MAX_SAFE_INTEGER)).reset).toBe(true);
  for (const name of await readdir(path.join(root, 'home', 'assistant'))) expect(await readFile(path.join(root, 'home', 'assistant', name), 'utf8')).not.toContain(secret);
  expect((await post('conversations/delete', { conversationId: conversation.id })).status).toBe(400);
  expect((await post('conversations/delete', { conversationId: conversation.id, confirmed: true })).status).toBe(200);
  expect((await poll()).events).toEqual([]);
  expect((await post('conversations/read', { conversationId: conversation.id })).status).toBe(400);
  expect((await settings('disconnect')).status).toBe(200); expect(assistant.status().configured).toBe(false); expect(invoked).toHaveBeenCalledTimes(1);
});
it('uses authenticated fetch streaming, bounded connection slots and cursor replay without resubmitting or cancelling on disconnect', async () => {
  await settings('replace', secret);
  const conversation = await create();
  behavior = async (_, callbacks, signal) => {
    callbacks.text('Streaming survives a disconnected panel.');
    await new Promise<void>(resolve => { signal.addEventListener('abort', () => resolve(), { once: true }); });
  };
  const turn = await start(conversation);
  // The turn is accepted before asynchronous MCP discovery starts its harness.
  await vi.waitFor(() => expect(invoked).toHaveBeenCalledTimes(1), { timeout: 10_000 });
  const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
  for (let i = 0; i < 4; i++) {
    const controller = new AbortController(); controllers.push(controller);
    const response = await fetch(`${studio.origin}/api/assistant/events`, { method: 'POST', headers, body: JSON.stringify({ after: 0, epoch: assistant.epoch, stream: true }), signal: controller.signal });
    expect(response.status).toBe(200); expect(response.headers.get('content-type')).toBe('application/x-ndjson'); expect(response.headers.get('cache-control')).toBe('no-store');
    const reader = response.body!.getReader(); readers.push(reader); const chunk = await reader.read(); expect(Buffer.from(chunk.value!).toString()).not.toContain(secret);
  }
  expect((await post('events', { after: 0, epoch: null, stream: true })).status).toBe(429);
  await readers[0]!.cancel(); await vi.waitFor(async () => expect(assistant.status().busy).toBe(true));
  const first = await poll(); expect((await poll(first.sequence)).events).toEqual([]); expect(invoked).toHaveBeenCalledTimes(1);
  expect((await settings('disconnect')).status).toBe(400);
  expect((await post('configure', { action: 'model', model: 'gpt-5.6-sol' })).status).toBe(400);
  expect(assistant.status().model).toBe('gpt-6-astra');
  expect((await post('turns/stop', { epoch: assistant.epoch, conversationId: randomUUID(), runId: turn.runId })).status).toBe(400);
  expect((await post('turns/stop', { epoch: assistant.epoch, conversationId: conversation.id, runId: turn.runId })).status).toBe(200);
  const terminal = await poll(first.sequence); expect(terminal.status.busy).toBe(false); expect(terminal.events.some(event => event.state === 'cancelled')).toBe(true);
  for (const reader of readers.slice(1)) await reader.cancel();
  const stored = await assistant.conversation(conversation.id); expect(stored.turns[0]?.notice).toContain('not rollback');
});
it('requires an exact active human approval and rejects forged, cross-project and replayed answers', async () => {
  await settings('replace', secret); const conversation = await create();
  behavior = async (_, callbacks, signal) => { await callbacks.tool('project_create', { name: 'API reviewed project', slug: 'api-reviewed' }, signal); };
  await start(conversation);
  await vi.waitFor(() => expect(assistant.pendingApprovals()).toHaveLength(1));
  const review = (await poll()).approvals[0]!;
  expect(review.args).toEqual({ name: 'API reviewed project', slug: 'api-reviewed' }); expect(await engine.projects.list()).toEqual([]);
  const answer = { id: review.id, epoch: review.epoch, conversationId: review.conversationId, runId: review.runId, projectId: review.projectId, approve: true };
  expect((await post('approvals', { ...answer, projectId: randomUUID() })).status).toBe(400);
  expect((await post('approvals', { ...answer, confirmed: true })).status).toBe(400);
  expect((await post('approvals', answer)).status).toBe(200);
  await vi.waitFor(() => expect(assistant.status().busy).toBe(false), { timeout: 10_000 });
  expect((await post('approvals', answer)).status).toBe(400);
  const projectId = z.object({ id: z.uuid() }).parse((await engine.projects.list())[0]).id;
  expect((await assistant.conversation(conversation.id)).projectId).toBe(projectId);
  expect((await poll()).approvals).toEqual([]); expect(JSON.stringify(await poll())).not.toContain(review.id);
});

it('closes a backpressured event stream before more tokens arrive without failing the build', async () => {
  await settings('replace', secret);
  let burst: (() => void) | undefined;
  behavior = async (_, callbacks) => new Promise<void>(resolve => {
    burst = () => { for (let index = 0; index < 8; index++) callbacks.text(`Word ${index}. `); resolve(); };
  });
  const conversation = await create(); await start(conversation);
  await vi.waitFor(() => expect(burst).toBeDefined());
  let backpressure = false;
  const errors: Error[] = [], observed = new Set<ServerResponse>();
  const write = ServerResponse.prototype.write;
  const spy = vi.spyOn(ServerResponse.prototype, 'write').mockImplementation(function (this: ServerResponse, ...args: Parameters<typeof write>) {
    const streaming = this.getHeader('Content-Type') === 'application/x-ndjson';
    if (streaming && !observed.has(this)) { observed.add(this); this.on('error', error => errors.push(error)); }
    const result = write.apply(this, args);
    return streaming && backpressure ? false : result;
  });
  try {
    const response = await post('events', { after: 0, epoch: assistant.epoch, stream: true });
    expect(response.status).toBe(200);
    backpressure = true; burst!();
    await response.text();
    await vi.waitFor(() => expect(assistant.status().busy).toBe(false));
    expect(errors).toEqual([]);
    expect((await assistant.conversation(conversation.id)).turns.at(-1)).toMatchObject({ state: 'completed', response: 'Word 0. Word 1. Word 2. Word 3. Word 4. Word 5. Word 6. Word 7. ' });
    expect((await poll()).events.filter(event => event.type === 'text')).toHaveLength(8);
    expect(invoked).toHaveBeenCalledTimes(1);
  } finally { spy.mockRestore(); }
});

it('validates and persists model selection without spending, then uses it for the next turn', async () => {
  const models = assistant.status().models;
  expect(models).toContainEqual(expect.objectContaining({ id: 'gpt-5.6-sol' }));
  const before = assistant.status().model;
  expect((await post('configure', { action: 'model', model: 'unsupported-model' })).status).toBe(400);
  expect(assistant.status().model).toBe(before);
  expect((await post('configure', { action: 'model', model: 'gpt-5.6-sol' })).status).toBe(200);
  expect(invoked).not.toHaveBeenCalled();
  await settings('replace', secret);
  const observed = vi.fn();
  behavior = async (input, callbacks) => { observed(input.model, input.apiKey); callbacks.text('Done'); };
  const conversation = await create(); await start(conversation);
  await vi.waitFor(() => expect(assistant.status().busy).toBe(false), { timeout: 10_000 });
  expect(observed).toHaveBeenCalledWith('gpt-5.6-sol', secret);
  expect((await assistant.conversation(conversation.id)).turns[0]?.model).toBe('gpt-5.6-sol');
  const resumed = new AssistantService({ home: path.join(root, 'home') });
  expect(resumed.status().model).toBe('gpt-5.6-sol'); await resumed.close();
});

it('keeps draft endpoints private, scopes conversations and fences writes and active turns on sign-out', async () => {
  const record = await create(), scope = { projectId: null, conversationId: record.id };
  const snapshot = await (await post('drafts/read', { scope })).json();
  const enabled = await (await post('drafts/configure', { scope, update: { context: snapshot.context, preferenceRevision: snapshot.preferenceRevision, enabled: true } })).json();
  const update = { context: enabled.context, preferenceRevision: enabled.preferenceRevision, expectedRevision: enabled.revision, value: { text: 'Unsent private fixture', mode: 'plan', attachments: {} } };
  expect((await post('drafts/save', { scope, update })).status).toBe(200);
  expect((await post('drafts/save', { scope, update })).status).toBe(400);
  expect(JSON.stringify(await poll())).not.toContain('Unsent private fixture');
  const other = await engine.projects.create({ name: 'Other fixture', slug: 'other-fixture' });
  expect((await post('drafts/read', { scope: { ...scope, projectId: other.id } })).status).toBe(400);
  await settings('replace', secret);
  behavior = async (_input, _callbacks, signal) => { await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true }); }); };
  await start(record); await vi.waitFor(() => expect(invoked).toHaveBeenCalledTimes(1));
  expect((await fetch(`${studio.origin}/api/account/sign-out`, { method: 'POST', headers, body: '{}' })).status).toBe(200);
  expect(assistant.status().active).toBeNull();
  const latest = await (await post('drafts/read', { scope })).json();
  expect((await post('drafts/save', { scope, update: { ...update, expectedRevision: latest.revision } })).status).toBe(400);
  expect((await post('turns/start', { epoch: assistant.epoch, accountContext: snapshot.context, turn: { conversationId: record.id, runId: randomUUID(), prompt: 'Stale account request' } })).status).toBe(400);
  expect(invoked).toHaveBeenCalledTimes(1);
  await post('conversations/delete', { conversationId: record.id, confirmed: true });
  expect(JSON.parse(await readFile(path.join(root, 'home/credentials/assistant-drafts.json'), 'utf8')).rows).toEqual([]);
});

it('snapshots provider selection per turn and preserves independent API connections', async () => {
  const xai = 'fixture-xai-secret-sentinel', anthropic = 'fixture-anthropic-secret-sentinel';
  for (const [provider, key] of [['xai', xai], ['anthropic', anthropic]]) {
    const response = await post('connections/update', { action: 'connect', provider, key, remember: false, expectedRevision: assistant.status().connectionRevision });
    expect(response.status).toBe(200); expect(await response.text()).not.toContain(key);
  }
  const model = assistant.status().connections.find(item => item.id === 'xai')!.models[0]!.id;
  expect((await post('configure', { action: 'model', provider: 'xai', model })).status).toBe(200);
  let release!: () => void;
  behavior = async (input, callbacks) => {
    expect(input).toMatchObject({ provider: 'xai', model, apiKey: xai });
    expect(input.prompt).not.toContain(anthropic);
    callbacks.text(anthropic.slice(0, 12)); callbacks.text(anthropic.slice(12));
    await new Promise<void>(resolve => { release = resolve; });
  };
  const conversation = await create(), turn = await start(conversation, `Explain ${anthropic}`);
  await vi.waitFor(() => expect(release).toBeDefined());
  expect((await post('configure', { action: 'model', provider: 'openai', model: 'gpt-6-astra' })).status).toBe(400);
  expect((await post('connections/update', { action: 'disconnect', provider: 'xai', expectedRevision: assistant.status().connectionRevision })).status).toBe(400);
  release(); await vi.waitFor(() => expect(assistant.status().busy).toBe(false));
  const record = await assistant.conversation(conversation.id);
  expect(record.turns[0]).toMatchObject({ id: turn.runId, provider: 'xai', model, prompt: 'Explain [redacted]', response: '[redacted]' });
  expect((await post('connections/update', { action: 'disconnect', provider: 'xai', expectedRevision: assistant.status().connectionRevision })).status).toBe(200);
  expect(assistant.status().connections.find(item => item.id === 'anthropic')?.configured).toBe(true);
  expect(engine.mediaJobs.providerStatus().configured).toBe(false);
});

it('isolates Assistant credentials and endpoints from changes to the OpenAI image fallback', async () => {
  const anthropic = 'fixture-anthropic-own-key', openai = 'fixture-openai-own-key', image = 'fixture-openai-image-key';
  const baseUrl = 'https://assistant-gateway.example/v1';
  const update = (input: Record<string, unknown>) => post('connections/update', { ...input, expectedRevision: assistant.status().connectionRevision });
  expect((await update({ action: 'connect', provider: 'anthropic', key: anthropic, remember: false, baseUrl })).status).toBe(200);
  const model = assistant.status().connections.find(item => item.id === 'anthropic')!.models[0]!.id;
  expect((await post('configure', { action: 'model', provider: 'anthropic', model })).status).toBe(200);
  const observed = vi.fn(); behavior = async input => { observed(input.provider, input.apiKey, input.baseUrl); };
  const conversation = await create();
  const send = async () => { await start(conversation); await vi.waitFor(() => expect(assistant.status().busy).toBe(false)); };
  await send(); expect(observed).toHaveBeenLastCalledWith('anthropic', anthropic, baseUrl);
  expect((await settings('replace', image)).status).toBe(200);
  await send(); expect(observed).toHaveBeenLastCalledWith('anthropic', anthropic, baseUrl);
  expect((await settings('disconnect')).status).toBe(200);
  await send(); expect(observed).toHaveBeenLastCalledWith('anthropic', anthropic, baseUrl);
  expect((await settings('replace', image)).status).toBe(200);
  for (const action of ['disconnect', 'environment', 'connect']) {
    expect((await post('configure', { action, ...(action === 'connect' ? { key: image } : {}) })).status).toBe(400);
  }
  expect((await update({ action: 'disconnect', provider: 'anthropic' })).status).toBe(200);
  expect(assistant.status()).toMatchObject({ providerId: 'anthropic', configured: false, source: 'none', environmentAvailable: false });
  expect((await post('turns/start', { epoch: assistant.epoch, turn: { conversationId: conversation.id, runId: randomUUID(), prompt: 'Do not fall back' } })).status).toBe(400);
  expect(observed).toHaveBeenCalledTimes(3);
  expect((await post('configure', { action: 'model', provider: 'openai', model: 'gpt-6-astra' })).status).toBe(200);
  await send(); expect(observed).toHaveBeenLastCalledWith('openai', image, undefined);
  expect((await update({ action: 'connect', provider: 'openai', key: openai, remember: false, baseUrl })).status).toBe(200);
  expect((await settings('disconnect')).status).toBe(200);
  await send(); expect(observed).toHaveBeenLastCalledWith('openai', openai, baseUrl);
  expect(engine.mediaJobs.providerStatus().configured).toBe(false);
  expect((await settings('replace', image)).status).toBe(200);
  expect((await update({ action: 'disconnect', provider: 'openai' })).status).toBe(200);
  await send(); expect(observed).toHaveBeenLastCalledWith('openai', image, undefined);
});

it('restores a saved non-OpenAI selection without advertising an unrelated startup key', async () => {
  const options = { home: path.join(root, 'separate-assistant'), secretProtection: { kind: 'configured' as const, key: 'a'.repeat(64) } };
  const initial = new AssistantService(options);
  try {
    await initial.useOpenAI(engine.mediaJobs);
    initial.connectionUpdate({ action: 'connect', provider: 'anthropic', key: 'fixture-remembered-anthropic', remember: true, expectedRevision: initial.status().connectionRevision });
    initial.configure({ action: 'model', provider: 'anthropic', model: initial.status().connections.find(item => item.id === 'anthropic')!.models[0]!.id });
  } finally { await initial.close(); }
  for (const startupKey of [undefined, 'fixture-unrelated-openai-startup']) {
    const restored = new AssistantService({ ...options, startupKey });
    try {
      expect(restored.status()).toMatchObject({ providerId: 'anthropic', configured: true, source: 'saved', environmentAvailable: false });
      expect(restored.status().connections.find(item => item.id === 'openai')).toMatchObject({ configured: !!startupKey, source: startupKey ? 'environment' : 'none' });
      for (const action of ['disconnect', 'environment', 'connect']) expect(() => restored.configure({ action, ...(action === 'connect' ? { key: secret } : {}) })).toThrow('AI connections');
      if (startupKey) {
        restored.configure({ action: 'model', provider: 'openai', model: 'gpt-6-astra' });
        expect(restored.status()).toMatchObject({ configured: true, environmentAvailable: true, source: 'environment' });
      }
    } finally { await restored.close(); }
  }
});
