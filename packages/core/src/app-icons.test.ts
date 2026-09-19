import { mkdtemp, rm, writeFile, symlink, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { Engine } from './engine.js';
import { Projects } from './projects.js';
import { iconApplySchema, type IconDiff, type IconSelection } from './icon-contracts.js';

let dir: string, engine: Engine, id: string, root: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'builder-icons-'));
  engine = new Engine(await Projects.open(path.join(dir, 'apps'), path.join(dir, 'home')), false);
  const project = await engine.projects.create({ name: 'Icons', slug: 'icons' }); id = project.id; root = project.root;
});
afterEach(async () => { await engine.close(); await rm(dir, { recursive: true, force: true }); });
async function source(transparent = false) {
  const base = sharp({ create: { width: 108, height: 108, channels: 4, background: transparent ? '#00000000' : '#456789' } });
  const mark = await sharp({ create: { width: 50, height: 40, channels: 4, background: '#557744' } }).png().toBuffer();
  const bytes = await (transparent ? base.composite([{ input: mark, left: 29, top: 34 }]) : base).png().toBuffer();
  let library = await engine.assets.import(id, { expectedRevision: (await engine.assets.list(id)).revision, mediaType: 'image/png', label: 'Original mark' }, bytes);
  const asset = library.assets.at(-1)!;
  library = await engine.assets.approve(id, asset.id, library.revision);
  return { asset, library };
}
async function prepareMaster() {
  const { asset, library } = await source();
  const prepared = await engine.appIcons.prepare(id, { assetId: asset.id, expectedRevision: library.revision, kind: 'master', fit: 'contain', background: '#ffffff' });
  const master = prepared.assets.at(-1)!;
  await engine.assets.approve(id, master.id, prepared.revision);
  return { masterId: master.id, background: '#ffffff' };
}
const confirmation = (selection: IconSelection, diff: IconDiff) => ({ ...selection, expectedConfigRevision: diff.expectedConfigRevision, expectedMediaRevision: diff.expectedMediaRevision, proposedRevision: diff.proposedRevision, confirmed: true as const });
it('creates immutable opaque masters and preserves unrelated config fields only after confirmed diff', async () => {
  const { asset, library } = await source(true);
  const before = await engine.files.read(id, 'app.json');
  const custom = { expo: { name: 'Preserve me', slug: 'icons', extra: { nested: [1, 2] }, plugins: ['expo-router'], ios: { bundleIdentifier: 'dev.test.app' }, android: { package: 'dev.test.app' } }, unrelated: 'keep' };
  await engine.files.write(id, [{ path: 'app.json', content: JSON.stringify(custom), expectedRevision: before.revision }]);
  const result = await engine.appIcons.prepare(id, { assetId: asset.id, expectedRevision: library.revision, kind: 'master', fit: 'contain', background: '#abcdef' });
  const master = result.assets.at(-1)!;
  expect(master).toMatchObject({ parentId: asset.id, width: 1024, height: 1024, transparent: false, role: 'app-icon', status: 'candidate', provenance: 'icon' });
  expect((await engine.assets.read(id, asset.id)).asset.hash).toBe(asset.hash);
  const selected = { masterId: master.id, background: '#abcdef' };
  await expect(engine.appIcons.preview(id, selected)).rejects.toThrow('approved opaque');
  await engine.assets.approve(id, master.id, result.revision);
  const diff = await engine.appIcons.preview(id, selected);
  expect(JSON.parse((await engine.files.read(id, 'app.json')).content)).toEqual(custom);
  expect(JSON.parse(diff.after)).toEqual({ ...custom, expo: { ...custom.expo, icon: `./${master.path}` } });
  await engine.appIcons.apply(id, confirmation(selected, diff));
  expect((await engine.files.read(id, 'app.json')).content).toBe(diff.after);
  await engine.close(); engine = new Engine(await Projects.open(path.join(dir, 'apps'), path.join(dir, 'home')), false);
  expect((await engine.files.read(id, 'app.json')).content).toBe(diff.after);
});
it('rejects stale config, stale assets, changed proposals and missing confirmation without changing app.json', async () => {
  const selected = await prepareMaster(), diff = await engine.appIcons.preview(id, selected);
  expect(iconApplySchema.safeParse({ ...confirmation(selected, diff), confirmed: false }).success).toBe(false);
  await expect(engine.appIcons.apply(id, { ...confirmation(selected, diff), proposedRevision: '0'.repeat(64) })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  expect((await engine.files.read(id, 'app.json')).content).toBe(diff.before);
  await engine.assets.brief(id, diff.expectedMediaRevision, { mood: 'new direction' });
  await expect(engine.appIcons.apply(id, confirmation(selected, diff))).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  const next = await engine.appIcons.preview(id, selected);
  const edited = JSON.stringify({ expo: { name: 'External edit' } }); await writeFile(path.join(root, 'app.json'), edited);
  await expect(engine.appIcons.apply(id, confirmation(selected, next))).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  expect(await readFile(path.join(root, 'app.json'), 'utf8')).toBe(edited);
});
it('requires an appropriate transparent foreground and prepares distinct adaptive layers', async () => {
  const selected = await prepareMaster();
  expect((await engine.appIcons.check(id, selected.masterId)).available).toBe(false);
  const { asset, library } = await source(true);
  expect((await engine.appIcons.check(id, asset.id)).available).toBe(true);
  const prepared = await engine.appIcons.prepare(id, { assetId: asset.id, expectedRevision: library.revision, kind: 'adaptive', fit: 'contain', background: '#abcdef' });
  const foreground = prepared.assets.at(-1)!;
  expect(foreground).toMatchObject({ width: 1024, height: 1024, transparent: true });
  await engine.assets.approve(id, foreground.id, prepared.revision);
  const selection = { ...selected, foregroundId: foreground.id, background: '#abcdef' };
  const diff = await engine.appIcons.preview(id, selection);
  expect(JSON.parse(diff.after).expo.android.adaptiveIcon).toEqual({ foregroundImage: `./${foreground.path}`, backgroundColor: '#abcdef' });
  await engine.appIcons.apply(id, confirmation(selection, diff));
});
it('refuses flattened, empty and undersized adaptive foregrounds with actionable reasons', async () => {
  const { asset, library } = await source();
  await expect(engine.appIcons.prepare(id, { assetId: asset.id, expectedRevision: library.revision, kind: 'adaptive', fit: 'contain', background: '#ffffff' })).rejects.toThrow('flattened photo');
  for (const size of [0, 10]) {
    let image = sharp({ create: { width: 108, height: 108, channels: 4, background: '#00000000' } });
    if (size) image = image.composite([{ input: await sharp({ create: { width: size, height: size, channels: 4, background: '#ffffff' } }).png().toBuffer() }]);
    const added = await engine.assets.import(id, { expectedRevision: (await engine.assets.list(id)).revision, mediaType: 'image/png', label: 'Bad foreground' }, await image.png().toBuffer());
    const source = added.assets.at(-1)!; await engine.assets.approve(id, source.id, added.revision);
    expect((await engine.appIcons.check(id, source.id)).reason).toContain(size ? 'too small' : 'empty');
  }
});
it.each(['app.config.js', 'app.config.ts', 'app.config.json', 'app.config.mjs'])('refuses overriding %s without executing it', async filename => {
  const selected = await prepareMaster(); await writeFile(path.join(root, filename), 'throw new Error("must not execute")');
  await expect(engine.appIcons.preview(id, selected)).rejects.toThrow('app.json only');
});
it('preserves platform overrides with warnings and supports top-level static config', async () => {
  const selected = await prepareMaster();
  await writeFile(path.join(root, 'app.json'), JSON.stringify({ name: 'No expo wrapper', ios: { icon: './custom.png' }, android: { adaptiveIcon: { foregroundImage: './existing.png' } } }));
  const diff = await engine.appIcons.preview(id, selected);
  expect(JSON.parse(diff.after).expo).toBeUndefined(); expect(JSON.parse(diff.after).ios.icon).toBe('./custom.png');
  expect(diff.warnings.join(' ')).toContain('ios.icon is preserved'); expect(diff.warnings.join(' ')).toContain('Existing Android adaptive icon');
});
it('rejects symlinks, foreign assets and closed engines', async () => {
  const selected = await prepareMaster(), other = await engine.projects.create({ name: 'Other', slug: 'other' });
  await expect(engine.appIcons.preview(other.id, selected)).rejects.toThrow('not found');
  await rm(path.join(root, 'app.json')); const external = path.join(dir, 'config.json'); await writeFile(external, '{}'); await symlink(external, path.join(root, 'app.json'));
  await expect(engine.appIcons.preview(id, selected)).rejects.toThrow(); expect(await readFile(external, 'utf8')).toBe('{}');
  await engine.close(); await expect(engine.appIcons.preview(id, selected)).rejects.toThrow('closed');
});
