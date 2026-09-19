import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { Projects } from './projects.js';
import { Assets, normalizeImage } from './assets.js';
import { MEDIA_BYTES } from './media-contracts.js';
let dir: string, projects: Projects, assets: Assets, id: string, root: string;
const png = () => sharp({ create: { width: 64, height: 32, channels: 4, background: '#ff880080' } }).png().toBuffer();
beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), 'builder-media-')); projects = await Projects.open(path.join(dir, 'apps'), path.join(dir, 'home')); assets = new Assets(projects); const app = await projects.create({ name: 'Media', slug: 'media' }); id = app.id; root = app.root; });
afterEach(async () => { await assets.close(); await rm(dir, { recursive: true, force: true }); });
it('lazily imports portable immutable assets, approves, saves brief and persists across restart', async () => {
  expect((await assets.list(id)).revision).toBeNull();
  const first = await assets.import(id, { expectedRevision: null, label: 'Scene', mediaType: 'image/png' }, await png());
  const asset = first.assets[0]!; expect(asset).toMatchObject({ width: 64, height: 32, transparent: true, status: 'candidate', provenance: 'imported' });
  const approved = await assets.approve(id, asset.id, first.revision);
  const brief = await assets.brief(id, approved.revision, { mood: 'Space explorer', referenceIds: [asset.id] });
  expect(await new Assets(projects).list(id)).toEqual(brief);
  expect((await assets.read(id, asset.id)).bytes).toEqual(await readFile(path.join(root, asset.path)));
});
it('preserves original and rights when transforming and rejects stale revisions', async () => {
  const first = await assets.import(id, { expectedRevision: null, label: 'Scene', mediaType: 'image/png', rightsNote: 'Own photograph' }, await png());
  const original = first.assets[0]!; const bytes = (await assets.read(id, original.id)).bytes;
  const next = await assets.transform(id, { assetId: original.id, expectedRevision: first.revision, width: 32, height: 32, fit: 'cover', focalX: 1 });
  expect(next.assets[1]).toMatchObject({ parentId: original.id, width: 32, height: 32, rightsNote: 'Own photograph', status: 'candidate' });
  expect((await assets.read(id, original.id)).bytes).toEqual(bytes);
  await expect(assets.approve(id, original.id, first.revision)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
});
it('rejects unsupported signatures, MIME mismatches, corrupt files, large files and pixel bombs', async () => {
  for (const bytes of [Buffer.from('<svg/>'), Buffer.from('GIF89a'), Buffer.from([137,80,78,71,13,10,26,10])]) await expect(normalizeImage(bytes, 'image/png')).rejects.toThrow();
  await expect(normalizeImage(await png(), 'image/jpeg')).rejects.toThrow();
  await expect(normalizeImage(Buffer.alloc(MEDIA_BYTES + 1), 'image/png')).rejects.toThrow();
  const big = await sharp({ create: { width: 4001, height: 4000, channels: 3, background: 'red' } }).png().toBuffer();
  await expect(normalizeImage(big, 'image/png')).rejects.toThrow();
});
it('normalizes JPEG and WebP and strips EXIF', async () => {
  for (const format of ['jpeg', 'webp'] as const) {
    const input = await sharp(await png()).withExif({ IFD0: { Artist: 'private metadata' } }).toFormat(format).toBuffer();
    expect((await sharp(input).metadata()).exif).toBeDefined();
    const normalized = await normalizeImage(input, `image/${format}`);
    expect((await sharp(normalized.data).metadata()).exif).toBeUndefined();
  }
});
it('rejects animated input', async () => {
  const raw = Buffer.alloc(32 * 64 * 4, 255); raw.fill(0, 0, 32 * 32 * 4);
  const input = await sharp(raw, { raw: { width: 32, height: 64, channels: 4, pageHeight: 32 } }).webp({ loop: 0, delay: [100, 100] }).toBuffer();
  expect((await sharp(input).metadata()).pages).toBe(2);
  await expect(normalizeImage(input, 'image/webp')).rejects.toThrow();
});
it('rejects manifest traversal, symlinks and changed immutable bytes', async () => {
  const first = await assets.import(id, { expectedRevision: null, label: 'Scene', mediaType: 'image/png' }, await png());
  const asset = first.assets[0]!, manifest = path.join(root, 'assets/builder/manifest.json');
  const text = await readFile(manifest, 'utf8'); const parsed = JSON.parse(text); parsed.assets[0].path = '../outside.png';
  await writeFile(manifest, JSON.stringify(parsed)); await expect(assets.list(id)).rejects.toThrow(); await writeFile(manifest, text);
  await writeFile(path.join(root, asset.path), 'changed'); await expect(assets.read(id, asset.id)).rejects.toThrow('changed');
  await rm(path.join(root, asset.path)); await symlink(path.join(root, 'app.json'), path.join(root, asset.path)); await expect(assets.list(id)).rejects.toMatchObject({ code: 'INVALID_PATH' });
});
it('keeps concurrent writes revision-safe, isolates projects and rejects unapproved references', async () => {
  const results = await Promise.allSettled([1, 2].map(async () => assets.import(id, { expectedRevision: null, label: 'Scene', mediaType: 'image/png' }, await png())));
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  const library = await assets.list(id), asset = library.assets[0]!;
  await expect(assets.brief(id, library.revision, { referenceIds: [asset.id] })).rejects.toThrow();
  const other = await projects.create({ name: 'Other', slug: 'other' }); await expect(assets.read(other.id, asset.id)).rejects.toThrow();
  expect((await readdir(path.join(root, 'assets/builder'))).length).toBe(2);
});
it('counts orphan files toward quotas and rejects writes after close', async () => {
  const first = await assets.import(id, { expectedRevision: null, label: 'Scene', mediaType: 'image/png' }, await png());
  for (let i = 0; i < 99; i++) await writeFile(path.join(root, `assets/builder/orphan-${i}.png`), 'x');
  await expect(assets.import(id, { expectedRevision: first.revision, label: 'Scene', mediaType: 'image/png' }, await png())).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
  await assets.close(); await expect(assets.brief(id, first.revision, {})).rejects.toThrow('closed');
});
