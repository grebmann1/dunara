import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Engine } from './engine.js';
import { Projects } from './projects.js';
import { NativeBuildWorkspaces } from './native-build-workspaces.js';
import { NativeDeliveries } from '../../builtin-plugins/src/features/native-deliveries.js';
import { LocalIOSHost, nativeArtifact, parseIOSDevice, type IOSHost, type NativeCommand } from '../../builtin-plugins/src/features/native-ios-host.js';
import type { DeliveryPlan, DeliverySelection, DeliveryStatus } from './native-delivery-contracts.js';

const device = { id: '00008130-001918DC2E520010', name: 'Fixture iPhone', model: 'iPhone', developerMode: true };
const team = { id: 'ABCDE12345', name: 'Apple Development: Fixture' };
let root: string, engine: Engine, workspaces: NativeBuildWorkspaces, deliveries: NativeDeliveries, id: string, selection: DeliverySelection;
let installed: boolean, host: IOSHost;
let backend: { EXPO_PUBLIC_SUPABASE_URL: string; EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: string } | undefined;
const inputs = (plan: DeliveryPlan) => ({ selection: plan.selection, proposedRevision: plan.proposedRevision, requestId: randomUUID(), confirmed: true });
const action = (job: DeliveryStatus) => ({ deliveryId: job.id, expectedRevision: job.revision });
async function terminal() {
  await vi.waitFor(async () => expect((await deliveries.list(id)).every(job => !['building', 'installing', 'launching'].includes(job.state))).toBe(true), { timeout: 10_000 });
  return (await deliveries.list(id))[0]!;
}
async function fixtureRun(spec: NativeCommand) {
  if (spec.args.includes('-extract')) return { stdout: spec.args.includes('ExpirationDate') ? '2099-01-01T00:00:00Z' : JSON.stringify([spec.args.includes('ProvisionedDevices') ? device.id : team.id]), stderr: '' };
  if (spec.args.includes('prebuild')) { await mkdir(path.join(spec.cwd, 'ios/Fixture.xcodeproj'), { recursive: true }); }
  if (spec.command === 'pod') await mkdir(path.join(spec.cwd, 'Fixture.xcworkspace'));
  if (spec.args.includes('build')) {
    const derived = spec.args[spec.args.indexOf('-derivedDataPath') + 1]!, app = path.join(derived, 'Build/Products/Release-iphoneos/Fixture.app');
    await mkdir(app, { recursive: true }); for (const name of ['main.jsbundle', 'embedded.mobileprovision', 'Info.plist']) await writeFile(path.join(app, name), 'fixture');
  }
  return { stdout: spec.command === '/usr/bin/plutil' ? JSON.stringify({ CFBundleIdentifier: 'com.fixture.phone' }) : '', stderr: spec.args.includes('-dvv') ? `TeamIdentifier=${team.id}\n` : '' };
}
beforeEach(async () => {
  backend = undefined;
  root = await mkdtemp(path.join(os.tmpdir(), 'native-delivery-')); installed = false;
  engine = new Engine(await Projects.open(path.join(root, 'apps'), path.join(root, 'home')), false);
  const project = await engine.projects.create({ name: 'Phone fixture', slug: 'phone-fixture' }); id = project.id;
  const setup = await engine.nativeBuilds.plan(id, { iosBundleIdentifier: 'com.fixture.phone', androidPackage: 'com.fixture.phone', scheme: 'phone-fixture' });
  await engine.nativeBuilds.apply(id, { configuration: setup.configuration, proposedRevision: setup.proposedRevision, confirmed: true });
  workspaces = new NativeBuildWorkspaces(engine.projects, true, async () => ({ app: backend ?? {}, revision: backend ? 'staging' : 'none' }), async () => {}, () => {}, async (step, directory) => {
    if (step.startsWith('export-')) { const target = path.join(directory, '../exports', step.slice(7)); await mkdir(target, { recursive: true }); await writeFile(path.join(target, 'bundle.js'), 'fixture'); }
  });
  const plan = await workspaces.plan(id, { profile: 'preview', platform: 'ios', environment: 'none' });
  const workspace = await workspaces.prepare(id, { selection: plan.selection, proposedRevision: plan.proposedRevision, requestId: randomUUID(), confirmed: true });
  await vi.waitFor(async () => expect((await workspaces.get(id, workspace.id)).state).toBe('ready'), { timeout: 10_000 });
  selection = { workspaceId: workspace.id, deviceId: device.id, teamId: team.id };
  host = { inspect: vi.fn(async () => ({ supported: true, devices: [device], teams: [team], issues: [], xcode: 'Xcode fixture', cocoaPods: 'fixture' })), run: vi.fn(fixtureRun), device: vi.fn(async () => device), installed: vi.fn(async () => installed), install: vi.fn(async () => { installed = true; }), launch: vi.fn(async () => 1234) };
  deliveries = new NativeDeliveries(engine.projects, workspaces, true, true, () => {}, host);
});
afterEach(async () => { await deliveries.close(); await workspaces.close(); await engine.close(); vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

it('requires independent reviewed build, install and launch; preserves source and makes build replay idempotent', async () => {
  const project = await engine.projects.get(id), before = await readFile(path.join(project.root, 'app.json'));
  const plan = await deliveries.plan(id, selection), request = inputs(plan);
  await deliveries.build(id, request); let job = await terminal(); expect(job.state).toBe('ready'); expect(host.install).not.toHaveBeenCalled();
  const calls = vi.mocked(host.run).mock.calls.length; expect((await deliveries.build(id, request)).id).toBe(job.id); expect(vi.mocked(host.run).mock.calls.length).toBe(calls);
  expect(await readFile(path.join(project.root, 'app.json'))).toEqual(before);
  expect(JSON.stringify(job)).not.toContain(root); expect(job).not.toHaveProperty('directoryIdentity');
  const review = await deliveries.installPlan(id, action(job)); expect(review.replacesExistingApp).toBe(false);
  await deliveries.install(id, { ...action(job), proposedRevision: review.proposedRevision, confirmed: true }); job = await terminal();
  expect(job.state).toBe('installed'); expect(host.launch).not.toHaveBeenCalled();
  await deliveries.launch(id, { ...action(job), confirmed: true }); job = await terminal();
  expect(job).toMatchObject({ state: 'launched', processId: 1234 }); expect(job.receipts.map(value => value.step)).toEqual(['copy', 'dependencies', 'prebuild', 'pods', 'compile', 'verify', 'install', 'launch']);
});

it('rejects stale plans and changed immutable inputs before executing commands', async () => {
  const request = inputs(await deliveries.plan(id, selection));
  await writeFile(path.join(engine.projects.home, 'native-workspaces', id, selection.workspaceId, 'input/app/index.tsx'), 'changed');
  await expect(deliveries.build(id, request)).rejects.toThrow('Prepared inputs changed'); expect(host.run).not.toHaveBeenCalled();
});

it('requires local execution trust and rejects unknown devices, teams and request reuse', async () => {
  const request = inputs(await deliveries.plan(id, selection));
  const untrusted = new NativeDeliveries(engine.projects, workspaces, false, true, () => {}, host);
  const hosted = new NativeDeliveries(engine.projects, workspaces, true, false, () => {}, host);
  await expect(untrusted.build(id, request)).rejects.toThrow('trust'); expect(() => hosted.preflight()).toThrow('local Dunara');
  await expect(deliveries.plan(id, { ...selection, teamId: 'XXXXXXXXXX' })).rejects.toThrow('Refresh');
  await expect(deliveries.build(id, { ...request, proposedRevision: '0'.repeat(64) })).rejects.toThrow('changed');
  await deliveries.build(id, request); await terminal();
  await expect(deliveries.build(id, { ...request, selection: { ...selection, teamId: 'XXXXXXXXXX' } })).rejects.toThrow('another native build');
});

it('requires a new installation review when app replacement status or artifact changes', async () => {
  await deliveries.build(id, inputs(await deliveries.plan(id, selection))); const job = await terminal(), review = await deliveries.installPlan(id, action(job));
  installed = true;
  await expect(deliveries.install(id, { ...action(job), proposedRevision: review.proposedRevision, confirmed: true })).rejects.toThrow('review changed');
  expect(host.install).not.toHaveBeenCalled(); expect((await deliveries.installPlan(id, action(job))).replacesExistingApp).toBe(true);
  const artifact = path.join(engine.projects.home, 'native-deliveries', id, job.id, 'build/Build/Products/Release-iphoneos/Fixture.app');
  await writeFile(path.join(artifact, 'main.jsbundle'), 'changed');
  await expect(deliveries.installPlan(id, action(job))).rejects.toThrow('Signed app changed');
});

it('refuses a signed bundle whose provisioning profile excludes the selected phone', async () => {
  vi.mocked(host.run).mockImplementation(async spec => spec.args.includes('ProvisionedDevices') ? { stdout: '[]', stderr: '' } : fixtureRun(spec));
  await deliveries.build(id, inputs(await deliveries.plan(id, selection))); const job = await terminal();
  expect(job.state).toBe('failed'); expect(job.error).toContain('does not include this iPhone'); expect(job.artifact).toBeUndefined();
  await expect(deliveries.installPlan(id, action(job))).rejects.toThrow('verified signed app'); expect(host.install).not.toHaveBeenCalled();
});

it('explains a locked phone during installation review without exposing device diagnostics', async () => {
  await deliveries.build(id, inputs(await deliveries.plan(id, selection))); const job = await terminal();
  vi.mocked(host.device).mockRejectedValue(Object.assign(new Error('Native command failed'), { diagnostic: 'PRIVATE CANARY: iPhone needs to be unlocked' }));
  await expect(deliveries.installPlan(id, action(job))).rejects.toThrow('Unlock the selected iPhone');
  await expect(deliveries.installPlan(id, action(job))).rejects.not.toThrow('PRIVATE CANARY'); expect(host.install).not.toHaveBeenCalled();
});

it('does not confuse a successful command with verified installation and does not leak tool output', async () => {
  await deliveries.build(id, inputs(await deliveries.plan(id, selection))); let job = await terminal();
  const review = await deliveries.installPlan(id, action(job)); vi.mocked(host.install).mockResolvedValue();
  await deliveries.install(id, { ...action(job), proposedRevision: review.proposedRevision, confirmed: true }); job = await terminal();
  expect(job.state).toBe('failed'); expect(job.receipts.some(value => value.step === 'install')).toBe(false);
  await expect(deliveries.launch(id, { ...action(job), confirmed: true })).rejects.toThrow('Verify installation');
  vi.mocked(host.run).mockRejectedValue(Object.assign(new Error('PRIVATE CANARY'), { diagnostic: 'PRIVATE CANARY' }));
  await deliveries.build(id, inputs(await deliveries.plan(id, selection))); job = await terminal();
  expect(job.state).toBe('failed'); expect(JSON.stringify(job)).not.toContain('PRIVATE CANARY');
});

it('cancels only an owned build and reconciles restart without replaying a command', async () => {
  vi.mocked(host.run).mockImplementation((_spec, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })));
  const pending = await deliveries.build(id, inputs(await deliveries.plan(id, selection)));
  await vi.waitFor(() => expect(host.run).toHaveBeenCalled());
  const current = (await deliveries.list(id))[0]!; const cancelled = await deliveries.cancel(id, action(current)); expect(cancelled.state).toBe('cancelled');
  const file = path.join(engine.projects.home, 'native-deliveries', id, pending.id, 'record.json'), record = JSON.parse(await readFile(file, 'utf8'));
  await writeFile(file, JSON.stringify({ ...record, state: 'building', epoch: randomUUID() }));
  const count = vi.mocked(host.run).mock.calls.length; expect((await deliveries.list(id))[0]!.state).toBe('interrupted'); expect(vi.mocked(host.run).mock.calls.length).toBe(count);
});

