import { openProjectRoutes } from './preview-actions.js';
import { selectProject } from './project-picker.js';
import { test, expect, type Page } from '@playwright/test';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import os from 'node:os';
import path from 'node:path';
import { Engine } from '../../packages/core/src/engine.js';
import { Projects } from '../../packages/core/src/projects.js';
import { startStudio } from '../../packages/cli/src/studio-server.js';

// Bootstrap responses contain credentials; never retain network traces.
test.use({ trace: 'off' });
let dir: string, engine: Engine, studio: Awaited<ReturnType<typeof startStudio>>;
test.beforeEach(async () => {
  test.skip(!!process.env.VISUAL, 'Visual suite only');
  dir = await mkdtemp(path.join(os.tmpdir(), 'studio-acceptance-'));
  engine = new Engine(await Projects.open(path.join(dir, 'apps'), path.join(dir, 'home')), false);
  studio = await startStudio(engine, path.resolve('dist/studio'));
});
test.afterEach(async ({ page }) => {
  if (process.env.VISUAL) return;
  await page.unrouteAll({ behavior: 'wait' });
  await page.close();
  await studio.close(); await engine.close(); await rm(dir, { recursive: true, force: true });
});

async function scrollFixture(page: Page) {
  const project = await engine.projects.create({ name: 'Scroll review', slug: 'scroll-review' });
  await engine.files.write(project.id, Array.from({ length: 20 }, (_, i) => ({ path: `app/long-route-${i}-${'segment-'.repeat(12)}.tsx`, content: 'export default function Route() { return null; }', expectedRevision: null })));
  for (let i = 0; i < 30; i++) engine.diagnostics.add(project.id, 'builder', 'info', `${i}: ${'long-diagnostic-path/'.repeat(30)}`);
  const bytes = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: '#123d3b' } }).png().toBuffer();
  const imported = await engine.assets.import(project.id, { expectedRevision: null, mediaType: 'image/png', label: 'Offline icon' }, bytes);
  const asset = imported.assets[0]!;
  await engine.assets.approve(project.id, asset.id, imported.revision);
  await page.goto(studio.launchUrl);
  await expect(page.getByRole('heading', { name: project.name, exact: true })).toBeVisible();
  return { project, asset };
}

