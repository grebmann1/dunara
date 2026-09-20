import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Projects } from './projects.js';
import { Files } from './files.js';
import type { ProjectWorkspaceHead, ProjectWorkspacePersistence } from './durable-projects.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
function remote() {
  let head: ProjectWorkspaceHead | null = null;
  let fail: 'before' | 'after' | undefined;
  const store: ProjectWorkspacePersistence = {
    async load() { return structuredClone(head); },
    async commit(input) {
      if (fail === 'before') throw Error('Storage unavailable');
      if ((head?.revision ?? null) !== input.expectedRevision) throw Error('Revision conflict');
      head = { revision: String(Number(head?.revision ?? 0) + 1), snapshot: structuredClone(input.snapshot) };
      if (fail === 'after') throw Error('Response lost');
      return { revision: head.revision };
    },
  };
  return { store, setFailure(value: typeof fail) { fail = value; } };
}
async function open(store: ProjectWorkspacePersistence) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dunara-durability-')); roots.push(root);
  const projects = await Projects.open(path.join(root, 'apps'), path.join(root, 'home'), store);
  return { root, projects, files: new Files(projects) };
}

describe('durable project workspaces', () => {
  it('reconstructs identity, metadata, source and binary assets from an empty cache', async () => {
    const { store } = remote(); const first = await open(store);
    const project = await first.projects.create({ name: 'Saved App', slug: 'saved-app' });
    await first.files.write(project.id, [{ path: 'src/saved.ts', content: 'export const saved = true;', expectedRevision: null }]);
    await first.projects.mutations.run(async () => { await mkdir(path.join(project.root, 'assets')); await writeFile(path.join(project.root, 'assets', 'proof.png'), Buffer.from([1, 2, 3, 255])); });
    await rm(first.root, { recursive: true });
    const second = await open(store); const restored = await second.projects.get(project.id);
    expect(restored.id).toBe(project.id); expect(restored.root).not.toBe(project.root);
    expect((await second.files.read(project.id, 'src/saved.ts')).content).toBe('export const saved = true;');
    expect(await readFile(path.join(restored.root, 'assets', 'proof.png'))).toEqual(Buffer.from([1, 2, 3, 255]));
    expect((await second.projects.metadata(restored)).project.id).toBe(project.id);
  });

  it.each(['before', 'after'] as const)('fences uncertain caches when a commit fails %s persistence', async failure => {
    const remoteStore = remote(); const first = await open(remoteStore.store);
    const project = await first.projects.create({ name: 'Saved App', slug: 'saved-app' });
    remoteStore.setFailure(failure);
    await expect(first.files.write(project.id, [{ path: 'src/change.ts', content: 'new value', expectedRevision: null }])).rejects.toThrow();
    await expect(first.files.read(project.id, 'src/change.ts')).rejects.toThrow('Reopen the workspace');
    remoteStore.setFailure(undefined);
    const second = await open(remoteStore.store);
    if (failure === 'after') expect((await second.files.read(project.id, 'src/change.ts')).content).toBe('new value');
    else expect((await second.files.list(project.id)).files).not.toContain('src/change.ts');
  });

  it('rejects stale concurrent owners without overwriting the winning revision', async () => {
    const { store } = remote(); const first = await open(store);
    const project = await first.projects.create({ name: 'Saved App', slug: 'saved-app' });
    const stale = await open(store);
    await first.files.write(project.id, [{ path: 'src/winner.ts', content: 'first', expectedRevision: null }]);
    await expect(stale.files.write(project.id, [{ path: 'src/loser.ts', content: 'second', expectedRevision: null }])).rejects.toThrow('Revision conflict');
    const restored = await open(store);
    expect((await restored.files.list(project.id)).files).toContain('src/winner.ts');
    expect((await restored.files.list(project.id)).files).not.toContain('src/loser.ts');
  });

  it('does not acknowledge mutations or expose their files before the commit finishes', async () => {
    const { store } = remote(); const first = await open(store);
    const project = await first.projects.create({ name: 'Saved App', slug: 'saved-app' });
    const commit = store.commit;
    let release!: () => void, entered!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    store.commit = async input => { entered(); await gate; return commit(input); };
    let acknowledged = false, read = false;
    const mutation = first.files.write(project.id, [{ path: 'src/pending.ts', content: 'pending', expectedRevision: null }]).then(() => { acknowledged = true; });
    await waiting;
    const reading = first.files.read(project.id, 'src/pending.ts').then(() => { read = true; });
    await new Promise(resolve => setImmediate(resolve));
    expect(acknowledged).toBe(false); expect(read).toBe(false);
    release(); await Promise.all([mutation, reading]); expect(read).toBe(true);
  });

  it('rejects poisoned remote paths before hydration and refuses existing local data', async () => {
    const { store } = remote(); const first = await open(store);
    await first.projects.create({ name: 'Saved App', slug: 'saved-app' });
    await expect(Projects.open(path.join(first.root, 'apps'), path.join(first.root, 'home'), store)).rejects.toThrow('empty cache');
    const head = (await store.load())!;
    head.snapshot.projects[0]!.files.push({ path: '../escape.ts', content: Buffer.from('bad') });
    const malicious = { ...store, async load() { return head; } };
    await expect(open(malicious)).rejects.toThrow('Invalid durable project file');
    expect(await readdir(path.join(roots.at(-1)!, 'apps'))).toEqual([]);
  });
});
