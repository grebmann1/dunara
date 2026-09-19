import { randomUUID } from 'node:crypto';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { ASSISTANT_LIMITS, type Conversation } from './contracts.js';
import { AssistantStore } from './store.js';

const roots: string[] = [];
async function home() { const root = await mkdtemp(path.join(os.tmpdir(), 'assistant-store-')); roots.push(root); return root; }
function conversation(projectId: string | null = null): Conversation {
  const now = new Date().toISOString();
  return { version: 1, id: randomUUID(), projectId, title: 'Local history', createdAt: now, updatedAt: now, turns: [] };
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
it('writes private atomic project-keyed history and deletes only the named conversation', async () => {
  const root = await home(); const store = await AssistantStore.open(root);
  const first = conversation(), second = conversation(randomUUID());
  await store.create(first); await store.create(second);
  expect((await lstat(store.directory)).mode & 0o777).toBe(0o700);
  expect((await lstat(path.join(store.directory, `${first.id}.json`))).mode & 0o777).toBe(0o600);
  expect(await store.list(null)).toEqual([first]); expect(await store.read(second.id)).toEqual(second);
  await expect(store.create(first)).rejects.toThrow('already exists');
  await expect(store.read('../escape')).rejects.toThrow();
  await store.remove(first.id); expect(await store.list(null)).toEqual([]);
  expect(await readdir(store.directory)).toEqual([`${second.id}.json`]);
});
it('marks unfinished turns interrupted after restart without replaying and removes safe atomic remnants', async () => {
  const root = await home(); const store = await AssistantStore.open(root); const record = conversation();
  record.turns.push({ id: randomUUID(), epoch: randomUUID(), state: 'running', prompt: 'Build', response: 'Partial', startedAt: record.createdAt, tools: [] });
  await store.create(record);
  await writeFile(path.join(store.directory, `.builder-${randomUUID()}.tmp`), 'incomplete', { mode: 0o600 });
  const reopened = await AssistantStore.open(root); const restored = await reopened.read(record.id);
  expect(restored.turns[0]).toMatchObject({ state: 'interrupted', response: 'Partial' });
  expect(restored.turns[0]?.notice).toContain('no prompt was resubmitted');
  expect(await readdir(store.directory)).toEqual([`${record.id}.json`]);
  expect(await reopened.hasRun(record.turns[0]!.id)).toBe(true);
});
it('enforces project counts, byte quotas and response reservations without deleting existing history', async () => {
  const root = await home(); const store = await AssistantStore.open(root, { ...ASSISTANT_LIMITS, conversationBytes: 1000, totalBytes: 1200, conversationsPerProject: 2 });
  const first = conversation(), second = conversation(); await store.create(first); await store.create(second);
  await expect(store.create(conversation())).rejects.toThrow('Too many conversations');
  await expect(store.save(first, 1000)).rejects.toThrow('history is full');
  expect(await store.read(first.id)).toEqual(first);
  await store.create(conversation(randomUUID()));
  await expect(store.save(first, 700)).rejects.toThrow('history is full');
  await store.remove(second.id); expect((await store.list(null)).length).toBe(1);
});
it.each(['directory', 'symlink', 'hardlink', 'public-file', 'identity', 'unknown'])('rejects unsafe history: %s', async attack => {
  const root = await home(); const store = await AssistantStore.open(root); const record = conversation(); await store.create(record);
  const filename = path.join(store.directory, `${record.id}.json`);
  if (attack === 'directory') await chmod(store.directory, 0o755);
  if (attack === 'symlink') { await rm(filename); await symlink(path.join(root, 'outside'), filename); }
  if (attack === 'hardlink') await link(filename, path.join(root, 'outside'));
  if (attack === 'public-file') await chmod(filename, 0o644);
  if (attack === 'identity') await writeFile(filename, JSON.stringify({ ...record, id: randomUUID() }));
  if (attack === 'unknown') await writeFile(path.join(store.directory, 'credentials.json'), '{}', { mode: 0o600 });
  await expect(AssistantStore.open(root)).rejects.toThrow();
});
it('rejects symlinked history roots and schema fields that could persist credentials or raw protocol', async () => {
  const root = await home(); await mkdir(path.join(root, 'outside')); await symlink(path.join(root, 'outside'), path.join(root, 'assistant'));
  await expect(AssistantStore.open(root)).rejects.toThrow('Symlinks');
  await rm(path.join(root, 'assistant')); const store = await AssistantStore.open(root); const record = conversation();
  await expect(store.create({ ...record, apiKey: 'sentinel' } as Conversation)).rejects.toThrow();
  await store.create(record);
  expect(await readFile(path.join(store.directory, `${record.id}.json`), 'utf8')).not.toContain('sentinel');
});
