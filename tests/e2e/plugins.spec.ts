import { test, expect } from '@playwright/test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Engine } from '../../packages/core/src/engine.js';
import { Projects } from '../../packages/core/src/projects.js';
import { startStudio } from '../../packages/cli/src/studio-server.js';
import { scaffoldPlugin } from '../../packages/cli/src/plugin-commands.js';
let root: string, engine: Engine, studio: Awaited<ReturnType<typeof startStudio>>, projectId: string;
test.beforeEach(async () => {
  test.skip(!!process.env.VISUAL); root = await mkdtemp(path.join(os.tmpdir(), 'plugins-browser-'));
  engine = new Engine(await Projects.open(path.join(root, 'apps'), path.join(root, 'home')), false);
  projectId = (await engine.projects.create({ name: 'Plugin fixture', slug: 'plugin-fixture' })).id;
  await scaffoldPlugin(path.join(root, 'sample')); studio = await startStudio(engine, path.resolve('dist/studio'));
  await mkdir('.builder/plugin-review', { recursive: true });
});
test.afterEach(async ({ page }) => { if (process.env.VISUAL) return; await page.close(); await studio.close(); await engine.close(); await rm(root, { recursive: true, force: true }); });
for (const [width, height] of [[375, 812], [430, 932]] as const) {
  test(`guides, external panels and reviewed recipes at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height }); await page.goto(studio.launchUrl);
    await page.getByRole('button', { name: 'Plugins', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Plugins', exact: true })).toBeVisible();
    await page.getByRole('button', { name: /Plugin Guide.*Included with Dunara/ }).click();
    await expect(page.getByRole('heading', { name: 'Build a feature. Share a plugin.' })).toBeVisible();
    await page.getByRole('button', { name: 'For your assistant', exact: true }).click();
    await expect(page.locator('.plugin-guide')).toContainText('@mobile-builder/plugin-sdk');
    await page.locator('#workspace-content').evaluate(element => { element.scrollTop = 0; }); await page.evaluate(() => window.scrollTo(0, 0)); await page.getByRole('heading', { name: 'Plugins', exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: `.builder/plugin-review/guide-${width}.png` });
    await page.getByRole('heading', { name: 'Build a feature. Share a plugin.' }).evaluate(element => element.scrollIntoView({ block: 'center' }));
    await page.screenshot({ path: `.builder/plugin-review/guide-panel-${width}.png` });
    await page.getByRole('button', { name: 'Install plugin', exact: true }).click();
    await page.getByLabel('Package path').fill(path.join(root, 'sample'));
    await page.getByRole('button', { name: 'Inspect package', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Install and enable' })).toBeDisabled();
    await page.getByLabel('I trust this plugin. Its code can access my computer and data.').check();
    await page.getByRole('button', { name: 'Install and enable' }).click();
    await expect(page.getByRole('heading', { name: 'My app notes', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Inspect app source', exact: true }).click();
    await expect(page.locator('.plugin-surface pre')).toContainText('app/index.tsx');
    await page.locator('#workspace-content').evaluate(element => { element.scrollTop = 0; }); await page.evaluate(() => window.scrollTo(0, 0)); await page.getByRole('heading', { name: 'Plugins', exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: `.builder/plugin-review/external-${width}.png` });
    await page.getByRole('heading', { name: 'My app notes', exact: true }).evaluate(element => element.scrollIntoView({ block: 'center' }));
    await page.screenshot({ path: `.builder/plugin-review/external-panel-${width}.png` });
    await page.getByRole('button', { name: 'Review recipe', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Review proposed changes' })).toBeVisible();
    await expect(engine.files.read(projectId, 'APP-NOTES.md')).rejects.toThrow();
    await page.getByRole('button', { name: 'Apply reviewed changes' }).click();
    await expect.poll(async () => await engine.files.read(projectId, 'APP-NOTES.md').then(file => file.content).catch(() => '')).toContain('My app');
    await page.getByRole('button', { name: 'Disable', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'My app notes', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Uninstall', exact: true }).click();
    await expect.poll(() => engine.plugins.snapshot().some(p => p.id === 'example.project-notes')).toBe(false);
    expect((await engine.files.read(projectId, 'APP-NOTES.md')).content).toContain('My app');
    for (const name of ['Supabase', 'Dunara Account']) {
      await page.getByRole('button', { name: new RegExp(`${name}.*Included with Dunara`) }).click();
      await page.getByRole('button', { name: 'Disable', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Enable', exact: true })).toBeVisible();
    }
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Project details', exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Dunara account', exact: true })).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Supabase connection', exact: true })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'OpenAI setup', exact: true })).toBeVisible();
    await page.screenshot({ path: `.builder/plugin-review/disabled-settings-${width}.png` });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}
