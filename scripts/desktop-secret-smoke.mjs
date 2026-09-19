import { clearTimeout } from 'node:timers';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import electron from 'electron';
const root = await mkdtemp(path.join(os.tmpdir(), 'builder-os-secrets-'));
const main = path.join(root, 'main.cjs');
await writeFile(main, `
const { app, safeStorage } = require('electron');
app.setName('Mobile App Builder'); app.setPath('userData', ${JSON.stringify(path.join(root, 'electron'))});
app.whenReady().then(async () => {
  if (process.argv.at(-1) !== 'write') app.setName('Dunara');
  const { desktopSecretProtection } = await import(${JSON.stringify(pathToFileURL(path.resolve('dist/packages/desktop/src/secret-storage.js')).href)});
  const { sharedOpenAIStore } = await import(${JSON.stringify(pathToFileURL(path.resolve('dist/packages/core/src/credentials.js')).href)});
  const protection = desktopSecretProtection(${JSON.stringify(path.join(root, 'home'))}, safeStorage);
  if (!protection) throw new Error('OS protection unavailable');
  const store = sharedOpenAIStore(${JSON.stringify(path.join(root, 'home'))}, protection);
  if (process.argv.at(-1) === 'write') store.save('offline-os-protected-fixture');
  if (store.load() !== 'offline-os-protected-fixture') throw new Error('Roundtrip failed');
  console.log('BUILDER_OS_PROTECTION_PASS'); app.quit();
}).catch(() => { console.error('OS credential qualification failed or protection is unavailable.'); app.exit(1); });
`);
async function run(phase) {
  await new Promise((resolve, reject) => {
    const child = spawn(electron, [main, phase], { env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR }, stdio: ['ignore', 'pipe', 'pipe'] });
    let result = ''; child.stdout.on('data', bytes => { result += bytes.toString(); }); child.stderr.resume();
    const timer = setTimeout(() => child.kill('SIGKILL'), 25_000);
    child.once('error', reject); child.once('exit', code => { clearTimeout(timer); try { assert.equal(code, 0); assert.ok(result.includes('BUILDER_OS_PROTECTION_PASS')); resolve(); } catch { reject(new Error(`OS credential ${phase} qualification failed or timed out.`)); } });
  });
}
try { await run('write'); await run('read'); console.log('PASS: real Electron OS protection restores existing encrypted credentials after the Dunara rename.'); }
finally { await rm(root, { recursive: true, force: true }); }
