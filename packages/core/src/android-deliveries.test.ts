import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Engine } from './engine.js';
import { Projects } from './projects.js';
import { NativeBuildWorkspaces } from './native-build-workspaces.js';
import { AndroidDeliveries } from '../../builtin-plugins/src/features/android-deliveries.js';
import type { AndroidHost } from '../../builtin-plugins/src/features/native-android-host.js';

let root: string, engine: Engine, workspaces: NativeBuildWorkspaces, delivery: AndroidDeliveries, id: string, workspaceId: string, installed: boolean, host: AndroidHost;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'android-delivery-')); installed = false;
  engine = new Engine(await Projects.open(path.join(root, 'apps'), path.join(root, 'home')), false);
  id = (await engine.projects.create({ name: 'Android fixture', slug: 'android-fixture' })).id;
  const setup = await engine.nativeBuilds.plan(id, { iosBundleIdentifier: 'com.fixture.app', androidPackage: 'com.fixture.app', scheme: 'fixture-app' });
  await engine.nativeBuilds.apply(id, { configuration: setup.configuration, proposedRevision: setup.proposedRevision, confirmed: true });
  workspaces = new NativeBuildWorkspaces(engine.projects, true, async () => ({ app: {}, revision: 'none' }), async () => {}, () => {}, async (step, directory) => {
    if (step.startsWith('export-')) { const output = path.join(directory, '../exports', step.slice(7)); await mkdir(output, { recursive: true }); await writeFile(path.join(output, 'bundle.js'), 'fixture'); }
  });
  const plan = await workspaces.plan(id, { profile: 'preview', platform: 'android', environment: 'none' });
  workspaceId = (await workspaces.prepare(id, { selection: plan.selection, proposedRevision: plan.proposedRevision, requestId: randomUUID(), confirmed: true })).id;
  await vi.waitFor(async () => expect((await workspaces.get(id, workspaceId)).state).toBe('ready'), { timeout: 10_000 });
  host = {
    inspect: vi.fn(async () => ({ available: true, issues: [], devices: [{ id: 'fixture-device', name: 'Android fixture' }] })),
    run: vi.fn(async spec => { if (spec.args.includes(':app:assembleRelease')) { const folder = path.join(spec.cwd, 'app/build/outputs/apk/release'); await mkdir(folder, { recursive: true }); await writeFile(path.join(folder, 'app-release.apk'), 'fixture-signed-apk-with-js'); } return { stdout: '', stderr: '' }; }),
    verify: vi.fn(async () => {}), installed: vi.fn(async () => installed), install: vi.fn(async () => { installed = true; }),
  };
  delivery = new AndroidDeliveries(engine.projects, workspaces, true, true, () => {}, host);
});
afterEach(async () => { await delivery.close(); await workspaces.close(); await engine.close(); await rm(root, { recursive: true, force: true }); });
async function build() {
  const plan = await delivery.plan(id, { workspaceId }), input = { selection: plan.selection, proposedRevision: plan.proposedRevision, requestId: randomUUID(), confirmed: true };
  await delivery.build(id, input);
  await vi.waitFor(async () => expect((await delivery.list(id))[0]?.state).toBe('ready'), { timeout: 10_000 });
  return { input, job: (await delivery.list(id))[0]! };
}
it('builds an immutable reviewed copy and requires a separate installation review', async () => {
  const project = await engine.projects.get(id), before = await readFile(path.join(project.root, 'app.json'));
  const { input, job } = await build(); expect(host.install).not.toHaveBeenCalled();
  expect((await delivery.build(id, input)).id).toBe(job.id); expect(host.run).toHaveBeenCalledTimes(3);
  expect(host.verify).toHaveBeenCalledWith(expect.any(String), 'com.fixture.app', expect.any(AbortSignal));
  expect((await delivery.artifact(id, job.id)).bytes.toString()).toBe('fixture-signed-apk-with-js');
  const plan = await delivery.installPlan(id, { id: job.id, expectedRevision: job.revision, deviceId: 'fixture-device' });
  expect(plan.replacesExistingApp).toBe(false);
  await delivery.install(id, { id: plan.id, expectedRevision: plan.expectedRevision, deviceId: plan.deviceId, proposedRevision: plan.proposedRevision, confirmed: true });
  await vi.waitFor(async () => expect((await delivery.list(id))[0]?.state).toBe('installed'));
  expect(await readFile(path.join(project.root, 'app.json'))).toEqual(before);
  const latest = (await delivery.list(id))[0]!;
  await delivery.remove(id, { id: latest.id, expectedRevision: latest.revision, confirmed: true });
  expect(await delivery.list(id)).toEqual([]);
  await expect(delivery.build(id, input)).rejects.toThrow('removed');
});
it('rejects changed APKs, replacement state, preparation and hosted execution', async () => {
  const hosted = new AndroidDeliveries(engine.projects, workspaces, true, false, () => {}, host);
  expect(() => hosted.preflight()).toThrow('trusted local');
  const { job } = await build();
  const plan = await delivery.installPlan(id, { id: job.id, expectedRevision: job.revision, deviceId: 'fixture-device' });
  installed = true;
  await expect(delivery.install(id, { id: plan.id, expectedRevision: plan.expectedRevision, deviceId: plan.deviceId, proposedRevision: plan.proposedRevision, confirmed: true })).rejects.toThrow('replacement status changed');
  expect(host.install).not.toHaveBeenCalled();
  const artifact = await delivery.artifact(id, job.id); await writeFile(artifact.file, 'tampered');
  await expect(delivery.artifact(id, job.id)).rejects.toThrow('APK changed');
  await writeFile(path.join(engine.projects.home, 'native-workspaces', id, workspaceId, 'input/app/index.tsx'), 'tampered');
  await expect(delivery.plan(id, { workspaceId })).rejects.toThrow('Prepared inputs changed');
});
