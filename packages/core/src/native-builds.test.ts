import { lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Engine } from './engine.js';
import { Projects } from './projects.js';
import { nativeBuildConfiguration, nativeBuildProfiles, type NativeBuildPlan } from './native-builds.js';
import { dependencyFiles } from './dependency-profiles.js';
import * as storage from './storage.js';

let root: string, engine: Engine, id: string, appRoot: string;
const configuration = { iosBundleIdentifier: 'com.acme.still', androidPackage: 'com.acme.still', scheme: 'acme-still' };
const confirm = (plan: NativeBuildPlan) => ({ configuration: plan.configuration ?? undefined, proposedRevision: plan.proposedRevision, confirmed: true });
const file = (relative: string) => path.join(appRoot, relative);
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'native-build-'));
  engine = new Engine(await Projects.open(path.join(root, 'apps'), path.join(root, 'home')), false);
  const project = await engine.projects.create({ name: 'Native App', slug: 'native-app' }); id = project.id; appRoot = project.root;
});
afterEach(async () => { vi.restoreAllMocks(); await engine.close(); await rm(root, { recursive: true, force: true }); });

it('reviews and applies local build identity and profiles without touching dependencies or unrelated configuration', async () => {
  const original = JSON.parse(await readFile(file('app.json'), 'utf8'));
  original.expo.extra = { appTheme: 'custom' }; original.expo.ios = { supportsTablet: true }; original.expo.android = { permissions: [] };
  await writeFile(file('app.json'), JSON.stringify(original));
  await writeFile(file('eas.json'), JSON.stringify({ build: { production: { autoIncrement: true } }, submit: { production: {} } }));
  const dependencies = await dependencyFiles(appRoot), before = await readFile(file('app.json'), 'utf8'), stop = vi.spyOn(engine.previews, 'stop');
  const binding = { ...configuration, expoOwner: 'acme-team', easProjectId: randomUUID() };
  const plan = await engine.nativeBuilds.plan(id, binding);
  expect(plan).toMatchObject({ state: 'ready', conflicts: [] }); expect(plan.files.map(f => f.path)).toEqual(['app.json', 'eas.json']);
  expect(await readFile(file('app.json'), 'utf8')).toBe(before); expect(stop).not.toHaveBeenCalled();
  await engine.nativeBuilds.apply(id, confirm(plan)); expect(stop).toHaveBeenCalledWith(id);
  expect(JSON.parse(await readFile(file('app.json'), 'utf8'))).toMatchObject({ expo: { ...original.expo, scheme: binding.scheme, owner: binding.expoOwner, ios: { supportsTablet: true, bundleIdentifier: binding.iosBundleIdentifier }, android: { permissions: [], package: binding.androidPackage }, extra: { appTheme: 'custom', eas: { projectId: binding.easProjectId } } } });
  expect(JSON.parse(await readFile(file('eas.json'), 'utf8'))).toEqual({ build: { production: { autoIncrement: true }, ...nativeBuildProfiles }, submit: { production: {} } });
  expect(await dependencyFiles(appRoot)).toEqual(dependencies);
  expect(await engine.nativeBuilds.inspect(id)).toMatchObject({ providerOwnership: 'unverified', recoveryRequired: false, dependencies: { profile: 'expo-supabase-v1', developmentClient: null } });
  const current = await engine.nativeBuilds.plan(id, binding); expect(current.state).toBe('current');
  expect(await engine.nativeBuilds.apply(id, confirm(current))).toEqual({ applied: [], recovered: false });
});
it('rejects stale source, dependencies, and identity collisions introduced after review', async () => {
  const plan = await engine.nativeBuilds.plan(id, configuration), manifest = await readFile(file('package.json'), 'utf8');
  await writeFile(file('package.json'), manifest + '\n');
  await expect(engine.nativeBuilds.apply(id, confirm(plan))).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  await writeFile(file('package.json'), manifest);
  const other = await engine.projects.create({ name: 'Another App', slug: 'another-app' });
  const otherConfig = JSON.parse(await readFile(path.join(other.root, 'app.json'), 'utf8')); otherConfig.expo.scheme = configuration.scheme;
  await writeFile(path.join(other.root, 'app.json'), JSON.stringify(otherConfig));
  await expect(engine.nativeBuilds.apply(id, confirm(plan))).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  expect((await engine.nativeBuilds.plan(id, configuration)).conflicts.join()).toContain('Another App');
  expect(await storage.exists(file('eas.json'))).toBeNull();
});
it('protects custom build profiles, native directories, and dynamic config', async () => {
  const custom = '{"build":{"preview":{"extends":"custom","distribution":"internal"}}}';
  await writeFile(file('eas.json'), custom); await mkdir(file('ios')); await writeFile(file('app.config.ts'), 'throw new Error("must never execute")');
  const plan = await engine.nativeBuilds.plan(id, configuration);
  expect(plan.state).toBe('conflict'); expect(plan.conflicts.join()).toContain('custom preview'); expect(plan.conflicts.join()).toContain('app.config.ts'); expect(plan.conflicts.join()).toContain('ios requires');
  await expect(engine.nativeBuilds.apply(id, confirm(plan))).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  expect(await readFile(file('eas.json'), 'utf8')).toBe(custom);
});
it('does not rebind an existing app or Expo project identity', async () => {
  const first = await engine.nativeBuilds.plan(id, { ...configuration, expoOwner: 'acme-team', easProjectId: randomUUID() });
  await engine.nativeBuilds.apply(id, confirm(first));
  const plan = await engine.nativeBuilds.plan(id, { ...configuration, iosBundleIdentifier: 'com.acme.other' });
  expect(plan.state).toBe('conflict'); expect(plan.conflicts).toHaveLength(3);
  await expect(engine.nativeBuilds.apply(id, confirm(plan))).rejects.toThrow('Resolve build setup conflicts');
});
it('requires valid user supplied identifiers, paired ownership and explicit confirmation', async () => {
  for (const input of [{ ...configuration, androidPackage: 'com.acme.class' }, { ...configuration, scheme: 'https' }, { ...configuration, iosBundleIdentifier: '../escape' }, { ...configuration, expoOwner: 'acme-team' }, { ...configuration, token: 'forbidden' }]) expect(nativeBuildConfiguration.safeParse(input).success).toBe(false);
  const plan = await engine.nativeBuilds.plan(id, configuration);
  await expect(engine.nativeBuilds.apply(id, { ...confirm(plan), confirmed: false })).rejects.toThrow();
  expect(await storage.exists(file('eas.json'))).toBeNull();
});
it('rejects symlinks and replacement roots without overwriting the replacement', async () => {
  const outside = path.join(root, 'outside.json'); await writeFile(outside, '{}'); await symlink(outside, file('eas.json'));
  await expect(engine.nativeBuilds.plan(id, configuration)).rejects.toThrow('Symlinks'); await rm(file('eas.json'));
  const plan = await engine.nativeBuilds.plan(id, configuration);
  await rename(appRoot, appRoot + '-original'); await mkdir(appRoot);
  for (const name of ['app.json', 'package.json', 'package-lock.json']) await writeFile(file(name), await readFile(path.join(appRoot + '-original', name)));
  await expect(engine.nativeBuilds.apply(id, confirm(plan))).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  expect(await storage.exists(file('eas.json'))).toBeNull();
});
it('restores the first file when the second file cannot be committed', async () => {
  const original = await readFile(file('app.json'), 'utf8'), plan = await engine.nativeBuilds.plan(id, configuration), write = storage.atomicWrite;
  vi.spyOn(storage, 'atomicWrite').mockImplementation(async (target, content) => { if (target === file('eas.json')) throw new Error('Disk full'); return write(target, content); });
  await expect(engine.nativeBuilds.apply(id, confirm(plan))).rejects.toMatchObject({ code: 'WRITE_FAILED', details: { recoveryRequired: false } });
  expect(await readFile(file('app.json'), 'utf8')).toBe(original); await engine.nativeBuilds.assertReady(id);
});
it('preserves concurrent edits and exposes recovery after a process restart', async () => {
  const plan = await engine.nativeBuilds.plan(id, configuration), write = storage.atomicWrite;
  vi.spyOn(storage, 'atomicWrite').mockImplementation(async (target, content) => {
    if (target === file('eas.json')) { await writeFile(file('app.json'), 'Concurrent edit: unfinished JSON'); throw new Error('Interrupted'); }
    return write(target, content);
  });
  await expect(engine.nativeBuilds.apply(id, confirm(plan))).rejects.toMatchObject({ code: 'WRITE_FAILED', details: { recoveryRequired: true } });
  vi.restoreAllMocks(); await engine.close(); engine = new Engine(await Projects.open(path.join(root, 'apps'), path.join(root, 'home')), false);
  await expect(engine.nativeBuilds.assertReady(id)).rejects.toThrow('interrupted build setup');
  expect((await engine.nativeBuilds.inspect(id)).recoveryRequired).toBe(true);
  expect((await engine.nativeBuilds.plan(id)).state).toBe('conflict');
  expect(await readFile(file('app.json'), 'utf8')).toContain('Concurrent edit');
  await writeFile(file('app.json'), plan.files[0]!.after!);
  const recovery = await engine.nativeBuilds.plan(id); expect(recovery.state).toBe('recovery');
  expect(await engine.nativeBuilds.apply(id, confirm(recovery))).toMatchObject({ recovered: true });
  expect(await readFile(file('app.json'), 'utf8')).toBe(plan.files[0]!.before); expect(await storage.exists(file('eas.json'))).toBeNull();
  await engine.nativeBuilds.assertReady(id);
});
it('handles a durable journal left before any writes and refuses recovery for a different root', async () => {
  const plan = await engine.nativeBuilds.plan(id, configuration), stat = await lstat(appRoot), directory = path.join(engine.projects.home, 'native-builds');
  await mkdir(directory); const journal = { version: 1, identity: { id, root: appRoot, device: stat.dev, inode: stat.ino }, files: plan.files };
  await writeFile(path.join(directory, `${id}.json`), JSON.stringify(journal));
  const recovery = await engine.nativeBuilds.plan(id); expect(recovery).toMatchObject({ state: 'recovery', files: [] });
  expect(await engine.nativeBuilds.apply(id, confirm(recovery))).toEqual({ recovered: true, applied: [] });
  await writeFile(path.join(directory, `${id}.json`), JSON.stringify({ ...journal, identity: { ...journal.identity, inode: -1 } }));
  await expect(engine.nativeBuilds.plan(id)).rejects.toThrow('different project root');
});
