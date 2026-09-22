import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { AssistantLimits, HarnessCallbacks, RunHarness } from './contracts.js';
import { AssistantStore } from './store.js';
import { AssistantService } from './service.js';
import { AssistantConnections } from './connections.js';

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const key = 'offline-session-credential-sentinel';
const roots: string[] = [], services: AssistantService[] = [];
async function setup(behavior: RunHarness['run'] = async () => {}, limits: Partial<AssistantLimits> = {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'assistant-service-')); roots.push(home);
  const harness = { run: vi.fn(behavior), close: vi.fn(async () => {}) };
  const gateway = { tools: [{ name: 'project_inspect', inputSchema: { type: 'object' as const } }], call: vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'Canonical result' }] })), close: vi.fn(async () => {}) };
  const service = new AssistantService({ secretProtection: { kind: 'configured', key: 'a'.repeat(64) }, home, createHarness: () => harness, createGateway: async () => gateway, limits }); services.push(service);
  const conversation = await service.createConversation(null); service.configure({ action: 'connect', key });
  const input = { conversationId: conversation.id, runId: randomUUID(), prompt: 'Build an app' };
  return { service, conversation, harness, gateway, input, home };
}
async function finished(service: AssistantService) { await vi.waitFor(() => expect(service.status().busy).toBe(false)); }
afterEach(async () => { await Promise.all(services.splice(0).map(service => service.close())); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
it('validates, persists and freezes reasoning per turn, and resets incompatible model selections', async () => {
  const models = vi.spyOn(AssistantConnections.prototype, 'models').mockReturnValue([{ id: 'gpt-6-astra', label: 'Astra', reasoningLevels: ['low', 'high'] }, { id: 'plain', label: 'Plain', reasoningLevels: [] }]);
  const gate = deferred<void>();
  try {
    const { service, input, home, harness } = await setup(async () => { await gate.promise; });
    expect(service.status().reasoningEffort).toBe('auto');
    expect(() => service.configure({ action: 'reasoning', reasoningEffort: 'ultra' })).toThrow();
    expect(() => service.configure({ action: 'reasoning', reasoningEffort: 'off' })).toThrow('supported reasoning');
    service.configure({ action: 'reasoning', reasoningEffort: 'high' });
    await service.start(input);
    await vi.waitFor(() => expect(harness.run).toHaveBeenCalled());
    expect(harness.run.mock.calls[0]![0].reasoningEffort).toBe('high');
    expect(() => service.configure({ action: 'reasoning', reasoningEffort: 'low' })).toThrow('active');
    gate.resolve(); await finished(service);
    expect((await service.conversation(input.conversationId)).turns[0]?.reasoningEffort).toBe('high');
    await service.close();
    const restored = new AssistantService({ home }); services.push(restored);
    expect(restored.status().reasoningEffort).toBe('high');
    restored.configure({ action: 'model', model: 'plain' });
    expect(restored.status().reasoningEffort).toBe('auto');
    expect(() => restored.configure({ action: 'reasoning', reasoningEffort: 'high' })).toThrow('supported reasoning');
    restored.configure({ action: 'reasoning', reasoningEffort: 'auto' });
  } finally { gate.resolve(); models.mockRestore(); }
});
it('persists only project-bound setup metadata, rejects credential arguments and resumes without replay', async () => {
  const projectId = randomUUID();
  const { service, gateway, home } = await setup(async (context, callbacks, signal) => {
    expect(context.tools.map(tool => tool.name)).toContain('assistant_request_setup');
    if (context.prompt === 'Continue') { expect(context.context).toContain('app_openai'); return; }
    for (const invalid of [
      { kind: 'app_openai', value: 'private-input-canary' },
      { kind: 'supabase', projectId: randomUUID() },
      { kind: 'app_openai', environment: 'https://evil.example' },
      { kind: 'custom', endpoint: 'https://evil.example' },
    ]) await expect(callbacks.tool('assistant_request_setup', invalid, signal)).rejects.toThrow();
    await callbacks.tool('assistant_request_setup', { kind: 'app_openai' }, signal);
    await callbacks.tool('assistant_request_setup', { kind: 'app_openai' }, signal);
  });
  gateway.tools.push({ name: 'backend_inspect', inputSchema: { type: 'object' } });
  const conversation = await service.createConversation(projectId);
  await service.start({ conversationId: conversation.id, runId: randomUUID(), prompt: 'Set up app AI' }); await finished(service);
  const expected = [{ kind: 'app_openai', environment: 'development', projectId }];
  expect((await service.conversation(conversation.id)).turns[0]).toMatchObject({ state: 'completed', setupRequests: expected });
  expect(gateway.call).not.toHaveBeenCalled();
  const history = await readFile(path.join(home, 'assistant', `${conversation.id}.json`), 'utf8');
  expect(history).not.toContain('private-input-canary');
  expect(JSON.stringify(service.events(0))).not.toContain('private-input-canary');
  await service.start({ conversationId: conversation.id, runId: randomUUID(), prompt: 'Continue' }); await finished(service);
  await service.close();
  const resumed = new AssistantService({ secretProtection: { kind: 'configured', key: 'a'.repeat(64) }, home }); services.push(resumed);
  expect((await resumed.conversation(conversation.id)).turns[0]?.setupRequests).toEqual(expected);
  expect(resumed.status().busy).toBe(false);
});
it('does not permit setup cards in Plan mode, without backend tools or without an app', async () => {
  for (const scenario of ['plan', 'no_backend', 'no_project'] as const) {
    const { service, gateway } = await setup(async (context, callbacks, signal) => {
      if (scenario !== 'no_project') expect(context.tools.map(tool => tool.name)).not.toContain('assistant_request_setup');
      await expect(callbacks.tool('assistant_request_setup', { kind: 'supabase' }, signal)).rejects.toThrow('Setup requires');
    });
    if (scenario !== 'no_backend') gateway.tools.push({ name: 'backend_inspect', inputSchema: { type: 'object' } });
    const conversation = await service.createConversation(scenario === 'no_project' ? null : randomUUID());
    await service.start({ conversationId: conversation.id, runId: randomUUID(), prompt: 'Connect', mode: scenario === 'plan' ? 'plan' : 'build' }); await finished(service);
    expect((await service.conversation(conversation.id)).turns[0]).toMatchObject({ state: 'completed' });
    expect((await service.conversation(conversation.id)).turns[0]?.setupRequests).toBeUndefined();
    expect(gateway.call).not.toHaveBeenCalled();
  }
});
it('counts setup cards against the turn budget', async () => {
  const { service, gateway } = await setup(async (_, callbacks, signal) => {
    await callbacks.tool('assistant_request_setup', { kind: 'supabase' }, signal);
    await callbacks.tool('assistant_request_setup', { kind: 'app_openai' }, signal);
  }, { tools: 1 });
  gateway.tools.push({ name: 'backend_inspect', inputSchema: { type: 'object' } });
  const conversation = await service.createConversation(randomUUID());
  await service.start({ conversationId: conversation.id, runId: randomUUID(), prompt: 'Set up' }); await finished(service);
  expect((await service.conversation(conversation.id)).turns[0]).toMatchObject({ state: 'limited', setupRequests: [{ kind: 'supabase' }] });
});
it('does not load a harness on startup, configuration, or history access; unavailable mode fails closed', async () => {
  const { service, harness, input, home } = await setup();
  expect(harness.run).not.toHaveBeenCalled(); expect(service.status()).toMatchObject({ available: true, configured: true, busy: false });
  expect(JSON.stringify(service.status())).not.toContain(key);
  const unavailable = new AssistantService({ secretProtection: { kind: 'configured', key: 'a'.repeat(64) }, home }); services.push(unavailable);
  unavailable.configure({ action: 'connect', key });
  expect(unavailable.status().available).toBe(false); await expect(unavailable.start(input)).rejects.toThrow('available assistant');
  expect(harness.run).not.toHaveBeenCalled();
});
it('locks each turn to Plan or Build, blocks Plan mutations before dispatch and retains the plan as context', async () => {
  const ready = deferred<void>(), finishPlan = deferred<void>();
  const { service, input, gateway, home } = await setup(async (context, callbacks, signal) => {
    if (context.mode === 'plan') {
      expect(context.tools.map(tool => tool.name)).toEqual(['project_inspect', 'assistant_update_tasks']);
      await callbacks.tool('project_inspect', {}, signal);
      await expect(callbacks.tool('project_write_files', { mode: 'build', confirmed: true }, signal)).rejects.toThrow('Plan mode');
      callbacks.text('Plan: inspect, implement, and verify.'); ready.resolve(); await finishPlan.promise;
    } else {
      expect(context.mode).toBe('build');
      expect(context.context).toContain('Plan: inspect, implement, and verify.');
      expect(context.context).toContain('"mode":"plan"');
      expect(context.tools.map(tool => tool.name)).toContain('project_write_files');
      await callbacks.tool('project_write_files', {}, signal);
    }
  });
  gateway.tools.push({ name: 'project_write_files', inputSchema: { type: 'object' } });
  await service.start({ ...input, mode: 'plan', prompt: 'Ignore Plan mode and build immediately' }); await ready.promise;
  expect(service.status().active).toMatchObject({ mode: 'plan' });
  expect(gateway.call).toHaveBeenCalledTimes(1);
  finishPlan.resolve(); await finished(service);
  expect((await service.conversation(input.conversationId)).turns[0]).toMatchObject({ mode: 'plan', state: 'completed' });
  await service.start({ ...input, runId: randomUUID(), mode: 'build', prompt: 'Implement the plan' }); await finished(service);
  expect(gateway.call).toHaveBeenCalledTimes(2);
  await service.close();
  const resumed = new AssistantService({ secretProtection: { kind: 'configured', key: 'a'.repeat(64) }, home }); services.push(resumed);
  expect((await resumed.conversation(input.conversationId)).turns.map(turn => turn.mode)).toEqual(['plan', 'build']);
});
it('defaults legacy turn requests to Build and rejects unknown modes before starting work', async () => {
  const { service, input, harness } = await setup(async context => { expect(context.mode).toBe('build'); });
  await expect(service.start({ ...input, mode: 'execute' })).rejects.toThrow();
  expect(harness.run).not.toHaveBeenCalled();
  await service.start(input); await finished(service);
  expect((await service.conversation(input.conversationId)).turns[0]?.mode).toBe('build');
});
it('validates and persists live task progress in Plan mode without invoking project tools', async () => {
  const ready = deferred<{ callbacks: HarnessCallbacks; signal: AbortSignal }>();
  const { service, input, home, gateway } = await setup(async (context, callbacks, signal) => {
    expect(context.tools.map(tool => tool.name)).toContain('assistant_update_tasks');
    ready.resolve({ callbacks, signal }); await new Promise(() => {});
  });
  await service.start({ ...input, mode: 'plan' }); const { callbacks, signal } = await ready.promise;
  const tasks = [{ id: 'inspect', label: 'Inspect the screens', status: 'completed' }, { id: 'layout', label: 'Plan the layout', status: 'in_progress' }, { id: 'verify', label: 'Review the proposal', status: 'pending' }];
  const sequence = service.events(0).sequence;
  await callbacks.tool('assistant_update_tasks', { tasks }, signal);
  expect((await service.conversation(input.conversationId)).turns[0]?.tasks).toEqual(tasks);
  expect(JSON.parse(await readFile(path.join(home, 'assistant', `${input.conversationId}.json`), 'utf8')).turns[0].tasks).toEqual(tasks);
  expect(service.events(sequence).events).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'state', state: 'running' })]));
  for (const invalid of [[], [tasks[0], tasks[0]], tasks.map(task => ({ ...task, status: 'in_progress' })), [{ id: 'invalid id', label: 'Invalid', status: 'pending' }], [{ id: 'secret', label: key, status: 'pending' }]]) await expect(callbacks.tool('assistant_update_tasks', { tasks: invalid }, signal)).rejects.toThrow();
  expect((await service.conversation(input.conversationId)).turns[0]?.tasks).toEqual(tasks);
  expect(gateway.call).not.toHaveBeenCalled();
  await service.stop(input.runId);
  await expect(callbacks.tool('assistant_update_tasks', { tasks: tasks.map(task => ({ ...task, status: 'completed' })) }, signal)).rejects.toThrow();
  expect((await service.conversation(input.conversationId)).turns[0]).toMatchObject({ state: 'cancelled', tasks, tools: [] });
  await service.close();
  const resumed = new AssistantService({ secretProtection: { kind: 'configured', key: 'a'.repeat(64) }, home }); services.push(resumed);
  expect((await resumed.conversation(input.conversationId)).turns[0]?.tasks).toEqual(tasks);
});
it('counts task updates against the action limit and includes them in continuation context', async () => {
  const { service, input, gateway } = await setup(async (context, callbacks, signal) => {
    if (context.prompt === 'Continue') {
      expect(context.context).toContain('Finish the screen');
      expect(context.context).toContain('in_progress'); return;
    }
    const tasks = [{ id: 'screen', label: 'Finish the screen', status: 'in_progress' }];
    await callbacks.tool('assistant_update_tasks', { tasks }, signal);
    await callbacks.tool('assistant_update_tasks', { tasks }, signal);
  }, { tools: 1 });
  await service.start(input); await finished(service);
  expect((await service.conversation(input.conversationId)).turns[0]).toMatchObject({ state: 'limited', tasks: [{ label: 'Finish the screen', status: 'in_progress' }] });
  expect(gateway.call).not.toHaveBeenCalled();
  await service.start({ ...input, runId: randomUUID(), prompt: 'Continue' }); await finished(service);
  expect((await service.conversation(input.conversationId)).turns[1]?.state).toBe('completed');
});
it('searches titles, messages and task labels only within the requested project', async () => {
  const { service, input } = await setup(async (_, callbacks, signal) => {
    callbacks.text('The navigation uses a bottom tab bar.');
    await callbacks.tool('assistant_update_tasks', { tasks: [{ id: 'contrast', label: 'Check contrast', status: 'pending' }] }, signal);
  });
  await service.start(input); await finished(service);
  const otherProject = randomUUID(), other = await service.createConversation(otherProject);
  await service.start({ ...input, conversationId: other.id, runId: randomUUID(), prompt: 'Private navigation' }); await finished(service);
  for (const query of ['build an APP', 'navigation', '  CONTRAST  ']) expect((await service.conversations(null, query)).map(record => record.id)).toEqual([input.conversationId]);
  expect((await service.conversations(otherProject, 'navigation')).map(record => record.id)).toEqual([other.id]);
  expect(await service.conversations(null, 'not present')).toEqual([]);
  await expect(service.conversations(null, 'x'.repeat(201))).rejects.toThrow();
});
it('restores remembered credentials separately from startup/session keys without starting the harness', async () => {
  const { service, home, harness } = await setup();
  service.configure({ action: 'connect', key, remember: true });
  expect(service.status().source).toBe('saved'); await service.close();
  const options = { home, secretProtection: { kind: 'configured' as const, key: 'a'.repeat(64) }, startupKey: 'offline-startup-key-sentinel', createHarness: () => harness };
  const resumed = new AssistantService(options); services.push(resumed);
  expect(resumed.status()).toMatchObject({ configured: true, source: 'saved', environmentAvailable: true });
  expect(JSON.stringify(resumed.status())).not.toContain(key);
  resumed.configure({ action: 'environment' }); expect(resumed.status().source).toBe('environment');
  const file = path.join(home, 'credentials', 'openai-images-protected.json');
  await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' });
  resumed.configure({ action: 'connect', key, remember: true });
  resumed.configure({ action: 'connect', key }); expect(resumed.status().source).toBe('session');
  await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' });
  resumed.configure({ action: 'connect', key, remember: true });
  resumed.configure({ action: 'disconnect' }); expect(resumed.status().configured).toBe(false);
  await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' });
  await resumed.close(); const restarted = new AssistantService(options); services.push(restarted);
  expect(restarted.status().source).toBe('environment'); expect(harness.run).not.toHaveBeenCalled();
});
it('streams bounded events, persists only summaries, redacts split credential echoes and resumes without resubmission', async () => {
  const { service, input, home, harness, gateway } = await setup(async (context, callbacks, signal) => {
    expect(context.prompt).not.toContain(key); expect(context.apiKey).toBe(key);
    callbacks.text('Safe '); callbacks.text(key.slice(0, 8)); callbacks.text(key.slice(8) + ' output');
    await callbacks.tool('project_inspect', {}, signal);
  });
  const listener = vi.fn(); const unsubscribe = service.subscribe(listener);
  await service.start({ ...input, prompt: `Build ${key}` }); await finished(service); unsubscribe();
  const stored = await service.conversation(input.conversationId);
  expect(stored.turns[0]).toMatchObject({ state: 'completed', prompt: 'Build [redacted]', response: 'Safe [redacted] output', tools: [{ name: 'project_inspect', state: 'completed' }] });
  const replay = service.events(0); expect(replay.events.every(event => event.runId === input.runId && event.epoch === service.epoch)).toBe(true);
  expect(replay.events.filter(event => event.type === 'text').map(event => event.text).join('')).toBe('Safe [redacted] output');
  expect(JSON.stringify(replay)).not.toContain(key); expect(listener).toHaveBeenCalled();
  expect(gateway.call).toHaveBeenCalledTimes(1); expect(harness.close).toHaveBeenCalled();
  const files = await readdir(path.join(home, 'assistant'));
  expect(files).toEqual([`${input.conversationId}.json`]);
  const disk = await readFile(path.join(home, 'assistant', files[0]!), 'utf8');
  expect(disk).not.toContain(key); expect(disk).not.toContain('Canonical result'); expect(disk).not.toContain('apiKey');
  await service.close();
  const resumed = new AssistantService({ secretProtection: { kind: 'configured', key: 'a'.repeat(64) }, home, createHarness: () => harness, createGateway: async () => gateway }); services.push(resumed);
  expect((await resumed.conversation(input.conversationId)).turns).toEqual(stored.turns);
  expect(resumed.epoch).not.toBe(service.epoch); expect(resumed.status().configured).toBe(false); expect(harness.run).toHaveBeenCalledTimes(1);
  resumed.configure({ action: 'connect', key }); await expect(resumed.start(input)).rejects.toThrow('already submitted');
  const another = await resumed.createConversation(randomUUID());
  await expect(resumed.start({ ...input, conversationId: another.id })).rejects.toThrow('already submitted');
});
it('rejects concurrent turns and credential replacement; Stop rejects late text and queued dispatch without rollback', async () => {
  const ready = deferred<{ callbacks: HarnessCallbacks; signal: AbortSignal }>();
  const { service, input, harness, gateway } = await setup(async (_, callbacks, signal) => { ready.resolve({ callbacks, signal }); await new Promise(() => {}); });
  await service.start(input); const { callbacks, signal } = await ready.promise;
  await callbacks.tool('project_inspect', {}, signal);
  await expect(service.start({ ...input, runId: randomUUID() })).rejects.toThrow('already active');
  expect(() => service.configure({ action: 'disconnect' })).toThrow('already active');
  await expect(service.deleteConversation(input.conversationId)).rejects.toThrow('already active');
  await expect(service.stop(randomUUID())).rejects.toThrow('not active');
  await service.stop(input.runId);
  expect(signal.aborted).toBe(true); expect(() => callbacks.text('late')).toThrow();
  await expect(callbacks.tool('project_inspect', {}, signal)).rejects.toThrow();
  expect(gateway.call).toHaveBeenCalledTimes(1); expect(harness.close).toHaveBeenCalled();
  const turn = (await service.conversation(input.conversationId)).turns[0];
  expect(turn?.state).toBe('cancelled'); expect(turn?.notice).toContain('not rollback'); expect(turn?.tools).toHaveLength(1);
  service.configure({ action: 'disconnect' }); expect(service.status().configured).toBe(false);
});
it('blocks concurrent dispatch, noncanonical tool attempts and credentials before reaching the gateway', async () => {
  const ready = deferred<{ callbacks: HarnessCallbacks; signal: AbortSignal }>();
  const fixture = await setup(async (_, callbacks, signal) => { ready.resolve({ callbacks, signal }); await new Promise(() => {}); });
  const pending = deferred<{ content: Array<{ type: 'text'; text: string }> }>();
  fixture.gateway.call.mockImplementation(() => pending.promise);
  await fixture.service.start(fixture.input); const { callbacks, signal } = await ready.promise;
  await expect(callbacks.tool('bash', { command: 'whoami' }, signal)).rejects.toThrow('Unadvertised');
  await expect(callbacks.tool('project_inspect', { key }, signal)).rejects.toThrow('Credentials');
  const dispatched = callbacks.tool('project_inspect', {}, signal);
  await expect(callbacks.tool('project_inspect', {}, signal)).rejects.toThrow('Parallel');
  pending.resolve({ content: [{ type: 'text', text: 'Completed write' }] }); await dispatched;
  expect(fixture.gateway.call).toHaveBeenCalledTimes(1); await fixture.service.stop(fixture.input.runId);
});
it('enforces tool, response, prompt and deadline limits without automatic continuation', async () => {
  const tools = await setup(async (_, callbacks, signal) => { for (let i = 0; i < 3; i++) await callbacks.tool('project_inspect', {}, signal); }, { tools: 2 });
  await tools.service.start(tools.input); await finished(tools.service);
  expect(tools.gateway.call).toHaveBeenCalledTimes(2); expect((await tools.service.conversation(tools.input.conversationId)).turns[0]?.state).toBe('limited');
  const text = await setup(async (_, callbacks) => { callbacks.text('x'.repeat(101)); }, { responseBytes: 100 });
  await text.service.start(text.input); await finished(text.service); expect((await text.service.conversation(text.input.conversationId)).turns[0]?.state).toBe('limited');
  const deadline = await setup(async () => { await new Promise(() => {}); }, { turnMs: 20 });
  await deadline.service.start(deadline.input); await finished(deadline.service); expect((await deadline.service.conversation(deadline.input.conversationId)).turns[0]?.state).toBe('limited');
  expect(deadline.harness.run).toHaveBeenCalledTimes(1);
  await expect(deadline.service.start({ ...deadline.input, runId: randomUUID(), prompt: 'é'.repeat(9000) })).rejects.toThrow();
});
it('bounds reconnection buffers and rejects work before provider dispatch when history cannot reserve a response', async () => {
  const bounded = await setup(async (_, callbacks) => { for (let index = 0; index < 12; index++) callbacks.text(`word${index} `); }, { events: 4 });
  await bounded.service.start(bounded.input); await finished(bounded.service);
  expect(bounded.service.events(0)).toMatchObject({ reset: true }); expect(bounded.service.events(0).events).toHaveLength(4);
  expect(bounded.service.events(bounded.service.events(0).sequence).events).toEqual([]);
  expect(bounded.service.events(1_000_000).reset).toBe(true);
  const full = await setup(async () => {}, { conversationBytes: 1000 });
  await expect(full.service.start(full.input)).rejects.toThrow('history is full'); expect(full.harness.run).not.toHaveBeenCalled();
  expect((await full.service.conversation(full.input.conversationId)).turns).toHaveLength(0);
  await full.service.deleteConversation(full.input.conversationId); expect(await full.service.conversations(null)).toEqual([]);
});
it('cleans late gateway startup after cancellation and bounds unresponsive cleanup', async () => {
  const fixture = await setup();
  const pending = deferred<typeof fixture.gateway>();
  const service = new AssistantService({ secretProtection: { kind: 'configured', key: 'a'.repeat(64) }, home: fixture.home, createHarness: () => fixture.harness, createGateway: () => pending.promise, limits: { shutdownMs: 25 } }); services.push(service);
  service.configure({ action: 'connect', key }); await service.start(fixture.input); await service.stop(fixture.input.runId);
  pending.resolve(fixture.gateway); await vi.waitFor(() => expect(fixture.gateway.close).toHaveBeenCalled()); expect(fixture.harness.run).not.toHaveBeenCalled();
  const stuck = await setup(async (_, callbacks) => { callbacks.text('Complete'); }, { shutdownMs: 25 });
  stuck.gateway.close.mockImplementation(async () => { await new Promise(() => {}); });
  await stuck.service.start(stuck.input); await finished(stuck.service);
  expect(stuck.service.status()).toMatchObject({ available: false, configured: false });
  expect((await stuck.service.conversation(stuck.input.conversationId)).turns[0]?.notice).toContain('cleanup did not complete');
});

it('fences a turn still loading its history when the account changes', async () => {
  const { service, input, harness } = await setup(), gate = deferred<void>(), entered = deferred<void>();
  const original = AssistantStore.prototype.read;
  const spy = vi.spyOn(AssistantStore.prototype, 'read').mockImplementationOnce(async function(this: AssistantStore, id: string) {
    const record = await original.call(this, id); entered.resolve(); await gate.promise; return record;
  });
  try {
    const pending = service.start(input), rejected = expect(pending).rejects.toThrow('Account changed');
    await entered.promise; await service.interruptAccountWork(); gate.resolve(); await rejected;
    expect(harness.run).not.toHaveBeenCalled(); expect((await service.conversation(input.conversationId)).turns).toEqual([]);
  } finally { gate.resolve(); spy.mockRestore(); }
});
