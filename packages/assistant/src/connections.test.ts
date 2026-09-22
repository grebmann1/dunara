import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { OAuthAuth, ProviderAuthInteraction } from '@earendil-works/pi-ai';
import { AssistantConnections } from './connections.js';
const roots: string[] = [], connections: AssistantConnections[] = [];
const protection = { kind: 'configured' as const, key: 'a'.repeat(64) }, legacy = { key: 'legacy-openai-sentinel', source: 'environment' };
const access = 'fake-oauth-access-sentinel', refresh = 'fake-oauth-refresh-sentinel';
async function setup(auth?: OAuthAuth, protectedStorage = true) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'ai-connections-')); roots.push(home);
  const changed = vi.fn(), idle = vi.fn();
  const manager = new AssistantConnections(home, protectedStorage ? protection : undefined, changed, idle, auth ? () => auth : undefined); connections.push(manager);
  const status = () => manager.status(legacy);
  const update = (value: Record<string, unknown>) => manager.update({ expectedRevision: status().connectionRevision, ...value });
  return { manager, home, changed, idle, status, update };
}
afterEach(async () => { connections.splice(0).forEach(value => value.close()); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
it('advertises reasoning from installed model capabilities, including managed and ChatGPT models', async () => {
  const { manager, home } = await setup(); await manager.initialize();
  expect(manager.models('openai').find(model => model.id === 'gpt-6-astra')?.reasoningLevels).toContain('high');
  expect(manager.models('chatgpt').find(model => model.id === 'gpt-6-astra')?.reasoningLevels).not.toContain('off');
  expect(manager.models('openai').find(model => model.id === 'gpt-4.1')?.reasoningLevels).toEqual([]);
  const managed = new AssistantConnections(home, undefined, () => {}, () => {}, undefined, { managed: { label: 'Included', apiKey: 'fixture-token', baseUrl: 'http://127.0.0.1:9999/v1', models: [{ id: 'gpt-6-astra', label: 'Included Astra' }] } });
  connections.push(managed); await managed.initialize();
  expect(managed.models('managed')).toEqual([{ id: 'gpt-6-astra', label: 'Included Astra', reasoningLevels: manager.models('openai').find(model => model.id === 'gpt-6-astra')?.reasoningLevels }]);
});
it('retains several isolated connections, encrypts remembered keys, and falls back to the legacy OpenAI key', async () => {
  const { manager, update, status, home } = await setup();
  const anthropic = 'fake-anthropic-key-sentinel', xai = 'fake-xai-key-sentinel';
  update({ action: 'connect', provider: 'anthropic', key: anthropic, remember: true });
  update({ action: 'connect', provider: 'xai', key: xai, remember: false });
  expect(manager.credential('anthropic', legacy).key).toBe(anthropic); expect(manager.credential('xai', legacy).key).toBe(xai);
  expect(manager.credential('openai', legacy).key).toBe(legacy.key);
  expect(JSON.stringify(status())).not.toMatch(/key-sentinel|legacy-openai-sentinel/);
  const contents = await Promise.all((await readdir(path.join(home, 'credentials'))).map(file => readFile(path.join(home, 'credentials', file), 'utf8')));
  expect(contents.join('')).not.toContain(anthropic); expect(contents.join('')).not.toContain(xai);
  const restored = new AssistantConnections(home, protection, () => {}, () => {}); connections.push(restored);
  expect(restored.credential('anthropic', legacy).key).toBe(anthropic); expect(restored.credential('xai', legacy).key).toBe('');
  update({ action: 'disconnect', provider: 'anthropic' }); expect(manager.credential('xai', legacy).key).toBe(xai);
});
it('rejects stale writes, unprotected remembering, unsafe endpoints and key entry for subscription providers', async () => {
  const { update, status, manager } = await setup(undefined, false);
  const revision = status().connectionRevision;
  expect(() => update({ action: 'connect', provider: 'xai', key: access, remember: true })).toThrow('Protected storage');
  for (const baseUrl of ['http://host.test', 'https://key:secret@host.test', 'https://host.test?key=secret', 'file:///tmp/key']) expect(() => update({ action: 'connect', provider: 'xai', key: access, remember: false, baseUrl })).toThrow();
  expect(() => update({ action: 'connect', provider: 'chatgpt', key: access, remember: false })).toThrow('subscription');
  update({ action: 'connect', provider: 'xai', key: access, remember: false, baseUrl: 'https://gateway.example/v1' });
  expect(() => manager.update({ action: 'disconnect', provider: 'xai', expectedRevision: revision })).toThrow('changed');
});
it('uses provider sign-in, keeps tokens off the wire, refreshes saved subscriptions and restores them', async () => {
  let interaction: ProviderAuthInteraction | undefined;
  const auth: OAuthAuth = { name: 'Fixture', login: async value => {
    interaction = value; value.notify({ type: 'auth_url', url: 'https://auth.openai.com/oauth/authorize?state=fixture' });
    const answer = await value.prompt({ type: 'manual_code', message: 'Enter code' }); expect(answer).toBe('fixture-code');
    return { type: 'oauth', access, refresh, expires: 0 };
  }, refresh: vi.fn(async () => ({ type: 'oauth' as const, access: access + '-rotated', refresh: refresh + '-rotated', expires: Date.now() + 3600000 })), async toAuth(value) { return { apiKey: value.access }; } };
  const { manager, status, home } = await setup(auth);
  await manager.begin({ provider: 'chatgpt', remember: true, expectedRevision: status().connectionRevision });
  const flow = status().signIn!; expect(flow.url).toContain('https://auth.openai.com');
  manager.answer({ id: flow.id, promptId: flow.prompt!.id, value: 'fixture-code' });
  await vi.waitFor(() => expect(status().signIn?.state).toBe('connected'));
  expect(interaction).toBeDefined(); expect(JSON.stringify(status())).not.toContain(access);
  await manager.prepare('chatgpt'); expect(auth.refresh).toHaveBeenCalledTimes(1);
  expect(manager.credential('chatgpt', legacy).key).toBe(access + '-rotated');
  const restored = new AssistantConnections(home, protection, () => {}, () => {}); connections.push(restored);
  expect(restored.credential('chatgpt', legacy).key).toBe(access + '-rotated');
  expect(() => manager.answer({ id: flow.id, promptId: flow.prompt!.id, value: 'replay' })).toThrow();
});
it('cancellation rejects late login results and untrusted sign-in URLs without replacing existing keys', async () => {
  let finish!: (value: { type: 'oauth'; access: string; refresh: string; expires: number }) => void;
  const auth: OAuthAuth = { name: 'Fixture', login: async value => { value.notify({ type: 'device_code', userCode: 'SAFE-CODE', verificationUri: 'https://auth.x.ai/activate' }); return new Promise(resolve => { finish = resolve; }); }, async refresh(value) { return value; }, async toAuth(value) { return { apiKey: value.access }; } };
  const { manager, status, update } = await setup(auth);
  update({ action: 'connect', provider: 'xai', key: access, remember: false });
  await manager.begin({ provider: 'grok', remember: false, expectedRevision: status().connectionRevision });
  const flow = status().signIn!; expect(flow.code).toBe('SAFE-CODE'); manager.cancel(flow.id);
  finish({ type: 'oauth', access, refresh, expires: Date.now() + 3600000 }); await new Promise(resolve => setTimeout(resolve, 0));
  expect(status().signIn?.state).toBe('cancelled'); expect(manager.credential('grok', legacy).key).toBe(''); expect(manager.credential('xai', legacy).key).toBe(access);
  auth.login = async value => { value.notify({ type: 'auth_url', url: 'https://auth.x.ai.evil.example/steal' }); throw new Error(access); };
  await manager.begin({ provider: 'grok', remember: false, expectedRevision: status().connectionRevision });
  await new Promise(resolve => setTimeout(resolve, 0)); expect(status().signIn?.url).toBeUndefined(); expect(JSON.stringify(status())).not.toContain(access);
});
it('keeps locked ciphertext until explicit disconnect', async () => {
  const { update, home } = await setup(); update({ action: 'connect', provider: 'google', key: access, remember: true });
  const locked = new AssistantConnections(home, undefined, () => {}, () => {}); connections.push(locked);
  expect(locked.status(legacy).connections.find(item => item.id === 'google')).toMatchObject({ locked: true, configured: false });
  expect(() => locked.update({ action: 'connect', provider: 'google', key: access, remember: false, expectedRevision: locked.status(legacy).connectionRevision })).toThrow('locked');
  locked.update({ action: 'disconnect', provider: 'google', expectedRevision: locked.status(legacy).connectionRevision });
  expect(locked.status(legacy).connections.find(item => item.id === 'google')?.locked).toBe(false);
});

it.each(['browser', 'device_code'] as const)('uses the host-selected ChatGPT %s flow', async method => {
  const { home } = await setup();
  const login = vi.fn(async (interaction: ProviderAuthInteraction) => {
    expect(await interaction.prompt({ type: 'select', message: 'Login', options: [{ id: 'browser', label: 'Browser' },{ id: 'device_code', label: 'Device' }] })).toBe(method);
    interaction.notify({ type: 'device_code', verificationUri: 'https://auth.openai.com/codex/device', userCode: 'FIXTURE' });
    return { type: 'oauth' as const, access, refresh, expires: Date.now()+3600000 };
  });
  const manager = new AssistantConnections(home, protection, () => {}, () => {}, () => ({ name: 'Fixture', login, async refresh(value) { return value; }, async toAuth(value) { return { apiKey: value.access }; } }), { chatgptLogin: method }); connections.push(manager);
  await manager.begin({ provider: 'chatgpt', remember: true, expectedRevision: manager.status(legacy).connectionRevision });
  await vi.waitFor(() => expect(manager.status(legacy).signIn?.state).toBe('connected'));
  expect(login).toHaveBeenCalledOnce(); expect(JSON.stringify(manager.status(legacy))).not.toContain(access);
});

it('keeps host credentials out of metadata and disallows client replacement of the managed connection', async () => {
  const { home } = await setup();
  const manager = new AssistantConnections(home, protection, () => {}, () => {}, undefined, { managed: { label: 'Included credits', apiKey: 'managed-secret-sentinel', baseUrl: 'http://127.0.0.1:54321/v1', models: [{ id: 'gpt-6-astra', label: 'Astra' }] } }); connections.push(manager);
  const status = manager.status(legacy);
  expect(status.connections.find(item => item.id === 'managed')).toMatchObject({ configured: true, kind: 'managed', baseUrl: '' });
  expect(JSON.stringify(status)).not.toMatch(/managed-secret|54321/);
  expect(() => manager.update({ action: 'disconnect', provider: 'managed', expectedRevision: status.connectionRevision })).toThrow('managed by this host');
});
