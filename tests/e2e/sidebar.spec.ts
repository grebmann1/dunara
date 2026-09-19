import { test, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Engine } from '../../packages/core/src/engine.js';
import { Projects } from '../../packages/core/src/projects.js';
import { startStudio } from '../../packages/cli/src/studio-server.js';

let root: string, engine: Engine, studio: Awaited<ReturnType<typeof startStudio>>;
test.use({ trace: 'off' });
test.beforeEach(async () => {
  test.skip(!!process.env.VISUAL);
  root = await mkdtemp(path.join(os.tmpdir(), 'sidebar-'));
  engine = new Engine(await Projects.open(path.join(root, 'apps'), path.join(root, 'home')), false);
  await engine.projects.create({ name: 'Garden notebook', slug: 'garden-notebook' });
  await engine.projects.create({ name: 'Field Notes', slug: 'field-notes-personal' });
  await engine.projects.create({ name: 'Field Notes', slug: 'field-notes-team' });
  studio = await startStudio(engine, path.resolve('dist/studio'));
});
test.afterEach(async ({ page }) => { if (process.env.VISUAL) return; await page.close(); await studio.close(); await engine.close(); await rm(root, { recursive: true, force: true }); });

test('project navigation filters names and slugs, keeps focus and selects only on activation', async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 1000 }); await page.goto(studio.launchUrl);
  const projects = page.getByRole('region', { name: 'Projects', exact: true });
  const search = projects.getByRole('searchbox', { name: 'Filter projects' });
  await search.fill('unmatched');
  await expect(projects).toContainText('No matching projects.');
  await projects.getByRole('button', { name: 'Clear filter' }).click();
  await search.fill('field-notes');
  const personal = projects.getByRole('button', { name: 'Field Notes field-notes-personal', exact: true });
  const team = projects.getByRole('button', { name: 'Field Notes field-notes-team', exact: true });
  await personal.click(); await expect(personal).toHaveAttribute('aria-pressed', 'true');
  await personal.press('End'); await expect(team).toBeFocused();
  await expect(personal).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Enter');
  await expect(team).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('combobox', { name: 'Project', exact: true })).toHaveAttribute('title', 'Field Notes · field-notes-team');
  await projects.getByRole('button', { name: 'Projects', exact: true }).click();
  await expect(search).toBeHidden();
  await projects.getByRole('button', { name: 'Projects', exact: true }).click();
  await expect(search).toHaveValue('field-notes'); await search.fill('');
  await page.getByRole('button', { name: 'Plugins', exact: true }).click();
  await expect(page.locator('#workspace-content')).toHaveAttribute('data-workspace', 'plugins');
  await page.screenshot({ path: info.outputPath('sidebar-desktop.png') });
  const footer = page.locator('.sidebar-footer');
  expect((await footer.boundingBox())!.y).toBeGreaterThan(850);
  await footer.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.locator('#workspace-content')).toHaveAttribute('data-workspace', 'settings');
});

test('sidebar width supports dragging, keyboard resizing and reset without losing the selected app', async ({ page }) => {
  for (let index = 0; index < 20; index++) await engine.projects.create({ name: `Project ${index} with a longer name`, slug: `project-${index}` });
  await page.setViewportSize({ width: 1440, height: 1000 }); await page.goto(studio.launchUrl);
  const handle = page.getByRole('separator', { name: 'Sidebar width' });
  const sidebar = page.locator('#studio-sidebar');
  await expect(handle).toHaveAttribute('aria-valuenow', '248');
  await handle.focus(); await page.keyboard.press('ArrowRight');
  await expect(handle).toHaveAttribute('aria-valuenow', '264');
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 100); await page.mouse.down(); await page.mouse.move(box.x + 66 + box.width / 2, box.y + 100); await page.mouse.up();
  await expect(handle).toHaveAttribute('aria-valuenow', '330');
  expect((await sidebar.boundingBox())!.width).toBe(330);
  await handle.dblclick(); await expect(handle).toHaveAttribute('aria-valuenow', '248');
  const list = page.locator('.sidebar-project-list');
  expect(await list.evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true);
  await list.getByRole('button').first().focus(); await page.keyboard.press('End');
  await expect(list.getByRole('button').last()).toBeFocused();
  await expect(list.getByRole('button').last()).toBeInViewport({ ratio: 1 });
  await expect(page.locator('.sidebar-footer').getByRole('button', { name: 'Settings', exact: true })).toBeInViewport({ ratio: 1 });
  const selected = (await engine.studio.snapshot()).projectId;
  await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click();
  await expect(sidebar).toBeHidden();
  await expect(page.getByRole('combobox', { name: 'Project', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Expand sidebar', exact: true }).click();
  await expect(sidebar).toBeVisible(); expect((await engine.studio.snapshot()).projectId).toBe(selected);
});

test('phone navigation retains the header project picker and reachable actions', async ({ page }, info) => {
  await page.goto(studio.launchUrl);
  for (const [width, height] of [[375, 812], [430, 932], [1440, 900]]) {
    await page.setViewportSize({ width: width!, height: height! });
    if (width === 1440) await page.evaluate(() => { document.documentElement.style.zoom = '2'; });
    await expect(page.getByRole('region', { name: 'Projects', exact: true })).toBeHidden();
    const picker = page.getByRole('combobox', { name: 'Project', exact: true });
    await picker.click(); await page.getByRole('option', { name: 'Garden notebook', exact: true }).click();
    await expect(picker).toHaveText('Garden notebook');
    await page.getByRole('button', { name: 'Plugins', exact: true }).click();
    await expect(page.locator('#workspace-content')).toHaveAttribute('data-workspace', 'plugins');
    await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeInViewport({ ratio: 1 });
    await expect(page.getByRole('button', { name: '+ New app', exact: true })).toBeInViewport({ ratio: 1 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`sidebar-${width}.png`) });
  }
});
