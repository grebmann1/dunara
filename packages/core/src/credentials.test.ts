import { z } from 'zod';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CredentialStore, startupCredentials, sharedOpenAIStore, EncryptedSettingsStore, PrivateSettingsStore } from './credentials.js';
import { Processes } from './processes.js';
import { ProviderSettings } from './provider-settings.js';

let root: string;
const protection = { kind: 'configured' as const, key: 'a'.repeat(64) };
const image = 'offline-image-credential-SENTINEL', assistant = 'offline-assistant-credential-SENTINEL';
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), 'builder-credentials-')); });
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });
it('parses only credential entries without evaluating or inheriting arbitrary .env configuration', async () => {
  const file = path.join(root, '.env');
  await writeFile(file, `OPENAI_API_KEY="${image}"\nBUILDER_ASSISTANT_API_KEY='${assistant}'\nNODE_OPTIONS=--require=hostile.js\nPATH=/hostile\nUNRELATED=$(touch should-not-exist)\n`, { mode: 0o600 });
  const before = { ...process.env };
  expect(startupCredentials(file, {})).toEqual({ imageKey: image, assistantKey: assistant });
  expect(process.env).toEqual(before); expect(await readdir(root)).toEqual(['.env']);
  expect(startupCredentials(file, { OPENAI_API_KEY: assistant, BUILDER_ASSISTANT_API_KEY: image })).toEqual({ imageKey: assistant, assistantKey: image });
  await writeFile(file, `OPENAI_API_KEY=${image}\n`);
  expect(startupCredentials(file, {})).toEqual({ imageKey: image, assistantKey: image });
  expect(startupCredentials(file, { BUILDER_ASSISTANT_API_KEY: assistant })).toEqual({ imageKey: image, assistantKey: assistant });
  expect(startupCredentials(path.join(root, 'missing'), {})).toEqual({ imageKey: undefined, assistantKey: undefined });
});
it('rejects unsafe .env files and invalid tokens with secret-free errors', async () => {
  const file = path.join(root, '.env');
  for (const content of [`OPENAI_API_KEY="bad ${image}"`, 'x'.repeat(65537), Buffer.from([0xff]), Buffer.from([0])]) {
    await writeFile(file, content, { mode: 0o600 });
    expect(() => startupCredentials(file, {})).toThrow('Credential storage');
    try { startupCredentials(file, {}); } catch (error) { expect(String(error)).not.toContain(image); }
  }
  await writeFile(file, `OPENAI_API_KEY=${image}`); await chmod(file, 0o666);
  expect(() => startupCredentials(file, {})).toThrow('unsafe'); await chmod(file, 0o600);
  const alias = path.join(root, 'alias'); await symlink(file, alias);
  expect(() => startupCredentials(alias, {})).toThrow('unsafe');
  await rm(alias); await link(file, alias); expect(() => startupCredentials(file, {})).toThrow('unsafe');
});
it('persists separate slots privately across restart, replaces atomically and explicitly deletes', async () => {
  const a = new CredentialStore(root, 'openai-assistant', protection), i = new CredentialStore(root, 'openai-images', protection);
  expect(a.load()).toBeUndefined(); expect(await readdir(root)).toEqual([]);
  a.save(assistant); expect(i.load()).toBeUndefined(); i.save(image);
  expect(new CredentialStore(root, 'openai-assistant', protection).load()).toBe(assistant);
  const dir = path.join(root, 'credentials'), file = path.join(dir, 'openai-assistant-protected.json');
  expect((await lstat(dir)).mode & 0o777).toBe(0o700); expect((await lstat(file)).mode & 0o777).toBe(0o600);
  a.save(image); expect(a.load()).toBe(image); expect(await readdir(dir)).toEqual(['openai-assistant-protected.json', 'openai-images-protected.json']);
  expect(await readFile(file, 'utf8')).not.toContain(image);
  a.remove(); a.remove(); expect(a.load()).toBeUndefined(); expect(i.load()).toBe(image);
});
it('fails closed on unsafe private storage without following or overwriting its targets', async () => {
  const store = new CredentialStore(root, 'openai-assistant', protection), dir = path.join(root, 'credentials');
  const file = path.join(dir, 'openai-assistant-protected.json'), target = path.join(root, 'outside');
  await writeFile(target, 'unchanged', { mode: 0o600 }); await mkdir(dir, { mode: 0o700 });
  await symlink(target, file);
  for (const op of [() => store.load(), () => store.save(assistant), () => store.remove()]) expect(op).toThrow('unsafe');
  expect(await readFile(target, 'utf8')).toBe('unchanged'); await rm(file);
  store.save(assistant); await chmod(file, 0o644); expect(() => store.load()).toThrow('unsafe');
  await chmod(file, 0o600); await link(file, path.join(root, 'hardlink')); expect(() => store.load()).toThrow('unsafe');
  await rm(path.join(root, 'hardlink')); await writeFile(file, JSON.stringify({ version: 1, key: assistant, extra: assistant }));
  expect(() => store.load()).toThrow('unsafe');
  await rm(dir, { recursive: true }); await symlink(root, dir); expect(() => store.save(assistant)).toThrow('unsafe');
});
it('restores saved image settings ahead of startup keys without probes and preserves revision/busy gates', () => {
  const credentials = new CredentialStore(root, 'openai-images', protection);
  const run = vi.fn(), createProvider = vi.fn(() => ({ run }));
  const options = { startupKey: image, credentials, createProvider };
  let settings = new ProviderSettings(undefined, options);
  expect(settings.status(false)).toMatchObject({ source: 'environment', environmentAvailable: true });
  const revision = settings.status(false).revision;
  settings.update({ action: 'replace', key: assistant, remember: true, expectedRevision: revision }, false);
  expect(credentials.load()).toBe(assistant);
  expect(() => settings.update({ action: 'disconnect', expectedRevision: revision }, false)).toThrow('changed');
  expect(() => settings.update({ action: 'disconnect', expectedRevision: settings.status(false).revision }, true)).toThrow('Wait');
  settings.close(); settings = new ProviderSettings(undefined, options);
  expect(settings.status(false).source).toBe('saved'); expect(createProvider).toHaveBeenLastCalledWith(assistant);
  settings.update({ action: 'environment', expectedRevision: settings.status(false).revision }, false);
  expect(credentials.load()).toBeUndefined(); expect(settings.status(false).source).toBe('environment');
  settings.update({ action: 'replace', key: assistant, remember: true, expectedRevision: settings.status(false).revision }, false);
  settings.update({ action: 'replace', key: image, expectedRevision: settings.status(false).revision }, false);
  expect(credentials.load()).toBeUndefined(); expect(settings.status(false).source).toBe('session');
  settings.update({ action: 'replace', key: assistant, remember: true, expectedRevision: settings.status(false).revision }, false);
  settings.update({ action: 'disconnect', expectedRevision: settings.status(false).revision }, false);
  expect(credentials.load()).toBeUndefined(); expect(settings.status(false).configured).toBe(false);
  expect(new ProviderSettings(undefined, options).status(false).source).toBe('environment');
  expect(run).not.toHaveBeenCalled();
});
it('never passes either supported credential into generated-app child processes', async () => {
  vi.stubEnv('OPENAI_API_KEY', image); vi.stubEnv('BUILDER_ASSISTANT_API_KEY', assistant);
  const processes = new Processes(); let output = '';
  try {
    await processes.run(process.execPath, ['-e', 'console.log(JSON.stringify({ image: process.env.OPENAI_API_KEY ?? null, assistant: process.env.BUILDER_ASSISTANT_API_KEY ?? null }))'], root, text => { output += text; });
    expect(JSON.parse(output)).toEqual({ image: null, assistant: null });
  } finally { await processes.close(); }
});

