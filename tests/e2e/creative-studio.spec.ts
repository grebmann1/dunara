import { closeMediaDrawer, openIconSettings } from './media-workspace-helpers.js';
import { test, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import { Engine } from '../../packages/core/src/engine.js';
import { Projects } from '../../packages/core/src/projects.js';
import { startStudio } from '../../packages/cli/src/studio-server.js';
import type { JobRequest } from '../../packages/core/src/media-job-contracts.js';

test.use({ trace: 'off', actionTimeout: 15_000 });
let directory: string, engine: Engine, studio: Awaited<ReturnType<typeof startStudio>>, projectId: string, requests: JobRequest[];
test.beforeEach(async () => {
  test.skip(!!process.env.VISUAL, 'Visual suite only');
  directory = await mkdtemp(path.join(os.tmpdir(), 'creative-studio-')); requests = [];
  const png = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: '#416a57' } }).png().toBuffer();
  engine = new Engine(await Projects.open(path.join(directory, 'apps'), path.join(directory, 'home')), false, false, { async run(request) { requests.push(request); return Array.from({ length: request.count }, () => png); } });
  projectId = (await engine.projects.create({ name: 'Still', slug: 'still' })).id;
  await engine.assets.brief(projectId, null, { purpose: 'A daily reset through small mindful rituals', audience: 'Busy people seeking a quieter moment', mood: 'Calm, warm, quietly optimistic', palette: 'Forest green, warm ivory, soft sage', imageStyle: 'Tactile natural forms', avoid: 'Busy compositions and tiny text', referenceIds: [] });
  studio = await startStudio(engine, path.resolve('dist/studio'));
});
test.afterEach(async ({ page }) => { if (process.env.VISUAL) return; await page.close(); await studio.close(); await engine.close(); await rm(directory, { recursive: true, force: true }); });

