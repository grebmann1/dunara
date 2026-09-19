import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { Projects } from './projects.js';
import { Files } from './files.js';
import { Designs } from './design.js';
import { Engine } from './engine.js';
let dir: string, projects: Projects, files: Files;
beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), 'builder-unit-')); projects = await Projects.open(path.join(dir, 'apps'), path.join(dir, 'home')); files = new Files(projects); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
it('creates portable projects and refuses an existing target', async () => {
  const app = await projects.create({ name: 'Garden', slug: 'garden' });
  expect((await projects.list())[0]?.id).toBe(app.id);
  expect((await files.read(app.id, 'app.json')).content).toContain('Garden');
  expect((await files.list(app.id)).files).toContain('app/progress.tsx');
  await expect(projects.create({ name: 'Garden', slug: 'garden' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
});
it('rejects traversal, secrets, dependency files, and symlinks', async () => {
  const app = await projects.create({ name: 'Garden', slug: 'garden' });
  for (const name of ['../home/projects.json', '/etc/passwd', '.env', 'node_modules/a.ts', 'credentials.json', 'app/../../x.ts']) await expect(files.read(app.id, name)).rejects.toMatchObject({ code: 'INVALID_PATH' });
  await symlink(path.join(dir, 'home'), path.join(app.root, 'escape'));
  await expect(files.read(app.id, 'escape/projects.json')).rejects.toMatchObject({ code: 'INVALID_PATH' });
  await symlink(path.join(app.root, 'app.json'), path.join(app.root, 'linked.json'));
  await expect(files.read(app.id, 'linked.json')).rejects.toMatchObject({ code: 'INVALID_PATH' });
});
it('prevalidates the entire batch and prevents stale writes', async () => {
  const app = await projects.create({ name: 'Garden', slug: 'garden' });
  const file = await files.read(app.id, 'app/index.tsx');
  await expect(files.write(app.id, [{ path: file.path, content: 'changed', expectedRevision: file.revision }, { path: 'app/habit.tsx', content: '', expectedRevision: null }])).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  expect((await files.read(app.id, file.path)).content).toBe(file.content);
  await files.write(app.id, [{ path: file.path, content: file.content + '\n', expectedRevision: file.revision }]);
  await expect(files.write(app.id, [{ path: file.path, content: '', expectedRevision: file.revision }])).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
});
it('updates tokens using revisions and surfaces invalid external edits', async () => {
  const app = await projects.create({ name: 'Garden', slug: 'garden' });
  const designs = new Designs(files), design = await designs.read(app.id);
  const next = await designs.apply(app.id, { expectedRevision: design.revision, mode: 'dark' });
  expect(next.tokens.background).not.toBe(design.tokens.background);
  await expect(designs.apply(app.id, { expectedRevision: design.revision, preset: 'clay' })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  await writeFile(path.join(app.root, 'src/theme/design.json'), '{}');
  await expect(designs.read(app.id)).rejects.toThrow();
});
it('rejects root replacement after registration and oversized files', async () => {
  const app = await projects.create({ name: 'Garden', slug: 'garden' });
  await writeFile(path.join(app.root, 'big.txt'), 'a'.repeat(256_001));
  await expect(files.read(app.id, 'big.txt')).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
  await rm(app.root, { recursive: true }); await mkdir(path.join(dir, 'outside'));
  await symlink(path.join(dir, 'outside'), app.root);
  await expect(projects.get(app.id)).rejects.toMatchObject({ code: 'INVALID_PATH' });
});
it('persists registry source and design but not runtime state across Engine restart', async () => {
  const first = new Engine(projects, false);
  const app = await projects.create({ name: 'Persistent', slug: 'persistent' });
  const source = await first.files.read(app.id, 'app/index.tsx');
  await first.files.write(app.id, [{ path: source.path, content: source.content + '\n// persisted\n', expectedRevision: source.revision }]);
  const design = await first.designs.apply(app.id, { expectedRevision: (await first.designs.read(app.id)).revision, preset: 'clay' });
  first.diagnostics.add(app.id, 'preview', 'error', 'Runtime only');
  await first.close();
  const second = new Engine(await Projects.open(projects.workspace, projects.home), false);
  try {
    expect(await second.projects.get(app.id)).toEqual(app);
    expect((await second.files.read(app.id, source.path)).content).toContain('// persisted');
    expect(await second.designs.read(app.id)).toEqual(design);
    expect(second.previews.status(app.id).status).toBe('stopped');
    expect(second.captures.list(app.id)).toEqual([]);
    expect(second.diagnostics.read(app.id).entries).toEqual([]);
  } finally { await second.close(); }
});
it('reports missing roots and malformed registry or design without deleting records', async () => {
  const app = await projects.create({ name: 'Missing', slug: 'missing' });
  const registry = path.join(projects.home, 'projects.json');
  const original = await readFile(registry, 'utf8');
  await rm(path.join(app.root, 'src/theme/design.json'));
  await expect(new Designs(files).read(app.id)).rejects.toThrow();
  expect(await projects.get(app.id)).toEqual(app);
  await rm(app.root, { recursive: true });
  await expect(projects.list()).rejects.toThrow();
  expect(await readFile(registry, 'utf8')).toBe(original);
  await writeFile(registry, '{broken');
  await expect(projects.list()).rejects.toThrow();
  await expect(projects.create({ name: 'New', slug: 'new' })).rejects.toThrow();
  expect(await readFile(registry, 'utf8')).toBe('{broken');
});
it('serializes racing writers and rejects binary content', async () => {
  const app = await projects.create({ name: 'Garden', slug: 'garden' });
  const file = await files.read(app.id, 'app/index.tsx');
  const results = await Promise.allSettled(['first', 'second'].map(text => files.write(app.id, [{ path: file.path, content: text, expectedRevision: file.revision }])));
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  expect(results.find(r => r.status === 'rejected')).toMatchObject({ reason: { code: 'REVISION_CONFLICT' } });
  await writeFile(path.join(app.root, 'binary.txt'), Buffer.from([0, 1, 2]));
  await expect(files.read(app.id, 'binary.txt')).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
});
