import { test, expect, type Page } from '@playwright/test';
import { mkdtemp, readFile, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { Engine } from '../../packages/core/src/engine.js';
import { Projects } from '../../packages/core/src/projects.js';
import { BuilderError } from '../../packages/core/src/contracts.js';
import type { Artifact } from '../../packages/core/src/capture.js';
import { startStudio } from '../../packages/cli/src/studio-server.js';
import { selectProject } from './project-picker.js';

test.use({ trace: 'off' });
let dir: string, engine: Engine, studio: Awaited<ReturnType<typeof startStudio>>, projectId: string, otherId: string, calls: number;
let retained: { meta: Artifact; png: Buffer }[];
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
test.beforeEach(async () => {
  test.skip(!!process.env.VISUAL, 'Visual suite only');
  calls = 0; dir = await mkdtemp(path.join(os.tmpdir(), 'kit-browser-'));
  engine = new Engine(await Projects.open(path.join(dir, 'apps'), path.join(dir, 'home')), false, false, { async run() { calls++; throw new Error('Offline only'); } });
  projectId = (await engine.projects.create({ name: 'Kit Alpha', slug: 'kit-alpha' })).id;
  otherId = (await engine.projects.create({ name: 'Kit Beta', slug: 'kit-beta' })).id;
  retained = [];
  for (const viewport of ['compact', 'large'] as const) {
    const dimensions = viewport === 'compact' ? { width: 375, height: 812 } : { width: 430, height: 932 };
    const png = await sharp({ create: { ...dimensions, channels: 3, background: '#567b68' } }).png().toBuffer();
    retained.push({ png, meta: { id: randomUUID(), projectId, route: viewport === 'compact' ? '/' : '/habit', viewport, ...dimensions, createdAt: new Date().toISOString(), bytes: png.length, rendering: 'React Native Web' } });
  }
  engine.captures.list = id => retained.filter(c => c.meta.projectId === id).map(c => c.meta);
  engine.captures.get = (id, cid) => { const capture = retained.find(c => c.meta.projectId === id && c.meta.id === cid); if (!capture) throw new BuilderError('INVALID_INPUT', 'Capture not found or expired'); return capture; };
  studio = await startStudio(engine, path.resolve('dist/studio'));
});
test.afterEach(async () => { if (process.env.VISUAL) return; await studio.close(); await engine.close(); await rm(dir, { recursive: true, force: true }); expect(calls).toBe(0); });
async function openKit(page: Page) {
  await page.goto(studio.launchUrl); await selectProject(page, projectId);
  await page.getByRole('button', { name: 'Assets', exact: true }).click();
  await page.getByRole('button', { name: 'Launch Kit', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Launch Kit', exact: true })).toBeVisible();
}
async function prepare(page: Page) {
  await page.getByRole('checkbox', { name: 'Select / · compact', exact: true }).check();
  await page.getByLabel('Short summary', { exact: true }).fill('A user-authored draft');
  await page.getByLabel('Screenshot imagery attribution').fill('Test fixture, no third-party imagery.');
  await page.getByRole('button', { name: 'Review local kit contents' }).click();
  await expect(page.getByRole('heading', { name: '4 · Confirm local contents' })).toBeFocused();
}
async function create(page: Page) {
  await expect(page.getByRole('button', { name: 'Create local kit', exact: true })).toBeDisabled();
  await page.getByRole('checkbox', { name: /I reviewed these exact contents/ }).check();
  await page.getByRole('button', { name: 'Create local kit', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Local kit created' })).toBeVisible();
}

test('reviews exact contents, downloads unchanged files, retains kits after capture loss and confirms deletion', async ({ page }) => {
  await openKit(page); await prepare(page); await create(page);
  const kit = (await engine.launchKits.list(projectId))[0]!;
  expect(kit.manifest.captures.map(c => c.id)).toEqual([retained[0]!.meta.id]);
  expect(kit.manifest.listing.summary).toBe('A user-authored draft');
  const saved = page.getByRole('region', { name: 'Saved Launch Kits' });
  for (const file of kit.files) {
    const downloadPromise = page.waitForEvent('download');
    await saved.getByRole('button', { name: `Download ${file.name}`, exact: true }).click();
    const download = await downloadPromise;
    const bytes = await readFile((await download.path())!); expect(hash(bytes)).toBe(file.sha256);
  }
  retained = [];
  await page.getByRole('button', { name: 'Refresh kits' }).click();
  await expect(saved.getByText('Kit Alpha', { exact: true })).toBeVisible();
  await page.route('**/launch-kits/*/files/*', route => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Download unavailable; retry' } }) }));
  await saved.getByRole('button', { name: 'Download manifest.json', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Download unavailable; retry');
  await page.unroute('**/launch-kits/*/files/*');
  await saved.getByRole('button', { name: 'Delete kit', exact: true }).click();
  expect(await engine.launchKits.list(projectId)).toHaveLength(1);
  await page.getByRole('button', { name: 'Keep kit' }).click();
  await saved.getByRole('button', { name: 'Delete kit', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm delete kit' }).click();
  await expect(saved).toContainText('No saved kits'); expect(await engine.launchKits.list(projectId)).toHaveLength(0);
});

test('stale icon, invalid URL and expired capture failures keep drafts for deliberate review', async ({ page }) => {
  const png = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: '#567b68' } }).png().toBuffer();
  let library = await engine.assets.import(projectId, { expectedRevision: null, label: 'Approved master', mediaType: 'image/png' }, png);
  const iconId = library.assets[0]!.id; library = await engine.assets.approve(projectId, iconId, library.revision);
  await openKit(page); await prepare(page);
  await page.getByLabel('Support URL (optional)').fill('javascript:alert(1)');
  await page.getByRole('button', { name: 'Review local kit contents' }).click();
  await expect(page.getByRole('alert')).toContainText('HTTP(S)');
  await page.getByLabel('Support URL (optional)').fill('');
  await page.getByRole('combobox', { name: 'Launch Kit icon', exact: true }).click(); await page.getByRole('option', { name: 'Approved master', exact: true }).click();
  await page.getByRole('button', { name: 'Review local kit contents' }).click();
  await page.getByRole('checkbox', { name: /I reviewed these exact contents/ }).check();
  await engine.assets.import(projectId, { expectedRevision: library.revision, label: 'External import', mediaType: 'image/png' }, png);
  await expect(page.getByRole('alert')).toContainText('Library changed');
  await expect(page.getByRole('button', { name: 'Create local kit', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Review local kit contents' }).click();
  // Expire after the UI review, before POST; the service must refuse, never recapture.
  retained = [];
  await page.getByRole('checkbox', { name: /I reviewed these exact contents/ }).check();
  await page.getByRole('button', { name: 'Create local kit', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Capture not found or expired' })).toBeVisible();
  await expect(page.getByLabel('Short summary', { exact: true })).toHaveValue('A user-authored draft');
  expect(await engine.launchKits.list(projectId)).toHaveLength(0);
});

test('project-keyed drafts and delayed creation results cannot contaminate another project', async ({ page }) => {
  await openKit(page); await prepare(page);
  let release!: () => void; const pending = new Promise<void>(resolve => { release = resolve; }); let requested = false;
  await page.route(`**/api/projects/${projectId}/launch-kits/create`, async route => { const response = await route.fetch(); requested = true; await pending; await route.fulfill({ response }); });
  try {
    await page.getByRole('checkbox', { name: /I reviewed these exact contents/ }).check();
    await page.getByRole('button', { name: 'Create local kit', exact: true }).click();
    await expect.poll(() => requested).toBe(true);
    await selectProject(page, otherId);
    await page.getByRole('button', { name: 'Assets', exact: true }).click();
    await page.getByRole('button', { name: 'Launch Kit', exact: true }).click();
    await page.getByLabel('Listing name', { exact: true }).fill('Beta draft');
    release(); await expect(page.getByRole('region', { name: 'Saved Launch Kits' })).toContainText('No saved kits');
    await expect(page.getByLabel('Listing name', { exact: true })).toHaveValue('Beta draft');
    await selectProject(page, projectId);
    await expect(page.getByLabel('Short summary', { exact: true })).toHaveValue('A user-authored draft');
    await expect(page.getByRole('region', { name: 'Saved Launch Kits' })).toContainText('Kit Alpha');
    await expect(page.getByRole('checkbox', { name: /I reviewed these exact contents/ })).toHaveCount(0);
  } finally { release(); }
});

test('capture footer reaches the secondary workflow across workspaces with responsive keyboard controls', async ({ page }) => {
  await page.goto(studio.launchUrl); await selectProject(page, projectId);
  await page.locator('.studio-console').getByRole('button', { name: 'Captures', exact: true }).click(); await page.getByRole('button', { name: 'Prepare Launch Kit', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Launch Kit', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'App Icons', exact: true }).click();
  await page.locator('.studio-console').getByRole('button', { name: 'Captures', exact: true }).click();
  await page.getByRole('button', { name: 'Prepare Launch Kit', exact: true }).click();
  await prepare(page);
  await mkdir('.builder/studio-enhancements-review/kit-layouts', { recursive: true });
  for (const width of [320, 375, 430, 768, 1280, 1440]) {
    await page.setViewportSize({ width, height: 932 });
    for (const zoom of [1, 2]) {
      await page.evaluate(value => { document.documentElement.style.zoom = String(value); }, zoom);
      await expect.poll(() => page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - innerWidth))).toBe(0);
      const confirm = page.getByRole('checkbox', { name: /I reviewed these exact contents/ });
      await confirm.evaluate(element => element.blur()); await confirm.focus(); await expect(confirm).toBeInViewport(); await page.keyboard.press('Space'); await expect(confirm).toBeChecked(); await page.keyboard.press('Space');
      await page.screenshot({ path: `.builder/studio-enhancements-review/kit-layouts/review-${width}-${zoom}.png` });
    }
  }
});
