import { link, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { scaffoldPlugin } from '../../cli/src/plugin-commands.js';
import { inspectBundledPackage, inspectPackage, materializePackage } from './packages.js';

it('snapshots package-manager-linked defaults into independent files without accepting linked user plugins', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bundled-plugin-'));
  try {
    const source = path.join(root, 'source'), installed = path.join(root, 'installed');
    await scaffoldPlugin(source); await mkdir(installed);
    const file = path.join(source, 'user.md'), storeFile = path.join(root, 'pnpm-store.md');
    await link(file, storeFile);
    await expect(inspectPackage(source)).rejects.toThrow('hard links');
    const snapshot = await inspectBundledPackage(source);
    await writeFile(storeFile, 'Changed after snapshot');
    const directory = await materializePackage(installed, snapshot);
    expect(await readFile(path.join(directory, 'user.md'), 'utf8')).toBe(snapshot.files['user.md']);
    expect((await lstat(path.join(directory, 'user.md'))).nlink).toBe(1);
    expect((await inspectPackage(directory)).digest).toBe(snapshot.digest);
    await symlink(file, path.join(source, 'linked.md'));
    await expect(inspectBundledPackage(source)).rejects.toThrow('symlink');
  } finally { await rm(root, { recursive: true, force: true }); }
});
