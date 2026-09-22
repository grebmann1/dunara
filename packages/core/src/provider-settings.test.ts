import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Engine } from './engine.js';
import { Projects } from './projects.js';
import { ProviderSettings } from './provider-settings.js';

let dir: string, engine: Engine;
const run = vi.fn();
const factory = vi.fn((_key: string) => ({ run }));
const sentinel = 'session-secret-SENTINEL-9wX';
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'provider-settings-'));
  run.mockReset().mockResolvedValue([]); factory.mockClear();
  engine = new Engine(await Projects.open(path.join(dir, 'apps'), path.join(dir, 'home')), false, false, undefined, { startupKey: 'environment-SENTINEL', createProvider: factory });
});
afterEach(async () => { await engine.close(); await rm(dir, { recursive: true, force: true }); });
const change = (action: string, key?: unknown, expectedRevision = engine.mediaJobs.providerStatus().revision) => engine.mediaJobs.configureProvider({ action, expectedRevision, ...(key === undefined ? {} : { key }) });
const stage = async () => {
  const project = await engine.projects.create({ name: 'Configuration', slug: 'configuration' });
  const job = await engine.mediaJobs.request(project.id, { requestId: randomUUID(), expectedRevision: null, prompt: 'Test illustration', label: 'Test', operation: 'generate' });
  return { id: project.id, job };
};
it('supports no-key, environment, session override, disconnect, explicit restoration and restart without spending', async () => {
  const empty = new ProviderSettings(); expect(empty.status(false)).toMatchObject({ configured: false, source: 'none', environmentAvailable: false });
  expect(() => empty.update({ action: 'environment', expectedRevision: empty.status(false).revision }, false)).toThrow('No startup');
  const initial = engine.mediaJobs.providerStatus(); expect(initial).toMatchObject({ configured: true, source: 'environment', busy: false });
  expect(await change('replace', `  ${sentinel}  `)).toMatchObject({ configured: true, source: 'session' });
  expect(factory).toHaveBeenLastCalledWith(sentinel);
  expect(engine.mediaJobs.providerStatus().revision).not.toBe(initial.revision);
  expect(await change('disconnect')).toMatchObject({ configured: false, source: 'none', environmentAvailable: true });
  expect(engine.mediaJobs.capabilities().available).toBe(false);
  expect(await change('environment')).toMatchObject({ configured: true, source: 'environment' });
  await change('replace', sentinel); await engine.close();
  expect(engine.mediaJobs.providerStatus()).toMatchObject({ configured: false, source: 'none', environmentAvailable: false });
  engine = new Engine(await Projects.open(path.join(dir, 'apps'), path.join(dir, 'home')), false, false, undefined, { startupKey: 'environment-SENTINEL', createProvider: factory });
  expect(engine.mediaJobs.providerStatus().source).toBe('environment'); expect(run).not.toHaveBeenCalled();
});
it.each(['', ' ', 'bad token', 'bad\nkey', 'bad\u0000key', 'é', 'x'.repeat(4097), 123, null])('rejects invalid key input without reflecting values: case %#', async key => {
  const before = engine.mediaJobs.providerStatus();
  await expect(change('replace', key)).rejects.toMatchObject({ code: 'INVALID_INPUT', message: expect.not.stringContaining('bad') });
  expect(engine.mediaJobs.providerStatus()).toEqual(before); expect(run).not.toHaveBeenCalled();
});
it('rejects stale tabs and missing/stale paid consent atomically; settings remain unpaid and private', async () => {
  const { id, job } = await stage(); const old = engine.mediaJobs.providerStatus().revision;
  await change('replace', sentinel);
  await expect(change('disconnect', undefined, old)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  await expect(engine.mediaJobs.approve(id, job.id)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  await expect(engine.mediaJobs.approve(id, job.id, old)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  expect((await engine.mediaJobs.get(id, job.id)).state).toBe('awaiting-approval');
  expect(JSON.stringify(engine.mediaJobs)).not.toContain(sentinel);
  expect(JSON.stringify(await engine.mediaJobs.list(id))).not.toContain(sentinel);
  expect(await readFile(path.join(dir, 'home/media-jobs.json'), 'utf8')).not.toContain(sentinel);
  expect(process.env.OPENAI_API_KEY).not.toBe(sentinel); expect(run).not.toHaveBeenCalled();
  await engine.mediaJobs.approve(id, job.id, engine.mediaJobs.providerStatus().revision);
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
});
it('serializes approval and replacement; blocks all updates through cancellation until the request settles', async () => {
  let resolve!: (value: Buffer[]) => void;
  run.mockImplementation(() => new Promise<Buffer[]>(r => { resolve = r; }));
  const { id, job } = await stage(); const revision = engine.mediaJobs.providerStatus().revision;
  const [approval, replacement] = await Promise.allSettled([engine.mediaJobs.approve(id, job.id, revision), change('replace', sentinel)]);
  expect(approval.status).toBe('fulfilled'); expect(replacement.status).toBe('rejected');
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
  for (const action of ['replace', 'disconnect', 'environment']) await expect(change(action, action === 'replace' ? sentinel : undefined)).rejects.toThrow('Wait');
  await engine.mediaJobs.cancel(id, job.id);
  expect(engine.mediaJobs.providerStatus().busy).toBe(true);
  await expect(change('disconnect')).rejects.toThrow('settle');
  resolve([]); await vi.waitFor(() => expect(engine.mediaJobs.providerStatus().busy).toBe(false));
  await change('disconnect'); expect((await engine.assets.list(id)).assets).toHaveLength(0); expect(run).toHaveBeenCalledTimes(1);
});
it('replacement wins before a queued approval and factory failures never reveal secrets', async () => {
  const { id, job } = await stage(); const old = engine.mediaJobs.providerStatus().revision;
  const [replacement, approval] = await Promise.allSettled([change('replace', sentinel), engine.mediaJobs.approve(id, job.id, old)]);
  expect(replacement.status).toBe('fulfilled'); expect(approval.status).toBe('rejected'); expect(run).not.toHaveBeenCalled();
  const settings = new ProviderSettings(undefined, { createProvider: () => { throw new Error(sentinel); } });
  expect(() => settings.update({ action: 'replace', key: sentinel, expectedRevision: settings.status(false).revision }, false)).toThrow('Provider configuration failed');
  await engine.close(); await expect(change('replace', sentinel)).rejects.toThrow('closed');
});

it('defaults to included images, preserves a saved personal key, and never switches funding when saving another key', async () => {
  const { CredentialStore } = await import('./credentials.js');
  const credentials = new CredentialStore(path.join(dir,'managed-home'), 'openai-images', { kind: 'configured', key: 'a'.repeat(64) });
  const managed = { label: 'Dunara credits', apiKey: 'managed-token-sentinel', baseUrl: 'http://127.0.0.1:45678/v1', models: [] };
  const options = { home: path.join(dir,'managed-home'), credentials, managed, createProvider: factory };
  const settings = new ProviderSettings(undefined,options);
  expect(settings.status(false)).toMatchObject({ configured: true, source: 'managed' });
  const update = (value: object) => settings.update({ ...value, expectedRevision: settings.status(false).revision },false);
  update({ action: 'replace', key: sentinel, remember: true });
  expect(settings.status(false).source).toBe('managed');
  expect(settings.credential().key).toBe(sentinel);
  update({ action: 'personal' });
  expect(new ProviderSettings(undefined,options).status(false).source).toBe('saved');
  update({ action: 'disconnect' });
  expect(new ProviderSettings(undefined,options).status(false)).toMatchObject({ configured: false, source: 'none' });
  update({ action: 'managed' });
  expect(JSON.stringify(settings.status(false))).not.toMatch(/token-sentinel|45678/);
});
