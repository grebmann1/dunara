import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { beforeEach, afterEach, expect, it } from 'vitest';
import { Engine } from './engine.js';
import { Projects } from './projects.js';
import { ProjectJourney } from './journey.js';

let root: string, engine: Engine, journey: ProjectJourney, id: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'dunara-journey-'));
  engine = new Engine(await Projects.open(path.join(root, 'apps'), path.join(root, 'home')), false);
  journey = new ProjectJourney(engine.projects, id => engine.boardCaptures.sourceRevision(id));
  id = (await engine.projects.create({ name: 'Journey', slug: 'journey' })).id;
});
afterEach(async () => { await engine.close(); await rm(root, { recursive: true, force: true }); });
it('persists a brief and progress across restart, navigation and project re-registration', async () => {
  const initial = await journey.read(id);
  expect(initial.saved).toBe(false);
  const first = await journey.update(id, { expectedRevision: initial.revision, patch: { brief: 'A place to share garden ideas.', idea: true } });
  const saved = await journey.update(id, { expectedRevision: first.revision, patch: { assetsLater: true } });
  expect(saved.preferences.brief).toBe(first.preferences.brief);
  await engine.studio.control({ expectedRevision: (await engine.studio.snapshot()).revision, action: { type: 'navigate', workspace: 'assets' } });
  expect(await journey.read(id)).toEqual(saved);
  const project = await engine.projects.get(id);
  const metadata = JSON.parse(await readFile(path.join(project.root, '.mobile-builder.json'), 'utf8'));
  expect(metadata.journey.brief).toBe('A place to share garden ideas.');
  await engine.close();
  engine = new Engine(await Projects.open(path.join(root, 'apps'), path.join(root, 'other-home')), false);
  await engine.projects.register(project.slug);
  journey = new ProjectJourney(engine.projects, id => engine.boardCaptures.sourceRevision(id));
  expect(await journey.read(id)).toEqual(saved);
});
it('keeps simultaneous progress changes conflict-aware and isolated by project', async () => {
  const other = await engine.projects.create({ name: 'Other', slug: 'other' });
  const initial = await journey.read(id);
  const results = await Promise.allSettled([true, false].map(idea => journey.update(id, { expectedRevision: initial.revision, patch: { idea, brief: 'Changed' } })));
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { code: 'REVISION_CONFLICT' } });
  expect((await journey.read(other.id)).saved).toBe(false);
  await expect(journey.update(id, { expectedRevision: initial.revision, patch: { brief: 'Overwrite' } })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  expect((await journey.read(id)).preferences.brief).toBe('Changed');
});
it('records tests only for the reviewed source and preserves stale evidence after source changes', async () => {
  const initial = await journey.read(id), sourceRevision = await engine.boardCaptures.sourceRevision(id);
  const tested = await journey.update(id, { expectedRevision: initial.revision, patch: { tested: true }, sourceRevision });
  expect(tested.preferences.testedSourceRevision).toBe(sourceRevision);
  expect(await engine.boardCaptures.sourceRevision(id)).toBe(sourceRevision);
  const source = await engine.files.read(id, 'app/index.tsx');
  await engine.files.write(id, [{ path: source.path, content: source.content + '\n// new screen revision\n', expectedRevision: source.revision }]);
  expect(await engine.boardCaptures.sourceRevision(id)).not.toBe(sourceRevision);
  expect((await journey.read(id)).preferences.testedSourceRevision).toBe(sourceRevision);
  await expect(journey.update(id, { expectedRevision: tested.revision, patch: { tested: true }, sourceRevision })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  await expect(journey.update(id, { expectedRevision: tested.revision, patch: { tested: true } })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  const cleared = await journey.update(id, { expectedRevision: tested.revision, patch: { tested: false } });
  expect(cleared.preferences.testedSourceRevision).toBeNull();
});
it('bounds progress content and keeps it outside generic source writes', async () => {
  const initial = await journey.read(id);
  await expect(journey.update(id, { expectedRevision: initial.revision, patch: { brief: 'a'.repeat(2001) } })).rejects.toThrow();
  await expect(journey.update(id, { expectedRevision: initial.revision, patch: { token: 'not supported' } })).rejects.toThrow();
  await expect(engine.files.read(id, '.mobile-builder.json')).rejects.toMatchObject({ code: 'INVALID_PATH' });
  expect(await journey.read(id)).toEqual(initial);
});
