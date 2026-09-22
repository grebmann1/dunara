import { closeMediaDrawer, openIconSettings } from './media-workspace-helpers.js';
import { test, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { Engine } from '../../packages/core/src/engine.js';
import { Projects } from '../../packages/core/src/projects.js';
import { startStudio } from '../../packages/cli/src/studio-server.js';
import { selectProject } from './project-picker.js';

test.use({ trace: 'off' });
let dir: string, engine: Engine, studio: Awaited<ReturnType<typeof startStudio>>, projectId: string, bytes: Buffer;
test.beforeEach(async () => {
  test.skip(!!process.env.VISUAL, 'Visual suite only');
  dir = await mkdtemp(path.join(os.tmpdir(), 'creative-destinations-'));
  engine = new Engine(await Projects.open(path.join(dir, 'apps'), path.join(dir, 'home')), false);
  projectId = (await engine.projects.create({ name: 'Creative Review', slug: 'creative-review' })).id;
  bytes = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: '#567b68' } }).png().toBuffer();
  studio = await startStudio(engine, path.resolve('dist/studio'));
});
test.afterEach(async () => { if (process.env.VISUAL) return; await studio.close(); await engine.close(); await rm(dir, { recursive: true, force: true }); });

test('icon stages keep exact diff review bounded, invalidate stale media and restore focus', async ({ page }) => {
  let library = await engine.assets.import(projectId, { expectedRevision: null, label: 'Local master', mediaType: 'image/png' }, bytes);
  const master = library.assets[0]!;
  library = await engine.assets.approve(projectId, master.id, library.revision);
  await page.goto(studio.launchUrl); await closeMediaDrawer(page); await page.getByRole('button', { name: 'App Icons', exact: true }).click();
  await openIconSettings(page); await page.getByRole('combobox', { name: 'Icon source', exact: true }).click();
  await page.getByRole('option', { name: 'Local master · approved', exact: true }).click();
  await expect(page.locator('.icon-prepare')).not.toHaveAttribute('open');
  for (const width of [320, 375, 430, 768, 1280, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const zoom of [1, 2]) {
      await page.evaluate(value => { document.documentElement.style.zoom = String(value); }, zoom);
      await openIconSettings(page); await page.getByRole('button', { name: 'Review app.json changes' }).click();
      const dialog = page.getByRole('dialog', { name: 'Proposed app.json change' });
      await expect(dialog).toBeVisible();
      const config = await engine.files.read(projectId, 'app.json');
      await expect(dialog.locator('pre').first()).toHaveText(config.content);
      const after = JSON.parse(await dialog.locator('pre').last().innerText());
      expect(after.expo.icon).toBe(`./${master.path}`);
      const bounds = await dialog.boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.y).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width + 1); expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(901);
      const consent = dialog.getByRole('checkbox');
      await consent.check(); await expect(dialog.getByRole('button', { name: 'Confirm and apply icon' })).toBeEnabled();
      const cancel = dialog.getByRole('button', { name: 'Cancel config proposal' });
      await cancel.scrollIntoViewIfNeeded(); await expect(cancel).toBeInViewport(); await cancel.click();
      await expect(page.getByRole('button', { name: 'Review app.json changes' })).toBeFocused();
      expect((await engine.files.read(projectId, 'app.json')).revision).toBe(config.revision);
    }
  }
  await page.evaluate(() => { document.documentElement.style.zoom = '1'; });
  await openIconSettings(page); await page.getByRole('button', { name: 'Review app.json changes' }).click();
  await page.getByRole('dialog').getByRole('checkbox').check();
  await engine.assets.import(projectId, { expectedRevision: library.revision, label: 'External library update', mediaType: 'image/png' }, bytes);
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('Library changed');
  await expect(page.getByRole('dialog').getByRole('checkbox')).not.toBeChecked();
  await expect(page.getByRole('button', { name: 'Confirm and apply icon' })).toBeDisabled();
  await page.getByRole('button', { name: 'Cancel config proposal' }).click();
  await openIconSettings(page); await page.getByRole('button', { name: 'Review app.json changes' }).click();
  await expect(page.getByRole('dialog').getByRole('checkbox')).not.toBeChecked();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Review app.json changes' })).toBeFocused();
});

