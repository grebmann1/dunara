import { test, expect } from '@playwright/test';
import { mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Engine } from '../../packages/core/src/engine.js';
import { Projects } from '../../packages/core/src/projects.js';
import { ProjectJourney } from '../../packages/core/src/journey.js';
import { startStudio } from '../../packages/cli/src/studio-server.js';
import type { Project } from '../../packages/core/src/contracts.js';

let root: string, engine: Engine, studio: Awaited<ReturnType<typeof startStudio>>, project: Project;
test.use({ trace: 'off', actionTimeout: 10_000 });
test.beforeEach(async ({ page }) => {
  test.skip(!!process.env.VISUAL, 'Visual baseline suite only');
  root = await mkdtemp(path.join(os.tmpdir(), 'dunara-reliability-'));
  engine = new Engine(await Projects.open(path.join(root, 'apps'), path.join(root, 'home')), false);
  project = await engine.projects.create({ name: 'Garden ideas', slug: 'garden-ideas' });
  studio = await startStudio(engine, path.resolve('dist/studio'));
  await page.goto(studio.launchUrl);
  await expect(page.locator('.creation-guide')).toContainText('1/7 done');
});
test.afterEach(async ({ page }) => {
  if (process.env.VISUAL) return;
  await page.close(); await studio.close(); await engine.close(); await rm(root, { recursive: true, force: true });
});

test('saves progress and an app brief across fresh browsers and opens delivery preparation', async ({ page, browser }, info) => {
  const guide = page.getByRole('dialog', { name: 'Your app journey', exact: true });
  await page.locator('.creation-guide-trigger').click();
  await guide.getByLabel('Your app brief').fill('Help neighbors share their gardening ideas.');
  await guide.getByRole('button', { name: 'Save & continue', exact: true }).click();
  await expect(page.locator('.creation-guide')).toContainText('2/7 done');
  await guide.getByRole('button', { name: /Add assets/ }).click();
  await guide.getByRole('button', { name: 'Do this later', exact: true }).click();
  await expect(guide.getByRole('button', { name: /Add assets/ })).toContainText('Later');
  const context = await browser.newContext({ reducedMotion: 'reduce' });
  try {
    const fresh = await context.newPage();
    await fresh.goto(studio.issueLaunchUrl());
    const saved = fresh.getByRole('dialog', { name: 'Your app journey', exact: true });
    await expect(fresh.locator('.creation-guide')).toContainText('2/7 done');
    await fresh.locator('.creation-guide-trigger').click();
    await saved.getByRole('button', { name: /Ideate/ }).click();
    await expect(saved.getByLabel('Your app brief')).toHaveValue('Help neighbors share their gardening ideas.');
    await expect(saved.getByRole('button', { name: /Add assets/ })).toContainText('Later');
    expect(await fresh.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('builder.creation-guide')))).toEqual([]);
    for (const size of [{ width: 375, height: 812 }, { width: 430, height: 932 }, { width: 1440, height: 1100 }]) {
      await fresh.setViewportSize(size);
      await saved.getByRole('button', { name: /Build To do/ }).click();
      const build = saved.getByRole('button', { name: 'Open build setup', exact: true });
      await build.click({ trial: true });
      await expect(build).toBeInViewport({ ratio: 1 });
      expect(await fresh.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
      await fresh.screenshot({ path: info.outputPath(`journey-build-${size.width}.png`) });
    }
    await saved.getByRole('button', { name: 'Open build setup', exact: true }).click();
    await expect(fresh.getByRole('dialog')).toContainText('App identity');
    await fresh.getByRole('dialog').getByRole('button', { name: 'Close dialog', exact: true }).click();
    await fresh.locator('.creation-guide-trigger').click();
    await saved.getByRole('button', { name: /Publish/ }).click();
    await expect(saved).toContainText('A Launch Kit does not publish your app.');
    await saved.getByRole('button', { name: 'Open Launch Kit', exact: true }).click();
    await expect(fresh.locator('#workspace-content')).toHaveAttribute('data-workspace', 'assets');
    await expect(fresh.getByRole('heading', { name: 'Launch Kit', exact: true })).toBeVisible();
  } finally { await context.close(); }
});

test('marks recorded testing stale when app source changes', async ({ page }) => {
  const journey = new ProjectJourney(engine.projects, id => engine.boardCaptures.sourceRevision(id));
  await journey.update(project.id, { expectedRevision: (await journey.read(project.id)).revision, patch: { tested: true }, sourceRevision: await engine.boardCaptures.sourceRevision(project.id) });
  const guide = page.getByRole('dialog', { name: 'Your app journey', exact: true });
  await page.locator('.creation-guide-trigger').click();
  await guide.getByRole('button', { name: /Preview & test/ }).click();
  await expect(guide.getByRole('button', { name: /Preview & test/ })).toContainText('Done');
  const file = await engine.files.read(project.id, 'app/index.tsx');
  await engine.files.write(project.id, [{ path: file.path, content: file.content + '\n// revised\n', expectedRevision: file.revision }]);
  await expect(guide.getByRole('button', { name: /Preview & test/ })).toContainText('Check again');
  await expect(guide).toContainText('Your app changed since your last recorded checks.');
  await expect(guide.getByRole('button', { name: 'I’ve tested my app', exact: true })).toBeDisabled();
});

