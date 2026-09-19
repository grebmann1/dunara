import { openProjectRoutes } from './preview-actions.js';
import { test, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Engine } from '../../packages/core/src/engine.js';
import { Projects } from '../../packages/core/src/projects.js';
import { startStudio } from '../../packages/cli/src/studio-server.js';

let dir: string, engine: Engine, studio: Awaited<ReturnType<typeof startStudio>>;
test.beforeEach(async () => {
  test.skip(!!process.env.VISUAL, 'Visual suite only');
  dir = await mkdtemp(path.join(os.tmpdir(), 'studio-navigation-'));
  engine = new Engine(await Projects.open(path.join(dir, 'apps'), path.join(dir, 'home')), false);
  studio = await startStudio(engine, path.resolve('dist/studio'));
});
test.afterEach(async ({ page }) => {
  if (process.env.VISUAL) return;
  await page.unrouteAll({ behavior: 'wait' }); await page.close();
  await studio.close(); await engine.close(); await rm(dir, { recursive: true, force: true });
});

test('same-named projects show distinct slugs and select the intended app with mouse and keyboard', async ({ page }) => {
  const first = await engine.projects.create({ name: 'Field Notes', slug: 'field-notes-personal' });
  const second = await engine.projects.create({ name: 'Field Notes', slug: 'field-notes-team' });
  await page.goto(studio.launchUrl);
  const picker = page.getByRole('combobox', { name: 'Project', exact: true });
  await picker.click();
  const personal = page.getByRole('option', { name: `${first.name} ${first.slug}`, exact: true });
  const team = page.getByRole('option', { name: `${second.name} ${second.slug}`, exact: true });
  await expect(personal.getByText(first.slug, { exact: true })).toBeVisible();
  await expect(team.getByText(second.slug, { exact: true })).toBeVisible();
  await personal.click();
  await expect(picker).toHaveText(first.name);
  await expect(picker).toHaveAttribute('title', `${first.name} · ${first.slug}`);
  await expect.poll(async () => (await engine.studio.snapshot()).projectId).toBe(first.id);
  await expect(picker).toBeFocused();

  await picker.press('Enter');
  await page.keyboard.press('End');
  await expect(team).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('listbox')).toHaveCount(0);
  await expect(picker).toHaveText(second.name);
  await expect(picker).toHaveAttribute('title', `${second.name} · ${second.slug}`);
  await expect.poll(async () => (await engine.studio.snapshot()).projectId).toBe(second.id);
  await expect(picker).toBeFocused();
  await picker.press('Enter');
  await expect(team).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Escape');
  await expect(picker).toBeFocused();
  expect((await engine.studio.snapshot()).projectId).toBe(second.id);
});

test('workspace arrow keys move focus and Enter or Space activate real destinations', async ({ page }) => {
  await engine.projects.create({ name: 'Keyboard Studio', slug: 'keyboard-studio' });
  await page.goto(studio.launchUrl);
  const nav = page.getByRole('navigation', { name: 'Workspace', exact: true });
  const preview = nav.getByRole('button', { name: 'Preview', exact: true });
  const assets = nav.getByRole('button', { name: 'Assets', exact: true });
  const settings = nav.getByRole('button', { name: 'Settings', exact: true });
  const plugins = nav.getByRole('button', { name: 'Plugins', exact: true });
  await expect(preview).toBeEnabled();
  await expect(assets).toBeEnabled();
  await preview.focus();
  await page.keyboard.press('ArrowDown');
  await expect(assets).toBeFocused();
  await expect(preview).toHaveAttribute('aria-current', 'page');
  expect((await engine.studio.snapshot()).studio?.workspace).toBe('preview');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { level: 1, name: 'Assets', exact: true })).toBeVisible();
  await expect(assets).toHaveAttribute('aria-current', 'page');
  await expect.poll(async () => (await engine.studio.snapshot()).studio?.workspace).toBe('assets');

  await assets.focus();
  await page.keyboard.press('End');
  await expect(plugins).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(settings).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'OpenAI setup', exact: true })).toBeVisible();
  await expect.poll(async () => (await engine.studio.snapshot()).studio?.workspace).toBe('settings');
  await settings.focus();
  await page.keyboard.press('Home');
  await expect(preview).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(plugins).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(preview).toBeFocused();
  await page.keyboard.press('Space');
  await expect(page.getByRole('heading', { name: 'Keyboard Studio', exact: true })).toBeVisible();
  await expect(preview).toHaveAttribute('aria-current', 'page');
  await expect(nav.locator('[aria-current="page"]')).toHaveCount(1);
  await expect.poll(async () => (await engine.studio.snapshot()).studio?.workspace).toBe('preview');
});

test('grouped preview tools dismiss outside and retain an unfinished route', async ({ page }) => {
  await engine.projects.create({ name: 'Popover Studio', slug: 'popover-studio' });
  await page.goto(studio.launchUrl);
  const tools = page.getByLabel('Preview tools', { exact: true });
  const manualPath = page.getByLabel('Agent-added screen / manual path', { exact: true });
  await openProjectRoutes(page);
  await manualPath.fill('/settings');
  await manualPath.press('Escape');
  await expect(manualPath).toBeHidden();
  await expect(tools).toBeFocused();
  await openProjectRoutes(page);
  await expect(manualPath).toHaveValue('/settings');
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await expect(manualPath).toBeHidden();

  await tools.click();
  await page.locator('.topbar .header-project').click();
  await expect(page.getByRole('button', { name: 'Project settings', exact: true })).toBeHidden();
  await openProjectRoutes(page);
  await expect(manualPath).toHaveValue('/settings');
  await page.getByRole('button', { name: 'Open custom route', exact: true }).click();
  await expect(tools).toBeFocused();
  await expect.poll(async () => {
    const state = (await engine.studio.snapshot()).studio;
    return state?.board.views.find(view => view.id === state.board.activeId)?.route;
  }).toBe('/settings');
  await expect(manualPath).toBeHidden();
});