async function scrollPosition(page: Page) {
  return page.evaluate(() => {
    const content = document.querySelector<HTMLElement>('.workspace-content')!;
    const sidebar = document.querySelector<HTMLElement>('.sidebar')!;
    return { documentTop: document.scrollingElement!.scrollTop, documentLeft: document.scrollingElement!.scrollLeft, workspaceTop: content.scrollTop, workspaceLeft: content.scrollLeft, workspaceHeight: content.clientHeight, workspaceScrollHeight: content.scrollHeight, headerTop: document.querySelector('.topbar')!.getBoundingClientRect().top, sidebarTop: sidebar.getBoundingClientRect().top, sidebarScrollTop: sidebar.scrollTop, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
  });
}

async function scrollEvidence(page: Page, name: string, measurements: unknown) {
  if (!process.env.STUDIO_SCROLL_EVIDENCE) return;
  const directory = path.resolve('.builder/studio-scroll-review');
  await mkdir(directory, { recursive: true });
  const prefix = path.join(directory, `${process.env.STUDIO_SCROLL_EVIDENCE}-${name}`);
  await writeFile(`${prefix}.json`, JSON.stringify(measurements, null, 2));
  await page.screenshot({ path: `${prefix}.png` });
}

test('desktop Preview and Settings scrolling stays within the workspace', async ({ page }) => {
  await scrollFixture(page);
  for (const viewport of [{ width: 1280, height: 720 }, { width: 1440, height: 900 }, { width: 768, height: 800 }]) {
    await page.setViewportSize(viewport);
    for (const destination of ['Preview', 'Settings']) {
      await page.getByRole('navigation', { name: 'Workspace', exact: true }).getByRole('button', { name: destination, exact: true }).click();
      await page.evaluate(() => { scrollTo(0, 0); document.querySelector('.workspace-content')!.scrollTop = 0; });
      if (destination === 'Preview') {
        const canvas = page.getByRole('region', { name: 'Phone preview canvas' });
        await canvas.focus();
        const top = await canvas.evaluate(node => node.scrollTop);
        await page.keyboard.press('ArrowDown');
        await expect.poll(() => canvas.evaluate(node => node.scrollTop)).toBeGreaterThan(top);
        expect((await scrollPosition(page)).workspaceTop).toBe(0);
        expect((await scrollPosition(page)).documentTop).toBe(0);
        continue;
      }
      const before = await scrollPosition(page);
      await scrollEvidence(page, `${destination.replace(' ', '-')}-${viewport.width}`, { before });
      await expect(page.locator('.workspace-content')).toHaveAttribute('data-workspace', 'settings');
      await expect.poll(async () => { const value = await scrollPosition(page); return value.workspaceScrollHeight - value.workspaceHeight; }).toBeGreaterThan(0);
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      const bounds = await page.locator('.workspace-content').boundingBox();
      const point = { x: bounds!.x + bounds!.width / 2, y: Math.min(bounds!.y + 140, viewport.height - 30) };
      await expect.poll(() => page.evaluate(({ x, y }) => !!document.elementFromPoint(x, y)?.closest('.workspace-content'), point)).toBe(true);
      await page.mouse.move(point.x, point.y);
      await page.mouse.wheel(0, 440);
      await expect.poll(async () => (await scrollPosition(page)).workspaceTop).toBeGreaterThan(0);
      const after = await scrollPosition(page);
      await scrollEvidence(page, `wheel-${destination.replace(' ', '-')}-${viewport.width}`, { before, after });
      expect.soft(after.documentTop).toBe(0);
      expect.soft(after.documentLeft).toBe(0);
      expect.soft(after.headerTop).toBe(before.headerTop);
      expect.soft(after.sidebarTop).toBe(before.sidebarTop);
      expect.soft(after.overflow).toBe(0);
      await page.locator('.workspace-content').evaluate(node => { node.scrollTop = node.scrollHeight; });
      await page.mouse.wheel(0, 600);
      await page.waitForTimeout(100);
      expect.soft((await scrollPosition(page)).documentTop).toBe(0);
    }
  }
});

test('phone and 200 percent Preview and Settings layouts keep reachable final controls', async ({ page }) => {
  await scrollFixture(page);
  for (const viewport of [{ width: 430, height: 932 }, { width: 375, height: 812 }, { width: 320, height: 640 }, { width: 1440, height: 900 }]) {
    await page.setViewportSize(viewport);
    await page.evaluate(zoom => { document.documentElement.style.zoom = String(zoom); }, viewport.width === 1440 ? 2 : 1);
    for (const destination of ['Preview', 'Settings']) {
      await page.getByRole('navigation', { name: 'Workspace', exact: true }).getByRole('button', { name: destination, exact: true }).click();
      await page.evaluate(() => { scrollTo(0, 0); document.querySelector('.workspace-content')!.scrollTop = 0; });
      await scrollEvidence(page, `${destination.replace(' ', '-')}-${viewport.width === 1440 ? 'zoom' : viewport.width}`, await scrollPosition(page));
      // The edge-to-edge Preview canvas owns wheel zoom; document scroll starts outside it.
      await page.mouse.move(viewport.width - 8, destination === 'Preview' ? 20 : viewport.height - 40);
      await page.mouse.wheel(0, 500);
      await expect.poll(async () => (await scrollPosition(page)).documentTop).toBeGreaterThan(0);
      expect.soft((await scrollPosition(page)).workspaceTop).toBe(0);
      expect.soft(await page.locator('.workspace-content').evaluate(node => getComputedStyle(node).overflowY)).toBe('visible');
      const last = page.locator('.workspace-content button:visible:not(:disabled), .workspace-content summary:visible').last();
      await last.scrollIntoViewIfNeeded();
      await last.focus();
      await expect(last).toBeFocused();
      await expect(last).toBeInViewport();
      expect.soft((await scrollPosition(page)).overflow).toBe(0);
      expect.soft(await page.locator('.console-panel:visible').evaluateAll(nodes => nodes.every(node => node.clientHeight < innerHeight))).toBe(true);
    }
  }
});

test('scroll ownership preserves keyboard focus, polling, banners and short-height navigation', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  const { project } = await scrollFixture(page);
  await page.getByRole('button', { name: 'Activity', exact: true }).click();
  const activity = page.getByRole('main', { name: 'Activity workspace', exact: true });
  await expect(activity).toBeVisible();
  await activity.getByRole('button', { name: /^Diagnostics/ }).click();
  await activity.getByRole('button', { name: 'Show all output', exact: true }).click();
  const content = page.locator('.workspace-content'), diagnostics = activity.getByRole('region', { name: 'Diagnostics', exact: true }).locator('.activity-scroll');
  const skip = page.getByRole('link', { name: 'Skip to workspace' });
  await skip.focus(); await expect(skip).toBeInViewport(); await page.keyboard.press('Enter');
  await expect(content).toBeFocused();
  await diagnostics.locator('summary').first().focus(); await page.keyboard.press('PageDown');
  await expect.poll(() => diagnostics.evaluate(node => node.scrollTop)).toBeGreaterThan(100);
  expect((await scrollPosition(page)).workspaceTop).toBe(0);
  await page.keyboard.press('Home');
  await expect.poll(() => diagnostics.evaluate(node => node.scrollTop)).toBe(0);
  await diagnostics.evaluate(node => { node.scrollTop = 440; });
  engine.diagnostics.add(project.id, 'builder', 'info', 'Ordinary workspace update');
  await page.waitForTimeout(4300); // Exercise periodic refresh while reading output.
  expect(await diagnostics.evaluate(node => node.scrollTop)).toBeGreaterThanOrEqual(440);
  const beforeWheel = await diagnostics.evaluate(node => node.scrollTop);
  await diagnostics.hover(); await page.mouse.wheel(0, 300);
  await expect.poll(() => diagnostics.evaluate(node => node.scrollTop)).toBeGreaterThan(beforeWheel);
  expect((await scrollPosition(page)).documentTop).toBe(0);
  expect((await scrollPosition(page)).workspaceTop).toBe(0);

  for (const destination of ['Assets', 'Activity', 'Settings', 'Preview']) {
    await page.getByRole('navigation', { name: 'Workspace', exact: true }).getByRole('button', { name: destination, exact: true }).click();
    await expect.poll(async () => (await scrollPosition(page)).workspaceTop).toBe(0);
    await expect(destination === 'Preview' ? page.locator('.topbar h1') : content.locator('h1:visible')).toBeInViewport();
    if (destination === 'Preview') await expect(page.locator('.toolbar')).toBeInViewport();
    await content.evaluate(node => { node.scrollTop = 440; });
  }
  await page.getByRole('button', { name: 'Design', exact: true }).click();
  await page.getByLabel('Corner radius').fill('31');
  await page.route('**/design', route => route.fulfill({ status: 400, json: { error: { message: 'Deliberate save failure '.repeat(15) } } }));
  await page.getByRole('button', { name: 'Apply changes' }).click();
  await expect(page.getByRole('alert')).toContainText('Deliberate save failure');
  const banner = await page.locator('.studio > .error-banner').boundingBox();
  const workspace = await page.locator('.workspace').boundingBox();
  expect(workspace!.y).toBe(banner!.y + banner!.height);
  expect(Math.round(workspace!.y + workspace!.height)).toBe(Math.round((await page.locator('.studio-console').boundingBox())!.y));
  expect((await scrollPosition(page)).documentTop).toBe(0);
  await page.getByRole('button', { name: 'Dismiss error' }).click();

  await page.getByRole('button', { name: 'Close Design', exact: true }).click();
  await page.setViewportSize({ width: 1280, height: 450 });
  const sidebar = page.locator('.sidebar');
  await sidebar.hover();
  await page.mouse.wheel(0, 500);
  await expect.poll(async () => (await scrollPosition(page)).sidebarScrollTop).toBeGreaterThan(0);
  expect((await scrollPosition(page)).documentTop).toBe(0);
  const newApp = page.getByRole('button', { name: '+ New app' });
  await newApp.click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(newApp).toBeFocused();
  await expect(newApp).toBeInViewport();
});

