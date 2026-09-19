import { openPreviewTools } from './preview-actions.js';
import { test, expect } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Engine } from '../../packages/core/src/engine.js';
import { Projects } from '../../packages/core/src/projects.js';
import { startStudio } from '../../packages/cli/src/studio-server.js';

let dir: string, engine: Engine, projectId: string, studio: Awaited<ReturnType<typeof startStudio>>, app: Server;
let appOrigin: string;
test.use({ trace: 'off' });
test.beforeEach(async ({ page }) => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'builder-modes-'));
  engine = new Engine(await Projects.open(path.join(dir, 'apps'), path.join(dir, 'home')), true);
  const project = await engine.projects.create({ name: 'Lune Review', slug: 'lune-review' }); projectId = project.id;
  // This fixture owns exactly four routes, regardless of added starter examples.
  await Promise.all((await readdir(path.join(project.root, 'app'))).filter(name => !['index.tsx', '_layout.tsx'].includes(name)).map(name => rm(path.join(project.root, 'app', name), { recursive: true, force: true })));
  const layout = await engine.files.read(projectId, 'app/_layout.tsx');
  await engine.files.write(projectId, [{ path: layout.path, expectedRevision: layout.revision, content: `<Tabs>${[['index', 'Tonight'], ['schedule', 'Schedule'], ['ritual', 'Ritual'], ['journal', 'Journal']].map(([name, title]) => `<Tabs.Screen name="${name}" options={{ title: '${title}' }} />`).join('')}</Tabs>` }, ...['schedule', 'ritual', 'journal'].map(name => ({ path: `app/${name}.tsx`, expectedRevision: null, content: 'export default function Screen() { return null; }' }))]);
  app = createServer((req, res) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(`<!doctype html><html><head><style>body{margin:0;padding:28px;background:#151429;color:#ede9ff;font:16px system-ui}h1{font:38px Georgia}input,button{padding:12px;max-width:100%;box-sizing:border-box}nav{position:fixed;bottom:0;left:0;right:0;padding:24px;background:#201e37}a{color:#c5bbfa}</style></head><body><p>☾ lune</p><h1>${req.url === '/' ? 'Tonight' : req.url?.slice(1)}</h1><p>A little room for rest.</p><input aria-label="App draft" placeholder="Your note"><div style="height:900px"></div><button onclick="this.textContent='Done'">Bottom action</button><nav><a href="/schedule">Schedule</a> · <a href="/journal">Journal</a></nav></body></html>`); });
  await new Promise<void>(resolve => app.listen(0, '127.0.0.1', resolve)); const address = app.address(); if (!address || typeof address === 'string') throw new Error('Missing app server'); appOrigin = `http://localhost:${address.port}`;
  engine.previews.status = id => ({ projectId: id, status: 'ready', url: appOrigin });
  studio = await startStudio(engine, path.resolve('dist/studio'));
  await page.goto(studio.launchUrl);
  await expect(page.getByRole('button', { name: 'All screens', exact: true })).toBeVisible();
});
test.afterEach(async ({ page }) => { await page.close(); await studio?.close(); await engine?.close(); app?.closeAllConnections(); await new Promise<void>(resolve => app?.close(() => resolve())); await rm(dir, { recursive: true, force: true }); });