test('recovers a missing selected folder while healthy apps stay usable and removal keeps source', async ({ page }, info) => {
  const healthy = await engine.projects.create({ name: 'Healthy app', slug: 'healthy-app' });
  const saved = path.join(root, 'saved-app');
  await rename(project.root, saved);
  await expect(page.getByRole('combobox', { name: 'Project', exact: true })).toContainText('Healthy app');
  await expect(page.getByRole('button', { name: '+ New app', exact: true })).toBeEnabled();
  const recovery = page.locator('.unavailable-projects');
  await recovery.locator('summary').click();
  await expect(recovery).toContainText(project.root);
  for (const size of [{ width: 375, height: 812 }, { width: 430, height: 932 }, { width: 1440, height: 1100 }]) {
    await page.setViewportSize(size);
    await recovery.scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: info.outputPath(`project-recovery-${size.width}.png`) });
  }
  await rename(saved, project.root);
  await recovery.getByRole('button', { name: 'Check again', exact: true }).click();
  await expect(recovery).toHaveCount(0);
  await rename(project.root, saved);
  await expect(recovery).toBeVisible();
  await recovery.locator('summary').click();
  await recovery.getByRole('button', { name: 'Remove from list', exact: true }).click();
  await expect(recovery).toContainText('does not delete any app files');
  await recovery.getByRole('button', { name: 'Confirm removal', exact: true }).click();
  await expect(recovery).toHaveCount(0);
  expect(await readFile(path.join(saved, 'app.json'), 'utf8')).toContain('Garden ideas');
  expect(await engine.projects.list()).toEqual([healthy]);
});

test('clears a missing last project and still permits a new app', async ({ page }) => {
  await rename(project.root, path.join(root, 'saved-app'));
  await expect(page.getByRole('heading', { name: 'Create your first app', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '+ New app', exact: true }).click();
  await page.getByLabel('App name', { exact: true }).fill('Fresh app');
  await page.getByRole('button', { name: 'Create app', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Project', exact: true })).toContainText('Fresh app');
  await expect(page.locator('.unavailable-projects')).toContainText('1 unavailable app');
});

test('retains an unsaved brief until the user reviews concurrent progress', async ({ page }, info) => {
  const guide = page.getByRole('dialog', { name: 'Your app journey', exact: true });
  await page.locator('.creation-guide-trigger').click();
  await guide.getByLabel('Your app brief').fill('My retained draft.');
  const journey = new ProjectJourney(engine.projects, id => engine.boardCaptures.sourceRevision(id));
  await journey.update(project.id, { expectedRevision: (await journey.read(project.id)).revision, patch: { brief: 'A newer saved brief.' } });
  await expect(guide).toContainText('Progress changed while you were editing.');
  await expect(guide.getByLabel('Your app brief')).toHaveValue('My retained draft.');
  await expect(guide.getByRole('button', { name: 'Save brief', exact: true })).toBeDisabled();
  for (const size of [{ width: 375, height: 812 }, { width: 430, height: 932 }, { width: 1440, height: 1100 }]) {
    await page.setViewportSize(size);
    await guide.getByLabel('Your app brief').scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: info.outputPath(`brief-conflict-${size.width}.png`) });
  }
  await guide.getByRole('button', { name: 'Review my draft against latest progress', exact: true }).click();
  await guide.getByRole('button', { name: 'Save brief', exact: true }).click();
  await expect.poll(async () => (await journey.read(project.id)).preferences.brief).toBe('My retained draft.');
});

test('imports browser choices explicitly without treating old test flags as current evidence', async ({ page }) => {
  await page.evaluate(id => localStorage.setItem(`builder.creation-guide.v1:${id}`, JSON.stringify({ idea: true, assetsLater: true, tested: true })), project.id);
  await page.goto(studio.issueLaunchUrl());
  const guide = page.getByRole('dialog', { name: 'Your app journey', exact: true });
  await page.locator('.creation-guide-trigger').click();
  await guide.getByRole('button', { name: 'Import saved browser progress', exact: true }).click();
  await expect(page.locator('.creation-guide')).toContainText('2/7 done');
  await expect(guide.getByRole('button', { name: /Add assets/ })).toContainText('Later');
  await expect(guide.getByRole('button', { name: /Preview & test/ })).toContainText('To do');
  await expect(guide.getByRole('button', { name: 'Import saved browser progress', exact: true })).toHaveCount(0);
});
