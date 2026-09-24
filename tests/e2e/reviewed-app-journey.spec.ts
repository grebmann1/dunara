import { test, expect, type Page } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Engine } from '../../packages/core/src/engine.js';
import { Projects } from '../../packages/core/src/projects.js';
import { startStudio } from '../../packages/cli/src/studio-server.js';
import { closeMediaDrawer } from './media-workspace-helpers.js';

let root: string, engine: Engine, projectId: string, studio: Awaited<ReturnType<typeof startStudio>>, preview: Server;
test.use({ trace: 'off', actionTimeout: 10_000 });
test.beforeEach(async ({ page }) => {
  test.skip(!!process.env.VISUAL, 'Workflow fixture');
  root = await mkdtemp(path.join(os.tmpdir(), 'dunara-reviewed-journey-'));
  engine = new Engine(await Projects.open(path.join(root, 'apps'), path.join(root, 'home')), true);
  const project = await engine.projects.create({ name: 'Garden ideas', slug: 'garden-ideas' }); projectId = project.id;
  await Promise.all((await readdir(path.join(project.root, 'app'))).filter(name => !['index.tsx', '_layout.tsx'].includes(name)).map(name => rm(path.join(project.root, 'app', name), { recursive: true, force: true })));
  const layout = await engine.files.read(projectId, 'app/_layout.tsx');
  await engine.files.write(projectId, [{ path: layout.path, expectedRevision: layout.revision, content: '<Tabs><Tabs.Screen name="index" options={{ title: "Garden" }} /></Tabs>' }]);
  preview = createServer((_req, res) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end('<!doctype html><html><body style="margin:0;padding:24px;background:#f6f2e7;color:#234338;font:18px system-ui"><h1>My garden</h1><div style="height:220px;border-radius:24px;background:#acc6b1;display:grid;place-items:center;font-size:96px">盆栽</div><h2>Today’s care</h2><button>Water my bonsai</button></body></html>'); });
  await new Promise<void>(resolve => preview.listen(0, '127.0.0.1', resolve));
  const address = preview.address(); if (!address || typeof address === 'string') throw Error('No preview port');
  engine.previews.status = id => ({ projectId: id, status: 'ready', url: `http://localhost:${address.port}` });
  studio = await startStudio(engine, path.resolve(process.env.DUNARA_STUDIO_TEST_ASSETS ?? 'dist/studio'));
  await page.goto(studio.launchUrl);
});
test.afterEach(async ({ page }) => {
  if (process.env.VISUAL) return;
  await page.close(); await studio?.close(); await engine?.close(); preview?.closeAllConnections();
  await new Promise<void>(resolve => preview?.close(() => resolve())); await rm(root, { recursive: true, force: true });
});
async function captureLayouts(page: Page, label: string) {
  for (const [width, height] of [[375, 812], [430, 932], [1440, 1000]] as const) {
    await page.setViewportSize({ width, height });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`${label}-${width}.png`) });
  }
}
test('checks both screen sizes, invalidates changed source, and exposes Android prerequisites', async ({ page }) => {
  await page.locator('.creation-guide-trigger').click();
  const guide = page.getByRole('dialog', { name: 'Your app journey', exact: true });
  await guide.getByRole('button', { name: /Preview & test/ }).click();
  const evidence = guide.getByRole('region', { name: 'Verification evidence' });
  await evidence.getByRole('button', { name: 'Check web screens' }).click();
  await expect(evidence).toContainText('Web rendering checked', { timeout: 30_000 });
  await expect(evidence).toContainText('2/2 current screen captures');
  await evidence.scrollIntoViewIfNeeded(); await captureLayouts(page, 'verification');
  const source = await engine.files.read(projectId, 'app/index.tsx');
  await engine.files.write(projectId, [{ path: source.path, expectedRevision: source.revision, content: source.content + '\n// new revision\n' }]);
  await expect(evidence).toContainText('Web checks incomplete');
  await expect(evidence).toContainText('0/2 current screen captures');
  await guide.getByRole('button', { name: /Build To do/ }).click();
  await guide.getByRole('button', { name: 'Open build setup', exact: true }).click();
  const android = page.getByRole('region', { name: 'Install on Android', exact: true });
  await page.route('**/android-deliveries/preflight', route => route.fulfill({ json: { available: false, devices: [], issues: ['Install Android Studio and configure an Android SDK before building.'] } }));
  await android.getByRole('button', { name: 'Check Android setup' }).click();
  await expect(android).toContainText('Install Android Studio');
  await android.scrollIntoViewIfNeeded(); await captureLayouts(page, 'android-setup');
  await expect(android.getByRole('button', { name: 'Build reviewed APK' })).toHaveCount(0);
});
test('imports an approved screen reference and previews placement without editing app source', async ({ page }) => {
  const source = await engine.files.read(projectId, 'app/index.tsx');
  await engine.boardCaptures.capture(projectId, '/');
  await page.getByRole('button', { name: 'Assets', exact: true }).click(); await closeMediaDrawer(page);
  await page.getByRole('button', { name: 'Generate', exact: true }).click();
  const form = page.getByRole('form', { name: 'Image generation' });
  await form.getByRole('button', { name: 'Add screen as approved reference' }).click();
  await expect(form.getByRole('region', { name: 'Visual references' })).toContainText('1 selected');
  const library = await engine.assets.list(projectId), reference = library.assets[0]!;
  expect(reference.status).toBe('approved'); expect(reference.label).toContain('Screen reference');
  await form.getByRole('region', { name: 'Visual references' }).scrollIntoViewIfNeeded(); await captureLayouts(page, 'screen-reference');
  await closeMediaDrawer(page);
  await page.getByRole('button', { name: reference.label, exact: true }).click();
  const placement = page.locator('.asset-placement').filter({ visible: true });
  await placement.locator('summary').click();
  await expect(placement.locator('.asset-placement-screen')).toBeVisible();
  await expect(placement).toContainText('No app files have changed');
  await placement.getByRole('combobox', { name: 'Placement', exact: true }).click();
  await page.getByRole('option', { name: 'Character / avatar', exact: true }).click();
  for (const [width, height] of [[375, 812], [430, 932], [1440, 1000]] as const) {
    await page.setViewportSize({ width, height });
    await expect(page.locator('.media-workbench')).toHaveAttribute('data-compact', String(width < 1000));
    if (!await placement.isVisible()) await page.getByRole('button', { name: 'Details', exact: true }).click();
    await expect(placement).toHaveAttribute('open', '');
    await expect(placement.getByRole('combobox', { name: 'Placement', exact: true })).toContainText('Character / avatar');
    await expect(placement.locator('.asset-placement-screen')).toBeVisible();
    await expect(placement.locator('.asset-placement-art img')).toBeVisible();
    await expect.poll(() => placement.locator('img').evaluateAll(images => images.every(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0))).toBe(true);
    await placement.locator('.asset-placement-phone').scrollIntoViewIfNeeded();
    await page.screenshot({ path: test.info().outputPath(`placement-${width}.png`) });
  }
  expect((await engine.files.read(projectId, source.path)).revision).toBe(source.revision);
});
