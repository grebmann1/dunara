import { afterEach, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { atomicWrite, readText, removeStateFile } from './storage.js';
import { PrivateSettingsStore } from './credentials.js';
import { flushHomeState, mountHomeState, type HomeStatePersistence } from './durable-state.js';

const roots: string[] = [], mounts: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of mounts.splice(0)) await close().catch(() => {}); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function home() { const value = await mkdtemp(path.join(os.tmpdir(), 'dunara-state-')); roots.push(value); return value; }
function remote() {
  const records = new Map<string, Uint8Array>(); let fail = false;
  const adapter: HomeStatePersistence = {
    async load() { return [...records].map(([key, content]) => ({ key, content: Uint8Array.from(content) })); },
    async write(input) { if (fail) throw Error('fixture database offline'); for (const { key, content } of input.records) { if (content === null) records.delete(key); else records.set(key, Uint8Array.from(content)); } },
  };
  return { adapter, records, fail() { fail = true; } };
}
it('restores committed history and explicit deletion into a fresh private cache', async () => {
  const store = remote(), first = await home(); mounts.push(await mountHomeState(first, store.adapter));
  await mkdir(path.join(first, 'assistant'), { mode: 0o700 });
  await atomicWrite(path.join(first, 'assistant', 'conversation.json'), '{"message":"saved"}');
  await atomicWrite(path.join(first, 'assistant', 'removed.json'), '{}');
  await removeStateFile(path.join(first, 'assistant', 'removed.json'));
  const second = await home(); mounts.push(await mountHomeState(second, store.adapter));
  expect(await readText(path.join(second, 'assistant', 'conversation.json'))).toBe('{"message":"saved"}');
  await expect(readFile(path.join(second, 'assistant', 'removed.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});
it('persists legacy synchronous settings only after the explicit service barrier', async () => {
  const store = remote(), root = await home(); mounts.push(await mountHomeState(root, store.adapter));
  const settings = new PrivateSettingsStore(root, 'fixture', z.object({ choice: z.string() }));
  settings.save({ choice: 'first' }); settings.save({ choice: 'last' });
  await flushHomeState(root);
  expect(JSON.parse(Buffer.from(store.records.get('credentials/fixture.json')!).toString())).toEqual({ choice: 'last' });
  settings.remove(); await flushHomeState(root); expect(store.records.size).toBe(0);
});
it('fences all state reads and mutations on storage failure but still unmounts', async () => {
  const store = remote(), root = await home(), close = await mountHomeState(root, store.adapter); mounts.push(close);
  await atomicWrite(path.join(root, 'saved.json'), 'previous');
  store.fail();
  await expect(atomicWrite(path.join(root, 'saved.json'), 'unacknowledged')).rejects.toThrow('could not be saved');
  await expect(readText(path.join(root, 'saved.json'))).rejects.toThrow('could not be saved');
  await expect(flushHomeState(root)).rejects.toThrow('could not be saved');
  await expect(close()).rejects.toThrow('could not be saved');
  expect(Buffer.from(store.records.get('saved.json')!).toString()).toBe('previous');
});
it('denies traversal, overlaps and restore over existing home files', async () => {
  const store = remote(), root = await home(); mounts.push(await mountHomeState(root, store.adapter));
  await expect(mountHomeState(root, store.adapter)).rejects.toThrow('already owned');
  const other = await home(); await atomicWrite(path.join(other, 'existing.json'), 'keep');
  await expect(mountHomeState(other, store.adapter)).rejects.toThrow('empty disposable cache');
  const empty = await home(); store.records.set('../escape', Buffer.from('bad'));
  await expect(mountHomeState(empty, store.adapter)).rejects.toThrow('Invalid home state');
});
