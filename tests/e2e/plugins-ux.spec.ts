import { test, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Engine } from '../../packages/core/src/engine.js';
import { Projects } from '../../packages/core/src/projects.js';
import { startStudio } from '../../packages/cli/src/studio-server.js';
import { scaffoldPlugin } from '../../packages/cli/src/plugin-commands.js';

let root: string, engine: Engine, studio: Awaited<ReturnType<typeof startStudio>>;
test.use({ trace: 'off' });
test.beforeEach(async ({ page }) => {
  test.skip(!!process.env.VISUAL);
  root = await mkdtemp(path.join(os.tmpdir(), 'plugins-ux-'));
  engine = new Engine(await Projects.open(path.join(root, 'apps'), path.join(root, 'home')), false);
  studio = await startStudio(engine, path.resolve('dist/studio'));
  await page.goto(studio.launchUrl); await page.getByRole('button', { name: 'Plugins', exact: true }).click();
});
test.afterEach(async ({ page }) => { if (process.env.VISUAL) return; await page.close(); await studio.close(); await engine.close(); await rm(root, { recursive: true, force: true }); });

test('search and detail navigation retain keyboard focus, readable guides and bounded responsive layouts', async ({ page }, info) => {
  for (const [width, height] of [[375, 812], [430, 932], [1024, 768], [1440, 1000]]) {
    await page.setViewportSize({ width: width!, height: height! });
    const search = page.getByRole('searchbox', { name: 'Search plugins' });
    await search.fill('No plugin matches this');
    await expect(page.getByText(/^No matching plugins\./)).toBeVisible();
    await page.getByRole('button', { name: 'Clear search', exact: true }).click();
    await search.fill('Supabase');
    const card = page.getByRole('button', { name: /Supabase.*Included with Dunara/ });
    await card.focus(); await page.keyboard.press('Enter');
    const detail = page.getByRole('region', { name: 'Plugin details', exact: true });
    await expect(detail.locator('h2').first()).toBeFocused();
    await expect(page.getByLabel('Input (JSON)')).toBeHidden();
    await page.getByRole('button', { name: 'For you', exact: true }).click();
    await expect(page.locator('.plugin-guide').getByRole('heading', { name: 'Supabase', exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await detail.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath('plugin-detail-' + width + '.png') });
    if (width! <= 1024) {
      await expect(search).toBeHidden();
      await page.getByRole('button', { name: 'All plugins', exact: true }).click();
      await expect(card).toBeFocused(); await expect(search).toHaveValue('Supabase');
    } else {
      await expect(search).toBeVisible();
      await page.evaluate(() => { document.documentElement.style.zoom = '2'; });
      await expect(search).toBeHidden();
      await page.getByRole('button', { name: 'All plugins', exact: true }).click();
      await expect(card).toBeFocused();
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.evaluate(() => { document.documentElement.style.zoom = ''; });
    }
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Plugins', exact: true }).click();
  }
});

test('a late guide response cannot replace the newly selected plugin', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let requested = false;
  await page.route('**/plugins/guide', async route => {
    if (route.request().postDataJSON().id !== 'builder.supabase') return route.continue();
    requested = true; await gate;
    await route.fulfill({ json: { content: '# Late Supabase guide' } });
  });
  await page.getByRole('button', { name: /Supabase.*Included with Dunara/ }).click();
  await page.getByRole('button', { name: 'For you', exact: true }).click();
  await expect.poll(() => requested).toBe(true);
  await page.getByRole('button', { name: 'All plugins', exact: true }).click();
  await page.getByRole('button', { name: /Dunara Account.*Included with Dunara/ }).click();
  release();
  await page.getByRole('button', { name: 'For you', exact: true }).click();
  await expect(page.locator('.plugin-guide').getByRole('heading', { name: 'Dunara Account', exact: true })).toBeVisible();
  await expect(page.locator('.plugin-detail')).not.toContainText('Late Supabase guide');
});

test('cancelling package inspection restores focus and discards late results and installation consent', async ({ page }) => {
  await scaffoldPlugin(path.join(root, 'sample'));
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let requested = false;
  await page.route('**/plugins/inspect', async route => {
    const response = await route.fetch(); requested = true; await gate;
    await route.fulfill({ response }).catch(() => {});
  });
  const trigger = page.getByRole('button', { name: 'Install plugin', exact: true });
  const dialog = page.getByRole('dialog', { name: 'Install a local plugin', exact: true });
  await trigger.click(); await page.getByLabel('Package path').fill(path.join(root, 'sample'));
  await page.getByRole('button', { name: 'Inspect package', exact: true }).click();
  await expect.poll(() => requested).toBe(true);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).toHaveCount(0); await expect(trigger).toBeFocused();
  release(); await page.unroute('**/plugins/inspect');
  await trigger.click();
  await expect(dialog.getByRole('region', { name: 'Package review' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Inspect package', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Install and enable', exact: true })).toBeDisabled();
  await page.getByLabel('I trust this plugin. Its code can access my computer and data.').check();
  await expect(page.getByRole('button', { name: 'Install and enable', exact: true })).toBeEnabled();
  await page.keyboard.press('Escape'); await expect(trigger).toBeFocused();
  await trigger.click(); await page.getByRole('button', { name: 'Inspect package', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Install and enable', exact: true })).toBeDisabled();
  expect(engine.plugins.snapshot().some(plugin => plugin.id === 'example.project-notes')).toBe(false);
});