test('saved overview, focused interaction and deliberate comparisons use bounded live previews', async ({ page }, info) => {
  await expect(page.locator('iframe')).toHaveCount(1);
  await page.getByRole('button', { name: 'All screens', exact: true }).click();
  await expect(page.locator('iframe')).toHaveCount(0);
  await expect(page.locator('.screen-card')).toHaveCount(4);
  await expect(page.locator('.screen-thumbnail img')).toHaveCount(4, { timeout: 60_000 });
  await expect(page.getByRole('button', { name: 'Refresh screens', exact: true })).toBeVisible();
  expect(await page.locator('.screen-thumbnail img').evaluateAll(images => images.every(image => (image as HTMLImageElement).naturalWidth === 375))).toBe(true);
  await page.screenshot({ path: info.outputPath('overview-desktop.png'), fullPage: true });
  await page.getByLabel('Select Tonight', { exact: true }).check();
  await page.getByLabel('Select Schedule', { exact: true }).check();
  await page.getByRole('button', { name: 'Compare selected', exact: true }).click();
  await expect(page.locator('iframe')).toHaveCount(2);
  await expect(page.getByLabel('Left screen', { exact: true })).toHaveValue('/');
  await expect(page.getByLabel('Right screen', { exact: true })).toHaveValue('/schedule');
  await page.getByLabel('Compare by', { exact: true }).selectOption('sizes');
  await page.getByLabel('Screen', { exact: true }).selectOption('/schedule');
  await expect.poll(() => page.locator('iframe').evaluateAll(frames => frames.map(frame => [frame.clientWidth, frame.clientHeight]))).toEqual([[375, 812], [430, 932]]);
  await expect(page.locator('iframe').nth(0)).toHaveAttribute('src', `${appOrigin}/schedule`);
  await expect(page.locator('iframe').nth(1)).toHaveAttribute('src', `${appOrigin}/schedule`);
  const widths = await page.locator('iframe').evaluateAll(frames => frames.map(frame => frame.getBoundingClientRect().width));
  expect(widths[1]! / widths[0]!).toBeCloseTo(430 / 375, 2);
  await expect(page.frameLocator('iframe').nth(0).getByLabel('App draft')).toBeVisible();
  await page.screenshot({ path: info.outputPath('compare-desktop.png'), fullPage: true });
  await page.getByRole('button', { name: 'Focus', exact: true }).click();
  await expect(page.locator('iframe')).toHaveCount(1);
  await page.frameLocator('iframe').getByLabel('App draft').fill('A retained draft');
  await page.getByRole('button', { name: 'Assets', exact: true }).click();
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(page.frameLocator('iframe').getByLabel('App draft')).toHaveValue('A retained draft');
  await page.getByRole('button', { name: 'All screens', exact: true }).click();
  await page.getByRole('button', { name: 'Open Journal in Focus', exact: true }).click();
  await expect(page.locator('iframe')).toHaveCount(1);
  await expect(page.locator('iframe')).toHaveAttribute('src', `${appOrigin}/journal`);
  await page.screenshot({ path: info.outputPath('focus-desktop.png'), fullPage: true });
  const snapshot = await engine.studio.snapshot();
  expect(snapshot.studio?.board).toMatchObject({ mode: 'focus', comparison: 'sizes' });
});