test('creative workspaces remain usable on desktop and compact phones', async ({ page }) => {
  await page.goto(studio.launchUrl);
  await closeMediaDrawer(page); await page.getByRole('button', { name: 'Assets', exact: true }).click();
  await closeMediaDrawer(page); await page.getByRole('button', { name: 'Generate', exact: true }).click();
  for (const [width, height] of [[1440, 1000], [375, 812], [430, 932]] as const) {
    await page.setViewportSize({ width, height });
    await page.screenshot({ path: test.info().outputPath(`assets-create-${width}.png`) });
    if (width < 600) {
      await page.getByRole('form', { name: 'Image generation' }).getByLabel('Image prompt').evaluate(element => element.scrollIntoView({ block: 'start' }));
      await page.screenshot({ path: test.info().outputPath(`assets-create-controls-${width}.png`) });
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await closeMediaDrawer(page); await page.getByRole('button', { name: 'App Icons', exact: true }).click();
  await page.getByRole('button', { name: 'Generate an icon', exact: true }).click();
  for (const [width, height] of [[1440, 1000], [375, 812], [430, 932]] as const) {
    await page.setViewportSize({ width, height });
    await page.screenshot({ path: test.info().outputPath(`icons-create-${width}.png`) });
    if (width < 600) {
      await page.getByRole('form', { name: 'Icon generation' }).getByRole('button', { name: 'Stage request for review' }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: test.info().outputPath(`icons-create-controls-${width}.png`) });
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  expect(requests).toHaveLength(0);
});

test('generates an app-directed icon, reviews its image, and applies it without leaving Icons', async ({ page }) => {
  await page.goto(studio.launchUrl); await closeMediaDrawer(page); await page.getByRole('button', { name: 'App Icons', exact: true }).click();
  await page.getByRole('button', { name: 'Generate an icon', exact: true }).click();
  const form = page.getByRole('form', { name: 'Icon generation' });
  await expect(form.getByRole('combobox', { name: 'Quality', exact: true })).toContainText('High');
  await expect(form.getByRole('combobox', { name: 'Output size' })).toBeDisabled();
  await form.getByRole('button', { name: 'Soft 3D', exact: true }).click();
  await form.getByLabel('Image prompt', { exact: true }).fill('A sculptural leaf folded into a quiet spiral.');
  await form.getByRole('button', { name: 'Stage request for review' }).click();
  const job = page.getByRole('article', { name: 'New app icon request' });
  await expect(job).toBeVisible(); expect(requests).toHaveLength(0);
  const staged = (await engine.mediaJobs.list(projectId)).jobs[0]!;
  expect(staged.request).toMatchObject({ role: 'app-icon', quality: 'high', size: '1024x1024', count: 1 });
  expect(staged.request.prompt).toContain('App: Still'); expect(staged.request.prompt).toContain('Forest green, warm ivory, soft sage');
  expect(staged.request.prompt).toContain('soft-touch materials'); expect(staged.request.prompt).toContain('fully opaque');
  await expect(job.locator('.media-prompt')).toHaveText(staged.request.prompt);
  await expect(job.getByRole('button', { name: 'Approve paid request' })).toBeDisabled();
  await job.getByRole('checkbox').check(); await job.getByRole('button', { name: 'Approve paid request' }).click();
  await expect(job.getByRole('button', { name: 'Review New app icon', exact: true })).toBeVisible();
  await expect(job.locator('.creative-results img')).toHaveJSProperty('naturalWidth', 1024); expect(requests).toHaveLength(1);
  for (const [width, height] of [[1440, 1000], [375, 812], [430, 932]] as const) {
    await page.setViewportSize({ width, height });
    await job.getByRole('button', { name: 'Review New app icon', exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: test.info().outputPath(`icon-generated-result-${width}.png`) });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await job.getByRole('button', { name: 'Review New app icon', exact: true }).click();
  await expect(page.getByRole('form', { name: 'Icon generation' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Approve candidate', exact: true }).click();
  await expect(page.locator('.icon-previews img')).toHaveCount(10);
  await openIconSettings(page); await page.getByRole('button', { name: 'Review app.json changes' }).click();
  await page.getByRole('checkbox', { name: 'I reviewed this exact config change and want to apply it.' }).check();
  await page.getByRole('button', { name: 'Confirm and apply icon' }).click();
  const asset = (await engine.assets.list(projectId)).assets[0]!;
  await expect.poll(async () => JSON.parse((await engine.files.read(projectId, 'app.json')).content).expo.icon).toBe(`./${asset.path}`);
  expect(requests).toHaveLength(1);
  await page.screenshot({ path: test.info().outputPath('icon-applied.png') });
});

test('artwork types, exact prompts and generation drafts survive workspace and project navigation', async ({ page }) => {
  const { selectProject } = await import('./project-picker.js');
  const other = await engine.projects.create({ name: 'Another app', slug: 'another-app' });
  await page.goto(studio.launchUrl); await closeMediaDrawer(page); await selectProject(page, projectId); await closeMediaDrawer(page); await page.getByRole('button', { name: 'Assets', exact: true }).click();
  await closeMediaDrawer(page); await page.getByRole('button', { name: 'Generate', exact: true }).click();
  const form = page.getByRole('form', { name: 'Image generation' });
  await form.getByRole('button', { name: /^Background/ }).click();
  await expect(form.getByRole('combobox', { name: 'Output size' })).toContainText('Portrait');
  await form.getByRole('button', { name: 'Paper cut', exact: true }).click();
  await form.getByLabel('Image prompt', { exact: true }).fill('Layered botanical silhouettes at dusk.');
  await form.getByRole('checkbox', { name: 'Match my app’s art direction' }).uncheck();
  await closeMediaDrawer(page); await page.getByRole('button', { name: 'App Icons', exact: true }).click();
  await page.getByRole('button', { name: 'Generate an icon', exact: true }).click();
  await page.getByRole('form', { name: 'Icon generation' }).getByLabel('Image prompt').fill('My separate icon idea.');
  await closeMediaDrawer(page); await page.getByRole('button', { name: 'Assets', exact: true }).click();
  if (!(await form.isVisible())) await page.getByRole('button', { name: 'Generate', exact: true }).click();
  await expect(form.getByLabel('Image prompt', { exact: true })).toHaveValue('Layered botanical silhouettes at dusk.');
  await closeMediaDrawer(page); await selectProject(page, other.id); await closeMediaDrawer(page); await page.getByRole('button', { name: 'Assets', exact: true }).click(); await closeMediaDrawer(page); await page.getByRole('button', { name: 'Generate', exact: true }).click();
  await expect(form.getByLabel('Image prompt', { exact: true })).toHaveValue('');
  await closeMediaDrawer(page); await selectProject(page, projectId); await closeMediaDrawer(page); await page.getByRole('button', { name: 'Assets', exact: true }).click(); await closeMediaDrawer(page); await page.getByRole('button', { name: 'Generate', exact: true }).click();
  if (!(await form.isVisible())) await page.getByRole('button', { name: 'Generate', exact: true }).click();
  await expect(form.getByLabel('Image prompt', { exact: true })).toHaveValue('Layered botanical silhouettes at dusk.');
  await expect(form.getByRole('button', { name: 'Paper cut', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await form.getByRole('button', { name: 'Stage request for review' }).click();
  await expect.poll(async () => (await engine.mediaJobs.list(projectId)).jobs.length).toBe(1);
  const job = (await engine.mediaJobs.list(projectId)).jobs[0]!;
  expect(job.request.role).toBe('background'); expect(job.request.size).toBe('1024x1536');
  expect(job.request.prompt).toContain('Layered botanical silhouettes'); expect(job.request.prompt).not.toContain('Forest green'); expect(job.request.prompt).not.toContain('App: Still');
  expect(requests).toHaveLength(0);
});

test('approved artwork can seed a variation and preserve its original', async ({ page }) => {
  const png = await sharp({ create: { width: 100, height: 100, channels: 3, background: '#b69c79' } }).png().toBuffer();
  const library = await engine.assets.list(projectId);
  const imported = await engine.assets.import(projectId, { expectedRevision: library.revision, mediaType: 'image/png', label: 'Original artwork', role: 'illustration' }, png);
  const original = imported.assets[0]!; await engine.assets.approve(projectId, original.id, imported.revision);
  await page.goto(studio.launchUrl); await closeMediaDrawer(page); await page.getByRole('button', { name: 'Assets', exact: true }).click();
  await page.getByRole('button', { name: 'Original artwork', exact: true }).click();
  await page.getByRole('button', { name: 'Create a variation', exact: true }).click();
  const form = page.getByRole('form', { name: 'Image generation' });
  await expect(form.getByRole('combobox', { name: 'Operation', exact: true })).toContainText('Edit approved image');
  await expect(form.getByRole('checkbox', { name: 'Original artwork', exact: true })).toBeChecked();
  await form.getByLabel('Image prompt').fill('Keep the subject and make the lighting warmer.');
  await form.getByRole('button', { name: 'Stage request for review' }).click();
  const job = page.getByRole('article', { name: 'Original artwork variation request' });
  await job.getByRole('checkbox').check(); await job.getByRole('button', { name: 'Approve paid request' }).click();
  await expect(job.getByRole('button', { name: 'Review Original artwork variation', exact: true })).toBeVisible();
  const result = (await engine.assets.list(projectId)).assets[1]!;
  expect(result).toMatchObject({ provenance: 'edited', parentId: original.id, status: 'candidate' });
  expect((await engine.assets.read(projectId, original.id)).asset.hash).toBe(original.hash); expect(requests).toHaveLength(1);
});
