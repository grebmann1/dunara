import { test, expect } from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Engine } from '../../packages/core/src/engine.js';
import { Projects } from '../../packages/core/src/projects.js';
import { ProjectJourney } from '../../packages/core/src/journey.js';
import { startStudio } from '../../packages/cli/src/studio-server.js';

let root: string, engine: Engine, studio: Awaited<ReturnType<typeof startStudio>>;
const sizes = [{ width: 375, height: 812 }, { width: 430, height: 932 }, { width: 1440, height: 1000 }];
test.use({ trace: 'off', actionTimeout: 10_000 });
test.beforeEach(async ({ page }) => {
  test.skip(!!process.env.VISUAL, 'Visual baseline suite only');
  root = await mkdtemp(path.join(os.tmpdir(), 'dunara-ux-'));
  engine = new Engine(await Projects.open(path.join(root, 'apps'), path.join(root, 'home')), true);
  studio = await startStudio(engine, path.resolve('dist/studio'));
  await page.goto(studio.launchUrl);
  await expect(page.getByRole('button', { name: '+ New app', exact: true })).toBeEnabled();
});
test.afterEach(async ({ page }) => {
  if (process.env.VISUAL) return;
  await page.close(); await studio.close(); await engine.close(); await rm(root, { recursive: true, force: true });
});

test('chooses and connects a backend before creation, retains the brief and leaves project linking for review', async ({ page }, info) => {
  await page.getByRole('button', { name: '+ New app', exact: true }).click();
  const dialog = page.locator('.project-creation-dialog');
  await dialog.getByLabel('App name', { exact: true }).fill('Garden notebook');
  await dialog.getByLabel('The idea', { exact: false }).fill('Help neighbors share their garden notes.');
  for (const size of sizes) {
    await page.setViewportSize(size);
    await expect(dialog.getByRole('button', { name: 'Continue', exact: true })).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: info.outputPath(`new-app-idea-${size.width}.png`) });
  }
  await dialog.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(dialog.getByRole('heading', { name: 'Choose your backend' })).toBeFocused();
  await expect(dialog.getByRole('button', { name: 'Create app', exact: true })).toBeDisabled();
  await dialog.getByRole('radio', { name: /^Supabase/ }).check();
  await expect(dialog.getByRole('button', { name: 'Create app', exact: true })).toBeDisabled();
  expect(await engine.projects.list()).toHaveLength(0);
  for (const size of sizes) {
    await page.setViewportSize(size);
    const save = dialog.getByRole('button', { name: 'Save Supabase connection', exact: true });
    await save.scrollIntoViewIfNeeded();
    await expect(save).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: info.outputPath(`new-app-backend-${size.width}.png`) });
    expect(await dialog.evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
  }
  await dialog.getByLabel('Personal access token', { exact: true }).fill('fixture-before-creation-token');
  await dialog.getByRole('button', { name: 'Save Supabase connection', exact: true }).click();
  await expect(dialog).toContainText('Account connection saved');
  expect(await engine.projects.list()).toHaveLength(0);
  await dialog.getByRole('button', { name: 'Create app', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('#workspace-content')).toHaveAttribute('data-workspace', 'backend');
  const [project] = await engine.projects.list();
  const journey = new ProjectJourney(engine.projects, id => engine.boardCaptures.sourceRevision(id));
  expect((await journey.read(project!.id)).preferences).toMatchObject({ brief: 'Help neighbors share their garden notes.', idea: true, backendLater: false });
  expect((await engine.backends.inspect(project!.id)).environments).toEqual([]);
  expect(await readFile(path.join(project!.root, '.mobile-builder.json'), 'utf8')).not.toContain('fixture-before-creation-token');
  expect(await page.content()).not.toContain('fixture-before-creation-token');
});