test('phone presentation never expands horizontal scrolling during mount, resizing or destination changes', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.addInitScript(() => {
    const samples: unknown[] = [];
    Object.assign(window, { scrollOverflowSamples: samples });
    const sample = () => {
      const area = document.querySelector<HTMLElement>('.device-area');
      const content = document.querySelector<HTMLElement>('.workspace-content');
      if (area?.clientWidth && content) {
        const documentOverflow = document.documentElement.scrollWidth - document.documentElement.clientWidth;
        const workspaceOverflow = content.scrollWidth - content.clientWidth;
        if (documentOverflow > 0 || workspaceOverflow > 0) samples.push({ documentOverflow, workspaceOverflow, width: innerWidth });
      }
    };
    new MutationObserver(sample).observe(document, { childList: true, subtree: true, attributes: true });
    const frame = () => { sample(); requestAnimationFrame(frame); };
    requestAnimationFrame(frame);
    addEventListener('resize', sample);
  });
  await scrollFixture(page);
  for (const width of [1280, 320, 768, 375, 1440, 430, 761, 760, 320]) {
    await page.setViewportSize({ width, height: 800 });
    await page.getByRole('button', { name: 'Large phone', exact: true }).click();
    await page.getByRole('button', { name: 'Assets', exact: true }).click();
    await page.setViewportSize({ width: width === 320 ? 1440 : 320, height: 800 });
    await page.getByRole('button', { name: 'Preview', exact: true }).click();
    await page.getByRole('button', { name: 'Compact phone', exact: true }).click();
  }
  const samples = await page.evaluate(() => Reflect.get(window, 'scrollOverflowSamples'));
  await scrollEvidence(page, 'transient-overflow', samples);
  expect(samples).toEqual([]);
});

test('failed design save retains the draft for retry', async ({ page }) => {
  const project = await engine.projects.create({ name: 'Draft test', slug: 'draft-test' });
  const before = await engine.designs.read(project.id);
  await page.goto(studio.launchUrl);
  await page.getByRole('button', { name: 'Design', exact: true }).click();
  await page.getByLabel('Corner radius').fill('31');
  await page.route('**/design', route => route.fulfill({ status: 400, json: { error: { message: 'Deliberate save failure' } } }));
  await page.getByRole('button', { name: 'Apply changes' }).click();
  await expect(page.getByRole('alert')).toContainText('Deliberate save failure');
  await expect(page.getByLabel('Corner radius')).toHaveValue('31');
  await expect(page.getByRole('button', { name: 'Apply changes' })).toBeEnabled();
  expect((await engine.designs.read(project.id)).revision).toBe(before.revision);
  await page.unroute('**/design');
  await page.getByRole('button', { name: 'Dismiss error' }).click();
  await page.getByRole('button', { name: 'Apply changes' }).click();
  await expect.poll(async () => (await engine.designs.read(project.id)).tokens.radius).toBe(31);
  await expect(page.getByRole('button', { name: 'Apply changes' })).toBeDisabled();
});

test('external revision preserves drafts and requires explicit conflict review', async ({ page }) => {
  const project = await engine.projects.create({ name: 'Concurrent edits', slug: 'concurrent' });
  await page.goto(studio.launchUrl);
  await page.getByRole('button', { name: 'Design', exact: true }).click();
  await page.getByLabel('Corner radius').fill('31');
  const before = await engine.designs.read(project.id);
  await engine.designs.apply(project.id, { tokens: { spacing: 12 }, expectedRevision: before.revision });
  engine.diagnostics.emit('change', project.id);
  await expect(page.getByLabel('Base spacing')).toHaveValue('12');
  await expect(page.getByLabel('Corner radius')).toHaveValue('31');
  await expect(page.getByRole('alert')).toContainText('Design changed');
  await expect(page.getByRole('button', { name: 'Apply changes' })).toBeDisabled();
  await page.getByRole('button', { name: 'Review against latest revision' }).click();
  await page.getByRole('button', { name: 'Apply changes' }).click();
  await expect.poll(async () => (await engine.designs.read(project.id)).tokens.radius).toBe(31);
  expect((await engine.designs.read(project.id)).tokens.spacing).toBe(12);
});