it('rejects cross-project reads, symlinked outputs and bundles without offline JavaScript', async () => {
  const app = path.join(root, 'artifact'); await mkdir(app); await writeFile(path.join(app, 'embedded.mobileprovision'), 'fixture');
  await expect(nativeArtifact(app)).rejects.toThrow('bundled JavaScript');
  await symlink(path.join(app, 'embedded.mobileprovision'), path.join(app, 'main.jsbundle'));
  await expect(nativeArtifact(app)).rejects.toThrow('Symlinks');
  await deliveries.build(id, inputs(await deliveries.plan(id, selection))); const job = await terminal();
  const other = await engine.projects.create({ name: 'Other', slug: 'other' });
  await expect(deliveries.installPlan(other.id, action(job))).rejects.toThrow();
});

it('removes only the reviewed terminal build while preserving source and the phone app', async () => {
  const request = inputs(await deliveries.plan(id, selection)); await deliveries.build(id, request); const job = await terminal(); installed = true;
  await expect(deliveries.remove(id, { ...action(job), expectedRevision: randomUUID(), confirmed: true })).rejects.toThrow('changed');
  expect(await deliveries.remove(id, { ...action(job), confirmed: true })).toEqual({ removed: job.id, phoneAppUnchanged: true });
  expect(await deliveries.remove(id, { ...action(job), confirmed: true })).toEqual({ removed: job.id, phoneAppUnchanged: true });
  await expect(deliveries.build(id, request)).rejects.toThrow('already removed');
  expect(await deliveries.list(id)).toEqual([]); expect(installed).toBe(true); expect(await workspaces.get(id, selection.workspaceId)).toMatchObject({ state: 'ready' });
  expect((await engine.projects.get(id)).id).toBe(id);
});