test('icon proposal waits for its refresh so immediate Escape restores an enabled trigger', async ({ page }) => {
  const library = await engine.assets.import(projectId, { expectedRevision: null, label: 'Focus master', mediaType: 'image/png' }, bytes);
  await engine.assets.approve(projectId, library.assets[0]!.id, library.revision);
  await page.goto(studio.launchUrl);
  await closeMediaDrawer(page); await page.getByRole('button', { name: 'App Icons', exact: true }).click();
  await openIconSettings(page); await page.getByRole('combobox', { name: 'Icon source', exact: true }).click();
  await page.getByRole('option', { name: 'Focus master · approved', exact: true }).click();
  let proposalRequested = false, refreshHeld = false;
  let releaseRefresh!: () => void;
  const released = new Promise<void>(resolve => { releaseRefresh = resolve; });
  await page.route(`**/api/projects/${projectId}/media/icon-preview`, async route => {
    proposalRequested = true; await route.continue();
  });
  await page.route(`**/api/projects/${projectId}/media`, async route => {
    if (proposalRequested) { refreshHeld = true; await released; }
    await route.continue();
  });
  const trigger = page.getByRole('button', { name: 'Review app.json changes' });
  try {
    await trigger.click();
    await expect.poll(() => refreshHeld).toBe(true);
    await expect(trigger).toBeDisabled();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    releaseRefresh();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(trigger).toBeFocused();
    await expect(trigger).toBeEnabled();
  } finally { releaseRefresh(); }
});

