import { cp, link, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Engine } from './engine.js';
import { Projects } from './projects.js';
import { NativeBuildWorkspaces } from './native-build-workspaces.js';
import { sourceSnapshot } from './native-workspace-source.js';
import type { WorkspacePlan, WorkspaceSelection, WorkspaceStatus } from './native-workspace-contracts.js';
import type { AppEnvironment } from './runtime-environment.js';

let root: string, engine: Engine, service: NativeBuildWorkspaces, id: string, appRoot: string;
let env: AppEnvironment, environmentRevision: string;
const selection: WorkspaceSelection = { profile: 'preview', platform: 'all', environment: 'none' };
const file = (name: string) => path.join(appRoot, name);
const confirm = (plan: WorkspacePlan, requestId = randomUUID()) => ({ selection: plan.selection, proposedRevision: plan.proposedRevision, requestId, confirmed: true });
const runFixture: NonNullable<ConstructorParameters<typeof NativeBuildWorkspaces>[5]> = async (step, directory, app) => {
  if (step.startsWith('export-')) {
    const output = path.join(directory, '../exports', step.slice(7)); await mkdir(output, { recursive: true });
    await writeFile(path.join(output, 'bundle.js'), JSON.stringify(app));
  }
};
const runner = vi.fn(runFixture);
function open(trusted = true) { return new NativeBuildWorkspaces(engine.projects, trusted, async () => ({ app: env, revision: environmentRevision }), async () => { await engine.nativeBuilds.assertReady(id); }, () => {}, runner); }
async function terminal(workspace: WorkspaceStatus) {
  await vi.waitFor(async () => expect(['preparing', 'cancelling']).not.toContain((await service.get(id, workspace.id)).state), { timeout: 10_000 });
  return service.get(id, workspace.id);
}
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'native-workspaces-')); env = {}; environmentRevision = 'none';
  engine = new Engine(await Projects.open(path.join(root, 'apps'), path.join(root, 'home')), false);
  const project = await engine.projects.create({ name: 'Build Fixture', slug: 'build-fixture' }); id = project.id; appRoot = project.root;
  const plan = await engine.nativeBuilds.plan(id, { iosBundleIdentifier: 'com.acme.fixture', androidPackage: 'com.acme.fixture', scheme: 'acme-fixture' });
  await engine.nativeBuilds.apply(id, { configuration: plan.configuration, proposedRevision: plan.proposedRevision, confirmed: true });
  service = open(); runner.mockReset().mockImplementation(runFixture);
});
afterEach(async () => { await service.close(); await engine.close(); vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

it('prepares immutable reviewed inputs and all exports without changing the source, dependencies or preview', async () => {
  await writeFile(file('backend/connection.json'), JSON.stringify({ environment: 'development', url: 'https://checked-in.example', publishableKey: 'old-fallback' }));
  for (const name of ['.env', '.env.local', 'credentials.json', 'src/.env.local', 'src/signing.p8']) await writeFile(file(name), 'PRIVATE_CANARY');
  const original = await sourceSnapshot(appRoot), stop = vi.spyOn(engine.previews, 'stop');
  const plan = await service.plan(id, selection), input = confirm(plan);
  expect(plan.files).toContainEqual(expect.objectContaining({ path: 'metro.config.js' }));
  expect((await service.plan(id, selection)).proposedRevision).toBe(plan.proposedRevision);
  expect(plan.files.some(item => /env.local|credentials|signing/.test(item.path))).toBe(false);
  const pending = await service.prepare(id, input), result = await terminal(pending);
  expect(result.state).toBe('ready'); expect(result.exports.map(item => item.platform)).toEqual(['web', 'ios', 'android']);
  expect(result.receipts.map(item => item.step)).toEqual(['install', 'typecheck', 'export-web', 'export-ios', 'export-android', 'verify']);
  const prepared = path.join(engine.projects.home, 'native-workspaces', id, pending.id);
  expect(JSON.parse(await readFile(path.join(prepared, 'input/backend/connection.json'), 'utf8'))).toEqual({ environment: 'none', url: '', publishableKey: '' });
  expect([...(await sourceSnapshot(path.join(prepared, 'input'))).contents.values()].some(bytes => bytes.includes('PRIVATE_CANARY'))).toBe(false);
  expect((await sourceSnapshot(appRoot)).fingerprint).toBe(original.fingerprint); expect(stop).not.toHaveBeenCalled();
  expect((await service.prepare(id, input)).id).toBe(result.id); expect(runner).toHaveBeenCalledTimes(5);
  await expect(service.prepare(id, { ...input, selection: { ...selection, platform: 'ios' } })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
});
it('overlays only the explicitly selected public backend and returns fingerprints instead of its key', async () => {
  env = { EXPO_PUBLIC_SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co', EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_fixture', EXPO_PUBLIC_BUILDER_ENVIRONMENT: 'staging' };
  const plan = await service.plan(id, { ...selection, platform: 'ios', environment: 'staging' });
  expect(JSON.stringify(plan)).not.toContain(env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY);
  const result = await terminal(await service.prepare(id, confirm(plan))); expect(result.state).toBe('ready');
  expect(result.exports.map(item => item.platform)).toEqual(['web', 'ios']);
  expect(runner.mock.calls.every(call => call[2] === env)).toBe(true);
  const connection = JSON.parse(await readFile(path.join(engine.projects.home, 'native-workspaces', id, result.id, 'app/backend/connection.json'), 'utf8'));
  expect(connection).toEqual({ environment: 'staging', url: env.EXPO_PUBLIC_SUPABASE_URL, publishableKey: env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY });
});
it('rejects stale source, backend configuration, dependencies and replacement roots before execution', async () => {
  let plan = await service.plan(id, selection);
  const original = await readFile(file('app/index.tsx')); await writeFile(file('app/index.tsx'), Buffer.concat([original, Buffer.from('\n')]));
  await expect(service.prepare(id, confirm(plan))).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  plan = await service.plan(id, selection); environmentRevision = 'different';
  await expect(service.prepare(id, confirm(plan))).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  plan = await service.plan(id, selection); const manifest = await readFile(file('package.json')); await writeFile(file('package.json'), Buffer.concat([manifest, Buffer.from('\n')]));
  await expect(service.prepare(id, confirm(plan))).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  plan = await service.plan(id, selection); await rename(appRoot, appRoot + '-old'); await cp(appRoot + '-old', appRoot, { recursive: true });
  await expect(service.prepare(id, confirm(plan))).rejects.toMatchObject({ code: 'REVISION_CONFLICT' }); expect(runner).not.toHaveBeenCalled();
});
it('requires execution trust and refuses custom code/config and unlinked backend targets', async () => {
  await service.close(); service = open(false);
  await expect(service.prepare(id, confirm(await service.plan(id, selection)))).rejects.toMatchObject({ code: 'TRUST_REQUIRED' });
  await expect(service.plan(id, { ...selection, environment: 'staging' })).rejects.toThrow('Link the intended backend');
  await writeFile(file('metro.config.js'), 'throw new Error("must never run")');
  await expect(service.plan(id, selection)).rejects.toThrow('unsupported build file'); await rm(file('metro.config.js'));
  await writeFile(file('src/backend/client.ts'), 'throw new Error("custom client")');
  await expect(service.plan(id, selection)).rejects.toThrow('Custom backend clients'); expect(runner).not.toHaveBeenCalled();
});
it('rejects included symlinks, hardlinks and oversized files, without following excluded state', async () => {
  const outside = path.join(root, 'outside'); await writeFile(outside, 'private');
  await symlink(outside, file('src/link.ts')); await expect(sourceSnapshot(appRoot)).rejects.toThrow('Symlinks'); await rm(file('src/link.ts'));
  await link(outside, file('src/link.ts')); await expect(sourceSnapshot(appRoot)).rejects.toThrow('Unsupported'); await rm(file('src/link.ts'));
  await symlink(path.join(root, 'missing'), file('.builder')); await sourceSnapshot(appRoot);
  await mkdir(file('assets')); await writeFile(file('assets/large.png'), Buffer.alloc(8_000_001)); await expect(sourceSnapshot(appRoot)).rejects.toThrow('oversized');
});
it('records failure without retaining arbitrary compiler output and detects changed reviewed files', async () => {
  runner.mockImplementationOnce(async () => { throw new Error('PRIVATE_COMPILER_CANARY'); });
  let result = await terminal(await service.prepare(id, confirm(await service.plan(id, selection))));
  expect(result.state).toBe('failed'); expect(result.error).toContain('install'); expect(JSON.stringify(result)).not.toContain('PRIVATE_COMPILER_CANARY');
  runner.mockImplementationOnce(async (_step, directory) => { await writeFile(path.join(directory, 'app.json'), '{}'); });
  result = await terminal(await service.prepare(id, confirm(await service.plan(id, selection))));
  expect(result.state).toBe('failed'); expect(result.error).toContain('verify');
});
it('cancels owned work, prevents overlapping execution and requires a current revision to remove', async () => {
  runner.mockImplementationOnce(async (_step, _directory, _env, signal) => { if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); });
  const pending = await service.prepare(id, confirm(await service.plan(id, selection)));
  await vi.waitFor(() => expect(runner).toHaveBeenCalledTimes(1), { timeout: 10_000 });
  expect((await service.get(id, pending.id)).step).toBe('install');
  await expect(service.prepare(id, confirm(await service.plan(id, selection)))).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
  await expect(service.cancel(id, { workspaceId: pending.id, expectedRevision: pending.revision })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  const current = await service.get(id, pending.id); await service.cancel(id, { workspaceId: pending.id, expectedRevision: current.revision });
  const result = await terminal(pending); expect(result.state).toBe('cancelled');
  await expect(service.remove(id, { workspaceId: result.id, expectedRevision: current.revision, confirmed: true })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  await service.remove(id, { workspaceId: result.id, expectedRevision: result.revision, confirmed: true });
  expect(await service.list(id)).toEqual([]); expect(await readFile(file('app.json'), 'utf8')).toContain('com.acme.fixture');
});
it('marks shutdown and old-epoch work interrupted and never resumes it automatically', async () => {
  runner.mockImplementationOnce(async (_step, _directory, _env, signal) => { if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); });
  const pending = await service.prepare(id, confirm(await service.plan(id, selection)));
  await vi.waitFor(() => expect(runner).toHaveBeenCalledTimes(1), { timeout: 10_000 });
  expect((await service.get(id, pending.id)).step).toBe('install');
  await service.close(); service = open(); expect((await service.get(id, pending.id)).state).toBe('interrupted');
  const recordFile = path.join(engine.projects.home, 'native-workspaces', id, pending.id, 'record.json');
  const record = JSON.parse(await readFile(recordFile, 'utf8')); await writeFile(recordFile, JSON.stringify({ ...record, state: 'preparing' }));
  expect((await service.get(id, pending.id)).state).toBe('interrupted'); expect(runner).toHaveBeenCalledTimes(1);
});
it('bounds retained workspaces and rejects replacement or redirected workspace directories', async () => {
  for (let i = 0; i < 5; i++) expect((await terminal(await service.prepare(id, confirm(await service.plan(id, selection))))).state).toBe('ready');
  await expect(service.prepare(id, confirm(await service.plan(id, selection)))).rejects.toThrow('limit: 5');
  const record = (await service.list(id))[0]!, directory = path.join(engine.projects.home, 'native-workspaces', id, record.id);
  await rename(directory, directory + '-old'); await cp(directory + '-old', directory, { recursive: true });
  await expect(service.get(id, record.id)).rejects.toThrow('identity changed');
  await rm(directory, { recursive: true }); await symlink(directory + '-old', directory);
  await expect(service.remove(id, { workspaceId: record.id, expectedRevision: record.revision, confirmed: true })).rejects.toThrow('Symlinks');
});
