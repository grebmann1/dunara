import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Engine } from './engine.js';
import { Projects } from './projects.js';
import { revision } from './files.js';

let dir: string, engine: Engine, projectId: string;
const png = Buffer.from('fixture-png');
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'board-captures-'));
  engine = new Engine(await Projects.open(path.join(dir, 'apps'), path.join(dir, 'home')), false);
  projectId = (await engine.projects.create({ name: 'Screens', slug: 'screens' })).id;
  vi.spyOn(engine.captures, 'capture').mockImplementation(async (id, route, viewport) => ({ meta: { id: randomUUID(), projectId: id, route, viewport, width: 375, height: 812, createdAt: new Date().toISOString(), rendering: 'React Native Web', bytes: png.length }, png }));
});
afterEach(async () => { await engine.close(); await rm(dir, { recursive: true, force: true }); });
it('invalidates saved screens when the selected backend changes, including during capture', async () => {
  let configuration = revision('development');
  vi.spyOn(engine.previews, 'configurationRevision').mockImplementation(async () => configuration);
  const first = await engine.boardCaptures.capture(projectId, '/');
  expect(first).toMatchObject({ stale: false, configurationRevision: configuration });
  configuration = revision('production');
  expect((await engine.boardCaptures.list(projectId))[0]).toMatchObject({ id: first.id, stale: true });
  const original = vi.mocked(engine.captures.capture).getMockImplementation()!;
  vi.mocked(engine.captures.capture).mockImplementationOnce(async (...args) => {
    configuration = revision('staging');
    return original(...args);
  });
  expect(await engine.boardCaptures.capture(projectId, '/')).toMatchObject({ stale: true, changedDuringCapture: true });
  expect(await engine.boardCaptures.capture(projectId, '/')).toMatchObject({ stale: false });
});
it('retains captures across restarts, flags external source edits and keeps the previous image after failure', async () => {
  const first = await engine.boardCaptures.capture(projectId, '/');
  expect(first.stale).toBe(false);
  expect(await engine.boardCaptures.get(projectId, first.id)).toEqual(png);
  const file = await engine.files.resolve(projectId, 'app/index.tsx');
  await writeFile(file, 'export default function Updated() { return null; }');
  expect((await engine.boardCaptures.list(projectId))[0]?.stale).toBe(true);
  vi.mocked(engine.captures.capture).mockRejectedValueOnce(new Error('Preview unavailable'));
  await expect(engine.boardCaptures.capture(projectId, '/')).rejects.toThrow('Preview unavailable');
  expect(await engine.boardCaptures.get(projectId, first.id)).toEqual(png);
  await engine.close(); engine = new Engine(await Projects.open(engine.projects.workspace, engine.projects.home), false);
  expect((await engine.boardCaptures.list(projectId))[0]).toMatchObject({ id: first.id, stale: true });
  expect(await engine.boardCaptures.get(projectId, first.id)).toEqual(png);
});
it('replaces a route, isolates projects and refuses symlinked storage or unsafe routes', async () => {
  const first = await engine.boardCaptures.capture(projectId, '/');
  const second = await engine.boardCaptures.capture(projectId, '/');
  expect(await engine.boardCaptures.list(projectId)).toHaveLength(1);
  await expect(engine.boardCaptures.get(projectId, first.id)).rejects.toThrow('replaced');
  expect(await engine.boardCaptures.get(projectId, second.id)).toEqual(png);
  const other = await engine.projects.create({ name: 'Other', slug: 'other' });
  await expect(engine.boardCaptures.get(other.id, second.id)).rejects.toThrow();
  await expect(engine.boardCaptures.capture(projectId, 'https://example.test/')).rejects.toThrow();
  const directory = path.join(engine.projects.home, 'preview-board', projectId);
  await rm(directory, { recursive: true }); await symlink(dir, directory);
  await expect(engine.boardCaptures.list(projectId)).rejects.toThrow('Symlinks');
});
it('marks a capture stale when source changes during rendering and bounds the retained board', async () => {
  const original = engine.captures.capture;
  vi.mocked(original).mockImplementationOnce(async (id, route, viewport) => {
    await writeFile(await engine.files.resolve(id, 'app/index.tsx'), '// changed during capture');
    return { meta: { id: randomUUID(), projectId: id, route, viewport, width: 375, height: 812, createdAt: new Date().toISOString(), rendering: 'React Native Web', bytes: png.length }, png };
  });
  expect(await engine.boardCaptures.capture(projectId, '/')).toMatchObject({ stale: true, changedDuringCapture: true });
  for (let index = 0; index < 25; index++) await engine.boardCaptures.capture(projectId, `/screen-${index}`);
  expect(await engine.boardCaptures.list(projectId)).toHaveLength(24);
});
