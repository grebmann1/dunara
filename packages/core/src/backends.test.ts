import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { Projects } from './projects.js';
import { Files, validFile, revision } from './files.js';
import { Backends } from './backends.js';
import { Engine } from './engine.js';
import type { EnvironmentName } from '../../platform/src/contracts.js';
const roots: string[] = [], services: Backends[] = [];
afterEach(async () => { for (const service of services.splice(0)) await service.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const ref = 'abcdefghijklmnopqrst', org = 'my-organization';
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'builder-backend-')); roots.push(root);
  const projects = await Projects.open(path.join(root, 'apps'), path.join(root, 'home')), files = new Files(projects);
  const project = await projects.create({ name: 'Connected', slug: 'connected' });
  const requests: { url: string; method: string }[] = [];
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
    const url = String(input); requests.push({ url, method: init?.method ?? 'GET' });
    if (url.endsWith('/organizations')) return Response.json([{ slug: org, name: 'My organization' }]);
    if (url.endsWith('/projects')) return Response.json([{ id: ref, name: 'Backend', region: 'eu-central-1', status: 'ACTIVE_HEALTHY', organization_slug: org }]);
    if (url.endsWith(`/projects/${ref}`)) return Response.json({ id: ref, name: 'Backend', region: 'eu-central-1', status: 'ACTIVE_HEALTHY', organization_slug: org });
    if (url.includes('/health?')) return Response.json([{ name: 'db', status: 'ACTIVE_HEALTHY' }]);
    if (url.includes('/api-keys?')) return Response.json([{ type: 'publishable', api_key: 'sb_publishable_example' }, { type: 'secret', api_key: 'sb_secret_canary' }]);
    if (url.endsWith('/database/migrations')) return Response.json(init?.method === 'POST' ? {} : []);
    if (url.endsWith('/config/auth')) return Response.json({ site_url: 'https://app.example', uri_allow_list: '', external_email_enabled: true, mailer_autoconfirm: false, smtp_pass: 'smtp-private-canary' });
    throw new Error('Unexpected test provider route');
  });
  const backends = new Backends(projects, files, { fetch: fetcher, encryptionKey: 'ab'.repeat(32) }); services.push(backends);
  backends.configure({ token: 'canary-management-private' });
  return { projects, files, project, requests, fetcher, backends };
}
async function link(f: Awaited<ReturnType<typeof fixture>>, environment: EnvironmentName = 'development') {
  const plan = await f.backends.plan(f.project.id, { action: 'link', environment, projectRef: ref, organization: org });
  const operation = await f.backends.submit(f.project.id, { plan, requestId: randomUUID() });
  expect(operation.state).toBe('awaiting_approval');
  await f.backends.approve(f.project.id, { operationId: operation.id, planHash: operation.planHash });
  await vi.waitFor(async () => expect((await f.backends.operation(f.project.id, operation.id)).state).toBe('succeeded'));
  return operation;
}