it('migrates legacy plaintext only after encrypted read-back and preserves shared precedence', async () => {
  const dir = path.join(root, 'credentials'); await mkdir(dir, { mode: 0o700 });
  const legacy = path.join(dir, 'openai-assistant.json');
  await writeFile(legacy, JSON.stringify({ version: 1, key: assistant }), { mode: 0o600 });
  expect(sharedOpenAIStore(root, protection).load()).toBe(assistant);
  expect(await readdir(dir)).toEqual(['openai-images-protected.json']);
  sharedOpenAIStore(root, protection).save(image);
  await writeFile(legacy, JSON.stringify({ version: 1, key: assistant }), { mode: 0o600 });
  expect(sharedOpenAIStore(root, protection).load()).toBe(image);
  expect(await readdir(dir)).toEqual(['openai-images-protected.json']);
});
it('retains legacy data if protection or encrypted read-back is unavailable', async () => {
  const dir = path.join(root, 'credentials'); await mkdir(dir, { mode: 0o700 });
  const legacy = path.join(dir, 'openai-images.json');
  await writeFile(legacy, JSON.stringify({ version: 1, key: image }), { mode: 0o600 });
  expect(() => sharedOpenAIStore(root).load()).toThrow();
  expect(await readFile(legacy, 'utf8')).toContain(image);
  const load = vi.spyOn(EncryptedSettingsStore.prototype, 'load');
  load.mockImplementationOnce(() => undefined).mockImplementationOnce(() => undefined).mockImplementationOnce(() => { throw new Error('read-back failed'); });
  expect(() => sharedOpenAIStore(root, protection).load()).toThrow();
  expect(await readFile(legacy, 'utf8')).toContain(image); load.mockRestore();
  expect(sharedOpenAIStore(root, protection).load()).toBe(image);
  expect(await readdir(dir)).toEqual(['openai-images-protected.json']);
});
it('starts locked without probing or falling back and permits explicit forget', () => {
  sharedOpenAIStore(root, protection).save(image);
  const createProvider = vi.fn(() => ({ run: vi.fn() }));
  const settings = new ProviderSettings(undefined, { credentials: sharedOpenAIStore(root, { ...protection, key: 'b'.repeat(64) }), startupKey: assistant, createProvider });
  expect(settings.status(false)).toMatchObject({ storage: 'locked', configured: false, rememberAvailable: false });
  expect(settings.credential().key).toBe('');
  expect(() => settings.update({ action: 'replace', key: assistant, expectedRevision: settings.status(false).revision }, false)).toThrow('locked');
  expect(sharedOpenAIStore(root, protection).load()).toBe(image);
  settings.update({ action: 'disconnect', expectedRevision: settings.status(false).revision }, false);
  expect(sharedOpenAIStore(root, protection).load()).toBeUndefined();
});
it('never saves plaintext when protection is unavailable and bounds generic settings writes', () => {
  expect(() => sharedOpenAIStore(root).save(image)).toThrow();
  const settings = new ProviderSettings(undefined, { credentials: sharedOpenAIStore(root) });
  settings.update({ action: 'replace', key: image, expectedRevision: settings.status(false).revision }, false);
  expect(settings.status(false)).toMatchObject({ source: 'session', storage: 'session', rememberAvailable: false });
  expect(() => new PrivateSettingsStore(root, '../escape', z.string())).toThrow();
  expect(() => new PrivateSettingsStore(root, 'bounded', z.string(), 16).save('x'.repeat(20))).toThrow();
});
