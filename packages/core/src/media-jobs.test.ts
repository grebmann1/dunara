import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Projects } from './projects.js';
import { Assets } from './assets.js';
import { MediaJobs } from './media-jobs.js';
import { Processes } from './processes.js';
import { ASTRA_MODEL, IMAGE_MODEL, jobSchema, mediaModelLabel } from './media-job-contracts.js';
import { boundedImageFetch, ProviderFailure } from './openai-images.js';
let dir: string, assets: Assets, jobs: MediaJobs, id: string, bytes: Buffer;
const request = (extra = {}) => ({ requestId: randomUUID(), expectedRevision: null, prompt: 'Original space explorer illustration', label: 'Explorer', operation: 'generate', ...extra });
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'media-jobs-'));
  const projects = await Projects.open(path.join(dir, 'apps'), path.join(dir, 'home'));
  assets = new Assets(projects); jobs = new MediaJobs(assets); id = (await projects.create({ name: 'Media', slug: 'media' })).id;
  bytes = await sharp({ create: { width: 32, height: 32, channels: 3, background: 'orange' } }).png().toBuffer();
});
afterEach(async () => { await jobs?.close(); await assets.close(); await rm(dir, { recursive: true, force: true }); });
it('never spends before explicit approval, deduplicates requests and persists output provenance', async () => {
  const run = vi.fn(async () => [bytes]); jobs = new MediaJobs(assets, { run });
  const input = request(); const job = await jobs.request(id, input);
  expect((await jobs.request(id, input)).id).toBe(job.id); expect(run).not.toHaveBeenCalled();
  expect(job.state).toBe('awaiting-approval'); await jobs.approve(id, job.id, jobs.providerStatus().revision);
  await expect(jobs.approve(id, job.id, jobs.providerStatus().revision)).rejects.toThrow();
  await vi.waitFor(async () => expect((await jobs.get(id, job.id)).state).toBe('succeeded'));
  expect(run).toHaveBeenCalledTimes(1); const library = await assets.list(id);
  expect(library.assets[0]).toMatchObject({ provider: 'openai', provenance: 'generated', status: 'candidate' });
  expect(await readFile(path.join(dir, 'home/media-jobs.json'), 'utf8')).not.toContain('apiKey');
  expect(await readFile(path.join(dir, 'apps/media/assets/builder/manifest.json'), 'utf8')).not.toContain(input.prompt);
});
it('binds Astra approval to the model, preserves provenance and reads legacy jobs after restart', async () => {
  const run = vi.fn(async () => [bytes]); jobs = new MediaJobs(assets, { run });
  const legacy = await jobs.request(id, request());
  const input = request({ model: ASTRA_MODEL }); const job = await jobs.request(id, input);
  expect(run).not.toHaveBeenCalled(); expect(job.model).toBe(ASTRA_MODEL);
  await expect(jobs.request(id, { ...input, model: IMAGE_MODEL })).rejects.toThrow('different settings');
  await expect(jobs.request(id, request({ model: ASTRA_MODEL, count: 2 }))).rejects.toThrow('one candidate');
  expect(() => jobSchema.parse({ ...job, model: IMAGE_MODEL })).toThrow('must match');
  await jobs.approve(id, job.id, jobs.providerStatus().revision);
  await vi.waitFor(async () => expect((await jobs.get(id, job.id)).state).toBe('succeeded'));
  expect(run).toHaveBeenCalledTimes(1);
  expect(run.mock.calls[0]).toEqual(expect.arrayContaining([expect.objectContaining({ model: ASTRA_MODEL })]));
  expect((await assets.list(id)).assets[0]).toMatchObject({ model: mediaModelLabel(ASTRA_MODEL), provider: 'openai', status: 'candidate' });
  await jobs.close();
  const file = path.join(dir, 'home/media-jobs.json');
  const ledger = JSON.parse(await readFile(file, 'utf8')); delete ledger[0].request.model;
  await writeFile(file, JSON.stringify(ledger)); jobs = new MediaJobs(assets, { run });
  expect((await jobs.get(id, legacy.id)).request.model).toBe(IMAGE_MODEL);
  expect((await jobs.get(id, job.id)).request.model).toBe(ASTRA_MODEL);
  expect(run).toHaveBeenCalledTimes(1);
});
it('keeps missing-key operation offline, isolates jobs and validates duplicate IDs', async () => {
  jobs = new MediaJobs(assets); const input = request(); const job = await jobs.request(id, input);
  await expect(jobs.approve(id, job.id, jobs.providerStatus().revision)).rejects.toThrow('OPENAI_API_KEY');
  expect((await jobs.list(id)).capabilities.available).toBe(false);
  await expect(jobs.request(id, { ...input, prompt: 'Different' })).rejects.toThrow('different');
  const other = await assets.projects.create({ name: 'Other', slug: 'other' });
  await expect(jobs.get(other.id, job.id)).rejects.toThrow();
  expect((await jobs.cancel(id, job.id)).state).toBe('cancelled');
});
it('requires approved edit references, retains originals and rejects stale approval', async () => {
  const first = await assets.import(id, { expectedRevision: null, label: 'Original', mediaType: 'image/png' }, bytes);
  const asset = first.assets[0]!;
  const run = vi.fn(async () => [bytes]); jobs = new MediaJobs(assets, { run });
  await expect(jobs.request(id, request({ operation: 'edit', referenceIds: [asset.id], expectedRevision: first.revision }))).rejects.toThrow('approved');
  const approved = await assets.approve(id, asset.id, first.revision);
  const job = await jobs.request(id, request({ operation: 'edit', referenceIds: [asset.id], expectedRevision: approved.revision }));
  await jobs.approve(id, job.id, jobs.providerStatus().revision); await vi.waitFor(async () => expect((await jobs.get(id, job.id)).state).toBe('succeeded'));
  expect(run.mock.calls).toHaveLength(1); expect((await assets.list(id)).assets[1]).toMatchObject({ parentId: asset.id, provenance: 'edited' });
  const stale = await jobs.request(id, request({ expectedRevision: (await assets.list(id)).revision }));
  await assets.brief(id, (await assets.list(id)).revision, { mood: 'New direction' });
  await expect(jobs.approve(id, stale.id, jobs.providerStatus().revision)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
});
it('bounds pending requests and permits only one provider call at a time', async () => {
  let resolve!: (b: Buffer[]) => void; const run = vi.fn(() => new Promise<Buffer[]>(r => { resolve = r; })); jobs = new MediaJobs(assets, { run });
  const first = await jobs.request(id, request()); await jobs.approve(id, first.id, jobs.providerStatus().revision);
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
  for (let i = 0; i < 9; i++) await jobs.request(id, request());
  await expect(jobs.request(id, request())).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
  const second = (await jobs.list(id)).jobs[1]!; await jobs.approve(id, second.id, jobs.providerStatus().revision); expect(run).toHaveBeenCalledTimes(1);
  resolve([bytes]); await vi.waitFor(async () => expect((await jobs.get(id, first.id)).state).toBe('succeeded'));
  await vi.waitFor(async () => expect((await jobs.get(id, second.id)).state).toBe('failed')); expect(run).toHaveBeenCalledTimes(1);
});
it('discards late output after cancellation and shutdown without resurrecting jobs', async () => {
  let resolve!: (b: Buffer[]) => void; const run = vi.fn(() => new Promise<Buffer[]>(r => { resolve = r; })); jobs = new MediaJobs(assets, { run });
  const job = await jobs.request(id, request()); await jobs.approve(id, job.id, jobs.providerStatus().revision); await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
  await jobs.cancel(id, job.id); await jobs.close(); resolve([bytes]);
  await new Promise(r => setTimeout(r, 40)); expect((await assets.list(id)).assets).toHaveLength(0); expect((await jobs.get(id, job.id)).state).toBe('cancelled');
});
it('marks uncertain restart states interrupted without resubmitting', async () => {
  jobs = new MediaJobs(assets); const job = await jobs.request(id, request()); await jobs.close();
  const file = path.join(dir, 'home/media-jobs.json'); const ledger = JSON.parse(await readFile(file, 'utf8')); ledger[0].state = 'running'; await writeFile(file, JSON.stringify(ledger));
  const run = vi.fn(async () => [bytes]); jobs = new MediaJobs(assets, { run });
  expect((await jobs.get(id, job.id)).state).toBe('interrupted'); expect(run).not.toHaveBeenCalled();
});
it.each(['timeout', 'quota', 'rejection', 'oversized'] as const)('sanitizes %s failures and never automatically retries', async kind => {
  const run = vi.fn(async (_request, _references, signal: AbortSignal) => {
    if (kind === 'timeout') return new Promise<Buffer[]>((_r, reject) => signal.addEventListener('abort', () => reject(new Error('secret-key')), { once: true }));
    if (kind === 'oversized') return [Buffer.alloc(10 * 1024 * 1024 + 1)];
    if (kind === 'quota') throw new ProviderFailure('Provider rate or quota limit reached. No automatic retry was made.');
    throw new Error('secret-key raw provider payload');
  }); jobs = new MediaJobs(assets, { run }, 100);
  const job = await jobs.request(id, request()); await jobs.approve(id, job.id, jobs.providerStatus().revision);
  await vi.waitFor(async () => expect((await jobs.get(id, job.id)).state).toBe('failed'));
  expect(JSON.stringify(await jobs.list(id))).not.toContain('secret-key'); expect(run).toHaveBeenCalledTimes(1);
});
it('rejects project replacement before spending', async () => {
  const run = vi.fn(async () => [bytes]); jobs = new MediaJobs(assets, { run }); const job = await jobs.request(id, request());
  await rename(path.join(dir, 'apps/media'), path.join(dir, 'apps/old-media'));
  await expect(jobs.approve(id, job.id, jobs.providerStatus().revision)).rejects.toThrow(); expect(run).not.toHaveBeenCalled();
});
it('does not pass the server image credential to generated-app processes', async () => {
  vi.stubEnv('OPENAI_API_KEY', 'fake-test-secret'); const processes = new Processes(); let output = '';
  try {
    await processes.run(process.execPath, ['-e', 'console.log(process.env.OPENAI_API_KEY ? "leaked" : "absent")'], dir, text => { output += text; });
    expect(output.trim()).toBe('absent');
  } finally { vi.unstubAllEnvs(); await processes.close(); }
});
it('bounds provider response bytes before JSON parsing and forbids redirects', async () => {
  const fetcher = vi.fn(async () => new Response('x', { headers: { 'content-length': '999999999' } }));
  await expect(boundedImageFetch(fetcher)('https://example.invalid')).rejects.toThrow('limit');
  expect(fetcher).toHaveBeenCalledWith('https://example.invalid', expect.objectContaining({ redirect: 'error' }));
});