test('captures survive source changes and refresh failures; all modes fit compact windows', async ({ page }, info) => {
  await page.getByRole('button', { name: 'All screens', exact: true }).click();
  await expect(page.locator('.screen-thumbnail img')).toHaveCount(4, { timeout: 60_000 });
  await expect(page.getByRole('button', { name: 'Refresh screens', exact: true })).toBeVisible();
  const original = await engine.boardCaptures.list(projectId);
  const source = await engine.files.read(projectId, 'app/journal.tsx');
  await engine.files.write(projectId, [{ path: source.path, expectedRevision: source.revision, content: source.content + '\n// Changed by another editor' }]);
  await expect(page.getByText('Source changed', { exact: true })).toHaveCount(4);
  const canvasBounds = (await page.getByRole('region', { name: 'Screen overview canvas' }).boundingBox())!;
  await page.mouse.move(canvasBounds.x + 12, canvasBounds.y + 70); await page.mouse.wheel(20, 20);
  const firstScreen = page.getByRole('article', { name: 'Tonight screen', exact: true });
  const beforeFailure = (await firstScreen.boundingBox())!;
  await page.route(`**/api/projects/${projectId}/board-captures`, route => route.fulfill({ status: 400, json: { error: { message: 'Preview is busy. Try again.' } } }));
  await page.getByRole('button', { name: 'Refresh Journal', exact: true }).click();
  await expect(page.getByText(/Previous capture retained/)).toBeVisible();
  await expect.poll(async () => Math.abs((await firstScreen.boundingBox())!.y - beforeFailure.y)).toBeLessThan(2);
  await expect(page.locator('.screen-thumbnail img')).toHaveCount(4);
  expect((await engine.boardCaptures.list(projectId)).map(capture => capture.id)).toEqual(original.map(capture => capture.id));
  for (const width of [375, 430]) {
    await page.setViewportSize({ width, height: width === 375 ? 812 : 932 });
    for (const mode of ['All screens', 'Focus', 'Compare']) {
      await page.getByRole('button', { name: mode, exact: true }).click();
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
      if (mode === 'All screens') {
        await expect(page.locator('iframe')).toHaveCount(0);
        const boxes = await page.locator('.screen-card').evaluateAll(cards => cards.slice(0, 2).map(card => card.getBoundingClientRect().top));
        expect(boxes[0]).toEqual(boxes[1]);
      } else {
        await expect(page.locator('iframe')).toHaveCount(mode === 'Focus' ? 1 : 2);
        await page.getByRole('button', { name: mode === 'Focus' ? 'Fit' : 'Fit all', exact: true }).click();
        const canvas = page.getByRole('region', { name: 'Phone preview canvas' });
        await expect.poll(() => canvas.evaluate(node => { const area = node.getBoundingClientRect(), phones = node.querySelector('.device-fit')!.getBoundingClientRect(); return phones.width <= area.width && phones.height <= area.height || !!document.querySelector('.canvas-hint'); })).toBe(true);
        if (mode === 'Focus') await expect.poll(() => page.evaluate(() => {
          const phone = document.querySelector('.live-board .device-fit')!.getBoundingClientRect(), toolbar = document.querySelector('.live-board .canvas-controls')!.getBoundingClientRect();
          return phone.bottom <= toolbar.top;
        })).toBe(true);
      }
      await page.screenshot({ path: info.outputPath(`${mode.toLowerCase().replace(' ', '-')}-${width}.png`), fullPage: true });
    }
  }
});