test('Activity categories keep diagnostics and captures reachable without stale save notices', async ({ page }, testInfo) => {
  await page.goto(studio.launchUrl);
  await closeMediaDrawer(page); await page.getByRole('button', { name: 'Assets', exact: true }).click();
  await closeMediaDrawer(page); await page.getByRole('button', { name: 'Import', exact: true }).click();
  await page.getByLabel('Image file').setInputFiles({ name: 'activity-fixture.png', mimeType: 'image/png', buffer: bytes });
  await page.getByRole('button', { name: 'Import candidate', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible();
  await closeMediaDrawer(page); await page.getByRole('button', { name: 'Activity', exact: true }).click();
  const workspace = page.getByRole('main', { name: 'Activity workspace' });
  await expect(workspace.getByRole('heading', { name: 'Activity', exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('activity-desktop.png'), fullPage: true });
  await expect(workspace.getByText('Saved.', { exact: true })).toHaveCount(0);
  await workspace.getByRole('button', { name: /^Diagnostics/ }).click();
  await expect(workspace.getByRole('heading', { name: 'Diagnostics', exact: true })).toBeVisible();
  await workspace.getByRole('button', { name: /^Captures/ }).click();
  await expect(workspace.getByRole('heading', { name: 'Screenshot history', exact: true })).toBeVisible();
  await expect(workspace.getByText('No captures yet', { exact: true })).toBeVisible();
  await expect(workspace.locator('.bottom-panel')).toHaveCount(0);
  for (const viewport of [{ width: 320, height: 640 }, { width: 375, height: 812 }, { width: 430, height: 932 }, { width: 1280, height: 900 }]) {
    await page.setViewportSize(viewport);
    for (const zoom of [1, 2]) {
      await page.evaluate(value => { document.documentElement.style.zoom = String(value); }, zoom);
      await workspace.getByRole('heading', { name: 'Screenshot history', exact: true }).scrollIntoViewIfNeeded();
      await expect(workspace.getByRole('heading', { name: 'Screenshot history', exact: true })).toBeInViewport();
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
      if (zoom === 1) {
        await workspace.getByRole('heading', { name: 'Activity', exact: true }).scrollIntoViewIfNeeded();
        await page.screenshot({ path: testInfo.outputPath(`activity-${viewport.width}.png`), fullPage: true });
      }
    }
  }
  await page.evaluate(() => { document.documentElement.style.zoom = '1'; });
  await workspace.getByRole('button', { name: /^Requests/ }).click();
  await workspace.getByRole('button', { name: 'Open asset library', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Asset library', exact: true })).toBeVisible();
  await closeMediaDrawer(page); await page.getByRole('button', { name: 'Activity', exact: true }).click();
  await workspace.getByRole('button', { name: /^Captures/ }).click();
  await workspace.getByRole('button', { name: 'Prepare Launch Kit', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Launch Kit', exact: true })).toBeVisible();
});

test('Activity prioritizes pending states and opens the exact request or result without paid retries', async ({ page }) => {
  await studio.close(); await engine.close(); let calls = 0;
  engine = new Engine(await Projects.open(path.join(dir, 'apps'), path.join(dir, 'home')), false, false, {
    async run(request, _references, signal) {
      calls++;
      if (request.label === 'Completed artwork') return [bytes];
      if (request.label === 'Failed artwork') throw new Error('Offline stub failure');
      return await new Promise<Buffer[]>((_, reject) => signal.addEventListener('abort', () => reject(new Error('Cancelled')), { once: true }));
    },
  });
  studio = await startStudio(engine, path.resolve('dist/studio'));
  const request = async (label: string) => engine.mediaJobs.request(projectId, { requestId: crypto.randomUUID(), expectedRevision: (await engine.assets.list(projectId)).revision, label, operation: 'generate', prompt: `Exact disclosure for ${label}`, count: 1 });
  const approve = async (id: string) => engine.mediaJobs.approve(projectId, id, engine.mediaJobs.providerStatus().revision);
  const completed = await request('Completed artwork'); await approve(completed.id);
  await expect.poll(async () => (await engine.mediaJobs.get(projectId, completed.id)).state).toBe('succeeded');
  const failed = await request('Failed artwork'); await approve(failed.id);
  await expect.poll(async () => (await engine.mediaJobs.get(projectId, failed.id)).state).toBe('failed');
  for (let n = 0; n < 20; n++) { const job = await request(`Cancelled history ${n}`); await engine.mediaJobs.cancel(projectId, job.id); }
  await request('First pending'); await request('Second pending');
  const running = await request('Running artwork'); await approve(running.id);
  await expect.poll(async () => (await engine.mediaJobs.get(projectId, running.id)).state).toBe('running');
  const queued = await request('Queued artwork'); await approve(queued.id);
  const other = await engine.projects.create({ name: 'Other creative project', slug: 'other-creative' });
  await page.goto(studio.launchUrl); await closeMediaDrawer(page); await selectProject(page, projectId); await closeMediaDrawer(page); await page.getByRole('button', { name: 'Activity', exact: true }).click();
  const cards = page.locator('.activity-job');
  await expect(cards).toHaveCount(26);
  const states = await cards.locator('.asset-status').allTextContents();
  expect(states.slice(0, 4).sort()).toEqual(['awaiting-approval', 'awaiting-approval', 'queued', 'running']);
  await expect(page.locator('.workspace-drawer')).toHaveCount(0);
  for (const width of [320, 375, 430, 768, 1280, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(() => { document.documentElement.style.zoom = '2'; });
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
    await cards.filter({ hasText: 'Failed artwork' }).getByRole('button', { name: 'Open request Failed artwork' }).click();
    await expect(page.getByRole('article', { name: 'Failed artwork request' })).toBeVisible();
    await closeMediaDrawer(page);
  }
  await page.evaluate(() => { document.documentElement.style.zoom = '1'; });
  await cards.filter({ hasText: 'Second pending' }).getByRole('button', { name: 'Open request Second pending' }).click();
  const target = page.getByRole('article', { name: 'Second pending request', exact: true });
  await expect(target).toBeFocused(); await expect(target.locator('.media-prompt')).toHaveText('Exact disclosure for Second pending');
  await expect(target.getByRole('button', { name: 'Approve paid request' })).toBeDisabled();
  await target.getByRole('button', { name: 'Cancel local job' }).click();
  await expect(target.getByRole('heading', { level: 3 })).toContainText('Cancelled');
  expect((await engine.mediaJobs.list(projectId)).jobs.find(job => job.request.label === 'First pending')!.state).toBe('awaiting-approval');
  await closeMediaDrawer(page); await page.getByRole('button', { name: 'Activity', exact: true }).click();
  await cards.filter({ hasText: 'Running artwork' }).getByRole('button', { name: 'Open request Running artwork' }).click();
  const runningCard = page.getByRole('article', { name: 'Running artwork request', exact: true });
  await expect(runningCard).toBeFocused(); await expect(runningCard.locator(':scope > details')).toHaveAttribute('open');
  await engine.mediaJobs.cancel(projectId, queued.id); await runningCard.getByRole('button', { name: 'Cancel local job' }).click();
  await closeMediaDrawer(page); await page.getByRole('button', { name: 'Activity', exact: true }).click();
  await cards.filter({ hasText: 'Completed artwork' }).getByRole('button', { name: /^View Completed/ }).click();
  await expect(page.locator('.asset-review')).toContainText('Completed artwork');
  await closeMediaDrawer(page); await page.getByRole('button', { name: 'Activity', exact: true }).click(); await closeMediaDrawer(page); await selectProject(page, other.id);
  await closeMediaDrawer(page); await page.getByRole('button', { name: 'Activity', exact: true }).click();
  await expect(page.getByText('No image requests yet', { exact: true })).toBeVisible();
  await expect(cards).toHaveCount(0); expect(calls).toBe(3);
});

test('a populated gallery keeps its toolbar pinned and isolates icon selection from browsing', async ({ page }, testInfo) => {
  let library = await engine.assets.list(projectId);
  for (let index = 1; index <= 18; index++) library = await engine.assets.import(projectId, { expectedRevision: library.revision, label: `Artwork ${String(index).padStart(2, '0')}`, mediaType: 'image/png' }, bytes);
  await engine.assets.approve(projectId, library.assets[0]!.id, library.revision);
  await page.goto(studio.launchUrl);
  await page.getByRole('button', { name: 'Assets', exact: true }).click();
  for (const viewport of [{ width: 1280, height: 700 }, { width: 375, height: 812 }, { width: 430, height: 932 }]) {
    await page.setViewportSize(viewport); await closeMediaDrawer(page);
    const toolbar = page.locator('.library-toolbar'), generator = page.getByRole('button', { name: 'Generate', exact: true });
    await expect(toolbar).toBeVisible();
    await expect(page.locator('.library-scroll img')).toHaveCount(18);
    await expect.poll(() => page.locator('.library-scroll img').evaluateAll(images => images.every(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0))).toBe(true);
    const top = (await toolbar.boundingBox())!.y;
    await page.getByRole('button', { name: 'Artwork 18', exact: true }).scrollIntoViewIfNeeded();
    expect((await toolbar.boundingBox())!.y).toBe(top);
    await expect(generator).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollHeight - innerHeight)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: testInfo.outputPath(`gallery-scrolled-${viewport.width}.png`) });
    await page.getByRole('searchbox', { name: 'Search assets' }).fill('Artwork 01');
    await expect(page.locator('.asset-tile')).toHaveCount(1);
    await page.getByRole('button', { name: 'Artwork 01', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Create a variation', exact: true })).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath(`asset-inspector-${viewport.width}.png`) });
    await closeMediaDrawer(page); await page.getByRole('searchbox', { name: 'Search assets' }).fill('');
  }
  await page.setViewportSize({ width: 1440, height: 900 }); await closeMediaDrawer(page);
  await page.getByRole('combobox', { name: 'Asset status', exact: true }).click();
  await page.getByRole('option', { name: 'Approved', exact: true }).click();
  await expect(page.locator('.asset-tile')).toHaveCount(1);
  await page.getByRole('button', { name: 'Use selected image in App Icons' }).click();
  await expect(page.getByRole('combobox', { name: 'Icon source', exact: true })).toContainText('Artwork 01');
  await page.getByRole('button', { name: 'Assets', exact: true }).click();
  await page.getByRole('combobox', { name: 'Asset status', exact: true }).click();
  await page.getByRole('option', { name: 'All assets', exact: true }).click();
  await page.getByRole('button', { name: 'Artwork 02', exact: true }).click();
  await page.getByRole('button', { name: 'App Icons', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Icon source', exact: true })).toContainText('Artwork 01');
});

test('Activity groups repeated output, preserves exact diagnostics and filters a bounded list', async ({ page }, testInfo) => {
  for (let index = 0; index < 98; index++) engine.diagnostics.add(projectId, 'preview', 'info', 'Preview bundle ready');
  engine.diagnostics.add(projectId, 'browser', 'error', 'Image unavailable\nExact image error details');
  engine.diagnostics.add(projectId, 'builder', 'error', 'Review the selected route');
  await page.goto(studio.launchUrl); await page.getByRole('button', { name: 'Activity', exact: true }).click();
  const activity = page.getByRole('main', { name: 'Activity workspace', exact: true });
  await expect(activity).toBeVisible();
  await activity.getByRole('button', { name: /^Diagnostics/ }).click();
  await expect(activity.locator('.diagnostic-row')).toHaveCount(2);
  await activity.getByRole('combobox', { name: 'Diagnostic level' }).click();
  await page.getByRole('option', { name: 'All output · 100', exact: true }).click();
  await expect(activity.locator('.diagnostic-row')).toHaveCount(3);
  await expect(activity.locator('.diagnostic-row').filter({ hasText: 'Preview bundle ready' })).toContainText('×98');
  await activity.getByRole('searchbox', { name: 'Search diagnostics' }).fill('Image');
  await expect(activity.locator('.diagnostic-row')).toHaveCount(1);
  await activity.locator('.diagnostic-row summary').click();
  await expect(activity.locator('.diagnostic-row pre')).toHaveText('Image unavailable\nExact image error details');
  await activity.getByRole('searchbox', { name: 'Search diagnostics' }).fill('');
  for (const viewport of [{ width: 1280, height: 700 }, { width: 375, height: 812 }, { width: 430, height: 932 }]) {
    await page.setViewportSize(viewport);
    await expect(page.getByRole('group', { name: 'Activity categories' })).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollHeight - innerHeight)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: testInfo.outputPath(`diagnostics-${viewport.width}.png`) });
  }
});

test('workspace navigation waits for the initial session so the first click is retained', async ({ page }) => {
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/studio', async route => { await ready; await route.continue(); });
  try {
    await page.goto(studio.launchUrl);
    await expect(page.getByRole('button', { name: 'Assets', exact: true })).toBeDisabled();
    release();
    await page.getByRole('button', { name: 'Assets', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Asset library', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Assets', exact: true })).toHaveAttribute('aria-pressed', 'true');
  } finally { release(); }
});
