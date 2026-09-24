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
  await saved.locator('.saved-kit-images > summary').click();
  for (const file of kit.files) {
    const downloadPromise = page.waitForEvent('download');
    await saved.locator(`[data-kit-file-id="${file.id}"]`).getByRole('button', { name: /^Download / }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe(file.name.split('/').pop());
    const bytes = await readFile((await download.path())!); expect(hash(bytes)).toBe(file.sha256);
  }
  retained = [];
  await page.getByRole('button', { name: 'Refresh kits' }).click();
  await expect(saved.getByText('Kit Alpha', { exact: true })).toBeVisible();
  await page.route('**/launch-kits/*/files/*', route => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Download unavailable; retry' } }) }));
  await saved.getByRole('button', { name: 'Download Kit manifest', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Download unavailable; retry');
  await page.unroute('**/launch-kits/*/files/*');
  await saved.getByRole('button', { name: 'Delete kit', exact: true }).click();
  expect(await engine.launchKits.list(projectId)).toHaveLength(1);
  await page.getByRole('button', { name: 'Keep kit' }).click();
  await saved.getByRole('button', { name: 'Delete kit', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm delete kit' }).click();
  await expect(saved).toContainText('No saved kits'); expect(await engine.launchKits.list(projectId)).toHaveLength(0);
});

test('saved kits use readable file groups, lazy durable previews and keyboard-accessible technical details at phone and desktop sizes', async ({ page }) => {
  for (const route of ['/characters', '/saved']) for (const capture of retained.slice(0, 2)) {
    retained.push({ png: capture.png, meta: { ...capture.meta, id: randomUUID(), route } });
  }
  const png = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: '#567b68' } }).png().toBuffer();
  let library = await engine.assets.import(projectId, { expectedRevision: null, label: 'Approved master', mediaType: 'image/png' }, png);
  const iconId = library.assets[0]!.id;
  library = await engine.assets.approve(projectId, iconId, library.revision);
  const kit = await engine.launchKits.create(projectId, {
    captureIds: retained.map(capture => capture.meta.id), icon: { assetId: iconId, expectedRevision: library.revision },
    listing: { name: 'Holocron Atlas', summary: 'Explore the galaxy', description: '' }, attribution: 'Test imagery', confirmed: true,
  });
  retained = [];
  let fileRequests = 0;
  page.on('request', request => { if (/\/launch-kits\/[^/]+\/files\//.test(request.url())) fileRequests++; });
  await openKit(page);
  const card = page.getByRole('article', { name: 'Holocron Atlas' });
  await expect(card).toContainText('6 screenshots · App icon · 12 files');
  await expect(card.locator('.saved-kit-technical > code')).toBeHidden();
  expect(fileRequests).toBe(0);
  const imageToggle = card.locator('.saved-kit-images > summary');
  await imageToggle.focus(); await page.keyboard.press('Enter');
  await expect(card.getByRole('img')).toHaveCount(7);
  await expect.poll(() => card.getByRole('img').evaluateAll(images => images.every(image => (image as HTMLImageElement).naturalWidth > 0))).toBe(true);
  await expect(card.getByRole('button', { name: 'Download Home · 375 × 812', exact: true })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Download /characters · 430 × 932', exact: true })).toBeVisible();
  const src = await card.getByRole('img').first().getAttribute('src');
  await page.getByRole('button', { name: 'Refresh kits' }).click();
  await expect(card.getByRole('img').first()).toHaveAttribute('src', src!);
  expect(fileRequests).toBe(7);
  const technical = card.locator('.saved-kit-technical > summary');
  await technical.focus(); await page.keyboard.press('Space');
  await expect(card.locator('.saved-kit-technical > code')).toHaveText(kit.location);
  await expect(card.locator('.saved-kit-technical')).toContainText(kit.files[0]!.sha256);
  await page.keyboard.press('Space');
  await expect(card.locator('.saved-kit-technical > code')).toBeHidden();
  await mkdir('.builder/studio-enhancements-review/saved-kits', { recursive: true });
  for (const [width, height] of [[1440, 1000], [375, 812], [430, 932], [320, 812]]) {
    await page.setViewportSize({ width: width!, height: height! });
    await card.evaluate(element => element.scrollIntoView({ block: 'start' }));
    await expect.poll(() => page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - innerWidth))).toBe(0);
    const download = card.getByRole('button', { name: 'Download Readiness checklist', exact: true });
    await expect(download).toBeEnabled();
    await card.getByRole('button', { name: 'Download Credits & attribution', exact: true }).focus();
    await page.keyboard.press('Tab');
    await expect(download).toBeFocused(); await expect(download).toBeInViewport();
    await card.evaluate(element => element.scrollIntoView({ block: 'start' }));
    await page.screenshot({ path: `.builder/studio-enhancements-review/saved-kits/saved-${width}.png` });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  for (const zoom of [2, 4]) {
    await page.evaluate(value => { document.documentElement.style.zoom = String(value); }, zoom);
    await technical.focus(); await page.keyboard.press('Enter');
    await expect(card.locator('.saved-kit-technical > code')).toBeVisible();
    await technical.evaluate(element => element.scrollIntoView({ block: 'start' }));
    await expect.poll(() => page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - innerWidth))).toBe(0);
    await page.screenshot({ path: `.builder/studio-enhancements-review/saved-kits/details-zoom-${zoom}.png` });
    await page.keyboard.press('Enter');
  }
  await page.evaluate(() => { document.documentElement.style.zoom = '1'; });
  await imageToggle.click();
  await expect(card.getByRole('img')).toHaveCount(0);
  await page.route('**/launch-kits/*/files/icon', route => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Unavailable' } }) }));
  await imageToggle.click();
  await expect(card.getByRole('button', { name: 'Retry preview of App icon · 1024 × 1024' })).toBeVisible();
  await page.unroute('**/launch-kits/*/files/icon');
  await card.getByRole('button', { name: 'Retry preview of App icon · 1024 × 1024' }).click();
  await expect(card.getByRole('img')).toHaveCount(7);
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