test('old pending action cannot restore the previously selected project', async ({ page }) => {
  const first = await engine.projects.create({ name: 'First app', slug: 'first' });
  const second = await engine.projects.create({ name: 'Second app', slug: 'second', preset: 'clay' });
  await page.goto(studio.launchUrl);
  await page.getByRole('button', { name: 'Design', exact: true }).click();
  await page.getByLabel('Corner radius').fill('31');
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let received!: () => void;
  const arrived = new Promise<void>(resolve => { received = resolve; });
  await page.route(`**/projects/${first.id}/design`, async route => {
    received(); await held; await route.continue();
  });
  await page.getByRole('button', { name: 'Apply changes' }).click(); await arrived;
  await selectProject(page, second.id);
  await expect(page.locator('.topbar h1')).toHaveText('Second app');
  release();
  await expect.poll(async () => (await engine.designs.read(first.id)).tokens.radius).toBe(31);
  await expect(page.locator('.preview-status')).not.toContainText('Applying');
  await expect(page.locator('.topbar h1')).toHaveText('Second app');
  await expect(page.getByLabel('Corner radius')).toHaveValue(String((await engine.designs.read(second.id)).tokens.radius));
});

test('late failures and delayed inspection stay scoped to their project', async ({ page }) => {
  const first = await engine.projects.create({ name: 'First app', slug: 'first' });
  const second = await engine.projects.create({ name: 'Second app', slug: 'second', preset: 'clay' });
  await page.goto(studio.launchUrl);
  await page.getByRole('button', { name: 'Design', exact: true }).click();
  await page.getByLabel('Corner radius').fill('31');
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let received!: () => void;
  const arrived = new Promise<void>(resolve => { received = resolve; });
  await page.route(`**/projects/${first.id}/design`, async route => {
    received(); await held; await route.fulfill({ status: 400, json: { error: { message: 'Old project failure' } } });
  });
  await page.getByRole('button', { name: 'Apply changes' }).click(); await arrived;
  await selectProject(page, second.id);
  await expect(page.locator('.topbar h1')).toHaveText('Second app');
  release();
  await expect(page.getByRole('button', { name: '+ New app' })).toBeEnabled();
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect((await engine.designs.read(first.id)).tokens.radius).not.toBe(31);
  let releaseInspect!: () => void;
  const inspectHeld = new Promise<void>(resolve => { releaseInspect = resolve; });
  let inspected!: () => void;
  const inspection = new Promise<void>(resolve => { inspected = resolve; });
  await page.route(`**/projects/${first.id}`, async route => {
    const response = await route.fetch(); inspected(); await inspectHeld; await route.fulfill({ response });
  });
  await selectProject(page, first.id); await inspection;
  await selectProject(page, second.id);
  await expect(page.locator('.topbar h1')).toHaveText('Second app');
  releaseInspect();
  await page.unrouteAll({ behavior: 'wait' });
  await expect(page.locator('.topbar h1')).toHaveText('Second app');
});

test('bare origin and reload show authentication recovery rather than connecting forever', async ({ page }) => {
  await page.goto(studio.origin);
  await expect(page.locator('.connection')).toHaveText('Session unavailable');
  await expect(page.getByRole('alert')).toContainText('Restart');
  await page.goto('about:blank');
  await page.goto(studio.launchUrl);
  await expect(page.getByRole('button', { name: '+ New app' })).toBeEnabled();
  await expect(page.locator('.connection')).toHaveText('Local workspace');
  expect(await page.evaluate(() => [Object.keys(localStorage).filter(key => key !== 'builder.workspace-layout.v1').length, sessionStorage.length])).toEqual([0, 0]);
  expect(new URL(page.url()).hash).toBe('');
  await page.reload();
  await expect(page.locator('.connection')).toHaveText('Session unavailable');
  await expect(page.getByRole('button', { name: '+ New app' })).toBeDisabled();
});

test('project route controls remain reachable at phone width and meet target sizes', async ({ page }) => {
  await engine.projects.create({ name: 'Layout app', slug: 'layout' });
  await page.goto(studio.launchUrl);
  await page.getByRole('button', { name: 'Design', exact: true }).click();
  await expect(page.getByLabel('Corner radius')).toBeVisible();
  await openProjectRoutes(page);
  for (const width of [1440, 768, 430, 375, 320]) {
    await page.setViewportSize({ width, height: 1100 });
    await expect(page.getByLabel('Agent-added screen')).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const dialog = page.getByRole('dialog', { name: 'Project routes', exact: true });
    await expect(dialog).toBeInViewport({ ratio: 0.99 });
    const small = await dialog.locator('button, input, select, summary').evaluateAll(nodes => nodes.filter(node => {
      const rect = node.getBoundingClientRect(); return rect.width > 0 && rect.height > 0 && rect.height < (matchMedia('(max-width: 760px), (pointer: coarse)').matches ? 44 : 36);
    }).map(node => node.getAttribute('aria-label') || node.textContent));
    expect(small).toEqual([]);
  }
});