test('keeps creation cancellable, supports no backend and catches a disconnected account before submission', async ({ page }) => {
  await page.getByRole('button', { name: '+ New app', exact: true }).click();
  const dialog = page.locator('.project-creation-dialog');
  await dialog.getByRole('button', { name: 'Continue', exact: true }).click();
  await dialog.getByRole('radio', { name: /No backend for now/ }).check();
  await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
  expect(await engine.projects.list()).toHaveLength(0);
  engine.backends.configure({ token: 'fixture-disconnected-before-submit' });
  await page.getByRole('button', { name: '+ New app', exact: true }).click();
  await dialog.getByRole('button', { name: 'Continue', exact: true }).click();
  await dialog.getByRole('radio', { name: /^Supabase/ }).check();
  await expect(dialog).toContainText('Account connection saved');
  engine.backends.disconnect();
  await dialog.getByRole('button', { name: 'Create app', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Connect your Supabase account');
  expect(await engine.projects.list()).toHaveLength(0);
  await dialog.getByRole('radio', { name: /No backend for now/ }).check();
  await dialog.getByRole('button', { name: 'Create app', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const [project] = await engine.projects.list();
  const journey = new ProjectJourney(engine.projects, id => engine.boardCaptures.sourceRevision(id));
  // The dialog closes once source exists; the busy workspace then persists setup.
  await expect.poll(async () => (await journey.read(project!.id)).preferences).toMatchObject({ idea: true, backendLater: true });
  await expect(page.locator('#workspace-content')).toHaveAttribute('data-workspace', 'preview');
});

test('keeps the journey out of the canvas, preserves drafts on dismissal and displays compact guidance', async ({ page }, info) => {
  await engine.projects.create({ name: 'Garden notebook', slug: 'garden-notebook' });
  // Reconcile the new project in the authenticated session; a fresh hash is not a document reload.
  await expect(page.getByRole('combobox', { name: 'Project', exact: true })).toHaveText('Garden notebook');
  const trigger = page.locator('.creation-guide-trigger');
  const guide = page.getByRole('dialog', { name: 'Your app journey', exact: true });
  await expect(trigger).toBeVisible();
  for (const size of sizes) {
    await page.setViewportSize(size);
    const before = await page.locator('.board-heading').boundingBox();
    expect((await page.locator('.creation-guide').boundingBox())!.height).toBeLessThanOrEqual(48);
    await page.screenshot({ path: info.outputPath(`workspace-${size.width}.png`) });
    await trigger.click();
    await expect(guide).toBeVisible();
    expect((await page.locator('.board-heading').boundingBox())!.y).toBe(before!.y);
    const labels = await guide.locator('ol li').allTextContents();
    expect(labels[1]).toContain('Connect Supabase'); expect(labels[2]).toContain('Create');
    await guide.getByLabel('Your app brief').fill('A quiet space for garden ideas.');
    await expect(guide.getByRole('button', { name: 'Save & continue' })).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: info.outputPath(`journey-idea-${size.width}.png`) });
    await page.keyboard.press('Escape');
    await expect(trigger).toBeFocused();
    await trigger.click();
    await expect(guide.getByLabel('Your app brief')).toHaveValue('A quiet space for garden ideas.');
    await guide.getByRole('button', { name: 'Close dialog' }).click();
  }
});

test('a failed brief save keeps the created app and the draft without offering a duplicate submission', async ({ page }) => {
  await page.getByRole('button', { name: '+ New app', exact: true }).click();
  const dialog = page.locator('.project-creation-dialog');
  await dialog.getByLabel('The idea', { exact: false }).fill('Keep my idea if saving progress fails.');
  await dialog.getByRole('button', { name: 'Continue', exact: true }).click();
  await dialog.getByRole('radio', { name: /No backend for now/ }).check();
  await page.route('**/journey', route => route.request().method() === 'POST' ? route.fulfill({ status: 503, json: { error: { message: 'Progress unavailable' } } }) : route.continue());
  await dialog.getByRole('button', { name: 'Create app', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('alert')).toContainText('Your app was created, but its brief could not be saved');
  expect(await engine.projects.list()).toHaveLength(1);
  await page.getByRole('button', { name: '+ New app', exact: true }).click();
  await expect(dialog.getByLabel('The idea', { exact: false })).toHaveValue('Keep my idea if saving progress fails.');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(await engine.projects.list()).toHaveLength(1);
});
