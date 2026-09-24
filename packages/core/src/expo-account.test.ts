import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { expect, it } from 'vitest';
import { expoAccountStatus } from './expo-account.js';

it('checks only installed Expo and returns safe sign-in guidance without exposing CLI output', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'expo-account-'));
  try {
    expect((await expoAccountStatus(root)).state).toBe('not-installed');
    const cli = path.join(root, 'node_modules/expo/bin/cli'); await mkdir(path.dirname(cli), { recursive: true });
    await writeFile(cli, 'console.log("fixture-username")'); expect((await expoAccountStatus(root)).state).toBe('signed-in');
    await writeFile(cli, 'console.log("Not logged in")'); expect((await expoAccountStatus(root)).state).toBe('signed-out');
    await writeFile(cli, 'console.log("Not logged in"); process.exitCode=1'); expect((await expoAccountStatus(root)).state).toBe('signed-out');
    await writeFile(cli, 'console.error("PRIVATE_SENTINEL"); process.exitCode=1');
    expect(await expoAccountStatus(root)).toMatchObject({ state: 'unknown' });
    expect(JSON.stringify(await expoAccountStatus(root))).not.toContain('PRIVATE_SENTINEL');
  } finally { await rm(root, { recursive: true, force: true }); }
});
