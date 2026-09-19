import { test, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Engine } from '../../packages/core/src/engine.js';
import { Projects } from '../../packages/core/src/projects.js';
import { startStudio } from '../../packages/cli/src/studio-server.js';

test.use({ trace: 'off' });
let dir: string, engine: Engine, studio: Awaited<ReturnType<typeof startStudio>>;
test.beforeEach(async () => {
  test.skip(!!process.env.VISUAL, 'Visual suite only');
  dir = await mkdtemp(path.join(os.tmpdir(), 'studio-polish-'));
  engine = new Engine(await Projects.open(path.join(dir, 'apps'), path.join(dir, 'home')), false);
  studio = await startStudio(engine, path.resolve('dist/studio'));
});
test.afterEach(async ({ page }) => {
  if (process.env.VISUAL) return;
  await page.close(); await studio.close(); await engine.close();
  await rm(dir, { recursive: true, force: true });
});

test('Studio polish remains usable across desktop and phone layouts', async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  page.setDefaultTimeout(10_000);
  const errors: string[] = [];
  const screenshots: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const sizes = [{ width: 1440, height: 900 }, { width: 375, height: 812 }, { width: 430, height: 932 }];
  const capture = async (state: string) => {
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
    const viewport = page.viewportSize()!;
    const imagePath = testInfo.outputPath(`${state}-${viewport.width}x${viewport.height}.png`);
    await page.screenshot({ path: imagePath, fullPage: await page.getByRole('dialog').count() === 0 });
    screenshots.push(imagePath);
  };
  const resetScroll = async () => page.evaluate(() => {
    window.scrollTo(0, 0);
    document.querySelector('.workspace-content')?.scrollTo(0, 0);
  });
  await page.goto(studio.launchUrl);
  const createTrigger = page.getByRole('button', { name: '+ New app', exact: true });
  for (const size of sizes) {
    await page.setViewportSize(size);
    await resetScroll();
    await expect(page.getByRole('heading', { name: 'Create your first app', exact: true })).toBeVisible();
    await expect(createTrigger).toBeEnabled();
    await capture('empty');
    await createTrigger.click();
    const dialog = page.locator('.project-creation-dialog');
    await expect(dialog.getByLabel('App name', { exact: true })).toBeFocused();
    await dialog.getByLabel('App name', { exact: true }).fill('Bonsai Studio');
    await dialog.locator('.creation-folder summary').click();
    await dialog.getByLabel('Directory slug', { exact: true }).fill('bonsai-studio');
    await dialog.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByRole('radio', { name: /No backend for now/ }).check();
    const create = dialog.getByRole('button', { name: 'Create app', exact: true });
    await create.scrollIntoViewIfNeeded();
    await expect(create).toBeInViewport();
    await capture('create-form');
    if (size.width === 430) await create.click();
    else {
      await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
      await expect(createTrigger).toBeFocused();
      expect(await engine.projects.list()).toHaveLength(0);
    }
    await expect(dialog).toHaveCount(0);
  }
  await expect(page.getByRole('combobox', { name: 'Project', exact: true })).toHaveText('Bonsai Studio');
  const [project] = await engine.projects.list();
  expect(project?.slug).toBe('bonsai-studio');
  expect((await engine.studio.snapshot()).projectId).toBe(project!.id);
  const nav = page.locator('#studio-sidebar');
  const navigate = async (label: string, heading = label) => {
    const destination = nav.getByRole('button', { name: label, exact: true });
    await destination.scrollIntoViewIfNeeded();
    await expect(destination).toBeInViewport();
    await destination.click();
    await expect(destination).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('heading', { level: 1, name: heading, exact: true })).toBeVisible();
    await resetScroll();
  };
  for (const [index, size] of sizes.entries()) {
    await page.setViewportSize(size);
    await navigate('Preview', 'Bonsai Studio');
    await expect(page.getByRole('button', { name: 'Start preview', exact: true })).toBeDisabled();
    await expect(page.locator('.preview-status')).toHaveText('stopped');
    await page.getByRole('button', { name: 'Large phone', exact: true }).click();
    await expect.poll(() => page.locator('.device-empty').evaluate(node => [node.clientWidth, node.clientHeight])).toEqual([430, 932]);
    await capture('preview-stopped-large');
    await page.getByRole('button', { name: 'Compact phone', exact: true }).click();
    await expect.poll(() => page.locator('.device-empty').evaluate(node => [node.clientWidth, node.clientHeight])).toEqual([375, 812]);
    await capture('preview-stopped');

    await navigate('Assets');
    await capture('assets-empty');
    await page.getByRole('button', { name: 'Import', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Import an original', exact: true })).toBeVisible();
    await page.getByLabel('Asset label', { exact: true }).fill('Bonsai illustration');
    await page.getByRole('textbox', { name: 'Provenance / rights note', exact: true }).fill('Original artwork from our design team.');
    const importAction = page.getByRole('button', { name: 'Import candidate', exact: true });
    await importAction.scrollIntoViewIfNeeded();
    await expect(importAction).toBeInViewport();
    await expect(importAction).toBeDisabled();
    await capture('asset-import-form');
    await page.getByRole('button', { name: 'Close import', exact: true }).click();

    await navigate('App Icons');
    if (await page.getByRole('button', { name: 'Choose existing image', exact: true }).isVisible()) await page.getByRole('button', { name: 'Choose existing image', exact: true }).click();
    await expect(page.getByRole('combobox', { name: 'Icon source', exact: true })).toContainText('Choose an image');
    await capture('icons-empty');
    await page.getByRole('button', { name: 'Open asset library', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Assets', exact: true })).toBeVisible();

    await navigate('Activity');
    await expect(page.getByText('No image requests yet', { exact: true })).toBeVisible();
    await capture('activity-empty');
    await page.getByRole('button', { name: 'Open asset library', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Assets', exact: true })).toBeVisible();

    await navigate('Settings');
    await expect(page.getByLabel('OpenAI API key', { exact: true })).toHaveValue('');
    await capture('settings');
    const cancelKey = page.getByRole('button', { name: 'Cancel key entry', exact: true });
    await cancelKey.scrollIntoViewIfNeeded();
    await expect(cancelKey).toBeInViewport();
    await cancelKey.click();
    await expect(page.getByText('Key entry cleared.', { exact: true })).toBeVisible();

    await navigate('Preview', 'Bonsai Studio');
    const design = page.getByRole('button', { name: 'Design', exact: true });
    await design.click();
    await expect(page.getByRole('heading', { name: 'Design tokens', exact: true })).toBeVisible();
    await capture('design');
    const radius = 21 + index;
    await page.getByLabel('Corner radius', { exact: true }).fill(String(radius));
    const apply = page.getByRole('button', { name: 'Apply changes', exact: true });
    await apply.scrollIntoViewIfNeeded();
    await expect(apply).toBeInViewport();
    await expect(apply).toBeEnabled();
    await capture('design-apply');
    await apply.click();
    await expect.poll(async () => (await engine.designs.read(project!.id)).tokens.radius).toBe(radius);
    if (await page.getByRole('dialog', { name: 'App design', exact: true }).count()) await page.keyboard.press('Escape');
    else await design.click();
    await expect(page.getByRole('heading', { name: 'Design tokens', exact: true })).toBeHidden();
  }
  expect(await engine.projects.list()).toHaveLength(1);
  expect(engine.mediaJobs.providerStatus().configured).toBe(false);
  expect(engine.previews.status(project!.id).status).toBe('stopped');
  expect(errors).toEqual([]);
  await testInfo.attach('screenshots', { body: screenshots.join('\n'), contentType: 'text/plain' });
});