test('screen management saves names, order and manual paths without editing app routes', async ({ page }, info) => {
  const before = await engine.files.read(projectId, 'app/index.tsx');
  await openPreviewTools(page);
  await page.getByRole('button', { name: 'Manage screens', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Manage screens', exact: true });
  await expect(dialog.getByRole('heading', { name: 'Manage screens', exact: true })).toBeFocused();
  for (const [width, height] of [[1440, 900], [375, 812], [430, 932]] as const) {
    await page.setViewportSize({ width, height });
    const bounds = (await dialog.boundingBox())!, input = (await dialog.getByLabel('Name for /', { exact: true }).boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(12); expect(bounds.y).toBeGreaterThanOrEqual(12);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width - 12); expect(bounds.y + bounds.height).toBeLessThanOrEqual(height - 12);
    expect(input.x - bounds.x).toBeGreaterThanOrEqual(24);
    await expect(dialog.getByRole('button', { name: 'Save screens', exact: true })).toBeInViewport({ ratio: 0.99 });
    expect(await dialog.evaluate(node => node.scrollWidth - node.clientWidth)).toBe(0);
    await page.screenshot({ path: info.outputPath(`screen-manager-${width}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await dialog.getByLabel('Name for /', { exact: true }).fill('Bedtime');
  await dialog.getByRole('button', { name: 'Move Journal up', exact: true }).click();
  await dialog.getByRole('button', { name: 'Hide Ritual', exact: true }).click();
  await dialog.locator('.screen-manager-add > summary').click();
  await dialog.getByLabel('Add a manual path', { exact: true }).fill('/settings');
  await dialog.getByRole('button', { name: 'Add screen', exact: true }).click();
  await dialog.getByRole('button', { name: 'Save screens', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole('button', { name: 'All screens', exact: true }).click();
  await expect(page.locator('.screen-card-heading strong')).toHaveText(['Bedtime', 'Schedule', 'Journal', 'Settings']);
  expect((await engine.files.read(projectId, 'app/index.tsx')).revision).toBe(before.revision);
  expect((await engine.studio.snapshot()).studio?.board.screens?.map(screen => screen.route)).toEqual(['/', '/schedule', '/journal', '/settings']);
  await openPreviewTools(page);
  await page.getByRole('button', { name: 'Manage screens', exact: true }).click();
  await dialog.getByRole('button', { name: 'Use discovered screens', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.screen-card-heading strong')).toHaveText(['Tonight', 'Schedule', 'Ritual', 'Journal']);
});

test('long screen lists scroll inside the dialog while actions stay visible and Cancel discards edits', async ({ page }, info) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await openPreviewTools(page);
  await page.getByRole('button', { name: 'Manage screens', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Manage screens', exact: true });
  await dialog.getByLabel('Name for /', { exact: true }).fill('Unsaved name');
  await dialog.locator('.screen-manager-add > summary').click();
  for (let index = 0; index < 8; index++) {
    await dialog.getByLabel('Add a manual path', { exact: true }).fill(`/settings/screen-${index}`);
    await dialog.getByRole('button', { name: 'Add screen', exact: true }).click();
  }
  const footer = dialog.locator('.screen-manager-footer');
  const fixedFooter = await footer.boundingBox();
  await dialog.getByLabel('Add a manual path', { exact: true }).fill('/' + 'long-route-'.repeat(16));
  await dialog.getByRole('button', { name: 'Add screen', exact: true }).click();
  expect(await footer.boundingBox()).toEqual(fixedFooter);
  await expect(dialog.getByRole('button', { name: 'Save screens', exact: true })).toBeInViewport({ ratio: 0.99 });
  await expect(dialog.getByRole('heading', { name: 'Manage screens', exact: true })).toBeInViewport({ ratio: 0.99 });
  expect(await dialog.locator('.screen-manager-body').evaluate(node => node.scrollHeight > node.clientHeight && node.scrollWidth === node.clientWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('screen-manager-long-375.png'), fullPage: true });
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByLabel('Preview tools', { exact: true })).toBeFocused();
  await openPreviewTools(page);
  await page.getByRole('button', { name: 'Manage screens', exact: true }).click();
  await expect(dialog.getByLabel('Name for /', { exact: true })).toHaveValue('Tonight');
  await expect(dialog.locator('.managed-screen')).toHaveCount(4);
  await dialog.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByLabel('Preview tools', { exact: true })).toBeFocused();
});

test('one compact toolbar groups secondary tools and reveals selection actions only when needed', async ({ page }, info) => {
  await page.getByRole('button', { name: 'All screens', exact: true }).click();
  await expect(page.locator('.screen-thumbnail img')).toHaveCount(4, { timeout: 60_000 });
  await expect(page.getByRole('button', { name: 'Refresh screens', exact: true })).toBeVisible();
  const header = page.locator('.board-heading'), canvas = page.getByRole('region', { name: 'Screen overview canvas' });
  const camera = () => canvas.locator('.device-fit').boundingBox();
  const originalCamera = await camera();
  const height = (await header.boundingBox())!.height;
  expect(height).toBeLessThanOrEqual(68);
  const chromeHeight = await canvas.evaluate(node => node.getBoundingClientRect().top - node.closest('.workspace-content')!.getBoundingClientRect().top);
  expect(chromeHeight).toBeLessThanOrEqual(72);
  await expect(page.locator('.overview-selection')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Manage screens', exact: true })).toBeHidden();
  await openPreviewTools(page);
  await expect(page.getByRole('button', { name: 'Manage screens', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Project routes', exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('grouped-toolbar-menu.png'), fullPage: true });
  await page.getByLabel('Preview tools', { exact: true }).press('Escape');
  await expect(page.getByLabel('Preview tools', { exact: true })).toBeFocused();
  await expect(page.getByRole('button', { name: 'Manage screens', exact: true })).toBeHidden();
  expect(await camera()).toEqual(originalCamera);
  await page.getByLabel('Select Tonight', { exact: true }).check();

  await page.getByLabel('Select Schedule', { exact: true }).check();

  await expect(page.locator('.overview-selection')).toBeVisible();
  await expect(canvas.locator('.screen-card').first()).toBeInViewport({ ratio: 0.99 });
  expect(await camera()).toEqual(originalCamera);
  await expect(page.getByRole('button', { name: 'Compare selected', exact: true })).toBeVisible();
  expect((await header.boundingBox())!.height).toBe(height);
  await page.screenshot({ path: info.outputPath('grouped-toolbar-selection.png'), fullPage: true });
  await page.getByRole('button', { name: 'Clear selection', exact: true }).click();
  await expect(page.locator('.overview-selection')).toBeHidden();
  expect(await camera()).toEqual(originalCamera);
  await page.screenshot({ path: info.outputPath('grouped-toolbar-desktop.png'), fullPage: true });
  for (const width of [375, 430]) {
    await page.setViewportSize({ width, height: width === 375 ? 812 : 932 });
    await openPreviewTools(page);
    const menu = page.locator('.preview-tools > .preview-popover');
    await expect(menu).toBeInViewport();
    const rect = (await menu.boundingBox())!;
    expect(rect.x).toBeGreaterThanOrEqual(0); expect(rect.x + rect.width).toBeLessThanOrEqual(width);
    await page.screenshot({ path: info.outputPath(`grouped-menu-${width}.png`), fullPage: true });
    await page.getByLabel('Preview tools', { exact: true }).press('Escape');
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
    await page.screenshot({ path: info.outputPath(`grouped-toolbar-${width}.png`), fullPage: true });
  }
});

test('workspace console exposes bounded diagnostics and captures while preview actions show clear states', async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.frameLocator('iframe').getByLabel('App draft').fill('Keep my live preview');
  const frame = await page.locator('iframe').elementHandle();
  const consolePanel = page.getByRole('contentinfo', { name: 'Workspace console' });
  const diagnostics = consolePanel.getByRole('button', { name: 'Diagnostics', exact: true });
  await expect(diagnostics).toHaveAttribute('aria-expanded', 'false');
  for (let index = 0; index < 50; index++) engine.diagnostics.add(projectId, 'preview', 'info', `Preview output ${index}`);
  engine.diagnostics.add(projectId, 'preview', 'info', '\n  \n');
  engine.diagnostics.add(projectId, 'browser', 'error', '\nImage could not load\nCheck the image path in app/index.tsx');
  await expect(consolePanel).toContainText('1 error');
  await expect(diagnostics).toHaveAttribute('aria-expanded', 'false');
  await openPreviewTools(page);
  await expect(page.locator('.preview-tools')).not.toContainText('Activity & captures');
  await expect(page.locator('.preview-tools').getByRole('region', { name: 'Diagnostics', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Project settings', exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('short-preview-menu.png'), fullPage: true });
  await diagnostics.click();
  await expect(page.locator('.preview-tools')).not.toHaveAttribute('open', '');
  await expect(consolePanel.locator('.diagnostic-row')).toHaveCount(1);
  await expect(consolePanel.locator('.diagnostic-row summary')).toContainText('Image could not load');
  await consolePanel.locator('.diagnostic-row summary').click();
  await expect(consolePanel.locator('pre')).toContainText('Check the image path');
  expect(await frame!.evaluate(node => node.isConnected)).toBe(true);
  await expect(page.frameLocator('iframe').getByLabel('App draft')).toHaveValue('Keep my live preview');
  for (const [width, height] of [[1440, 900], [375, 812], [430, 932]] as const) {
    await page.setViewportSize({ width, height });
    await expect(consolePanel).toBeInViewport({ ratio: 0.99 });
    expect((await consolePanel.boundingBox())!.height).toBeLessThan(height * 0.6);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
    await page.screenshot({ path: info.outputPath(`console-diagnostics-${width}.png`), fullPage: true });
  }
  await consolePanel.getByRole('searchbox', { name: 'Search diagnostics' }).fill('not found');
  await expect(consolePanel.getByText('No matching output', { exact: true })).toBeVisible();
  await consolePanel.getByRole('searchbox', { name: 'Search diagnostics' }).press('Escape');
  await expect(diagnostics).toBeFocused();
  await expect(diagnostics).toHaveAttribute('aria-expanded', 'false');
  await page.setViewportSize({ width: 1440, height: 900 });
  await engine.captures.capture(projectId, '/', 'compact'); engine.diagnostics.emit('change', projectId);
  await consolePanel.getByRole('button', { name: 'Captures', exact: true }).click();
  const capture = consolePanel.getByRole('button', { name: 'Open capture of / · compact', exact: true });
  await expect(capture).toBeVisible();
  await page.screenshot({ path: info.outputPath('console-captures.png'), fullPage: true });
  await capture.click();
  const viewer = page.getByRole('dialog', { name: 'Capture · / · compact', exact: true });
  await expect(viewer.getByRole('img')).toBeVisible();
  await viewer.press('Escape');
  await expect(capture).toBeFocused();
  await consolePanel.getByRole('button', { name: 'Collapse console', exact: true }).click();
  await openPreviewTools(page); await page.getByRole('button', { name: 'Project settings', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Project details', exact: true })).toContainText(projectId);
  await expect(consolePanel).toBeVisible();
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  let running = true;
  engine.previews.status = id => ({ projectId: id, status: running ? 'ready' : 'stopped', ...(running ? { url: appOrigin } : {}) });
  engine.previews.stop = async id => { running = false; return engine.previews.status(id); };
  engine.previews.start = async id => { running = true; return engine.previews.status(id); };
  const stop = page.getByRole('button', { name: 'Stop preview', exact: true });
  await expect(stop).toHaveCSS('color', 'rgb(180, 35, 24)');
  await stop.click();
  const start = page.getByRole('button', { name: 'Start preview', exact: true });
  await expect(start).toBeEnabled(); await expect(start).toHaveCSS('color', 'rgb(22, 101, 52)');
  await page.screenshot({ path: info.outputPath('preview-start-green.png'), fullPage: true });
  await start.click(); await expect(stop).toBeEnabled();
});

test('preview tools open focused dialogs and project information lives in Settings', async ({ page }, info) => {
  engine.previews.status = id => ({ projectId: id, status: 'ready', url: appOrigin, deviceUrl: 'exp://192.0.2.1:8081' });
  engine.diagnostics.emit('change', projectId);
  const device = page.getByRole('button', { name: 'Connect a device', exact: true });
  await expect(device).toBeVisible();
  await device.click();
  const connection = page.getByRole('dialog', { name: 'Connect a device', exact: true });
  await expect(connection).toContainText('exp://192.0.2.1:8081');
  await page.screenshot({ path: info.outputPath('device-connection.png'), fullPage: true });
  await connection.press('Escape'); await expect(device).toBeFocused();
  for (const [width, height] of [[375, 812], [430, 932]] as const) {
    await page.setViewportSize({ width, height });
    for (const tool of ['Project routes', 'Canvas help']) {
      await openPreviewTools(page); await page.getByRole('button', { name: tool, exact: true }).click();
      const dialog = page.getByRole('dialog', { name: tool, exact: true });
      await expect(dialog.getByRole('heading', { name: tool, exact: true })).toBeFocused();
      await expect(dialog).toBeInViewport({ ratio: 0.99 });
      expect(await dialog.evaluate(node => node.scrollWidth - node.clientWidth)).toBe(0);
      await page.screenshot({ path: info.outputPath(`${tool.replace(' ', '-')}-${width}.png`), fullPage: true });
      await dialog.press('Escape');
      await expect(page.getByLabel('Preview tools', { exact: true })).toBeFocused();
    }
    await openPreviewTools(page); await page.getByRole('button', { name: 'Project settings', exact: true }).click();
    const project = page.getByRole('region', { name: 'Project details', exact: true });
    await expect(project).toContainText(projectId);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
    await page.screenshot({ path: info.outputPath(`project-settings-${width}.png`) });
    await page.getByRole('button', { name: 'Preview', exact: true }).click();
  }
});

test('overview scrolling and background dragging move the camera while screens keep their world positions', async ({ page }, info) => {
  await page.getByRole('button', { name: 'All screens', exact: true }).click();
  await expect(page.locator('.screen-thumbnail img')).toHaveCount(4, { timeout: 60_000 });
  await expect(page.getByRole('button', { name: 'Refresh screens', exact: true })).toBeVisible();
  const canvas = page.getByRole('region', { name: 'Screen overview canvas' });
  const grid = canvas.locator('.device-fit');
  const level = page.getByRole('status', { name: 'Canvas zoom level', exact: true });
  const remainsStill = () => canvas.evaluate(async node => {
    const start = [node.scrollLeft, node.scrollTop], end = performance.now() + 2200;
    while (performance.now() < end) {
      await new Promise(requestAnimationFrame);
      if (node.scrollLeft !== start[0] || node.scrollTop !== start[1]) return false;
    }
    return true;
  });
  expect(await remainsStill()).toBe(true);
  const world = () => canvas.locator('.screen-card').evaluateAll(nodes => nodes.map(node => {
    const item = node as HTMLElement;
    return [item.offsetLeft, item.offsetTop, item.offsetWidth, item.offsetHeight];
  }));
  const layout = await world();
  await expect(page.getByRole('button', { name: 'Pan canvas', exact: true })).toHaveCount(0);
  await expect(canvas).toHaveCSS('cursor', 'grab');
  const first = (await canvas.locator('.screen-card').nth(0).boundingBox())!, second = (await canvas.locator('.screen-card').nth(1).boundingBox())!;
  const gap = { x: (first.x + first.width + second.x) / 2, y: first.y + first.height / 2 };
  const beforeGap = (await grid.boundingBox())!;
  await page.mouse.move(gap.x, gap.y); await page.mouse.down();
  await page.mouse.move(gap.x + 25, gap.y - 25, { steps: 4 }); await page.mouse.up();
  await expect.poll(async () => (await grid.boundingBox())!.x - beforeGap.x).toBeCloseTo(25, 0);
  await expect.poll(async () => (await grid.boundingBox())!.y - beforeGap.y).toBeCloseTo(-25, 0);
  expect(await world()).toEqual(layout);
  await page.getByRole('button', { name: 'Fit all', exact: true }).click();
  const bounds = (await canvas.boundingBox())!;
  const before = (await grid.boundingBox())!;
  const zoomBefore = await level.innerText();
  await page.mouse.move(bounds.x + 12, bounds.y + 70);
  await page.mouse.wheel(-120, -70);
  await expect.poll(async () => (await grid.boundingBox())!.x - before.x).toBeCloseTo(120, 0);
  await expect.poll(async () => (await grid.boundingBox())!.y - before.y).toBeCloseTo(70, 0);
  await expect(level).toHaveText(zoomBefore);
  expect(await world()).toEqual(layout);
  const scrolled = (await grid.boundingBox())!;
  await page.mouse.move(bounds.x + 12, bounds.y + 70);
  await page.mouse.down();
  await expect(canvas).toHaveCSS('cursor', 'grabbing');
  await page.mouse.move(bounds.x + 100, bounds.y + 130, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await grid.boundingBox())!.x - scrolled.x).toBeCloseTo(88, 0);
  await expect.poll(async () => (await grid.boundingBox())!.y - scrolled.y).toBeCloseTo(60, 0);
  expect(await world()).toEqual(layout);
  const moved = (await grid.boundingBox())!;
  await page.mouse.move(bounds.x + 140, bounds.y + 200, { steps: 8 });
  expect(await grid.boundingBox()).toEqual(moved);
  await expect(canvas).not.toHaveAttribute('data-dragging');
  expect(await remainsStill()).toBe(true);

  // The dotted scene and the captures share the same camera movement.
  const origins = await canvas.evaluate(node => {
    const scene = node.querySelector('.canvas-surface')!.getBoundingClientRect(), grid = node.querySelector('.device-fit')!.getBoundingClientRect();
    return { x: grid.x - scene.x, y: grid.y - scene.y };
  });
  await page.keyboard.down('Shift'); await page.mouse.wheel(0, 60); await page.keyboard.up('Shift');
  await expect.poll(async () => (await grid.boundingBox())!.x - moved.x).toBeCloseTo(-60, 0);
  expect(await canvas.evaluate(node => {
    const scene = node.querySelector('.canvas-surface')!.getBoundingClientRect(), grid = node.querySelector('.device-fit')!.getBoundingClientRect();
    return { x: grid.x - scene.x, y: grid.y - scene.y };
  })).toEqual(origins);

  await page.getByRole('button', { name: 'Fit all', exact: true }).click();
  await page.getByLabel('Select Tonight', { exact: true }).check();
  await page.getByRole('button', { name: 'Zoom to selected screen', exact: true }).click();
  const screenBox = (await page.getByRole('article', { name: 'Tonight screen', exact: true }).boundingBox())!;
  expect(screenBox.x + screenBox.width / 2).toBeCloseTo(bounds.x + bounds.width / 2, 0);
  const anchor = { x: bounds.x + bounds.width * 0.6, y: bounds.y + bounds.height * 0.4 };
  const unzoomed = (await grid.boundingBox())!;
  const selectedZoom = await level.innerText();
  await page.mouse.move(anchor.x, anchor.y);
  await page.keyboard.down('Control'); await page.mouse.wheel(0, -100); await page.keyboard.up('Control');
  await expect(level).not.toHaveText(selectedZoom);
  const zoomed = (await grid.boundingBox())!, ratio = zoomed.width / unzoomed.width;
  expect(Math.abs((anchor.x - unzoomed.x) * ratio - (anchor.x - zoomed.x))).toBeLessThan(2);
  expect(Math.abs((anchor.y - unzoomed.y) * ratio - (anchor.y - zoomed.y))).toBeLessThan(2);
  const camera = await canvas.evaluate(node => ({ left: node.scrollLeft, top: node.scrollTop }));
  const zoom = await level.innerText();
  await page.getByRole('button', { name: 'Open Tonight in Focus', exact: true }).click();
  await expect(page.locator('iframe')).toHaveCount(1);
  await page.getByRole('button', { name: 'All screens', exact: true }).click();
  await expect(level).toHaveText(zoom);
  await expect.poll(() => canvas.evaluate(node => ({ left: node.scrollLeft, top: node.scrollTop }))).toEqual(camera);
  await expect(page.getByLabel('Select Tonight', { exact: true })).toBeChecked();
  await canvas.focus(); await canvas.press('0');
  await expect.poll(() => canvas.evaluate(node => {
    const area = node.getBoundingClientRect(), grid = node.querySelector('.device-fit')!.getBoundingClientRect();
    const controls = node.closest('.overview-board')!.querySelector('.canvas-controls')!.getBoundingClientRect();
    return grid.left >= area.left && grid.right <= area.right && grid.top >= area.top && grid.bottom <= controls.top;
  })).toBe(true);
  await page.screenshot({ path: info.outputPath('overview-camera-desktop.png'), fullPage: true });
  for (const width of [375, 430]) {
    await page.setViewportSize({ width, height: width === 375 ? 812 : 932 });
    await expect.poll(world).toEqual(layout);
    await page.getByRole('button', { name: 'Fit all', exact: true }).click();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
    await page.screenshot({ path: info.outputPath(`overview-camera-${width}.png`), fullPage: true });
  }
});