it('links through explicit review and exposes only selected public app configuration', async () => {
  const f = await fixture(); await link(f);
  expect(f.requests.every(request => request.method === 'GET')).toBe(true);
  expect(await f.backends.appEnvironment(f.project.id)).toEqual({ EXPO_PUBLIC_SUPABASE_URL: `https://${ref}.supabase.co`, EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_example', EXPO_PUBLIC_BUILDER_ENVIRONMENT: 'development' });
  const state = JSON.stringify(await f.backends.inspect(f.project.id));
  expect(state).not.toContain('canary'); expect(state).not.toContain('sb_secret');
});
it('checks project, credential, source, and approval revisions before mutations', async () => {
  const f = await fixture(); await link(f);
  const migrationPath = 'supabase/migrations/20260917000100_habits.sql';
  await f.files.write(f.project.id, [{ path: migrationPath, content: 'create table habits(id uuid);', expectedRevision: null }]);
  const plan = await f.backends.plan(f.project.id, { action: 'migration', path: migrationPath });
  const op = await f.backends.submit(f.project.id, { plan, requestId: randomUUID() });
  const before = await f.files.read(f.project.id, migrationPath);
  await f.files.write(f.project.id, [{ path: migrationPath, content: before.content + '\n-- changed', expectedRevision: before.revision }]);
  await expect(f.backends.approve(f.project.id, { operationId: op.id, planHash: op.planHash })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  expect(f.requests.every(request => request.method === 'GET')).toBe(true);
  await expect(f.backends.operation(randomUUID(), op.id)).rejects.toThrow();
  f.backends.configure({ token: 'different-management-token' });
  await expect(f.backends.submit(f.project.id, { plan, requestId: randomUUID() })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
});
it('requires review before sending SQL and records the completed migration', async () => {
  const f = await fixture(); await link(f);
  const file = 'supabase/migrations/20260917000200_habits.sql';
  await f.files.write(f.project.id, [{ path: file, content: 'create table habits(id uuid);', expectedRevision: null }]);
  const plan = await f.backends.plan(f.project.id, { action: 'migration', path: file });
  const op = await f.backends.submit(f.project.id, { plan, requestId: randomUUID() });
  expect(f.requests.filter(request => request.method === 'POST')).toHaveLength(0);
  await f.backends.approve(f.project.id, { operationId: op.id, planHash: op.planHash });
  await vi.waitFor(async () => expect((await f.backends.operation(f.project.id, op.id)).state).toBe('succeeded'));
  expect(f.requests.filter(request => request.method === 'POST')).toHaveLength(1);
});
it('allows backend artifacts without opening arbitrary SQL or secret paths', () => {
  for (const file of ['supabase/migrations/20260917000100_habits.sql', 'supabase/tests/policies.sql', 'supabase/seed.sql', 'supabase/config.toml']) expect(validFile(file)).toBe(true);
  for (const file of ['other.sql', 'supabase/.env', 'supabase/secret.sql', 'supabase/../other.sql', 'supabase/functions/credentials.json']) expect(validFile(file)).toBe(false);
});

it.each([true, false])('recovers an uncertain migration only with exact provider SQL evidence (matches: %s)', async matches => {
  const f = await fixture(); await link(f);
  const file = 'supabase/migrations/20260917000300_recovery.sql', sql = 'create table recovery_test(id uuid);';
  await f.files.write(f.project.id, [{ path: file, content: sql, expectedRevision: null }]);
  const original = f.fetcher.getMockImplementation()!;
  let submitted = false, writes = 0;
  f.fetcher.mockImplementation(async (url, init) => {
    if (String(url).endsWith('/database/migrations') && init?.method === 'POST') {
      submitted = true; writes++; return new Response(null, { status: 503 });
    }
    if (submitted && String(url).endsWith('/database/migrations')) return Response.json([{ version: '20260917000300', name: '20260917000300_recovery' }]);
    if (String(url).endsWith('/database/migrations/20260917000300')) return Response.json({ version: '20260917000300', name: '20260917000300_recovery', statements: [matches ? sql : 'drop table another_app;'] });
    return original(url, init);
  });
  const plan = await f.backends.plan(f.project.id, { action: 'migration', path: file });
  const op = await f.backends.submit(f.project.id, { plan, requestId: randomUUID() });
  await f.backends.approve(f.project.id, { operationId: op.id, planHash: op.planHash });
  await vi.waitFor(async () => expect((await f.backends.operation(f.project.id, op.id)).state).toBe('reconciliation_required'));
  await f.backends.close();
  const restarted = new Backends(f.projects, f.files, { fetch: f.fetcher, encryptionKey: 'ab'.repeat(32) }); services.push(restarted);
  restarted.configure({ token: 'canary-management-private' });
  const saved = await restarted.operation(f.project.id, op.id);
  await restarted.reconcile(f.project.id, { operationId: op.id, planHash: saved.planHash, fence: saved.fence });
  await vi.waitFor(async () => expect((await restarted.operation(f.project.id, op.id)).state).toBe(matches ? 'succeeded' : 'reconciliation_required'));
  expect(writes).toBe(1);
});

it('pages an ambiguous catalog with snapshot revisions and rejects changed connections', async () => {
  const f = await fixture(), original = f.fetcher.getMockImplementation()!;
  f.fetcher.mockImplementation(async (url, init) => String(url).endsWith('/projects') ? Response.json([ref, 'zyxwvutsrqponmlkjihg'].map(id => ({ id, organization_slug: org, name: 'Same name', region: 'eu-central-1', status: 'ACTIVE_HEALTHY' }))) : original(url, init));
  const first = await f.backends.catalog(f.project.id, { limit: 1 });
  expect(first).toMatchObject({ selectionRequired: true, projects: [{ ref }], pagination: { nextOffset: 1, truncated: true, totalProjects: 2 } });
  const second = await f.backends.catalog(f.project.id, { offset: 1, limit: 1, expectedRevision: first.revision });
  expect(second.projects[0]?.name).toBe(first.projects[0]?.name); expect(second.projects[0]?.ref).not.toBe(ref); expect(second.pagination.truncated).toBe(false);
  await expect(f.backends.catalog(f.project.id, { offset: 1 })).rejects.toThrow();
  await expect(f.backends.catalog(randomUUID())).rejects.toThrow();
  f.backends.configure({ token: 'replaced-management-token' });
  await expect(f.backends.catalog(f.project.id, { offset: 1, expectedRevision: first.revision })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
});
it('reports read evidence, unknown write permission, and redacted prerequisites without mutating probes', async () => {
  const f = await fixture(); await link(f); f.requests.length = 0;
  const report = await f.backends.capabilities(f.project.id);
  expect(report.reads.every(item => item.permission === 'verified')).toBe(true);
  expect(report.actions.find(item => item.id === 'apply_migration')).toMatchObject({ implemented: true, permission: 'unknown', humanReview: true });
  expect(report.actions.find(item => item.id === 'configure_smtp')).toMatchObject({ implemented: true });
  expect(JSON.stringify(report)).not.toMatch(/canary|sb_secret|sb_publishable|app\.example/);
  expect(f.requests.every(item => item.method === 'GET' && !item.url.includes('api-keys'))).toBe(true);
  f.backends.disconnect(); f.requests.length = 0;
  const missing = await f.backends.capabilities(f.project.id, 'staging');
  expect(missing.actions.find(item => item.id === 'apply_migration')?.prerequisites).toEqual(['supabase_connection', 'environment_binding']);
  expect(f.requests).toHaveLength(0);
});
it('rejects discovery returned after the user replaces its connection', async () => {
  const f = await fixture(), original = f.fetcher.getMockImplementation()!;
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  f.fetcher.mockImplementation(async (url, init) => { await gate; return original(url, init); });
  const catalog = expect(f.backends.catalog(f.project.id)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledTimes(2));
  f.backends.configure({ token: 'replaced-management-token' }); release(); await catalog;
});
it.each([401, 403, 429, 200])('retains actionable capability failure metadata for provider HTTP %s', async status => {
  const f = await fixture();
  f.fetcher.mockImplementation(async () => new Response('private-canary-invalid-response', { status, headers: { 'Retry-After': '10' } }));
  const report = await f.backends.capabilities(f.project.id);
  const expected = status === 401 ? 'CONNECTION_REQUIRED' : status === 403 ? 'PROVIDER_PERMISSION_REQUIRED' : status === 429 ? 'PROVIDER_RATE_LIMITED' : 'PROVIDER_RESPONSE_INVALID';
  expect(report.reads.find(item => item.id === 'projects_read')).toMatchObject({ permission: status === 403 ? 'denied' : 'unknown', error: { code: expected } });
  expect(JSON.stringify(report)).not.toContain('private-canary');
});
it.each([undefined, 'cd'.repeat(32)])('retains all saved secrets when the encryption key is missing or wrong', async encryptionKey => {
  const f = await fixture(); f.backends.configure({ token: 'saved-management-canary', remember: true }); await f.backends.close();
  const wrong = new Backends(f.projects, f.files, { encryptionKey }); services.push(wrong);
  expect(wrong.status()).toMatchObject({ configured: false, rememberAvailable: false, encryption: { state: 'unavailable' } });
  for (const remember of [true, false]) expect(() => wrong.configure({ token: 'replacement-management-canary', remember })).toThrow();
  expect(() => wrong.disconnect()).toThrow(); await wrong.close();
  const restored = new Backends(f.projects, f.files, { encryptionKey: 'ab'.repeat(32) }); services.push(restored);
  expect(restored.status()).toMatchObject({ configured: true, source: 'saved', encryption: { state: 'ready' } });
});
it('fences concurrent environment switches, preview starts and stale capture identity through the shared Engine', async () => {
  const f = await fixture(); await link(f); await link(f, 'staging'); await f.backends.close();
  const engine = new Engine(f.projects, true, false, undefined, {}, {}, undefined, {});
  try {
    const id = f.project.id, state = await engine.backends.inspect(id), configuration = await engine.previews.configurationRevision(id), sourceRevision = await engine.boardCaptures.sourceRevision(id);
    const directory = path.join(f.projects.home, 'preview-board', id); await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, revision('/') + '.json'), JSON.stringify({ id: randomUUID(), projectId: id, route: '/', createdAt: new Date().toISOString(), sourceRevision, configurationRevision: configuration, environment: 'development', changedDuringCapture: false, png: 'fixture' }));
    expect((await engine.boardCaptures.list(id))[0]?.stale).toBe(false);
    let release!: () => void; const stopped = new Promise<void>(resolve => { release = resolve; }), stop = engine.previews.stop.bind(engine.previews);
    const spy = vi.spyOn(engine.previews, 'stop').mockImplementation(async projectId => { await stopped; return stop(projectId); });
    const first = engine.selectBackendEnvironment(id, { environment: 'staging', expectedRevision: state.environmentRevision });
    await vi.waitFor(() => expect(spy).toHaveBeenCalledOnce());
    await expect(engine.previews.start(id)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    const stale = expect(engine.selectBackendEnvironment(id, { environment: 'development', expectedRevision: state.environmentRevision })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    release(); const selected = await first; await stale;
    expect(selected.activeEnvironment).toBe('staging'); expect(spy).toHaveBeenCalledOnce(); expect(engine.previews.status(id).status).toBe('stopped');
    expect(await engine.previews.configurationRevision(id)).not.toBe(configuration); expect((await engine.boardCaptures.list(id))[0]?.stale).toBe(true);
    const other = await f.projects.create({ name: 'Other', slug: 'other' });
    await engine.studio.control({ expectedRevision: (await engine.studio.snapshot()).revision, action: { type: 'select-project', projectId: other.id } });
    await expect(engine.selectBackendEnvironment(id, { environment: 'development', expectedRevision: selected.environmentRevision })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    expect(spy).toHaveBeenCalledOnce();
  } finally { vi.restoreAllMocks(); await engine.close(); }
});