test('200 percent scaling and keyboard navigation preserve usable controls', async ({ page }) => {
  await engine.projects.create({ name: 'Keyboard app', slug: 'keyboard' });
  await page.goto(studio.launchUrl);
  await page.getByRole('button', { name: 'Design', exact: true }).click();
  await expect(page.getByLabel('Corner radius')).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.evaluate(() => { document.documentElement.style.zoom = '2'; });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByLabel('Corner radius').focus();
  await page.keyboard.press('End'); await expect(page.getByLabel('Corner radius')).toHaveValue('32');
  await page.getByRole('button', { name: 'Discard draft' }).focus(); await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Design', exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'Large phone' }).focus(); await page.keyboard.press('Space');
  await expect(page.getByRole('button', { name: 'Large phone' })).toHaveAttribute('aria-pressed', 'true');
  await openProjectRoutes(page);
  await page.getByLabel('Agent-added screen').focus(); await page.keyboard.type('/keyboard'); await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'Project routes', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Preview tools', { exact: true })).toBeFocused();
  await expect(page.locator('.preview-caption')).toContainText('/keyboard');
  await page.getByRole('button', { name: '+ New app' }).focus();
  const focus = await page.getByRole('button', { name: '+ New app' }).evaluate(node => ({ outline: getComputedStyle(node).outlineStyle, width: getComputedStyle(node).outlineWidth }));
  expect(focus.outline).not.toBe('none'); expect(focus.width).not.toBe('0px');
  await page.keyboard.press('Enter'); await expect(page.getByLabel('App name', { exact: true })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  // Radix traps focus in the portalled modal and hides the background from assistive technology.
  await expect(page.getByRole('button', { name: 'Close dialog' })).toBeFocused();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByLabel('App name', { exact: true }).focus();
  await page.getByRole('button', { name: '+ New app', includeHidden: true }).evaluate(node => node.focus());
  await expect(page.getByLabel('App name', { exact: true })).toBeFocused();
  await page.keyboard.press('Tab'); await expect(page.getByLabel('The idea', { exact: false })).toBeFocused();
  await page.keyboard.press('Escape'); await expect(page.getByRole('button', { name: '+ New app' })).toBeFocused();
});

test('polling survives WebSocket failure and reconnects without losing drafts', async ({ page }) => {
  await engine.projects.create({ name: 'Polling app', slug: 'polling' });
  let failing = true;
  await page.routeWebSocket('**/events', socket => { if (failing) socket.close(); else socket.connectToServer(); });
  await page.goto(studio.launchUrl);
  await page.getByRole('button', { name: 'Design', exact: true }).click();
  await expect(page.locator('.connection')).toHaveText('Connected · polling');
  await page.getByLabel('Corner radius').fill('31');
  const second = await engine.projects.create({ name: 'From another interface', slug: 'external' });
  await page.getByRole('combobox', { name: 'Project', exact: true }).click();
  await expect(page.getByRole('option', { name: 'From another interface', exact: true })).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(page.getByLabel('Corner radius')).toHaveValue('31');
  failing = false;
  await expect(page.locator('.connection')).toHaveText('Local workspace');
  await page.route('**/api/projects', route => route.abort());
  engine.diagnostics.emit('change', second.id);
  await expect(page.locator('.connection')).toHaveText('Workspace unavailable');
  await expect(page.getByRole('button', { name: 'Apply changes' })).toBeDisabled();
  await expect(page.getByRole('alert')).toContainText('restart/relaunch');
  await page.unroute('**/api/projects');
  await expect(page.locator('.connection')).toHaveText('Local workspace');
  await expect(page.getByLabel('Corner radius')).toHaveValue('31');
  await studio.close();
  await expect(page.locator('.connection')).toHaveText('Workspace unavailable');
});

test('capture retrieval distinguishes expired artifacts from retryable failures', async ({ page }) => {
  const project = await engine.projects.create({ name: 'Capture feedback', slug: 'capture-feedback' });
  let failure: 'server' | 'decode' | null = 'server';
  const png = await sharp({ create: { width: 1, height: 1, channels: 4, background: '#ffffff' } }).png().toBuffer();
  await page.route(`**/api/projects/${project.id}`, async route => {
    const response = await route.fetch(), state = await response.json();
    await route.fulfill({ response, json: { ...state, captures: [
      { id: 'expired', projectId: project.id, route: '/', viewport: 'compact', width: 375, height: 812, bytes: 68, createdAt: new Date().toISOString(), rendering: 'React Native Web' },
      { id: 'retryable', projectId: project.id, route: '/habit', viewport: 'large', width: 430, height: 932, bytes: 68, createdAt: new Date().toISOString(), rendering: 'React Native Web' },
    ] } });
  });
  await page.route('**/artifacts/expired', route => route.fulfill({ status: 404, json: { error: { message: 'Expired' } } }));
  await page.route('**/artifacts/retryable', route => failure === 'server' ? route.fulfill({ status: 500, body: 'Unavailable' }) : route.fulfill({ status: 200, contentType: 'image/png', body: failure === 'decode' ? 'Invalid PNG bytes' : png }));
  await page.goto(studio.launchUrl);
  await page.getByRole('button', { name: 'Design', exact: true }).click();
  await page.locator('.studio-console').getByRole('button', { name: 'Captures', exact: true }).click();
  await expect(page.locator('.studio-console').getByText('Screenshot expired', { exact: true })).toBeVisible();
  await expect(page.locator('.studio-console').getByText('Screenshot unavailable', { exact: true })).toBeVisible();
  failure = 'decode';
  await Promise.all([page.waitForResponse('**/artifacts/retryable'), page.getByRole('button', { name: 'Retry image' }).click()]);
  await expect(page.locator('.studio-console').getByText('Screenshot unavailable', { exact: true })).toBeVisible();
  failure = null;
  await page.getByRole('button', { name: 'Retry image' }).click();
  await expect(page.getByRole('img', { name: 'Capture of /habit · large' })).toBeVisible();
  await expect(page.getByRole('img', { name: 'Capture of /habit · large' })).toHaveJSProperty('naturalWidth', 1);
  const thumbnail = page.getByRole('button', { name: 'Open capture of /habit · large', exact: true });
  await thumbnail.click();
  const viewer = page.getByRole('dialog', { name: 'Capture · /habit · large', exact: true });
  await expect(viewer.getByRole('img', { name: 'Full capture of /habit · large' })).toHaveJSProperty('naturalWidth', 1);
  for (const viewport of [{ width: 375, height: 812 }, { width: 430, height: 932 }, { width: 1440, height: 1100 }]) {
    await page.setViewportSize(viewport);
    // Allow the container's ResizeObserver and portal relocation to commit.
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(viewer).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'App design', exact: true })).toHaveCount(0);
    await expect(viewer.getByRole('button', { name: 'Close dialog', exact: true })).toBeInViewport();
    await page.screenshot({ path: test.info().outputPath(`capture-viewer-${viewport.width}.png`) });
  }
  await expect(viewer.getByRole('button', { name: 'Close dialog', exact: true })).toBeFocused();
  expect(page.context().pages()).toHaveLength(1);
  await page.keyboard.press('Escape');
  await expect(viewer).toBeHidden();
  await expect(thumbnail).toBeFocused();
});

