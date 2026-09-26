import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { Projects } from './projects.js';
import { Previews } from './preview.js';
import { Diagnostics } from './diagnostics.js';
import { Processes, freePort } from './processes.js';
import { revision } from './files.js';
import { makeLegacyApp } from '../../../tests/fixtures/legacy-app.js';
import { dependencyFiles, dependencyProfiles } from './dependency-profiles.js';
import { nativeAuthDependencies } from '../../../tests/fixtures/native-auth-app.js';
let dir: string, projects: Projects;
beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), 'builder-preview-')); projects = await Projects.open(path.join(dir, 'apps'), path.join(dir, 'home')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
it('requires local execution trust', async () => {
  const p = new Previews(projects, new Diagnostics(), false);
  await expect(p.start('anything')).rejects.toMatchObject({ code: 'TRUST_REQUIRED' });
});
it('rejects changed manifests before executing code', async () => {
  const app = await projects.create({ name: 'Demo', slug: 'demo' });
  await writeFile(path.join(app.root, 'package.json'), JSON.stringify({ scripts: { start: 'touch owned' } }));
  const p = new Previews(projects, new Diagnostics(), true);
  await expect(p.start(app.id)).rejects.toMatchObject({ code: 'DEPENDENCIES_CHANGED' });
  expect(p.status(app.id).status).toBe('failed'); await p.close();
});
it('bounds diagnostic history and line size', () => {
  const d = new Diagnostics();
  for (let i = 0; i < 110; i++) d.add('p', 'preview', 'info', 'x'.repeat(5000));
  expect(d.read('p').entries).toHaveLength(100); expect(d.read('p').entries[0]?.message.length).toBe(4000); expect(d.read('p').truncated).toBe(true);
});
it('allocates a port and shuts down only owned children', async () => {
  expect(await freePort()).toBeGreaterThan(0);
  const owned = new Processes(), unrelated = new Processes();
  const child = owned.spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], dir, () => {});
  const other = unrelated.spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], dir, () => {});
  try { await owned.close(); expect(child.signalCode).not.toBe(null); expect(other.signalCode).toBe(null); } finally { await unrelated.close(); }
});
it('surfaces failed installs and cancellation', async () => {
  const p = new Processes();
  await expect(p.run(process.execPath, ['-e', 'process.exit(2)'], dir, () => {})).rejects.toMatchObject({ code: 'PROCESS_FAILED' });
  const controller = new AbortController();
  const pending = p.run(process.execPath, ['-e', 'setInterval(()=>{},1000)'], dir, () => {}, controller.signal);
  controller.abort();
  await expect(pending).rejects.toThrow(); await p.close();
});
it('keeps occupied ports untouched and allocates a different port', async () => {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP address');
    expect(await freePort()).not.toBe(address.port);
    expect(server.listening).toBe(true);
  } finally { server.close(); await once(server, 'close'); }
});
it('enables Metro watching even when the harness runs in CI', async () => {
  vi.stubEnv('CI', '1'); const p = new Processes(); const output: string[] = [];
  try { await p.run(process.execPath, ['-e', 'console.log(process.env.CI)'], dir, line => output.push(line)); expect(output.join('').trim()).toBe('0'); }
  finally { vi.unstubAllEnvs(); await p.close(); }
});
it('allows Expo account lookup only for an explicitly online preview without forwarding provider tokens', async () => {
  vi.stubEnv('EXPO_TOKEN', 'private-expo-canary'); vi.stubEnv('OPENAI_API_KEY', 'private-provider-canary');
  const processes = new Processes();
  try {
    for (const expoOnline of [false, true]) {
      const output: string[] = [];
      const child = processes.spawn(process.execPath, ['-e', 'console.log(JSON.stringify({offline:process.env.EXPO_OFFLINE,expoToken:process.env.EXPO_TOKEN,providerToken:process.env.OPENAI_API_KEY}))'], dir, line => output.push(line), {}, { expoOnline });
      await once(child, 'exit');
      expect(JSON.parse(output.join(''))).toEqual({ offline: expoOnline ? '0' : '1' });
    }
  } finally { vi.unstubAllEnvs(); await processes.close(); }
});
it('coalesces duplicate starts and stops a pending dependency install before retry', async () => {
  const app = await projects.create({ name: 'Lifecycle', slug: 'lifecycle' });
  const p = new Previews(projects, new Diagnostics(), true);
  const install = vi.spyOn(p.processes, 'run').mockImplementation(async (_command, _args, _cwd, _log, signal) => {
    await new Promise<void>((_resolve, reject) => {
      signal?.throwIfAborted(); signal?.addEventListener('abort', () => reject(new Error('Install cancelled')), { once: true });
    });
  });
  try {
    const first = p.start(app.id).catch(error => error);
    await vi.waitFor(() => expect(install).toHaveBeenCalledOnce());
    const second = p.start(app.id).catch(error => error);
    await p.stop(app.id);
    expect(await first).toBeInstanceOf(Error); expect(await second).toBeInstanceOf(Error);
    expect(install).toHaveBeenCalledOnce(); expect(p.status(app.id).status).toBe('stopped');
    install.mockRejectedValueOnce(new Error('Injected install failure'));
    await expect(p.start(app.id)).rejects.toThrow('Injected install failure');
    expect(p.status(app.id).status).toBe('failed');
    expect(p.diagnostics.read(app.id).entries.some(e => e.message.includes('Injected install failure'))).toBe(true);
    await p.stop(app.id); expect(p.status(app.id).status).toBe('stopped');
  } finally { await p.close(); install.mockRestore(); }
});
it('joins an existing startup before asynchronous project lookup can race with stop', async () => {
  const app = await projects.create({ name: 'Lifecycle', slug: 'lifecycle' });
  const p = new Previews(projects, new Diagnostics(), true);
  const install = vi.spyOn(p.processes, 'run').mockRejectedValue(new Error('Unexpected second install'));
  install.mockImplementationOnce(async (_command, _args, _cwd, _log, signal) => {
    await new Promise<void>((_resolve, reject) => {
      signal?.throwIfAborted(); signal?.addEventListener('abort', () => reject(new Error('Install cancelled')), { once: true });
    });
  });
  const get = projects.get.bind(projects);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let lookup: ReturnType<typeof vi.spyOn> | undefined;
  try {
    const first = p.start(app.id).catch(error => error);
    await vi.waitFor(() => expect(install).toHaveBeenCalledOnce());
    lookup = vi.spyOn(projects, 'get').mockImplementationOnce(async id => { await gate; return get(id); });
    const second = p.start(app.id).catch(error => error);
    // Stop must not depend on the deliberately delayed duplicate-start lookup.
    lookup.mockRestore();
    await p.stop(app.id);
    release();
    expect(await second).toBe(await first);
    expect(install).toHaveBeenCalledOnce();
    expect(p.status(app.id).status).toBe('stopped');
  } finally { release(); lookup?.mockRestore(); await p.close(); install.mockRestore(); }
});
it('recovers from startup failure and unexpected owned-child exit without reinstalling', async () => {
  const app = await projects.create({ name: 'Lifecycle', slug: 'lifecycle' });
  const p = new Previews(projects, new Diagnostics(), true);
  const cli = path.join(app.root, 'node_modules/expo/bin/cli');
  await mkdir(path.dirname(cli), { recursive: true });
  await writeFile(cli, 'process.exit(2);');
  await writeFile(path.join(app.root, 'node_modules/.builder-dependencies'), revision(await readFile(path.join(app.root, 'package-lock.json'), 'utf8')));
  const install = vi.spyOn(p.processes, 'run'), spawn = vi.spyOn(p.processes, 'spawn');
  try {
    await expect(p.start(app.id)).rejects.toMatchObject({ code: 'PROCESS_FAILED' });
    await writeFile(cli, "require('node:http').createServer((req,res)=>res.end('ready')).listen(Number(process.argv.at(-1)));");
    const ready = await p.start(app.id);
    expect(ready.status).toBe('ready'); expect(install).not.toHaveBeenCalled();
    expect((await p.start(app.id)).url).toBe(ready.url);
    const child = spawn.mock.results.at(-1)!.value;
    await p.processes.stop(child);
    await vi.waitFor(() => expect(p.status(app.id).status).toBe('failed'));
    expect((await p.start(app.id)).status).toBe('ready');
    await p.close(); expect(p.status(app.id).status).toBe('stopped');
    await expect(p.start(app.id)).rejects.toMatchObject({ code: 'PROCESS_FAILED' });
  } finally { await p.close(); install.mockRestore(); spawn.mockRestore(); }
}, 15_000);
it('rejects changed dependency locks before installing', async () => {
  const app = await projects.create({ name: 'Lock', slug: 'lock' });
  await writeFile(path.join(app.root, 'package-lock.json'), JSON.stringify({ name: app.slug, packages: { '': { name: app.slug } } }));
  const p = new Previews(projects, new Diagnostics(), true);
  const install = vi.spyOn(p.processes, 'run');
  try { await expect(p.start(app.id)).rejects.toMatchObject({ code: 'DEPENDENCIES_CHANGED' }); expect(install).not.toHaveBeenCalled(); }
  finally { await p.close(); install.mockRestore(); }
});
it('starts a preview with pinned native sign-in dependencies without rewriting the app', async () => {
  const app = await projects.create({ name: 'Native sign-in', slug: 'native-sign-in' });
  const files = nativeAuthDependencies(await dependencyFiles(app.root));
  await writeFile(path.join(app.root, 'package.json'), files.manifest);
  await writeFile(path.join(app.root, 'package-lock.json'), files.lock);
  const p = new Previews(projects, new Diagnostics(), true);
  const install = vi.spyOn(p.processes, 'run').mockImplementation(async () => {
    const cli = path.join(app.root, 'node_modules/expo/bin/cli');
    await mkdir(path.dirname(cli), { recursive: true });
    await writeFile(cli, "require('node:http').createServer((req,res)=>res.end('ready')).listen(Number(process.argv.at(-1)));");
  });
  try {
    expect((await p.start(app.id)).status).toBe('ready');
    expect(install).toHaveBeenCalledOnce();
    expect(install.mock.calls[0]!.slice(0, 2)).toEqual(['npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund']]);
    expect(await dependencyFiles(app.root)).toEqual(files);
  } finally { await p.close(); install.mockRestore(); }
});
it('does not retain exited child PIDs for later shutdown', async () => {
  const p = new Processes(); const child = p.spawn(process.execPath, ['-e', 'process.exit(0)'], dir, () => {});
  await once(child, 'exit');
  const kill = vi.spyOn(process, 'kill');
  try { await p.close(); expect(kill).not.toHaveBeenCalled(); } finally { kill.mockRestore(); }
});
it('reinstalls after a reviewed dependency change even when Expo is already present', async () => {
  const app = await projects.create({ name: 'Dependencies', slug: 'dependencies' }), current = await dependencyFiles(app.root);
  await makeLegacyApp(app.root);
  await mkdir(path.join(app.root, 'node_modules/expo/bin'), { recursive: true });
  await writeFile(path.join(app.root, 'node_modules/expo/bin/cli'), '// fixture');
  const p = new Previews(projects, new Diagnostics(), true), signal = new AbortController().signal;
  const install = vi.spyOn(p.processes, 'run').mockResolvedValue(undefined);
  try {
    await p.installDependencies(app.id, app.root, signal); expect(install).toHaveBeenCalledOnce();
    await p.installDependencies(app.id, app.root, signal); expect(install).toHaveBeenCalledOnce();
    await writeFile(path.join(app.root, 'package.json'), current.manifest); await writeFile(path.join(app.root, 'package-lock.json'), current.lock);
    await p.installDependencies(app.id, app.root, signal); expect(install).toHaveBeenCalledTimes(2);
    expect(install.mock.calls[1]!.slice(0, 2)).toEqual(['npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund']]);
    await p.installDependencies(app.id, app.root, signal); expect(install).toHaveBeenCalledTimes(2);
    // A failed install must not stamp the new lock as installed.
    const legacy = await dependencyFiles(dependencyProfiles['expo-legacy']);
    await writeFile(path.join(app.root, 'package.json'), legacy.manifest); await writeFile(path.join(app.root, 'package-lock.json'), legacy.lock);
    install.mockRejectedValueOnce(new Error('Network failed'));
    await expect(p.installDependencies(app.id, app.root, signal)).rejects.toThrow('Network failed');
    await p.installDependencies(app.id, app.root, signal); expect(install).toHaveBeenCalledTimes(4);
  } finally { install.mockRestore(); await p.close(); }
});
