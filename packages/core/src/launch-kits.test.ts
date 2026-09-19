import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, mkdtemp, open, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Engine } from './engine.js';
import { Projects } from './projects.js';
import { BuilderError } from './contracts.js';
import type { Artifact } from './capture.js';
import { KIT_STORAGE_BYTES, type LaunchKitCreate } from './launch-kit-contracts.js';

let dir: string, engine: Engine, id: string, capture: { meta: Artifact; png: Buffer }, input: LaunchKitCreate;
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'builder-kit-'));
  engine = new Engine(await Projects.open(path.join(dir, 'apps'), path.join(dir, 'home')), false);
  id = (await engine.projects.create({ name: 'Kit test', slug: 'kit-test' })).id;
  const png = await sharp({ create: { width: 375, height: 812, channels: 3, background: '#eeeeee' } }).png().toBuffer();
  capture = { png, meta: { id: randomUUID(), projectId: id, route: '/habit', viewport: 'compact', width: 375, height: 812, createdAt: new Date().toISOString(), rendering: 'React Native Web', bytes: png.length } };
  vi.spyOn(engine.captures, 'get').mockImplementation((projectId, captureId) => {
    if (projectId !== id || captureId !== capture.meta.id) throw new BuilderError('INVALID_INPUT', 'Capture not found or expired');
    return capture;
  });
  input = { captureIds: [capture.meta.id], listing: { name: 'Garden', summary: 'My draft', description: '<script>not executed</script>\n[not a link](file:secret)' }, attribution: 'Test-owned screenshot fixture.', confirmed: true };
});
afterEach(async () => { vi.restoreAllMocks(); await engine.close(); await rm(dir, { recursive: true, force: true }); });
const bundlePath = (bundleId: string) => path.join(dir, 'home/launch-kits', id, bundleId);
async function icon(transparent = false, approved = true) {
  const bytes = await sharp({ create: { width: 1024, height: 1024, channels: transparent ? 4 : 3, background: transparent ? '#33663380' : '#336633' } }).png().toBuffer();
  let library = await engine.assets.import(id, { expectedRevision: (await engine.assets.list(id)).revision, label: 'Test icon', mediaType: 'image/png', rightsNote: 'Original test image' }, bytes);
  const asset = library.assets.at(-1)!;
  if (approved) library = await engine.assets.approve(id, asset.id, library.revision);
  return { assetId: asset.id, expectedRevision: library.revision! };
}
it('copies unchanged original PNGs and inert listing drafts, without reading arbitrary source', async () => {
  const kit = await engine.launchKits.create(id, input);
  expect(kit.manifest.captures).toEqual([capture.meta]);
  expect(kit.manifest.limitations.join(' ')).toContain('not native App Store screenshots');
  expect(kit.location).toBe(`launch-kits/${id}/${kit.manifest.id}`);
  for (const file of kit.files) {
    const result = await engine.launchKits.readFile(id, kit.manifest.id, file.id);
    expect(result.file).toEqual(file); expect(digest(result.bytes)).toBe(file.sha256);
    expect(await readFile(path.join(bundlePath(kit.manifest.id), file.name))).toEqual(result.bytes);
  }
  expect((await engine.launchKits.readFile(id, kit.manifest.id, `screenshot-${capture.meta.id}`)).bytes).toEqual(capture.png);
  expect((await engine.launchKits.readFile(id, kit.manifest.id, 'listing')).bytes.toString()).not.toContain('<script>');
  expect(JSON.stringify(kit)).not.toContain(dir);
  expect(await engine.launchKits.list(id)).toEqual([kit]);
});
it('persists after restart and missing or expired originals, and requires confirmed project-scoped deletion', async () => {
  const kit = await engine.launchKits.create(id, input);
  await engine.close();
  engine = new Engine(await Projects.open(path.join(dir, 'apps'), path.join(dir, 'home')), false);
  expect(await engine.launchKits.read(id, kit.manifest.id)).toEqual(kit);
  await expect(engine.launchKits.create(id, input)).rejects.toThrow('expired');
  const other = await engine.projects.create({ name: 'Other', slug: 'other' });
  await expect(engine.launchKits.read(other.id, kit.manifest.id)).rejects.toThrow('not found');
  await expect(engine.launchKits.remove(id, { bundleId: kit.manifest.id, confirmed: false })).rejects.toThrow();
  await engine.launchKits.remove(id, { bundleId: kit.manifest.id, confirmed: true });
  expect(await engine.launchKits.list(id)).toEqual([]);
});
it('retains the public backend provenance carried by current preview captures', async () => {
  capture.meta.environment = 'staging'; capture.meta.configurationRevision = 'a'.repeat(64);
  const kit = await engine.launchKits.create(id, input);
  expect(kit.manifest.captures).toEqual([capture.meta]);
  await engine.close(); engine = new Engine(await Projects.open(path.join(dir, 'apps'), path.join(dir, 'home')), false);
  expect((await engine.launchKits.read(id, kit.manifest.id)).manifest.captures[0]).toMatchObject({ environment: 'staging', configurationRevision: 'a'.repeat(64) });
});
it('retains approved icon bytes and attribution, not asset prompts or private project paths', async () => {
  const selected = await icon();
  const kit = await engine.launchKits.create(id, { ...input, icon: selected });
  expect(kit.manifest.icon).toMatchObject({ assetId: selected.assetId, rightsNote: 'Original test image', mediaRevision: selected.expectedRevision });
  expect((await engine.launchKits.readFile(id, kit.manifest.id, 'icon')).bytes).toEqual((await engine.assets.read(id, selected.assetId)).bytes);
  expect(JSON.stringify(kit)).not.toContain('assets/builder/');
  expect(JSON.stringify(kit)).not.toContain('prompt');
});
it('rejects unapproved, transparent, stale and cross-project icons', async () => {
  const candidate = await icon(false, false);
  await expect(engine.launchKits.create(id, { ...input, icon: candidate })).rejects.toThrow('approved opaque');
  const transparent = await icon(true);
  await expect(engine.launchKits.create(id, { ...input, icon: transparent })).rejects.toThrow('approved opaque');
  const selected = await icon();
  await engine.assets.brief(id, selected.expectedRevision, { mood: 'Changed' });
  await expect(engine.launchKits.create(id, { ...input, icon: selected })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  await expect(engine.launchKits.create(id, { ...input, icon: { assetId: randomUUID(), expectedRevision: (await engine.assets.list(id)).revision } })).rejects.toThrow('not found');
  expect(await engine.launchKits.list(id)).toEqual([]);
});
it('revalidates icon revision after staging and removes only its own failed staging files', async () => {
  const selected = await icon();
  const read = engine.assets.read.bind(engine.assets);
  vi.spyOn(engine.assets, 'read').mockImplementationOnce(async (...args) => {
    const result = await read(...args);
    const root = (await engine.projects.get(id)).root;
    const file = path.join(root, 'assets/builder/manifest.json');
    const manifest = JSON.parse(await readFile(file, 'utf8')); manifest.assets[0].status = 'candidate';
    await writeFile(file, JSON.stringify(manifest));
    return result;
  });
  await expect(engine.launchKits.create(id, { ...input, icon: selected })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  expect(await engine.launchKits.list(id)).toEqual([]);
  expect(await readdir(path.join(dir, 'home/launch-kits', id))).toEqual([]);
});
it('serializes creates across service instances and rechecks project quota after restart without eviction', async () => {
  const other = new Engine(await Projects.open(path.join(dir, 'apps'), path.join(dir, 'home')), false);
  vi.spyOn(other.captures, 'get').mockReturnValue(capture);
  try {
    const results = await Promise.allSettled(Array.from({ length: 7 }, (_, n) => (n % 2 ? engine : other).launchKits.create(id, input)));
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(5);
    expect(await engine.launchKits.list(id)).toHaveLength(5);
  } finally { await other.close(); }
  await engine.close(); engine = new Engine(await Projects.open(path.join(dir, 'apps'), path.join(dir, 'home')), false);
  vi.spyOn(engine.captures, 'get').mockReturnValue(capture);
  await expect(engine.launchKits.create(id, input)).rejects.toThrow('explicitly delete');
  const first = (await engine.launchKits.list(id))[0]!;
  await engine.launchKits.remove(id, { bundleId: first.manifest.id, confirmed: true });
  await engine.launchKits.create(id, input);
  expect(await engine.launchKits.list(id)).toHaveLength(5);
});
it('counts interrupted staging bytes toward home quota on restart, never evicts them', async () => {
  const staging = path.join(dir, 'home/launch-kits', id, `.staging-${randomUUID()}`);
  await mkdir(staging, { recursive: true });
  const file = path.join(staging, 'orphan.png'), handle = await open(file, 'wx');
  try { await handle.truncate(KIT_STORAGE_BYTES); } finally { await handle.close(); }
  await engine.close(); engine = new Engine(await Projects.open(path.join(dir, 'apps'), path.join(dir, 'home')), false);
  vi.spyOn(engine.captures, 'get').mockReturnValue(capture);
  expect(await engine.launchKits.list(id)).toEqual([]);
  await expect(engine.launchKits.create(id, input)).rejects.toThrow('storage limit');
  expect(await readdir(staging)).toEqual(['orphan.png']);
});
it.each(['capture', 'duplicate', 'empty', 'eleven', 'confirmation', 'url', 'credential-url', 'secret', 'private-path', 'utf8'])('rejects invalid request: %s', async kind => {
  const request = structuredClone(input);
  if (kind === 'capture') request.captureIds = [randomUUID()];
  if (kind === 'duplicate') request.captureIds.push(capture.meta.id);
  if (kind === 'empty') request.captureIds = [];
  if (kind === 'eleven') request.captureIds = Array.from({ length: 11 }, () => randomUUID());
  if (kind === 'url') request.listing.supportUrl = 'javascript:alert(1)';
  if (kind === 'credential-url') request.listing.supportUrl = 'https://user:password@example.test';
  if (kind === 'secret') request.listing.description = `sk-${'x'.repeat(30)}`;
  if (kind === 'private-path') request.listing.description = ['','Users','private','workspace'].join('/');
  if (kind === 'utf8') request.listing.description = '漢'.repeat(12_000);
  await expect(engine.launchKits.create(id, kind === 'confirmation' ? { ...request, confirmed: false } : request)).rejects.toThrow();
  expect(await engine.launchKits.list(id)).toEqual([]);
});
it('rejects traversal, malformed stored metadata, unexpected files and changed immutable contents', async () => {
  const kit = await engine.launchKits.create(id, input), bundle = bundlePath(kit.manifest.id);
  for (const fileId of ['../app.json', 'screenshot-../../outside', 'icon']) await expect(engine.launchKits.readFile(id, kit.manifest.id, fileId)).rejects.toThrow();
  const file = path.join(bundle, 'manifest.json'), original = await readFile(file, 'utf8');
  const manifest = JSON.parse(original); manifest.files[0].name = '../outside';
  await writeFile(file, JSON.stringify(manifest)); await expect(engine.launchKits.read(id, kit.manifest.id)).rejects.toThrow();
  await writeFile(file, original); await writeFile(path.join(bundle, 'unexpected.txt'), 'do not delete me');
  await expect(engine.launchKits.remove(id, { bundleId: kit.manifest.id, confirmed: true })).rejects.toThrow('unexpected');
  await rm(path.join(bundle, 'unexpected.txt')); await writeFile(path.join(bundle, 'listing.md'), 'Changed');
  await expect(engine.launchKits.read(id, kit.manifest.id)).rejects.toThrow('changed');
});
it.each(['home', 'root', 'project', 'bundle', 'screenshots'])('rejects same-path directory replacement: %s', async part => {
  const kit = await engine.launchKits.create(id, input);
  await engine.launchKits.read(id, kit.manifest.id);
  const target = part === 'home' ? path.join(dir, 'home') : part === 'root' ? path.join(dir, 'home/launch-kits') : part === 'project' ? path.join(dir, 'home/launch-kits', id) : part === 'bundle' ? bundlePath(kit.manifest.id) : path.join(bundlePath(kit.manifest.id), 'screenshots');
  await rename(target, `${target}-moved`); await mkdir(target);
  await expect(engine.launchKits.list(id)).rejects.toMatchObject({ code: 'INVALID_PATH' });
});
it.each(['symlink', 'hardlink'])('rejects %s file substitution without reading or deleting its target', async kind => {
  const kit = await engine.launchKits.create(id, input), file = path.join(bundlePath(kit.manifest.id), 'listing.md');
  const outside = path.join(dir, 'outside.md'); await writeFile(outside, 'Preserve me'); await rm(file);
  if (kind === 'symlink') await symlink(outside, file); else await link(outside, file);
  await expect(engine.launchKits.read(id, kit.manifest.id)).rejects.toMatchObject({ code: 'INVALID_PATH' });
  await expect(engine.launchKits.remove(id, { bundleId: kit.manifest.id, confirmed: true })).rejects.toThrow();
  expect(await readFile(outside, 'utf8')).toBe('Preserve me');
});
it('rejects a symlinked home child root and operations after shutdown', async () => {
  const outside = path.join(dir, 'outside'); await mkdir(outside);
  await symlink(outside, path.join(dir, 'home/launch-kits'));
  await expect(engine.launchKits.create(id, input)).rejects.toMatchObject({ code: 'INVALID_PATH' });
  expect(await readdir(outside)).toEqual([]);
  await engine.launchKits.close(); await expect(engine.launchKits.list(id)).rejects.toThrow('closed');
});
