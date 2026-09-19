import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { Projects } from './projects.js';
import { Files } from './files.js';
import { Backends } from './backends.js';
import { hash, SecretBox } from '../../platform/src/crypto.js';
import { PlatformStore } from '../../platform/src/store.js';
import { desiredConfiguration } from '../../platform/src/configuration.js';
import { prepareFunction } from './function-artifacts.js';
import { DatabaseSync } from 'node:sqlite';

const roots: string[] = [], services: Backends[] = [], ref = 'abcdefghijklmnopqrst', key = 'ab'.repeat(32);
afterEach(async () => { for (const service of services.splice(0)) await service.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'builder-config-')); roots.push(root);
  const projects = await Projects.open(path.join(root, 'apps'), path.join(root, 'home')), files = new Files(projects), project = await projects.create({ name: 'Config', slug: 'config' });
  const database = path.join(projects.home, 'platform'), store = new PlatformStore(database, new SecretBox(key));
  const actor = { id: 'local-owner', workspaceId: store.identity(), role: 'owner' as const, source: 'local-owner' as const };
  store.putRecord(actor, 'backend', `${project.id}:development`, { projectId: project.id, environment: 'development', provider: 'supabase', projectRef: ref, organization: 'org', url: `https://${ref}.supabase.co`, publishableKey: 'sb_publishable_example', connectedAt: new Date().toISOString(), ownershipMode: 'user' }); store.close();
  const auth: Record<string, unknown> = { site_url: 'https://old.example', external_email_enabled: false, unrelated: 'keep', smtp_pass: 'provider-private-canary' };
  const buckets = new Map<string, unknown>(), functions: Record<string, unknown>[] = [], requests: { url: string; method: string; body: unknown }[] = [];
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input), method = init?.method ?? 'GET', body = typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body;
    requests.push({ url, method, body });
    if (url.endsWith(`/projects/${ref}`)) return Response.json({ id: ref, name: 'Test', region: 'eu-central-1', status: 'ACTIVE_HEALTHY', organization_slug: 'org' });
    if (url.endsWith('/config/auth')) { if (method === 'PATCH') Object.assign(auth, body); return Response.json(auth); }
    if (url.endsWith('/functions')) return Response.json(functions);
    if (url.includes('/functions/deploy?')) { const metadata = JSON.parse((body as FormData).get('metadata') as string); const identity = { id: 'fn-id', slug: metadata.name, version: 1, status: 'ACTIVE', verify_jwt: metadata.verify_jwt, ezbr_sha256: 'remote-bundle' }; functions.push(identity); return Response.json(identity, { status: 201 }); }
    if (url.endsWith('/secrets')) return new Response(null, { status: 201 });
    if (url.includes('/storage/v1/bucket')) {
      const id = url.split('/').at(-1)!;
      if (method === 'GET') return buckets.has(id) ? Response.json(buckets.get(id)) : new Response(null, { status: 404 });
      const name = body.id ?? id; buckets.set(name, { ...body, id: name }); return Response.json({ name });
    }
    throw new Error('Unexpected fixture URL');
  });
  const backends = new Backends(projects, files, { fetch: fetcher, encryptionKey: key }); services.push(backends); backends.configure({ token: 'private-management-canary', remember: true });
  async function source(value: unknown) { const old = await files.read(project.id, 'backend/configuration.json').catch(() => null); await files.write(project.id, [{ path: 'backend/configuration.json', content: JSON.stringify(value), expectedRevision: old?.revision ?? null }]); }
  async function plan() { return backends.plan(project.id, { action: 'configure' }); }
  async function stage() { const prepared = await plan(); return backends.submit(project.id, { preparedPlanHash: hash(prepared), requestId: randomUUID() }); }
  async function approve(op: { id: string; planHash: string }) { await backends.approve(project.id, { operationId: op.id, planHash: op.planHash }); }
  async function state(id: string, expected: string) { await vi.waitFor(async () => expect((await backends.operation(project.id, id)).state).toBe(expected), { timeout: 10_000 }); return backends.operation(project.id, id); }
  return { root, database, projects, files, project, backends, requests, fetcher, auth, buckets, functions, source, plan, stage, approve, state };
}
const authConfig = { version: 1, auth: { settings: { site_url: 'https://new.example', external_email_enabled: true } } };
it('adds public variable declarations with source revisions, reserved-name protection and independent private environments', async () => {
  const f = await fixture(), service = f.backends.configuration, id = f.project.id;
  const empty = await service.functionEnvironment(id, 'development');
  const input = { environment: 'development', name: 'PAYMENTS_API_KEY', expectedSourceRevision: empty.sourceRevision };
  const declared = await service.declareFunctionEnvironment(id, input);
  expect(declared.variables).toHaveLength(1);
  expect(declared.variables[0]).toMatchObject({ name: 'PAYMENTS_API_KEY', input: { purpose: 'function', available: false } });
  await expect(service.declareFunctionEnvironment(id, input)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  for (const name of ['SUPABASE_URL', 'SB_REGION', 'DENO_DEPLOYMENT_ID', 'has spaces', 'lowercase']) await expect(service.declareFunctionEnvironment(id, { ...input, name, expectedSourceRevision: declared.sourceRevision })).rejects.toThrow();
  await expect(service.declareFunctionEnvironment(id, { ...input, expectedSourceRevision: declared.sourceRevision, value: 'must-not-be-accepted' })).rejects.toThrow();
  service.secrets.supply(id, { environment: 'development', name: declared.variables[0]!.secret, expectedRevision: null, value: 'private-env-canary' });
  expect((await service.functionEnvironment(id, 'development')).variables[0]!.input.available).toBe(true);
  expect((await service.functionEnvironment(id, 'staging')).variables[0]!.input.available).toBe(false);
  expect(JSON.stringify(await service.functionEnvironment(id, 'development'))).not.toContain('canary');
  expect((await f.files.read(id, 'backend/configuration.json')).content).not.toContain('canary');
});
it('publishes only reviewed project-wide environment variables without Auth reads, missing unrelated inputs or function deployment', async () => {
  const f = await fixture(), service = f.backends.configuration, id = f.project.id;
  await f.source({ ...authConfig, auth: { ...authConfig.auth, secrets: [{ field: 'smtp_pass', secret: 'smtp_password' }] }, requirements: [{ name: 'smtp_password', purpose: 'smtp', label: 'SMTP password' }], functions: [{ slug: 'unrelated', entrypoint: 'supabase/functions/unrelated/index.ts' }] });
  const inventory = await service.functionEnvironment(id, 'development');
  const added = await service.declareFunctionEnvironment(id, { environment: 'development', name: 'PAYMENTS_API_KEY', expectedSourceRevision: inventory.sourceRevision });
  const secret = added.variables[0]!.secret;
  const before = service.secrets.supply(id, { environment: 'development', name: secret, value: 'private-value-before-canary', expectedRevision: null });
  const plan = await f.backends.plan(id, { action: 'function_environment' });
  expect(plan.steps.map(s => s.kind)).toEqual(['function_secrets']); expect(plan.prerequisites).toEqual([]); expect(plan.sources).toHaveLength(1);
  const op = await f.backends.submit(id, { preparedPlanHash: hash(plan), requestId: randomUUID() });
  expect(f.requests.every(r => r.method === 'GET')).toBe(true);
  service.secrets.supply(id, { environment: 'development', name: secret, value: 'private-value-after-canary', expectedRevision: before.revision });
  await expect(f.approve(op)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  const replacement = await f.backends.plan(id, { action: 'function_environment' });
  const next = await f.backends.submit(id, { preparedPlanHash: hash(replacement), requestId: randomUUID() });
  await f.approve(next); await f.state(next.id, 'succeeded');
  expect(f.requests.filter(r => r.method !== 'GET')).toEqual([expect.objectContaining({ method: 'POST', url: `https://api.supabase.com/v1/projects/${ref}/secrets`, body: [{ name: 'PAYMENTS_API_KEY', value: 'private-value-after-canary' }] })]);
  expect(f.requests.some(r => r.url.endsWith('/config/auth') || r.url.includes('/functions'))).toBe(false);
  expect(JSON.stringify(await f.backends.inspect(id))).not.toContain('canary');
  expect((await f.files.read(id, 'backend/configuration.json')).content).not.toContain('canary');
});
it('stages exact v2 changes by opaque digest, preserves unrelated settings and deduplicates requests', async () => {
  const f = await fixture(); await f.source(authConfig);
  const plan = await f.plan(), requestId = randomUUID(), input = { preparedPlanHash: hash(plan), requestId };
  const op = await f.backends.submit(f.project.id, input);
  expect(await f.backends.submit(f.project.id, input)).toEqual(op); expect(f.requests.every(r => r.method === 'GET')).toBe(true);
  await expect(f.backends.submit(f.project.id, { plan: { ...plan, steps: [] }, requestId: randomUUID() })).rejects.toMatchObject({ code: 'INVALID_PLAN' });
  await f.approve(op); await f.state(op.id, 'succeeded');
  expect(f.auth).toMatchObject({ site_url: 'https://new.example', unrelated: 'keep', smtp_pass: 'provider-private-canary' });
  expect((await f.plan()).steps).toHaveLength(0);
  expect(JSON.stringify(await f.backends.inspect(f.project.id))).not.toContain('canary');
});
it.each(['source', 'remote', 'connection'])('blocks %s drift before any configuration write', async change => {
  const f = await fixture(); await f.source(authConfig); const op = await f.stage();
  if (change === 'source') await f.source({ version: 1, auth: { settings: { external_email_enabled: true } } });
  if (change === 'remote') f.auth.site_url = 'https://someone-else.example';
  if (change === 'connection') f.backends.configure({ token: 'different-management-token' });
  await expect(f.approve(op)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  expect(f.requests.every(r => r.method === 'GET')).toBe(true);
});
it('keeps credentials out of public state, rejects cross-environment use and invalidates replacement', async () => {
  const f = await fixture(); await f.source({ ...authConfig, auth: { ...authConfig.auth, secrets: [{ field: 'smtp_pass', secret: 'mail_password' }] }, requirements: [{ name: 'mail_password', purpose: 'smtp', label: 'SMTP password' }] });
  const missing = await f.plan(); expect(missing.prerequisites).toHaveLength(1);
  await expect(f.stage()).rejects.toMatchObject({ code: 'SECRET_REQUIRED' });
  const supplied = f.backends.configuration.secrets.supply(f.project.id, { environment: 'development', name: 'mail_password', value: 'smtp-canary-only-in-private-storage', expectedRevision: null, remember: true });
  expect(supplied).toMatchObject({ available: true, persistence: 'saved' });
  expect(JSON.stringify(supplied)).not.toContain('canary');
  expect(() => f.backends.configuration.secrets.supply(f.project.id, { environment: 'staging', name: 'mail_password', value: 'cross-environment-canary', expectedRevision: null })).toThrow();
  const op = await f.stage();
  f.backends.configuration.secrets.supply(f.project.id, { environment: 'development', name: 'mail_password', value: 'replacement-canary-private', expectedRevision: supplied.revision });
  await expect(f.approve(op)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  const next = await f.stage(); await f.approve(next); await f.state(next.id, 'succeeded');
  expect(f.auth.smtp_pass).toBe('replacement-canary-private');
  expect(JSON.stringify(await f.backends.inspect(f.project.id))).not.toContain('canary');
  expect((await readFile(path.join(f.database, 'platform.sqlite'))).toString()).not.toContain('smtp-canary');
});
it.each([false, true])('recovers lost Auth response without replay; secret write uncertainty=%s', async secret => {
  const f = await fixture(); await f.source(secret ? { ...authConfig, auth: { ...authConfig.auth, secrets: [{ field: 'smtp_pass', secret: 'mail_password' }] }, requirements: [{ name: 'mail_password', purpose: 'smtp', label: 'SMTP password' }] } : authConfig);
  if (secret) { await f.plan(); f.backends.configuration.secrets.supply(f.project.id, { environment: 'development', name: 'mail_password', value: 'private-smtp-canary', expectedRevision: null, remember: true }); }
  const original = f.fetcher.getMockImplementation()!;
  f.fetcher.mockImplementation(async (url, init) => { const response = await original(url, init); if (init?.method === 'PATCH') throw new Error('Lost response'); return response; });
  const op = await f.stage(); await f.approve(op); const unknown = await f.state(op.id, 'reconciliation_required');
  await f.backends.reconcile(f.project.id, { operationId: op.id, planHash: op.planHash, fence: unknown.fence });
  await f.state(op.id, secret ? 'reconciliation_required' : 'succeeded');
  expect(f.requests.filter(r => r.method === 'PATCH')).toHaveLength(1);
});
it('uses private Storage API buckets and immutable function sources, verifies deployment and avoids repeat changes', async () => {
  const f = await fixture(); await f.files.write(f.project.id, [{ path: 'supabase/functions/owner-check/index.ts', content: 'Deno.serve(() => new Response("example"));', expectedRevision: null }]);
  await f.source({ version: 1, storage: { serverCredential: 'storage_key', buckets: [{ id: 'private-uploads', public: false, file_size_limit: 1000000, allowed_mime_types: ['image/png'] }] }, functions: [{ slug: 'owner-check', entrypoint: 'supabase/functions/owner-check/index.ts' }], requirements: [{ name: 'storage_key', purpose: 'storage_server', label: 'Storage server key' }] });
  await f.plan(); f.backends.configuration.secrets.supply(f.project.id, { environment: 'development', name: 'storage_key', value: 'sb_secret_testserverkey12345678', expectedRevision: null });
  const op = await f.stage(); await f.approve(op); await f.state(op.id, 'succeeded');
  expect(f.buckets.get('private-uploads')).toMatchObject({ public: false }); expect(f.functions).toHaveLength(1);
  expect((await f.plan()).steps).toHaveLength(0);
  const posted = f.requests.find(r => r.url.includes('/functions/deploy'))!.body as FormData;
  expect((posted.getAll('file')[0] as File).name).toBe('index.ts');
  expect(JSON.stringify(await f.backends.inspect(f.project.id))).not.toContain('testserverkey');
});
it('reports read-only evidence without executing email, SQL, or app code', async () => {
  const f = await fixture(); await f.source(authConfig);
  const report = await f.backends.configuration.validate(f.project.id, {});
  expect(report.status).toBe('pass'); expect(report.checks.find(c => c.name === 'email_delivery')?.status).toBe('not_run');
  expect(f.requests.every(r => r.method === 'GET')).toBe(true);
  const journey = await f.backends.configuration.setup(f.project.id, { requestId: randomUUID(), scenario: 'complete' });
  expect(journey.phase).toBe('configure_or_verify');
});
it.each([false, true])('checks owner Storage operations and refuses outage-as-denial evidence: outage=%s', async outage => {
  const f = await fixture(), ownerId = randomUUID(), otherId = randomUUID(), objects = new Map<string, string>();
  const jwt = (id: string) => `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: id })).toString('base64url')}.fixture`;
  const owner = jwt(ownerId), other = jwt(otherId), original = f.fetcher.getMockImplementation()!;
  let signedAt = 0;
  f.fetcher.mockImplementation(async (input, init) => {
    const url = new URL(String(input)), method = init?.method ?? 'GET', token = new Headers(init?.headers).get('Authorization'), own = token === `Bearer ${owner}`;
    if (url.pathname === '/auth/v1/user') return Response.json({ id: own ? ownerId : otherId });
    if (url.pathname.startsWith('/storage/v1/object/sign/private-uploads/')) {
      if (method === 'POST') { signedAt = Date.now(); return Response.json({ signedURL: url.pathname.replace('/storage/v1', '') + '?token=private-signed-canary' }); }
      return new Response(null, { status: Date.now() - signedAt > 1000 ? 403 : 200 });
    }
    if (url.pathname === '/storage/v1/object/private-uploads' && method === 'DELETE') {
      if (!own) return new Response(null, { status: outage ? 503 : 403 });
      for (const object of JSON.parse(init?.body as string).prefixes) objects.delete(object); return Response.json([]);
    }
    if (url.pathname.startsWith('/storage/v1/object/private-uploads/')) {
      const object = url.pathname.replace('/storage/v1/object/private-uploads/', '');
      if (!own) return new Response(null, { status: 403 });
      if (method === 'GET') return objects.has(object) ? new Response(objects.get(object)) : new Response(null, { status: 404 });
      objects.set(object, String(init?.body)); return Response.json({ Key: object });
    }
    return original(input, init);
  });
  await f.backends.configuration.planVerification(f.project.id, { action: 'verify', scenario: 'storage', bucket: 'private-uploads' });
  for (const [name, value] of [['qualification_owner', owner], ['qualification_other', other]]) f.backends.configuration.secrets.supply(f.project.id, { environment: 'development', name, value, expectedRevision: null });
  const plan = await f.backends.configuration.planVerification(f.project.id, { action: 'verify', scenario: 'storage', bucket: 'private-uploads' }), op = await f.backends.submit(f.project.id, { plan, requestId: randomUUID() });
  await f.approve(op); const result = await f.state(op.id, outage ? 'failed' : 'succeeded');
  expect(objects.size).toBe(outage ? 1 : 0);
  if (!outage) expect(result.steps.find(s => s.name === 'verify.storage.receipt')?.result).toMatchObject({ evidence: expect.arrayContaining([{ check: 'signed_url_expiry', status: 'pass' }, { check: 'owner_delete_confirmed', status: 'pass' }]) });
  expect(JSON.stringify(result)).not.toContain(owner); expect(JSON.stringify(result)).not.toContain('private-signed-canary');
  if (outage) {
    const step = plan.steps[0]!; if (step.kind !== 'verification') throw new Error('Expected fixture step');
    expect(result.steps.find(s => s.name === 'verify.storage')).toMatchObject({ state: 'failed', result: { fixtureId: step.fixtureId, fixturesRetained: true } });
    const cleanup = await f.backends.configuration.planVerification(f.project.id, { action: 'verify', scenario: 'cleanup', fixtureId: step.fixtureId });
    const staged = await f.backends.submit(f.project.id, { plan: cleanup, requestId: randomUUID() }); await f.approve(staged); await f.state(staged.id, 'succeeded'); expect(objects.size).toBe(0);
  }
});
it('reviews Google web callback sources and resolves its private client secret only at dispatch', async () => {
  const f = await fixture();
  const config = { version: 1, auth: { settings: { external_google_enabled: true, external_google_client_id: 'fixture.apps.googleusercontent.com', uri_allow_list: 'https://app.example/oauth-callback' }, secrets: [{ field: 'external_google_secret', secret: 'google_client' }] }, requirements: [{ name: 'google_client', purpose: 'app_login', label: 'Google web client secret' }] };
  expect(desiredConfiguration.safeParse({ ...config, auth: { ...config.auth, settings: { ...config.auth.settings, uri_allow_list: 'https://app.example/' } } }).success).toBe(false);
  await f.source(config); const missing = await f.plan();
  expect(missing.sources.map(s => s.path)).toEqual(expect.arrayContaining(['src/backend/social.ts', 'app/oauth-callback.tsx']));
  f.backends.configuration.secrets.supply(f.project.id, { environment: 'development', name: 'google_client', value: 'private-google-client-canary', expectedRevision: null });
  const op = await f.stage(); await f.approve(op); await f.state(op.id, 'succeeded');
  expect(f.auth).toMatchObject({ external_google_enabled: true, external_google_skip_nonce_check: false, external_google_secret: 'private-google-client-canary' });
  expect(JSON.stringify(await f.backends.inspect(f.project.id))).not.toContain('private-google-client-canary');
});
it.each(['import x from "https://example.com/x.ts";', 'import("./dep.ts");', 'import "../../escape.ts";'])('rejects uncaptured function dependency: %s', async content => {
  const f = await fixture(); await f.files.write(f.project.id, [{ path: 'supabase/functions/owner-check/index.ts', content, expectedRevision: null }]);
  await expect(prepareFunction(f.files, f.project.id, 'owner-check', 'supabase/functions/owner-check/index.ts')).rejects.toThrow();
});
it('rejects public storage, arbitrary Auth fields and undeclared or conflicting secret purposes', () => {
  expect(desiredConfiguration.safeParse({ version: 1, auth: { settings: { smtp_pass: 'raw-canary' } } }).success).toBe(false);
  expect(desiredConfiguration.safeParse({ version: 1, storage: { serverCredential: 'key', buckets: [{ id: 'public', public: true, file_size_limit: 100, allowed_mime_types: ['image/png'] }] } }).success).toBe(false);
  expect(desiredConfiguration.safeParse({ version: 1, auth: { secrets: [{ field: 'smtp_pass', secret: 'missing' }] } }).success).toBe(false);
});
it('marks an explicit provider denial as failed without keeping the environment uncertain', async () => {
  const f = await fixture(); await f.source(authConfig); const original = f.fetcher.getMockImplementation()!;
  f.fetcher.mockImplementation((url, init) => init?.method === 'PATCH' ? Promise.resolve(Response.json({ error: 'private-provider-canary' }, { status: 403 })) : original(url, init));
  const op = await f.stage(); await f.approve(op); const failed = await f.state(op.id, 'failed');
  expect(failed.steps.find(s => s.name === 'auth')).toMatchObject({ state: 'rejected' }); expect(JSON.stringify(failed)).not.toContain('canary');
});
it('a mixed v1/v2 queue isolates unknown and malformed records without stopping supported work', async () => {
  const f = await fixture(); await f.source(authConfig); const valid = await f.stage();
  const store = new PlatformStore(f.database, new SecretBox(key)), actor = { id: 'local-owner', workspaceId: store.identity(), role: 'owner' as const, source: 'local-owner' as const };
  const unsupported = store.submit(actor, { projectId: f.project.id, environment: 'staging', kind: 'backend_future', idempotencyKey: randomUUID(), plan: { version: 99 } });
  const malformed = store.submit(actor, { projectId: f.project.id, environment: 'staging', kind: 'backend_future', idempotencyKey: randomUUID(), plan: { version: 99 } });
  store.approve(actor, unsupported.id, unsupported.planHash); store.approve(actor, malformed.id, malformed.planHash); store.approve(actor, valid.id, valid.planHash); store.close();
  const db = new DatabaseSync(path.join(f.database, 'platform.sqlite')); db.prepare('UPDATE operations SET plan=? WHERE id=?').run('{broken', malformed.id); db.close();
  await vi.waitFor(async () => expect((await f.backends.operation(f.project.id, unsupported.id)).state).toBe('failed'), { timeout: 5000 });
  await f.state(valid.id, 'succeeded'); expect((await f.backends.inspect(f.project.id)).operations.some(op => op.id === malformed.id)).toBe(false);
});
it('runs bounded development record checks with scoped private sessions and refuses production verification', async () => {
  const f = await fixture(), ownerId = randomUUID(), otherId = randomUUID(), notes = new Map<string, { id: string; owner_id: string; body: string }>();
  const owner = 'owner.payload.signature', other = 'other.payload.signature', original = f.fetcher.getMockImplementation()!;
  f.fetcher.mockImplementation(async (input, init) => {
    const url = new URL(String(input)), token = new Headers(init?.headers).get('Authorization'), userId = token === `Bearer ${owner}` ? ownerId : token === `Bearer ${other}` ? otherId : undefined;
    if (url.pathname === '/auth/v1/user') return Response.json({ id: userId });
    if (url.pathname === '/rest/v1/notes') {
      if (!userId) return new Response(null, { status: 403 });
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      if (init?.method === 'POST') { if (body.owner_id !== userId || notes.has(body.id)) return new Response(null, { status: 403 }); notes.set(body.id, body); return Response.json([body]); }
      const id = url.searchParams.get('id')!.slice(3), note = notes.get(id);
      if (!note || note.owner_id !== userId) return Response.json([]);
      if (init?.method === 'PATCH') note.body = body.body;
      if (init?.method === 'DELETE') notes.delete(id);
      return Response.json([note]);
    }
    return original(input, init);
  });
  const missing = await f.backends.configuration.planVerification(f.project.id, { action: 'verify', scenario: 'records' }); expect(missing.prerequisites).toHaveLength(2);
  for (const [name, value] of [['qualification_owner', owner], ['qualification_other', other]]) f.backends.configuration.secrets.supply(f.project.id, { environment: 'development', name, value, expectedRevision: null });
  const plan = await f.backends.configuration.planVerification(f.project.id, { action: 'verify', scenario: 'records' }), op = await f.backends.submit(f.project.id, { plan, requestId: randomUUID() });
  expect(notes.size).toBe(0); await f.approve(op); const result = await f.state(op.id, 'succeeded'); expect(notes.size).toBe(0);
  expect(result.steps.find(step => step.name === 'verify.records.receipt')?.result).toMatchObject({ qualification: 'service_checks_only', evidence: expect.arrayContaining([{ check: 'other_user_update_denied', status: 'pass' }, { check: 'owner_delete_confirmed', status: 'pass' }]) });
  expect(JSON.stringify(result)).not.toContain(owner);
  await expect(f.backends.configuration.planVerification(f.project.id, { action: 'verify', environment: 'production', scenario: 'records' })).rejects.toThrow();
});