test('project picker has an honest empty state and a single accessible project control', async ({ page }) => {
  await page.goto(studio.launchUrl);
  await expect(page.getByRole('button', { name: '+ New app' })).toBeEnabled();
  const capture = async (state: string) => {
    if (!process.env.STUDIO_PICKER_EVIDENCE) return;
    const directory = path.resolve('.builder/studio-picker-review');
    await mkdir(directory, { recursive: true });
    await page.screenshot({ path: path.join(directory, `${process.env.STUDIO_PICKER_EVIDENCE}-${state}.png`) });
  };
  await capture('empty-desktop');
  await expect(page.getByRole('combobox', { name: 'Project', exact: true })).toHaveCount(0);
  await expect(page.locator('.project-avatar')).toHaveCount(0);
  await expect(page.locator('.sidebar')).toContainText('No projects yet');
  await page.setViewportSize({ width: 320, height: 640 });
  await capture('empty-mobile');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: '+ New app' }).click();
  await page.getByLabel('App name', { exact: true }).fill('Alpha Studio');
  await page.locator('.creation-folder summary').click();
  await page.getByLabel('Directory slug').fill('alpha-studio');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('radio', { name: /No backend for now/ }).check();
  await page.getByRole('button', { name: 'Create app', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const picker = page.getByRole('combobox', { name: 'Project', exact: true });
  await expect(picker).toBeVisible();
  await expect(page.locator('.project-picker select')).toHaveCount(0);
  await picker.click();
  await expect(page.getByRole('option')).toHaveCount(1);
  await expect(page.getByRole('option', { name: 'Alpha Studio' })).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Escape');
  const longName = `Zeta ${'long project name '.repeat(3).trim()}`;
  const second = await engine.projects.create({ name: longName, slug: 'zeta-studio' });
  await selectProject(page, second.id);
  await expect(page.locator('.topbar h1')).toHaveText(longName);
  await expect(picker).toBeFocused();
  for (const width of [1440, 768, 430, 375, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await picker.focus(); await picker.press('Tab'); await page.keyboard.press('Shift+Tab');
    await expect(picker).toBeFocused();
    const bounds = await picker.boundingBox();
    expect(bounds!.height).toBeGreaterThanOrEqual(width <= 760 ? 44 : 36);
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    const layout = await page.evaluate(() => ({
      width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
      overflowing: [...document.querySelectorAll('body *')].filter(node => node.getBoundingClientRect().right > innerWidth).map(node => ({ tag: node.tagName, className: node.className, right: node.getBoundingClientRect().right })),
    }));
    expect(layout.scrollWidth, JSON.stringify(layout)).toBe(width);
    const focus = await picker.evaluate(node => ({ width: getComputedStyle(node).outlineWidth, style: getComputedStyle(node).outlineStyle }));
    expect(focus.width).not.toBe('0px'); expect(focus.style).not.toBe('none');
    await capture(`selected-${width}`);
    const control = await picker.boundingBox();
    await picker.click();
    const list = page.getByRole('listbox', { name: 'Projects', exact: true });
    await expect(list).toBeVisible();
    const menu = await list.boundingBox();
    expect(menu!.y >= control!.y + control!.height + 4 || menu!.y + menu!.height <= control!.y - 4).toBe(true);
    expect(menu!.x).toBeGreaterThanOrEqual(0);
    expect(menu!.x + menu!.width).toBeLessThanOrEqual(width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    await capture(`open-${width}`);
    await page.keyboard.press('Home');
    await expect(page.getByRole('option', { name: 'Alpha Studio' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(picker).toBeFocused();
    await expect(picker).toContainText(longName);
    await picker.click(); await page.keyboard.press('Tab');
    await expect(list.getByRole('option', { selected: true })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(picker).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: '+ New app' })).toBeFocused();
    await expect(list).toHaveCount(0);
    await picker.click();
    await expect(list.getByRole('option', { selected: true })).toBeFocused();
    // Radix defers outside-pointer registration to avoid dismissing on the opening gesture.
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await page.mouse.click(width - 24, 4);
    await expect(list).toHaveCount(0);
    await expect(picker).toBeFocused();
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => { document.body.style.zoom = '2'; });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await capture('selected-zoom');
  await picker.focus();
  await picker.press('Space');
  await expect(page.getByRole('option', { name: longName })).toBeFocused();
  await page.keyboard.press('a');
  await expect(page.getByRole('option', { name: 'Alpha Studio' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(picker).toContainText('Alpha Studio');
  await expect(page.locator('.topbar h1')).toHaveText('Alpha Studio');
  await picker.press('ArrowDown');
  await expect(page.getByRole('option', { name: 'Alpha Studio' })).toBeFocused();
  await page.keyboard.press('End');
  await expect(page.getByRole('option', { name: longName })).toBeFocused();
  await capture('open-zoom');
  await page.keyboard.press('Enter');
  await expect(picker).toContainText(longName);
  await expect(page.getByRole('listbox')).toHaveCount(0);
});

test('create validates names and slugs, cancels, rejects duplicates and guards repeat submits', async ({ page }) => {
  await engine.projects.create({ name: 'Existing app', slug: 'existing' });
  await page.goto(studio.launchUrl);
  const open = page.getByRole('button', { name: '+ New app' });
  await open.click(); await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(await engine.projects.list()).toHaveLength(1);
  await open.click();
  await page.getByLabel('App name', { exact: true }).fill('Invalid !');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('radio', { name: /No backend for now/ }).check();
  await page.getByRole('button', { name: 'Create app', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Use a name');
  await page.getByRole('button', { name: 'Dismiss error' }).click();
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await page.getByLabel('App name', { exact: true }).fill('Valid name');
  await page.locator('.creation-folder summary').click();
  await page.getByLabel('Directory slug').fill('BAD slug');
  expect(await page.getByLabel('Directory slug').evaluate((node: HTMLInputElement) => node.checkValidity())).toBe(false);
  await page.getByLabel('Directory slug').fill('existing');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('button', { name: 'Create app', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await page.getByRole('button', { name: 'Dismiss error' }).click();
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await page.locator('.creation-folder summary').click();
  await page.getByLabel('Directory slug').fill('valid-name');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }); let posts = 0;
  await page.route('**/api/projects', async route => { if (route.request().method() === 'POST') { posts++; await held; } await route.continue(); });
  await page.getByRole('button', { name: 'Create app', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Creating…', exact: true })).toBeDisabled();
  await page.keyboard.press('Enter');
  release();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(posts).toBe(1); expect(await engine.projects.list()).toHaveLength(2);
  await expect(page.locator('.topbar h1')).toHaveText('Valid name');
});

test('action controls wait for a newer in-flight reconciliation before accepting another revision', async ({ page }) => {
  const project = await engine.projects.create({ name: 'Settled revisions', slug: 'settled' });
  await page.goto(studio.launchUrl);
  await page.getByRole('button', { name: 'Design', exact: true }).click();
  await expect(page.getByRole('button', { name: 'clay', exact: true })).toBeEnabled();
  const releases: Array<() => void> = [];
  let hold = true;
  await page.route(`**/api/projects/${project.id}`, async route => {
    const response = await route.fetch();
    if (hold) await new Promise<void>(resolve => releases.push(resolve));
    await route.fulfill({ response });
  });
  try {
    await page.getByRole('button', { name: 'clay', exact: true }).click();
    await expect.poll(() => releases.length).toBeGreaterThanOrEqual(1);
    engine.diagnostics.emit('change', project.id);
    await expect.poll(() => releases.length).toBeGreaterThanOrEqual(2);
    releases[0]!();
    await expect(page.getByRole('button', { name: 'midnight', exact: true }).click({ trial: true, timeout: 500 })).rejects.toThrow('Timeout');
  } finally { hold = false; for (const release of releases) release(); }
  await expect(page.getByRole('button', { name: 'midnight', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'clay', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'clay', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'midnight', exact: true }).click();
  await expect.poll(async () => (await engine.designs.read(project.id)).preset).toBe('midnight');
  await expect(page.getByRole('button', { name: 'sage', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'midnight', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'midnight', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.unrouteAll({ behavior: 'wait' });
});

test('design presets, appearances, every token and slider bounds save exact disk values', async ({ page }) => {
  const project = await engine.projects.create({ name: 'Design matrix', slug: 'design-matrix' });
  await page.goto(studio.launchUrl);
  await page.getByRole('button', { name: 'Design', exact: true }).click();
  for (const preset of ['sage', 'clay', 'midnight'] as const) {
    const choice = page.getByRole('button', { name: preset, exact: true });
    if (await choice.getAttribute('aria-pressed') !== 'true') await choice.click();
    await expect.poll(async () => (await engine.designs.read(project.id)).preset).toBe(preset);
    await expect(choice).toBeDisabled();
    for (const mode of ['dark', 'light'] as const) {
      await page.getByRole('button', { name: mode === 'dark' ? 'Dark' : 'Light', exact: true }).click();
      await expect.poll(async () => (await engine.designs.read(project.id)).mode).toBe(mode);
    }
  }
  await expect(page.getByRole('button', { name: 'Apply changes' })).toBeDisabled();
  const before = await engine.designs.read(project.id);
  for (const color of ['background', 'surface', 'text', 'muted', 'accent', 'onAccent', 'border'] as const) await page.getByLabel(color, { exact: true }).fill('#123456');
  for (const [label, min, max] of [['Corner radius', '0', '32'], ['Base spacing', '4', '12'], ['Body type', '14', '20']]) {
    await page.getByLabel(label!).fill(min!); await expect(page.getByLabel(label!)).toHaveValue(min!);
    await page.getByRole('button', { name: 'Apply changes' }).click();
    await expect(page.getByRole('button', { name: 'sage', exact: true })).toBeEnabled();
    await page.getByLabel(label!).fill(max!);
    await page.getByRole('button', { name: 'Apply changes' }).click();
    await expect(page.getByRole('button', { name: 'sage', exact: true })).toBeEnabled();
  }
  const after = await engine.designs.read(project.id);
  expect(after.revision).not.toBe(before.revision);
  expect(after.tokens).toMatchObject({ background: '#123456', surface: '#123456', text: '#123456', muted: '#123456', accent: '#123456', onAccent: '#123456', border: '#123456', radius: 32, spacing: 12, bodySize: 20 });
  await expect(page.getByRole('button', { name: 'midnight', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Light', exact: true })).toBeDisabled();
  await page.getByLabel('Corner radius').fill('31');
  await expect(page.getByRole('button', { name: 'sage', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Discard draft' }).click();
  await page.getByRole('button', { name: 'sage', exact: true }).click();
  await expect.poll(async () => (await engine.designs.read(project.id)).tokens.accent).not.toBe('#123456');
  await page.getByLabel('Corner radius').fill('31');
  await page.getByLabel('Corner radius').fill(String((await engine.designs.read(project.id)).tokens.radius));
  await expect(page.getByRole('button', { name: 'Apply changes' })).toBeDisabled();
});

test('malformed design repair preserves draft and diagnostics remain bounded safe text', async ({ page }) => {
  const project = await engine.projects.create({ name: 'Repair app', slug: 'repair' });
  await page.goto(studio.launchUrl);
  await page.getByRole('button', { name: 'Design', exact: true }).click();
  await page.getByLabel('Corner radius').fill('31');
  const original = await engine.files.read(project.id, 'src/theme/design.json');
  const broken = await engine.files.write(project.id, [{ path: original.path, content: '{', expectedRevision: original.revision }]);
  engine.diagnostics.emit('change', project.id);
  await expect(page.getByRole('heading', { name: 'Design needs attention' })).toBeVisible();
  await engine.files.write(project.id, [{ path: original.path, content: original.content, expectedRevision: broken.applied[0]!.revision }]);
  engine.diagnostics.emit('change', project.id);
  await expect(page.getByLabel('Corner radius')).toHaveValue('31');
  await page.getByRole('button', { name: /^Close (dialog|Design)$/ }).click();
  await page.locator('.studio-console').getByRole('button', { name: 'Diagnostics', exact: true }).click();
  await page.locator('.studio-console').getByRole('button', { name: 'Show all output', exact: true }).click();
  await expect(page.getByText('Install, preview and browser feedback will appear here.')).toBeVisible();
  for (let i = 0; i < 105; i++) engine.diagnostics.add(project.id, 'builder', i === 104 ? 'error' : 'info', `${i}: <script>throw new Error('unsafe')</script>`);
  await expect(page.locator('.studio-console .diagnostic-row')).toHaveCount(100);
  await expect(page.locator('.studio-console .diagnostic-row').first()).toContainText('104:');
  await expect(page.locator('.studio-console .diagnostic-row').last()).toContainText('5:');
  await expect(page.locator('.studio-console .activity-retention')).toContainText('Older output was truncated.');
  await expect(page.locator('.console-bar')).toContainText('1 error');
  expect(await page.locator('.studio-console script').count()).toBe(0);
});

test('shortcut paths, invalid custom paths and project switch reset are explicit', async ({ page }) => {
  const first = await engine.projects.create({ name: 'First routes', slug: 'routes-one' });
  const second = await engine.projects.create({ name: 'Second routes', slug: 'routes-two' });
  await page.goto(studio.launchUrl);
  await expect(page.getByLabel('Project', { exact: true })).toContainText(first.name);
  await openProjectRoutes(page);
  await expect(page.getByRole('region', { name: 'Project routes', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '/habit File candidate', exact: true })).toBeVisible();
  await page.getByLabel('Agent-added screen').fill('//outside');
  await page.getByRole('button', { name: 'Open custom route' }).click();
  await expect(page.getByRole('alert')).toContainText('Use a concrete route');
  await page.getByLabel('Agent-added screen').fill('/settings');
  await page.getByRole('button', { name: 'Open custom route' }).click();
  await expect(page.locator('.preview-caption')).toContainText('/settings');
  await page.getByRole('button', { name: 'Design', exact: true }).click();
  await page.getByLabel('Corner radius').fill('31');
  await page.getByRole('button', { name: /^Close (dialog|Design)$/ }).click();
  await selectProject(page, second.id);
  await openProjectRoutes(page);
  await expect(page.getByLabel('Agent-added screen')).toHaveValue('');
  await page.getByLabel('Agent-added screen').press('Escape');
  await expect(page.locator('.preview-caption')).not.toContainText('/settings');
  await expect(page.getByRole('button', { name: 'Discard draft' })).toHaveCount(0);
  await selectProject(page, first.id);
  await page.getByRole('button', { name: 'Design', exact: true }).click();
  await expect(page.getByLabel('Corner radius')).toHaveValue('31');
});

test('create dialog supports focus, Escape and compact keyboard targets', async ({ page }) => {
  await page.goto(studio.launchUrl);
  const trigger = page.getByRole('button', { name: '+ New app' });
  await trigger.click();
  await expect(page.getByRole('dialog', { name: 'What are you making?' })).toBeVisible();
  await expect(page.getByLabel('App name', { exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0); await expect(trigger).toBeFocused();
  const bounds = await trigger.boundingBox(); expect(bounds!.height).toBeGreaterThanOrEqual(36);
});
