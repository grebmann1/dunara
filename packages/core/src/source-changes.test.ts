import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm, rename, cp, symlink, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { beforeEach, afterEach, expect, it } from 'vitest';
import { Engine } from './engine.js';
import { Projects } from './projects.js';
import { SourceChanges, type ChangeScope } from './source-changes.js';
import { revision } from './files.js';

let root: string, app: string, engine: Engine, changes: SourceChanges, scope: ChangeScope, token: string, controller: AbortController;
const original = 'export const title = "Original";\n', edited = 'export const title = "A new beginning";\n';
const guard = async () => {};
const write = (name: string, content: string, before: string | null) => engine.files.write(scope.projectId, [{ path: name, content, expectedRevision: before === null ? null : revision(before) }]);
const tracked = (name: string, content: string, before: string | null) => changes.withToken(token, () => write(name, content, before));
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'dunara-source-changes-'));
  engine = new Engine(await Projects.open(path.join(root, 'apps'), path.join(root, 'home')), false);
  const project = await engine.projects.create({ name: 'Recovery', slug: 'recovery' }); app = project.root;
  scope = { projectId: project.id, conversationId: randomUUID(), runId: randomUUID() };
  changes = engine.sourceChanges; controller = new AbortController(); token = changes.begin(scope, controller.signal);
  await write('app/recovery.ts', original, null);
});
afterEach(async () => { await engine.close(); await rm(root, { recursive: true, force: true }); });