it('parses physical devices across Xcode JSON generations without exposing private properties', () => {
  const legacy = { hardwareProperties: { reality: 'physical', platform: 'iOS', udid: device.id, marketingName: 'iPhone', serialNumber: 'PRIVATE' }, deviceProperties: { name: device.name, developerModeStatus: 'enabled' } };
  expect(parseIOSDevice(legacy)).toEqual(device);
  expect(parseIOSDevice({ properties: { hardware: { ...legacy.hardwareProperties, reality: 'simulated' }, state: legacy.deviceProperties } })).toBeUndefined();
  expect(parseIOSDevice({ properties: { hardware: legacy.hardwareProperties, state: { name: device.name, developerModeStatus: { enabled: { mode: 1 } } } } })).toEqual(device);
});

it('runs native commands without inherited provider credentials or child-process injection', async () => {
  vi.stubEnv('OPENAI_API_KEY', 'PRIVATE'); vi.stubEnv('DEVICECTL_CHILD_SECRET', 'PRIVATE'); vi.stubEnv('NODE_OPTIONS', '--invalid-injection');
  try {
    const result = await new LocalIOSHost().run({ command: process.execPath, args: ['-e', 'console.log(JSON.stringify([process.env.OPENAI_API_KEY,process.env.DEVICECTL_CHILD_SECRET,process.env.NODE_OPTIONS]))'], cwd: root }, new AbortController().signal);
    expect(result.stdout.trim()).toBe('[null,null,null]');
  } finally { vi.unstubAllEnvs(); }
});


it('builds the reviewed public backend binding without requiring Metro or private backend credentials', async () => {
  backend = { EXPO_PUBLIC_SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co', EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_fixture' };
  const preparation = await workspaces.plan(id, { profile: 'preview', platform: 'ios', environment: 'staging' });
  const workspace = await workspaces.prepare(id, { selection: preparation.selection, proposedRevision: preparation.proposedRevision, requestId: randomUUID(), confirmed: true });
  await vi.waitFor(async () => expect((await workspaces.get(id, workspace.id)).state).toBe('ready'), { timeout: 10_000 });
  selection = { ...selection, workspaceId: workspace.id };
  const plan = await deliveries.plan(id, selection);
  expect(plan.consequences.join(' ')).toContain('staging backend');
  await deliveries.build(id, inputs(plan)); const job = await terminal(); expect(job.state).toBe('ready');
  const connection = JSON.parse(await readFile(path.join(engine.projects.home, 'native-deliveries', id, job.id, 'app/backend/connection.json'), 'utf8'));
  expect(connection).toEqual({ environment: 'staging', url: backend.EXPO_PUBLIC_SUPABASE_URL, publishableKey: backend.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY });
  expect(JSON.stringify(job)).not.toContain('sb_publishable_fixture');
});
