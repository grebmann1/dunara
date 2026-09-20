import { test, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Engine } from '../../packages/core/src/engine.js';
import { Projects } from '../../packages/core/src/projects.js';
import { startStudio } from '../../packages/cli/src/studio-server.js';
import { AssistantService } from '../../packages/assistant/src/service.js';
import { selectProject } from './project-picker.js';

test.use({ trace: 'off', actionTimeout: 20_000 });
let dir: string, engine: Engine, studio: Awaited<ReturnType<typeof startStudio>>;
test.beforeEach(async () => {
  test.skip(!!process.env.VISUAL, 'Visual suite only');
  dir = await mkdtemp(path.join(os.tmpdir(), 'studio-design-system-'));
  engine = new Engine(await Projects.open(path.join(dir, 'apps'), path.join(dir, 'home')), false);
  studio = await startStudio(engine, path.resolve('dist/studio'));
});
test.afterEach(async ({ page }) => {
  if (process.env.VISUAL) return;
  await page.unrouteAll({ behavior: 'wait' }); await page.close();
  await studio.close(); await engine.close(); await rm(dir, { recursive: true, force: true });
});

test('project identity and status share one compact header across widths and zoom', async ({ page }, testInfo) => {
  const project = await engine.projects.create({ name: 'Bonsai Atelier Review with a deliberately long project name', slug: 'header-review' });
  await page.goto(studio.launchUrl);
  const title = page.locator('.topbar h1');
  await expect(title).toHaveText(project.name);
  await expect(title).toHaveAttribute('title', project.name);
  await expect(page.locator('.topbar .preview-status')).toHaveText('stopped');
  await expect(page.locator('.canvas-heading')).toHaveCount(0);
  for (const width of [320, 375, 430, 768, 1280, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const header = await page.locator('.topbar').boundingBox();
    const name = await title.boundingBox();
    const status = await page.locator('.preview-status').boundingBox();
    const toggle = await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).boundingBox();
    expect(header!.height).toBe(width <= 760 ? 52 : 48);
    expect(Math.abs(name!.y + name!.height / 2 - (status!.y + status!.height / 2))).toBeLessThan(1);
    expect(name!.x).toBeGreaterThanOrEqual(toggle!.x + toggle!.width);
    expect(name!.x + name!.width).toBeLessThanOrEqual(status!.x);
    expect(toggle!.width).toBeGreaterThanOrEqual(width <= 760 ? 44 : 36);
    expect(toggle!.height).toBeGreaterThanOrEqual(width <= 760 ? 44 : 36);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
    if (width > 760) {
      expect((await page.locator('.sidebar').boundingBox())!.y).toBe(header!.height);
      expect(await page.locator('.workspace-content').evaluate(node => getComputedStyle(node).overflowY)).toBe('auto');
      await expect(page.locator('.topbar').getByRole('img', { name: 'Dunara', exact: true })).toBeVisible();
    }
    await page.screenshot({ path: testInfo.outputPath(`header-expanded-${width}.png`) });
    await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click();
    const expand = page.getByRole('button', { name: 'Expand sidebar', exact: true });
    await expect(expand).toBeFocused();
    const mark = page.locator('.topbar').getByRole('img', { name: 'Dunara', exact: true });
    await expect(mark).toBeVisible();
    const collapsedToggle = await expand.boundingBox(), collapsedMark = await mark.boundingBox(), collapsedTitle = await title.boundingBox();
    expect(collapsedMark!.x - (collapsedToggle!.x + collapsedToggle!.width)).toBe(8);
    expect(collapsedTitle!.x - (collapsedMark!.x + collapsedMark!.width)).toBe(8);
    expect(await title.evaluate(node => getComputedStyle(node).borderLeftWidth)).toBe('0px');
    expect((await page.locator('.topbar').boundingBox())!.height).toBe(width <= 760 ? 52 : 48);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
    await page.screenshot({ path: testInfo.outputPath(`header-collapsed-${width}.png`) });
    await expand.press('Enter');
    expect((await title.boundingBox())!.x).toBe(name!.x);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('button', { name: 'Assets', exact: true }).click();
  await expect(page.locator('.topbar .header-project')).toHaveText(project.name);
  await expect(page.locator('.topbar h1')).toHaveCount(0);
  await expect(page.getByRole('heading', { level: 1, name: 'Assets', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  for (const width of [1440, 768, 375, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(() => { document.documentElement.style.zoom = '2'; });
    await expect(title).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
    await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click();
    await expect(title).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
    await page.screenshot({ path: testInfo.outputPath(`header-zoom-${width}.png`) });
    await page.getByRole('button', { name: 'Expand sidebar', exact: true }).press('Enter');
  }
  await page.evaluate(() => { document.documentElement.style.zoom = ''; });
  await page.goto(studio.origin);
  await expect(page.locator('.connection')).toHaveText('Session unavailable');
  await expect(page.locator('.connection')).toBeVisible();
  await expect(page.locator('.preview-status')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
});

test('header prioritizes preview and connection state beside a working Assistant control', async ({ page }, testInfo) => {
  const project = await engine.projects.create({ name: 'Bonsai Studio', slug: 'header-assistant' });
  const assistant = new AssistantService({
    home: path.join(dir, 'home'),
    createHarness: () => ({ async run() { throw new Error('Header review must not start a model run'); }, async close() {} }),
    createGateway: async () => { throw new Error('Header review must not call tools'); },
  });
  await studio.close();
  studio = await startStudio(engine, path.resolve('dist/studio'), assistant);
  try {
    await page.goto(studio.launchUrl);
    const connection = page.locator('.connection');
    const preview = page.locator('.preview-status');
    const toggle = page.getByRole('button', { name: 'Assistant', exact: true });
    await expect(connection).toHaveText('Local workspace');
    await expect(connection).toHaveAttribute('data-quiet', 'true');
    await expect(toggle).toBeVisible();
    for (const attention of [false, true]) {
      if (attention) {
        await page.route('**/api/projects', route => route.abort());
        engine.diagnostics.emit('change', project.id);
        await expect(connection).toHaveText('Workspace unavailable');
        await expect(connection).toBeVisible();
        await expect(connection).toHaveAttribute('data-quiet', 'false');
        await expect(preview).toBeHidden();
      } else {
        await expect(preview).toHaveText('stopped');
        await expect(preview).toBeVisible();
        expect(await connection.evaluate(node => getComputedStyle(node).clipPath)).toBe('inset(50%)');
      }
      for (const size of [{ width: 1440, height: 900 }, { width: 375, height: 812 }, { width: 430, height: 932 }, { width: 320, height: 812 }]) {
        await page.setViewportSize(size);
        const header = (await page.locator('.topbar').boundingBox())!;
        const button = (await toggle.boundingBox())!;
        expect(header.height).toBe(size.width <= 760 ? 52 : 48);
        expect(button.width).toBeGreaterThanOrEqual(44);
        expect(button.height).toBe(size.width <= 760 ? 44 : 36);
        expect(button.x + button.width).toBeLessThanOrEqual(header.x + header.width);
        await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
        if (size.width === 1440) {
          await expect(toggle.locator('.assistant-label')).toBeVisible();
          const mark = (await page.locator('.studio-brand').boundingBox())!;
          const icon = (await page.locator('.studio-brand').getByRole('img', { name: 'Dunara', exact: true }).boundingBox())!;
          expect(icon.x).toBeGreaterThanOrEqual(mark.x);
          expect(icon.y).toBeGreaterThanOrEqual(mark.y);
          expect(icon.x + icon.width).toBeLessThanOrEqual(mark.x + mark.width);
          expect(icon.y + icon.height).toBeLessThanOrEqual(mark.y + mark.height);
        }
        if (size.width !== 320) await page.screenshot({ path: testInfo.outputPath(`header-${attention ? 'unavailable' : 'local'}-${size.width}.png`) });
        await toggle.click();
        await expect(page.getByRole('dialog', { name: 'Assistant', exact: true })).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(toggle).toBeFocused();
      }
      for (const width of [1440, 750]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(() => { document.documentElement.style.zoom = '2'; });
        expect((await page.locator('.topbar').boundingBox())!.height).toBe(width <= 760 ? 104 : 96);
        await expect(toggle).toBeInViewport();
        await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
        await page.evaluate(() => { document.documentElement.style.zoom = ''; });
      }
    }
    await page.unroute('**/api/projects');
    await expect(connection).toHaveText('Local workspace');
    await expect(preview).toBeVisible();
    await expect(connection).toHaveAttribute('data-quiet', 'true');
  } finally {
    await assistant.close();
  }
});

test('header icon collapses and restores the sidebar without remounting the workspace', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(studio.launchUrl);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const sidebar = page.locator('#studio-sidebar');
  const content = page.locator('.workspace-content');
  const settings = await content.getByLabel('OpenAI API key', { exact: true }).elementHandle();
  expect(settings).not.toBeNull();
  for (const width of [1440, 1280, 768, 430, 375, 320]) {
    await page.setViewportSize({ width, height: 900 });
    const collapse = page.getByRole('button', { name: 'Collapse sidebar', exact: true });
    await expect(collapse).toHaveAttribute('aria-expanded', 'true');
    await expect(collapse).toHaveAttribute('aria-controls', 'studio-sidebar');
    const target = await collapse.boundingBox();
    expect(target!.width).toBeGreaterThanOrEqual(width <= 760 ? 44 : 36);
    expect(target!.height).toBeGreaterThanOrEqual(width <= 760 ? 44 : 36);
    const expanded = await content.boundingBox();
    if ([1440, 375, 430].includes(width)) await page.screenshot({ path: testInfo.outputPath(`sidebar-expanded-${width}.png`), fullPage: true });
    await collapse.click();
    const expand = page.getByRole('button', { name: 'Expand sidebar', exact: true });
    await expect(expand).toHaveAttribute('aria-expanded', 'false');
    await expect(expand).toBeFocused();
    await expect(sidebar).toBeHidden();
    await expect(page.getByRole('navigation', { name: 'Workspace' })).toHaveCount(0);
    await expect(content).toHaveAttribute('data-workspace', 'settings');
    expect(await settings!.evaluate(node => node.isConnected)).toBe(true);
    const collapsed = await content.boundingBox();
    if (width > 760) expect(collapsed!.width).toBeGreaterThan(expanded!.width + 100);
    else expect(collapsed!.y).toBeLessThan(expanded!.y);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
    if ([1440, 375, 430].includes(width)) await page.screenshot({ path: testInfo.outputPath(`sidebar-collapsed-${width}.png`), fullPage: true });
    await expand.press('Enter');
    await expect(sidebar).toBeVisible();
    await expect(collapse).toBeFocused();
    await collapse.press('Space');
    await expect(sidebar).toBeHidden();
    await expand.click();
    await expect(page.getByRole('button', { name: 'Settings', exact: true })).toHaveAttribute('aria-pressed', 'true');
  }
  await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => { document.documentElement.style.zoom = '2'; });
  await expect(sidebar).toBeHidden();
  await page.getByRole('button', { name: 'Expand sidebar', exact: true }).click();
  await expect(sidebar).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
  expect(errors).toEqual([]);
});

test('sidebar footer keeps Settings without promotional copy across widths and zoom', async ({ page }) => {
  await page.goto(studio.launchUrl);
  for (const zoom of [1, 2]) {
    await page.evaluate(value => { document.documentElement.style.zoom = String(value); }, zoom);
    for (const width of [375, 768, 1280, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(page.locator('#studio-sidebar')).toBeVisible();
      await expect(page.locator('.sidebar-footer').getByRole('button', { name: 'Settings', exact: true })).toBeVisible();
      await expect(page.getByText('Local, shared workspace.', { exact: true })).toHaveCount(0);
      await expect(page.getByText('Build with your agent. Review here.', { exact: true })).toHaveCount(0);
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
    }
  }
});

test('Preview keeps metadata on demand and omits controls without a project', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(studio.launchUrl);
  await expect(page.getByRole('button', { name: 'Create your first app', exact: true })).toBeEnabled();
  await expect(page.locator('.toolbar')).toHaveCount(0);
  await expect(page.locator('.preview-status')).toHaveCount(0);
  const project = await engine.projects.create({ name: 'Quiet preview', slug: 'quiet-preview' });
  await expect(page.getByRole('heading', { name: project.name, exact: true })).toBeVisible();
  await expect(page.locator('.preview-status')).toHaveAttribute('data-state', 'stopped');
  await expect(page.locator('.preview-status')).toHaveText('stopped');
  for (const width of [320, 375, 430, 768, 1280, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const layout = await page.evaluate(() => {
      return {
        overflow: document.documentElement.scrollWidth - innerWidth,
        background: getComputedStyle(document.querySelector('.workspace-content')!).backgroundColor,
      };
    });
    await expect(page.getByRole('region', { name: 'Project details', exact: true })).toBeHidden();
    expect(layout.overflow).toBe(0);
    expect(layout.background).toBe('rgb(255, 255, 255)');
  }
  await page.getByLabel('Preview tools', { exact: true }).click();
  await page.getByRole('button', { name: 'Project settings', exact: true }).click();
  await expect(page.getByText(project.root, { exact: true })).toBeVisible();
  await expect(page.getByText(project.id, { exact: true })).toBeVisible();
});

test('Preview canvas contains zoom without changing iframe dimensions or mobile scroll ownership', async ({ page }) => {
  const project = await engine.projects.create({ name: 'Height fit', slug: 'height-fit' });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => route.request().isNavigationRequest() && route.request().frame().parentFrame()
    ? route.fulfill({ contentType: 'text/html', body: '<!doctype html><p>Offline preview sizing fixture</p>' })
    : route.continue());
  await page.route(`**/api/projects/${project.id}`, async route => {
    const response = await route.fetch(), state = await response.json();
    await route.fulfill({ response, json: { ...state, preview: { status: 'ready', url: studio.origin } } });
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(studio.launchUrl);
  const fit = page.getByRole('button', { name: 'Fit', exact: true });
  const canvas = page.getByRole('region', { name: 'Phone preview canvas' });
  await expect(fit).toHaveAttribute('aria-pressed', 'true');
  const overflow = () => page.locator('.workspace-content').evaluate(node => node.scrollHeight - node.clientHeight);
  const frame = page.getByTitle('Live app preview');
  for (const [name, width, height] of [['Compact phone', 375, 812], ['Large phone', 430, 932]] as const) {
    await page.getByRole('button', { name, exact: true }).click();
    await expect.poll(overflow).toBeLessThan(300);
    await expect.poll(() => frame.evaluate(node => ({ width: node.clientWidth, height: node.clientHeight }))).toEqual({ width, height });
    const beforeZoom = await overflow();
    await page.getByRole('button', { name: '100%', exact: true }).click();
    await expect(fit).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(() => canvas.evaluate(node => node.scrollHeight - node.clientHeight)).toBeGreaterThan(400);
    await expect.poll(overflow).toBe(beforeZoom);
    await fit.click();
    await expect.poll(() => canvas.evaluate(node => { const area = node.getBoundingClientRect(), phone = node.querySelector('.device-fit')!.getBoundingClientRect(); return phone.left >= area.left && phone.right <= area.right && phone.top >= area.top && phone.bottom <= area.bottom; })).toBe(true);
    await expect.poll(overflow).toBeLessThan(300);
  }
  const mountedFrame = await frame.elementHandle();
  await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click();
  await expect(page.locator('#studio-sidebar')).toBeHidden();
  expect(await mountedFrame!.evaluate(node => ({ connected: node.isConnected, width: node.clientWidth, height: node.clientHeight }))).toEqual({ connected: true, width: 430, height: 932 });
  await expect.poll(overflow).toBeLessThan(300);
  await page.getByRole('button', { name: 'Expand sidebar', exact: true }).click();
  expect(await mountedFrame!.evaluate(node => node.isConnected)).toBe(true);
  for (const viewport of [{ width: 1280, height: 720 }, { width: 1440, height: 500 }, { width: 375, height: 812 }, { width: 430, height: 932 }, { width: 1440, height: 900 }]) {
    await page.setViewportSize(viewport);
    const mobile = viewport.width < 760;
    await expect(fit).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
    expect(await page.locator('.workspace-content').evaluate(node => getComputedStyle(node).overflowY)).toBe(mobile ? 'visible' : 'auto');
    await expect.poll(() => canvas.evaluate(node => { const area = node.getBoundingClientRect(), phone = node.querySelector('.device-fit')!.getBoundingClientRect(); return phone.left >= area.left && phone.right <= area.right && phone.top >= area.top && phone.bottom <= area.bottom; })).toBe(true);
    if (mobile) await expect.poll(() => canvas.locator('.device-fit').evaluate(node => node.getBoundingClientRect().width)).toBeGreaterThan(150);
    const diagnostics = page.locator('.studio-console').getByRole('button', { name: 'Diagnostics', exact: true });
    await expect(diagnostics).toBeInViewport();
    await diagnostics.focus(); await page.keyboard.press('Enter');
    await expect(diagnostics).toHaveAttribute('aria-expanded', 'true');
    await expect(diagnostics).toBeFocused();
    await page.screenshot({ path: test.info().outputPath(`console-keyboard-${viewport.width}x${viewport.height}.png`) });
    await page.keyboard.press('Escape');
    await expect(diagnostics).toBeFocused();
    await expect(diagnostics).toHaveAttribute('aria-expanded', 'false');
  }
  expect(errors).toEqual([]);
});

test('design draft survives panel-to-sheet resizing, dismissal and project switching', async ({ page }) => {
  const first = await engine.projects.create({ name: 'Design pilot', slug: 'design-pilot' });
  const second = await engine.projects.create({ name: 'Other pilot', slug: 'other-pilot' });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(studio.launchUrl);
  await selectProject(page, first.id);
  const trigger = page.getByRole('button', { name: 'Design', exact: true });
  await trigger.click();
  await page.getByLabel('Corner radius').fill('27');
  for (const width of [320, 375, 430, 768, 1280, 1440]) {
    await page.setViewportSize({ width, height: 800 });
    await expect(page.getByLabel('Corner radius')).toHaveValue('27');
    await expect(page.getByRole('dialog')).toHaveCount(width < 1280 ? 1 : 0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (width < 1280) {
      await page.keyboard.press('Escape'); await expect(trigger).toBeFocused();
      await trigger.click(); await expect(page.getByLabel('Corner radius')).toHaveValue('27');
    }
  }
  await selectProject(page, second.id);
  await expect(page.getByLabel('Corner radius')).not.toHaveValue('27');
  await selectProject(page, first.id);
  await expect(page.getByLabel('Corner radius')).toHaveValue('27');
  await page.getByRole('button', { name: 'Apply changes', exact: true }).click();
  await expect.poll(async () => (await engine.designs.read(first.id)).tokens.radius).toBe(27);
});

test('narrow creation dialog traps focus, fits the viewport and returns focus', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto(studio.launchUrl);
  const trigger = page.getByRole('button', { name: '+ New app' });
  await trigger.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toHaveAccessibleName('What are you making?');
  await expect(page.getByLabel('App name', { exact: true })).toBeFocused();
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press('Tab');
    expect(await dialog.evaluate(node => node.contains(document.activeElement))).toBe(true);
  }
  const rect = await dialog.boundingBox();
  expect(rect!.x).toBeGreaterThanOrEqual(0); expect(rect!.x + rect!.width).toBeLessThanOrEqual(320);
  expect(rect!.height).toBeLessThanOrEqual(640);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0); await expect(trigger).toBeFocused();
  expect(await engine.projects.list()).toHaveLength(0);
});

test('long project lists remain bounded and dismissal permits the next modal', async ({ page }) => {
  for (let i = 0; i < 16; i++) await engine.projects.create({ name: `Project ${String(i).padStart(2, '0')} with a long readable name`, slug: `project-${i}` });
  await page.setViewportSize({ width: 320, height: 480 });
  await page.goto(studio.launchUrl);
  const project = page.getByRole('combobox', { name: 'Project', exact: true });
  const selected = await project.textContent();
  await project.focus(); await page.keyboard.press('Enter');
  const list = page.getByRole('listbox');
  await expect(list).toBeVisible();
  const rect = await list.boundingBox();
  expect(rect!.x).toBeGreaterThanOrEqual(0);
  expect(rect!.y).toBeGreaterThanOrEqual(0);
  expect(rect!.x + rect!.width).toBeLessThanOrEqual(320);
  expect(rect!.y + rect!.height).toBeLessThanOrEqual(480);
  await page.keyboard.press('End');
  await expect(page.getByRole('option').last()).toBeFocused();
  await expect(page.getByRole('option').last()).toBeInViewport();
  await page.keyboard.press('Escape');
  await expect(project).toBeFocused(); await expect(project).toHaveText(selected!);
  await page.getByRole('button', { name: '+ New app' }).click();
  const dialog = page.getByRole('dialog', { name: 'What are you making?' });
  await expect(dialog.getByLabel('App name', { exact: true })).toBeFocused();
  await expect(list).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('button', { name: '+ New app' })).toBeFocused();
  expect(await engine.projects.list()).toHaveLength(16);
});

test('touch project selection and outside dismissal preserve the selected project', async ({ browser }) => {
  const first = await engine.projects.create({ name: 'Touch first', slug: 'touch-first' });
  await engine.projects.create({ name: 'Touch second', slug: 'touch-second' });
  const context = await browser.newContext({ hasTouch: true, viewport: { width: 375, height: 812 } });
  try {
    const page = await context.newPage();
    await page.goto(studio.launchUrl);
    const trigger = page.getByRole('combobox', { name: 'Project', exact: true });
    await trigger.tap();
    await page.getByRole('option', { name: first.name, exact: true }).tap();
    await expect(trigger).toHaveText(first.name);
    await trigger.tap();
    await expect(page.getByRole('listbox')).toBeVisible();
    // Wait for Radix's deferred outside-pointer listener before a synthetic touch.
    await page.waitForTimeout(200);
    await page.touchscreen.tap(360, 780);
    await expect(page.getByRole('listbox')).toHaveCount(0);
    await expect(trigger).toHaveText(first.name);
    await expect(trigger).toBeFocused();
  } finally { await context.close(); }
});

test('project menu remains usable at 200 percent zoom', async ({ page }) => {
  for (let i = 0; i < 16; i++) await engine.projects.create({ name: `Project ${String(i).padStart(2, '0')} with a long readable name`, slug: `zoom-project-${i}` });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(studio.launchUrl);
  await page.evaluate(() => { document.documentElement.style.zoom = '2'; });
  const trigger = page.getByRole('combobox', { name: 'Project', exact: true });
  await trigger.click();
  const list = page.getByRole('listbox');
  await expect(list).toBeVisible();
  const rect = await list.boundingBox();
  expect(rect!.x).toBeGreaterThanOrEqual(0);
  expect(rect!.y).toBeGreaterThanOrEqual(0);
  expect(rect!.x + rect!.width).toBeLessThanOrEqual(1440);
  expect(rect!.y + rect!.height).toBeLessThanOrEqual(900);
  await page.keyboard.press('End');
  await expect(page.getByRole('option').last()).toBeInViewport();
  await page.keyboard.press('Enter');
  await expect(trigger).toContainText('Project 15');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Image generation' })).toBeVisible();
});

test('creation and Design dialogs fit at 200 percent zoom with reachable actions', async ({ page }) => {
  await engine.projects.create({ name: 'Zoomed dialogs', slug: 'zoomed-dialogs' });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(studio.launchUrl);
  await page.evaluate(() => { document.documentElement.style.zoom = '2'; });
  for (const name of ['+ New app', 'Design']) {
    const trigger = page.getByRole('button', { name, exact: true });
    await trigger.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    const rect = await dialog.boundingBox();
    expect(rect!.x).toBeGreaterThanOrEqual(0);
    expect(rect!.y).toBeGreaterThanOrEqual(0);
    expect(rect!.x + rect!.width).toBeLessThanOrEqual(1440);
    expect(rect!.y + rect!.height).toBeLessThanOrEqual(900);
    if (name === 'Design') {
      const apply = dialog.getByRole('button', { name: 'Apply changes', exact: true });
      await apply.scrollIntoViewIfNeeded();
      await expect(apply).toBeInViewport();
    } else {
      await dialog.locator('.creation-folder summary').click();
      await dialog.getByLabel('Directory slug').focus();
      await page.keyboard.press('Tab');
      await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeInViewport();
    }
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
  }
});

test('Design does not oscillate between panel and modal near the responsive boundary', async ({ page }) => {
  await engine.projects.create({ name: 'Boundary review', slug: 'boundary-review' });
  await page.setViewportSize({ width: 1230, height: 1200 });
  await page.goto(studio.launchUrl);
  await page.getByRole('button', { name: 'Design', exact: true }).click();
  await page.getByLabel('Corner radius').fill('27');
  const surface = page.getByRole('dialog', { name: 'App design', exact: true });
  await expect(surface).toBeVisible();
  const states = await surface.evaluate(async node => {
    const states: boolean[] = [];
    for (let i = 0; i < 60; i++) {
      await new Promise(requestAnimationFrame);
      states.push(node.isConnected);
    }
    return states;
  });
  expect(states.every(Boolean)).toBe(true);
  await expect(page.getByLabel('Corner radius')).toHaveValue('27');
});

test('project menu gives long names room and design sheet uses one content-height scroll surface', async ({ page }) => {
  await engine.projects.create({ name: 'Project with a long readable name', slug: 'spacing-review' });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(studio.launchUrl);
  await page.getByRole('combobox', { name: 'Project', exact: true }).click();
  const list = page.getByRole('listbox');
  await expect(list).toBeVisible();
  expect((await list.boundingBox())!.width).toBeGreaterThanOrEqual(280);
  expect(await list.locator('[data-radix-select-viewport]').evaluate(node => parseFloat(getComputedStyle(node).padding))).toBeGreaterThanOrEqual(4);
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 375, height: 812 });
  await page.getByRole('button', { name: 'Design', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'App design' });
  await expect(sheet).toBeVisible();
  const sizing = await sheet.locator('.inspector').evaluate(node => {
    const rect = node.getBoundingClientRect();
    const last = node.lastElementChild!.getBoundingClientRect();
    return { contentBottom: last.bottom, panelBottom: rect.bottom, padding: parseFloat(getComputedStyle(node).paddingBottom) };
  });
  expect(sizing.panelBottom).toBeGreaterThanOrEqual(sizing.contentBottom + sizing.padding - 1);
  await sheet.getByRole('button', { name: 'Apply changes', exact: true }).scrollIntoViewIfNeeded();
  await expect(sheet.getByRole('button', { name: 'Apply changes', exact: true })).toBeInViewport();
  await sheet.getByRole('button', { name: 'Close dialog' }).click();
  await expect(sheet).toHaveCount(0);
});

test('Settings shared controls fit narrow and zoomed layouts without a project', async ({ page }) => {
  await page.goto(studio.launchUrl);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Image generation' })).toBeVisible();
  for (const width of [320, 375, 430, 768, 1280, 1440]) {
    await page.setViewportSize({ width, height: 800 });
    for (const zoom of width === 1440 ? [1, 2] : [1]) {
      await page.evaluate(value => { document.documentElement.style.zoom = String(value); }, zoom);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const undersized = await page.locator('.settings-workspace button, .settings-workspace input').evaluateAll(nodes => nodes.filter(node => {
        const rect = node.getBoundingClientRect();
        const minimum = matchMedia('(max-width: 760px), (pointer: coarse)').matches ? 44 : 36;
        return rect.width < minimum || rect.height < minimum;
      }).map(node => ({ name: node.getAttribute('name') || node.getAttribute('type') || node.textContent, width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height })));
      expect(undersized).toEqual([]);
      await page.getByLabel('OpenAI API key', { exact: true }).focus();
      await expect(page.getByLabel('OpenAI API key', { exact: true })).toBeInViewport();
      await page.getByRole('button', { name: 'Save for this Dunara session' }).focus();
      await expect(page.getByRole('button', { name: 'Save for this Dunara session' })).toBeInViewport();
    }
  }
  expect(await engine.projects.list()).toHaveLength(0);
});