it('attributes only managed turn writes, combines repeated edits and restores modified and added files', async () => {
  await tracked('app/recovery.ts', edited, original);
  await tracked('app/recovery.ts', edited + '// second pass\n', edited);
  await tracked('src/new.ts', 'export const newValue = true;', null);
  await write('src/manual.ts', 'unrelated manual work', null);
  expect((await changes.inspect(scope)).canRestore).toBe(false);
  await changes.finish(token);
  const review = await changes.inspect(scope);
  expect(review).toMatchObject({ state: 'ready', canRestore: true, conflicts: [] });
  expect(review.changes.map(file => file.path)).toEqual(['app/recovery.ts', 'src/new.ts']);
  expect(await changes.diff(scope, 'app/recovery.ts')).toEqual({ path: 'app/recovery.ts', before: original, after: edited + '// second pass\n' });
  expect((await stat(path.join(root, 'home', 'source-changes', `${scope.runId}.json`))).mode & 0o077).toBe(0);
  expect(await changes.restore(scope, review.revision, guard)).toMatchObject({ state: 'restored', canRestore: false });
  expect(await readFile(path.join(app, 'app/recovery.ts'), 'utf8')).toBe(original);
  await expect(readFile(path.join(app, 'src/new.ts'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(path.join(app, 'src/manual.ts'), 'utf8')).toBe('unrelated manual work');
  await expect(changes.restore(scope, review.revision, guard)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
});

it('prevalidates every restore path and protects newer edits even with an old review', async () => {
  await tracked('app/recovery.ts', edited, original); await tracked('src/new.ts', 'new', null); await changes.finish(token);
  const reviewed = await changes.inspect(scope);
  await write('src/new.ts', 'manual correction', 'new');
  await expect(changes.restore(scope, reviewed.revision, guard)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  expect(await readFile(path.join(app, 'app/recovery.ts'), 'utf8')).toBe(edited);
  expect(await changes.inspect(scope)).toMatchObject({ canRestore: false, conflicts: ['src/new.ts'] });
  expect(await readFile(path.join(app, 'src/new.ts'), 'utf8')).toBe('manual correction');
});

it('refuses to absorb a manual edit during a turn even if the Assistant reads its revision', async () => {
  await tracked('app/recovery.ts', edited, original);
  await write('app/recovery.ts', 'manual', edited);
  await expect(tracked('app/recovery.ts', 'overwritten', 'manual')).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  await changes.finish(token);
  expect(await changes.diff(scope, 'app/recovery.ts')).toMatchObject({ before: original, after: edited });
  expect((await changes.inspect(scope)).canRestore).toBe(false);
});

it('prevalidates a write batch before recording it and does not create empty recovery work', async () => {
  await expect(changes.withToken(token, () => engine.files.write(scope.projectId, [
    { path: 'src/new.ts', content: 'new', expectedRevision: null },
    { path: 'app/recovery.ts', content: edited, expectedRevision: null },
  ]))).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  await changes.finish(token);
  expect(await changes.inspect(scope)).toMatchObject({ state: 'none', changes: [], canRestore: false });
});

it('resumes an interrupted restore explicitly and never automatically replays it at restart', async () => {
  await tracked('app/recovery.ts', edited, original); await tracked('src/new.ts', 'new', null); await changes.finish(token);
  const review = await changes.inspect(scope); let guards = 0;
  await expect(changes.restore(scope, review.revision, async () => { if (++guards === 4) throw new Error('lost session'); })).rejects.toMatchObject({ code: 'WRITE_FAILED' });
  changes = new SourceChanges(engine.files);
  const retry = await changes.inspect(scope);
  expect(retry).toMatchObject({ state: 'restoring', canRestore: true });
  expect(await readFile(path.join(app, 'app/recovery.ts'), 'utf8')).toBe(original);
  expect(await readFile(path.join(app, 'src/new.ts'), 'utf8')).toBe('new');
  await changes.restore(scope, retry.revision, guard);
  await expect(readFile(path.join(app, 'src/new.ts'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it.each(['applied', 'unapplied', 'ambiguous'] as const)('reconciles a durable %s write intent after process interruption', async state => {
  await changes.withToken(token, () => engine.projects.mutations.run(() => changes.prepare(scope.projectId, [{ path: 'app/recovery.ts', before: original, after: edited }])));
  if (state !== 'unapplied') await writeFile(path.join(app, 'app/recovery.ts'), state === 'applied' ? edited : 'external');
  changes = new SourceChanges(engine.files);
  const recovered = await changes.inspect(scope);
  expect(recovered.state).toBe('ready'); expect(recovered.canRestore).toBe(state === 'applied');
  expect(recovered.conflicts).toEqual(state === 'ambiguous' ? ['app/recovery.ts'] : []);
  expect(recovered.changes).toHaveLength(state === 'unapplied' ? 0 : 1);
  if (state === 'ambiguous') expect(await changes.diff(scope, 'app/recovery.ts')).toMatchObject({ uncertain: true });
});

it('drains in-flight calls and denies writes after cancellation or finalization', async () => {
  await tracked('app/recovery.ts', edited, original);
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const late = changes.withToken(token, async () => { await waiting; return write('src/late.ts', 'late', null); });
  const failed = expect(late).rejects.toThrow();
  controller.abort(); const finished = changes.finish(token); release(); await failed; await finished;
  await expect(readFile(path.join(app, 'src/late.ts'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await changes.inspect(scope)).canRestore).toBe(true);
  await expect(changes.withToken(token, async () => {})).rejects.toThrow('ended');
});

it('refuses a different project, conversation or replaced root and symlinked restore target', async () => {
  await tracked('app/recovery.ts', edited, original); await changes.finish(token);
  await expect(changes.inspect({ ...scope, conversationId: randomUUID() })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await expect(changes.inspect({ ...scope, projectId: randomUUID() })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await rm(path.join(app, 'app/recovery.ts')); await symlink(path.join(app, 'app/index.tsx'), path.join(app, 'app/recovery.ts'));
  expect(await changes.inspect(scope)).toMatchObject({ canRestore: false, conflicts: ['app/recovery.ts'] });
  await rename(app, `${app}-old`); await cp(`${app}-old`, app, { recursive: true });
  await expect(changes.inspect(scope)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
});

it('refuses unrecordable edits before touching source and removes only the chosen conversation history', async () => {
  const small = new SourceChanges(engine.files, { turnBytes: 200, totalBytes: 200, records: 1 });
  engine.files.journal = small;
  const smallToken = small.begin(scope, controller.signal);
  await expect(small.withToken(smallToken, () => write('app/recovery.ts', edited, original))).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
  expect(await readFile(path.join(app, 'app/recovery.ts'), 'utf8')).toBe(original);
  engine.files.journal = changes;
  await tracked('app/recovery.ts', edited, original);
  await expect(changes.removeConversation(scope.conversationId)).rejects.toThrow('active turn');
  await changes.finish(token);
  await changes.removeConversation(randomUUID()); expect((await changes.inspect(scope)).changes).toHaveLength(1);
  await changes.removeConversation(scope.conversationId); expect((await changes.inspect(scope)).state).toBe('none');
  expect(await readFile(path.join(app, 'app/recovery.ts'), 'utf8')).toBe(edited);
});
