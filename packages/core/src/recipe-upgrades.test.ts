import { lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Engine } from './engine.js';
import { Projects, templateRoot } from './projects.js';
import { dependencyFiles, dependencyProfile } from './dependency-profiles.js';
import { recipeUpgradePaths, type RecipeUpgradeProposal } from './recipe-upgrades.js';
import * as storage from './storage.js';
import { makeLegacyApp } from '../../../tests/fixtures/legacy-app.js';

let root: string, engine: Engine, id: string, appRoot: string;
const confirm = (p: RecipeUpgradeProposal) => ({ projectId: p.project.id, proposedRevision: p.proposedRevision, confirmed: true });
const file = (relative: string) => path.join(appRoot, relative);
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'recipe-upgrade-'));
  engine = new Engine(await Projects.open(path.join(root, 'apps'), path.join(root, 'home')), true);
  const project = await engine.projects.create({ name: 'My App', slug: 'my-app' }); id = project.id; appRoot = project.root;
});
afterEach(async () => { vi.restoreAllMocks(); await engine.close(); await rm(root, { recursive: true, force: true }); });
it('leaves current apps and their customized backend files untouched', async () => {
  await writeFile(file('src/backend/client.ts'), '// Customized client');
  const plan = await engine.recipeUpgrades.preview(id);
  expect(plan).toMatchObject({ state: 'current', files: [], recipe: 'supabase-notes-v1' });
  expect(await engine.recipeUpgrades.apply(id, confirm(plan))).toMatchObject({ applied: [] });
  expect(await readFile(file('src/backend/client.ts'), 'utf8')).toBe('// Customized client');
});
it('reviews exact manifest, lock and recipe changes, then preserves unrelated screens, navigation, metadata and theme', async () => {
  await makeLegacyApp(appRoot);
  const originals = await Promise.all(['app/index.tsx', 'src/ui/index.tsx', 'src/theme/design.json', 'app/_layout.tsx', '.mobile-builder.json'].map(async p => [p, await readFile(file(p), 'utf8')] as const));
  const before = await dependencyFiles(appRoot), stop = vi.spyOn(engine.previews, 'stop');
  const plan = await engine.recipeUpgrades.preview(id);
  expect(plan).toMatchObject({ state: 'ready', fromProfile: 'expo-legacy', toProfile: 'expo-supabase-v1', conflicts: [] });
  expect(plan.files.map(f => f.path)).toEqual(recipeUpgradePaths);
  expect(await dependencyFiles(appRoot)).toEqual(before); expect(stop).not.toHaveBeenCalled();
  const manifest = plan.files.find(f => f.path === 'package.json')!;
  expect(JSON.parse(manifest.after!).dependencies).toMatchObject({ '@supabase/supabase-js': '2.116.0', 'expo-secure-store': '57.0.3' });
  expect(JSON.parse(manifest.after!).name).toBe('my-app');
  expect((await engine.recipeUpgrades.apply(id, confirm(plan))).applied).toHaveLength(12);
  expect(stop).toHaveBeenCalledWith(id);
  for (const change of plan.files) expect(await readFile(file(change.path), 'utf8')).toBe(change.after);
  for (const [p, value] of originals) expect(await readFile(file(p), 'utf8')).toBe(value);
  expect(await dependencyProfile(await dependencyFiles(appRoot))).toBe('expo-supabase-v1');
  expect((await engine.recipeUpgrades.preview(id)).state).toBe('current');
  await expect(engine.files.write(id, [{ path: 'package-lock.json', content: '{}', expectedRevision: null }])).rejects.toThrow();
});
it('binds confirmation to the project, its root identity and all reviewed source revisions', async () => {
  await makeLegacyApp(appRoot); const plan = await engine.recipeUpgrades.preview(id);
  await expect(engine.recipeUpgrades.apply(id, { ...confirm(plan), confirmed: false })).rejects.toThrow();
  await expect(engine.recipeUpgrades.apply(id, { ...confirm(plan), files: [] })).rejects.toThrow();
  const other = await engine.projects.create({ name: 'Other', slug: 'other' });
  await expect(engine.recipeUpgrades.apply(other.id, confirm(plan))).rejects.toThrow('another project');
  await writeFile(file('src/theme/design.json'), (await readFile(file('src/theme/design.json'), 'utf8')) + '\n');
  await expect(engine.recipeUpgrades.apply(id, confirm(plan))).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  const fresh = await engine.recipeUpgrades.preview(id);
  await rename(appRoot, appRoot + '-moved'); await mkdir(appRoot);
  await expect(engine.recipeUpgrades.apply(id, confirm(fresh))).rejects.toThrow();
  await rm(appRoot, { recursive: true }); await rename(appRoot + '-moved', appRoot);
});
it.each(['app/account.tsx', 'app/(auth)/account.tsx', 'app/account/index.tsx', 'app/account.web.tsx', 'src/backend/client.web.ts', 'backend/connection.json', 'supabase/migrations/20260917000100_custom.sql'])('refuses an existing integration collision at %s', async relative => {
  await makeLegacyApp(appRoot); const before = await dependencyFiles(appRoot);
  await mkdir(path.dirname(file(relative)), { recursive: true }); await writeFile(file(relative), '// User-owned source');
  const plan = await engine.recipeUpgrades.preview(id);
  expect(plan.state).toBe('conflict'); expect(plan.conflicts.some(c => c.path === relative || relative.startsWith(c.path))).toBe(true);
  expect(plan.files).toEqual([]);
  await expect(engine.recipeUpgrades.apply(id, confirm(plan))).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  expect(await dependencyFiles(appRoot)).toEqual(before); expect(await readFile(file(relative), 'utf8')).toBe('// User-owned source');
});
it('rejects custom dependencies and ambiguous router roots and detects new routes after review', async () => {
  await makeLegacyApp(appRoot); const original = await readFile(file('package.json'), 'utf8');
  const manifest = JSON.parse(original); manifest.scripts.custom = 'echo customized'; await writeFile(file('package.json'), JSON.stringify(manifest));
  expect((await engine.recipeUpgrades.preview(id)).state).toBe('conflict');
  await writeFile(file('package.json'), original); await mkdir(file('src/app'));
  expect((await engine.recipeUpgrades.preview(id)).conflicts.some(c => c.path === 'src/app')).toBe(true);
  await rm(file('src/app'), { recursive: true }); const plan = await engine.recipeUpgrades.preview(id);
  await writeFile(file('app/account.js'), 'export default function Custom(){}');
  await expect(engine.recipeUpgrades.apply(id, confirm(plan))).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
});
it('refuses symlinked app source and recovery directories', async () => {
  await makeLegacyApp(appRoot); const outside = path.join(root, 'outside'); await mkdir(outside);
  await symlink(outside, file('app/linked'));
  await expect(engine.recipeUpgrades.preview(id)).rejects.toThrow('Symlinks');
  await rm(file('app/linked')); await symlink(outside, path.join(engine.projects.home, 'recipe-upgrades'));
  await expect(engine.recipeUpgrades.preview(id)).rejects.toThrow('Symlinks');
});
it('requires manual review for dynamic Expo config or a custom router root', async () => {
  await makeLegacyApp(appRoot); await writeFile(file('app.config.ts'), 'export default { expo: {} };');
  expect((await engine.recipeUpgrades.preview(id)).conflicts.some(c => c.path === 'app.config.ts')).toBe(true);
  await rm(file('app.config.ts'));
  const config = JSON.parse(await readFile(file('app.json'), 'utf8'));
  config.expo.plugins = [['expo-router', { root: './routes' }]];
  await writeFile(file('app.json'), JSON.stringify(config));
  expect((await engine.recipeUpgrades.preview(id)).conflicts.some(c => c.path === 'app.json')).toBe(true);
});
it('rolls back a failed manifest commit including the already replaced lockfile', async () => {
  await makeLegacyApp(appRoot); const original = await dependencyFiles(appRoot), plan = await engine.recipeUpgrades.preview(id);
  const write = storage.atomicWrite; let failed = false;
  vi.spyOn(storage, 'atomicWrite').mockImplementation(async (target, content) => {
    if (target === file('package.json') && !failed) { failed = true; throw new Error('Injected disk failure'); }
    return write(target, content);
  });
  await expect(engine.recipeUpgrades.apply(id, confirm(plan))).rejects.toMatchObject({ code: 'WRITE_FAILED', details: { recoveryRequired: false } });
  expect(await dependencyFiles(appRoot)).toEqual(original); expect(await storage.exists(file('app/account.tsx'))).toBeNull();
  await engine.recipeUpgrades.assertReady(id);
  expect((await engine.recipeUpgrades.preview(id)).state).toBe('ready');
});
it('retains recovery and a concurrent edit when rollback cannot restore every original file', async () => {
  await makeLegacyApp(appRoot); const plan = await engine.recipeUpgrades.preview(id), write = storage.atomicWrite;
  vi.spyOn(storage, 'atomicWrite').mockImplementation(async (target, content) => {
    if (target === file('src/backend/database.types.ts')) {
      await writeFile(file('src/backend/client.ts'), '// Concurrent edit during commit');
      throw new Error('Injected interruption');
    }
    return write(target, content);
  });
  await expect(engine.recipeUpgrades.apply(id, confirm(plan))).rejects.toMatchObject({ code: 'WRITE_FAILED', details: { recoveryRequired: true } });
  expect(await readFile(file('src/backend/client.ts'), 'utf8')).toBe('// Concurrent edit during commit');
  await expect(engine.recipeUpgrades.assertReady(id)).rejects.toThrow('interrupted recipe upgrade');
  expect((await engine.recipeUpgrades.preview(id)).state).toBe('conflict');
});
it('detects edits while stopping a preview and prevents a concurrent preview from starting during the commit', async () => {
  await makeLegacyApp(appRoot); const plan = await engine.recipeUpgrades.preview(id);
  vi.spyOn(engine.previews, 'stop').mockImplementationOnce(async () => {
    await expect(engine.previews.start(id)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    await writeFile(file('app/account.tsx'), '// External editor changed this');
    return { projectId: id, status: 'stopped' };
  });
  await expect(engine.recipeUpgrades.apply(id, confirm(plan))).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  expect(await dependencyProfile(await dependencyFiles(appRoot))).toBe('expo-legacy');
});
it('recovers a persisted interruption after restart and preserves edits made after the interruption', async () => {
  await makeLegacyApp(appRoot); const original = await dependencyFiles(appRoot), plan = await engine.recipeUpgrades.preview(id);
  const stat = await lstat(appRoot), journal = path.join(engine.projects.home, 'recipe-upgrades', `${id}.json`);
  await mkdir(path.dirname(journal), { recursive: true });
  await writeFile(journal, JSON.stringify({ version: 1, recipe: plan.recipe, identity: { id, root: appRoot, device: stat.dev, inode: stat.ino }, files: plan.files.map(({ path, before, after }) => ({ path, before, after })) }));
  for (const f of plan.files.slice(0, 2)) await writeFile(file(f.path), f.after!);
  await writeFile(file('src/backend/client.ts'), '// Edit after the crash');
  await engine.close(); engine = new Engine(await Projects.open(path.join(root, 'apps'), path.join(root, 'home')), true);
  await expect(engine.previews.start(id)).rejects.toThrow('interrupted recipe upgrade');
  const conflicted = await engine.recipeUpgrades.preview(id); expect(conflicted.state).toBe('conflict');
  await expect(engine.recipeUpgrades.apply(id, confirm(conflicted))).rejects.toThrow('conflicts');
  expect(await readFile(file('src/backend/client.ts'), 'utf8')).toBe('// Edit after the crash');
  await writeFile(file('src/backend/client.ts'), await readFile(path.join(templateRoot, 'src/backend/client.ts')));
  const recovery = await engine.recipeUpgrades.preview(id); expect(recovery).toMatchObject({ state: 'recovery', toProfile: 'expo-legacy' });
  expect(recovery.files).toHaveLength(2); expect(recovery.files.every(f => f.after === null)).toBe(true);
  expect(await engine.recipeUpgrades.apply(id, confirm(recovery))).toMatchObject({ recovered: true });
  expect(await storage.exists(journal)).toBeNull(); expect(await dependencyFiles(appRoot)).toEqual(original);
  expect((await engine.recipeUpgrades.preview(id)).state).toBe('ready');
});
