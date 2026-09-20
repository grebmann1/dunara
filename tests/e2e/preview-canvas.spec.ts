import { test, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Engine } from '../../packages/core/src/engine.js';
import { Projects } from '../../packages/core/src/projects.js';
import { startStudio } from '../../packages/cli/src/studio-server.js';
import { selectProject } from './project-picker.js';

test.use({ trace: 'off' });
let dir: string, engine: Engine, studio: Awaited<ReturnType<typeof startStudio>>;
test.beforeEach(async ({ page }) => {
  test.skip(!!process.env.VISUAL, 'Visual suite only');
  dir = await mkdtemp(path.join(os.tmpdir(), 'studio-canvas-'));
  engine = new Engine(await Projects.open(path.join(dir, 'apps'), path.join(dir, 'home')), true);
  studio = await startStudio(engine, path.resolve('dist/studio'));
  await engine.projects.create({ name: 'Canvas Alpha', slug: 'canvas-alpha' });
  await page.route('**/*', route => route.request().isNavigationRequest() && route.request().frame().parentFrame()
    ? route.fulfill({ contentType: 'text/html', body: '<!doctype html><body style="margin:0"><h1>Live canvas fixture</h1><input aria-label="App draft"><div style="height:1800px">Scrollable app content</div><button id="bottom" style="position:fixed;bottom:0;height:56px;width:100%" onclick="this.textContent=\'Bottom action worked\'">Bottom action</button></body>' })
    : route.continue());
  // Keep authenticated API requests on the real server; a cancelled refresh
  // must not leave a fetch/fulfill interceptor racing the next navigation.
  const inspect = engine.inspect.bind(engine);
  engine.inspect = async (...args) => {
    const state = await inspect(...args);
    return { ...state, preview: { ...state.preview, status: 'ready', url: studio.origin.replace('127.0.0.1', 'localhost') } };
  };
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(studio.launchUrl);
  await expect(page.frameLocator('iframe').getByRole('heading', { name: 'Live canvas fixture' })).toBeVisible();
});
test.afterEach(async ({ page }) => {
  if (process.env.VISUAL) return;
  await page.unrouteAll({ behavior: 'wait' }); await page.close();
  await studio.close(); await engine.close(); await rm(dir, { recursive: true, force: true });
});

test('zoom and scrolling/keyboard navigation keep bottom actions reachable without reloading the live phone', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const canvas = page.getByRole('region', { name: 'Phone preview canvas' });
  const fit = page.getByRole('button', { name: 'Fit', exact: true });
  const frame = page.frameLocator('iframe');
  const mounted = await page.getByTitle('Live app preview').elementHandle();
  await frame.getByLabel('App draft').fill('Keep this draft');
  const outerOverflow = await page.locator('.workspace-content').evaluate(node => node.scrollHeight - node.clientHeight);
  await page.getByRole('button', { name: '100%', exact: true }).click();
  await expect(page.getByRole('status', { name: 'Canvas zoom level' })).toHaveText('100%');
  await expect.poll(() => canvas.evaluate(node => node.scrollHeight - node.clientHeight)).toBeGreaterThan(300);
  expect(await page.locator('.workspace-content').evaluate(node => node.scrollHeight - node.clientHeight)).toBe(outerOverflow);
  await canvas.focus(); await page.keyboard.press('Home');
  const rect = await canvas.boundingBox();
  await page.mouse.move(rect!.x + 12, rect!.y + rect!.height / 2);
  await page.mouse.wheel(0, 300);
  await expect.poll(() => canvas.evaluate(node => node.scrollTop)).toBeGreaterThan(150);
  await expect(canvas).not.toHaveAttribute('data-dragging');
  await canvas.focus(); await page.keyboard.press('End');
  await expect.poll(() => canvas.evaluate(node => { const area = node.getBoundingClientRect(), phone = node.querySelector('.device-fit')!.getBoundingClientRect(); return phone.bottom > area.top && phone.bottom <= area.bottom; })).toBe(true);
  await page.keyboard.press('Escape');
  await frame.getByRole('button', { name: 'Bottom action', exact: true }).click();
  await expect(frame.getByRole('button', { name: 'Bottom action worked' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('canvas-bottom-at-100.png') });
  await fit.click();
  await expect.poll(() => canvas.evaluate(node => { const area = node.getBoundingClientRect(), phone = node.querySelector('.device-fit')!.getBoundingClientRect(); return phone.left >= area.left && phone.right <= area.right && phone.top >= area.top && phone.bottom <= area.bottom; })).toBe(true);
  await expect(frame.getByLabel('App draft')).toHaveValue('Keep this draft');
  expect(await mounted!.evaluate(node => ({ connected: node.isConnected, width: node.clientWidth, height: node.clientHeight }))).toEqual({ connected: true, width: 375, height: 812 });
  await page.getByRole('button', { name: '100%', exact: true }).click();
  for (let i = 0; i < 10; i++) await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await expect(page.getByRole('status', { name: 'Canvas zoom level' })).toHaveText('200%');
  await expect(page.getByRole('button', { name: 'Zoom in', exact: true })).toBeDisabled();
  await page.setViewportSize({ width: 768, height: 812 });
  await canvas.focus(); await page.keyboard.press('ArrowRight');
  await expect.poll(() => canvas.evaluate(node => node.scrollLeft)).toBeGreaterThan(0);
  for (let i = 0; i < 18; i++) await page.getByRole('button', { name: 'Zoom out', exact: true }).click();
  await expect(page.getByRole('status', { name: 'Canvas zoom level' })).toHaveText('25%');
  await expect(page.getByRole('button', { name: 'Zoom out', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Assets', exact: true }).click();
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(page.getByRole('status', { name: 'Canvas zoom level' })).toHaveText('25%');
  expect(await mounted!.evaluate(node => node.isConnected)).toBe(true);
  const other = await engine.projects.create({ name: 'Canvas Beta', slug: 'canvas-beta' });
  await selectProject(page, other.id);
  await expect(fit).toHaveAttribute('aria-pressed', 'true');
  expect(errors).toEqual([]);
});

test('canvas controls and bottom content fit six widths and browser zoom', async ({ page }, testInfo) => {
  const canvas = page.getByRole('region', { name: 'Phone preview canvas' });
  const fit = page.getByRole('button', { name: 'Fit', exact: true });
  for (const width of [320, 375, 430, 768, 1280, 1440]) {
    await page.setViewportSize({ width, height: width === 430 ? 932 : 812 });
    for (const zoom of [1, 2]) {
      await page.evaluate(value => { document.documentElement.style.zoom = String(value); }, zoom);
      await fit.click();
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
      await expect.poll(() => canvas.evaluate(node => { const area = node.getBoundingClientRect(), phone = node.querySelector('.device-fit')!.getBoundingClientRect(); return phone.left >= area.left && phone.right <= area.right && phone.top >= area.top && phone.bottom <= area.bottom; })).toBe(true);
      for (const button of await page.locator('.live-board .canvas-controls button').all()) {
        const dimensions = await button.evaluate(node => {
          if (!(node instanceof HTMLButtonElement)) throw new Error('Expected a canvas button');
          return { width: node.offsetWidth, height: node.offsetHeight };
        });
        expect(dimensions.width).toBeGreaterThanOrEqual(width <= 760 ? 44 : 32); expect(dimensions.height).toBeGreaterThanOrEqual(width <= 760 ? 44 : 32);
      }
      await page.getByRole('button', { name: '100%', exact: true }).click();
      await canvas.focus(); await page.keyboard.press('End');
      await expect.poll(() => canvas.evaluate(node => { const area = node.getBoundingClientRect(), phone = node.querySelector('.device-fit')!.getBoundingClientRect(); return phone.bottom > area.top && phone.bottom <= area.bottom; })).toBe(true);
      await expect(page.getByTitle('Live app preview')).toHaveJSProperty('clientWidth', 375);
      await fit.click();
    }
    await page.evaluate(() => { document.documentElement.style.zoom = ''; });
    if (width === 375 || width === 430) await page.screenshot({ path: testInfo.outputPath(`canvas-fit-${width}.png`), fullPage: true });
  }
});

test('modified wheel zoom anchors the cursor, scrolling moves the camera, and the phone keeps native scrolling', async ({ page }) => {
  const canvas = page.getByRole('region', { name: 'Phone preview canvas' });
  const fit = page.getByRole('button', { name: 'Fit', exact: true });
  const level = page.getByRole('status', { name: 'Canvas zoom level' });
  const phone = page.locator('.live-board .device-fit'), iframe = page.locator('iframe');
  const mounted = await iframe.elementHandle();
  await page.frameLocator('iframe').getByLabel('App draft').fill('Retain wheel draft');
  await fit.click(); await canvas.scrollIntoViewIfNeeded();
  const area = (await canvas.boundingBox())!, original = (await phone.boundingBox())!;
  await page.mouse.move(area.x + 15, area.y + 70); await page.mouse.wheel(-35, -35);
  await expect.poll(async () => (await phone.boundingBox())!.x - original.x).toBeCloseTo(35, 0);
  await expect.poll(async () => (await phone.boundingBox())!.y - original.y).toBeCloseTo(35, 0);
  await fit.click();
  await expect.poll(async () => (await phone.boundingBox())!.x - original.x).toBeCloseTo(0, 0);
  await expect.poll(async () => (await phone.boundingBox())!.y - original.y).toBeCloseTo(0, 0);
  for (const browserZoom of [1, 2]) {
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.evaluate(value => { document.documentElement.style.zoom = String(value); }, browserZoom);
    await fit.click(); await canvas.scrollIntoViewIfNeeded();
    const rect = (await canvas.boundingBox())!;
    const cursor = { x: rect.x + 12, y: Math.min(rect.y + rect.height * 0.35, 1000) };
    const before = (await phone.boundingBox())!, beforeLevel = Number.parseInt((await level.textContent())!);
    const point = { x: (cursor.x - before.x) / before.width, y: (cursor.y - before.y) / before.height };
    await page.mouse.move(cursor.x, cursor.y); await page.keyboard.down('Control'); await page.mouse.wheel(0, -100);
    await expect.poll(async () => Number.parseInt((await level.textContent())!)).toBeGreaterThan(beforeLevel);
    const after = (await phone.boundingBox())!;
    expect(Math.abs((cursor.x - after.x) / after.width - point.x)).toBeLessThan(0.01);
    expect(Math.abs((cursor.y - after.y) / after.height - point.y)).toBeLessThan(0.01);
    await page.mouse.wheel(0, 10000); await expect(level).toHaveText('25%');
    await page.mouse.wheel(0, -10000); await expect(level).toHaveText('200%');
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
    await page.keyboard.up('Control');
  }
  await page.evaluate(() => { document.documentElement.style.zoom = ''; });
  await fit.click(); await canvas.scrollIntoViewIfNeeded();
  const fitLevel = await level.textContent(), rect = (await iframe.boundingBox())!;
  const child = page.frames().find(frame => frame.parentFrame())!;
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
  await page.mouse.wheel(0, 180);
  await expect.poll(() => child.evaluate(() => scrollY)).toBeGreaterThan(0);
  await expect(level).toHaveText(fitLevel!);
  expect(await mounted!.evaluate(node => ({ connected: node.isConnected, width: node.clientWidth, height: node.clientHeight }))).toEqual({ connected: true, width: 375, height: 812 });
  await expect(page.frameLocator('iframe').getByLabel('App draft')).toHaveValue('Retain wheel draft');
});

test('background and middle-button dragging pan the camera without moving or remounting phones', async ({ page }) => {
  const canvas = page.getByRole('region', { name: 'Phone preview canvas' });
  const phone = canvas.locator('.device-fit'), frame = page.frameLocator('iframe');
  const mounted = await page.locator('iframe').elementHandle();
  const level = page.getByRole('status', { name: 'Canvas zoom level' });
  await frame.getByLabel('App draft').fill('Retain drag draft');
  for (const browserZoom of [1, 2]) {
    await page.evaluate(value => { document.documentElement.style.zoom = String(value); }, browserZoom);
    await page.getByRole('button', { name: 'Fit', exact: true }).click();
    await canvas.scrollIntoViewIfNeeded();
    const area = (await canvas.boundingBox())!, before = (await phone.boundingBox())!;
    const zoom = await level.textContent();
    const world = () => phone.evaluate(node => ({ left: (node as HTMLElement).offsetLeft, top: (node as HTMLElement).offsetTop, width: (node as HTMLElement).offsetWidth, height: (node as HTMLElement).offsetHeight }));
    const layout = await world();
    const start = { x: area.x + 12, y: Math.min(area.y + area.height / 2, 800) };
    await page.mouse.move(start.x, start.y); await page.mouse.down();
    await expect(canvas).toHaveAttribute('data-dragging', 'true');
    await page.mouse.move(start.x + 100, start.y - 60, { steps: 8 }); await page.mouse.up();
    await expect.poll(async () => (await phone.boundingBox())!.x - before.x).toBeCloseTo(100, 0);
    await expect.poll(async () => (await phone.boundingBox())!.y - before.y).toBeCloseTo(-60, 0);
    expect(await world()).toEqual(layout); await expect(level).toHaveText(zoom!);
    await expect(canvas).not.toHaveAttribute('data-dragging');
    const moved = (await phone.boundingBox())!;
    await page.mouse.move(start.x + 120, start.y - 80); expect(await phone.boundingBox()).toEqual(moved);
  }
  await page.evaluate(() => { document.documentElement.style.zoom = ''; });
  await page.getByRole('button', { name: 'Fit', exact: true }).click(); await canvas.scrollIntoViewIfNeeded();
  const area = (await canvas.boundingBox())!, before = (await phone.boundingBox())!;
  const start = { x: area.x + 12, y: area.y + area.height / 2 };
  // Pointer capture keeps the gesture working as it crosses the live iframe.
  await page.mouse.move(start.x, start.y); await page.mouse.down({ button: 'middle' });
  await page.mouse.move(before.x + before.width / 2, start.y, { steps: 8 }); await page.mouse.up({ button: 'middle' });
  await expect.poll(async () => (await phone.boundingBox())!.x - before.x).toBeCloseTo(before.x + before.width / 2 - start.x, 0);
  await page.getByRole('button', { name: 'Fit', exact: true }).click();
  const stopped = (await phone.boundingBox())!;
  await page.mouse.move(start.x, start.y); await page.mouse.down(); await page.keyboard.press('Escape');
  await page.mouse.move(start.x + 50, start.y - 40); await page.mouse.up();
  expect(await phone.boundingBox()).toEqual(stopped);
  await page.mouse.move(start.x, start.y); await page.mouse.down();
  await canvas.dispatchEvent('pointercancel'); await expect(canvas).not.toHaveAttribute('data-dragging');
  await page.mouse.move(start.x + 50, start.y - 40); await page.mouse.up();
  expect(await phone.boundingBox()).toEqual(stopped);
  await frame.getByRole('button', { name: 'Bottom action', exact: true }).click();
  await expect(frame.getByRole('button', { name: 'Bottom action worked' })).toBeVisible();
  await expect(frame.getByLabel('App draft')).toHaveValue('Retain drag draft');
  expect(await mounted!.evaluate(node => ({ connected: node.isConnected, width: node.clientWidth, height: node.clientHeight }))).toEqual({ connected: true, width: 375, height: 812 });
});

test('native touch scrolling moves the camera without activating app controls', async ({ page, context }) => {
  await page.setViewportSize({ width: 430, height: 932 });
  const canvas = page.getByRole('region', { name: 'Phone preview canvas' });
  await page.getByRole('button', { name: '100%', exact: true }).click();
  await canvas.focus(); await page.keyboard.press('Home');
  await canvas.scrollIntoViewIfNeeded();
  const rect = await canvas.boundingBox();
  const beforeTouch = await canvas.evaluate(node => node.scrollTop);
  const cdp = await context.newCDPSession(page);
  const x = rect!.x + 12, y = Math.min(850, rect!.y + rect!.height - 50);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  for (let distance = 20; distance <= 160; distance += 20) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y - distance }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
  await expect(canvas).not.toHaveAttribute('data-dragging');
  await expect.poll(async () => (await canvas.evaluate(node => node.scrollTop)) - beforeTouch).toBeGreaterThan(80);
  await expect(page.frameLocator('iframe').getByRole('button', { name: 'Bottom action', exact: true })).toHaveCount(1);
  await canvas.focus(); await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Pan canvas' })).toHaveCount(0);
  await cdp.detach();
});

test('canvas reserves room for named screens and keeps on-demand tools from shifting phones', async ({ page }, testInfo) => {
  const canvas = page.locator('.live-board .device-area');
  const mounted = await page.locator('iframe').elementHandle();
  await page.frameLocator('iframe').getByLabel('App draft').fill('Keep my canvas draft');
  const measurements = [];
  for (const width of [768, 1280, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const count of [1, 2]) {
      if (count === 2) await page.getByRole('button', { name: 'Compare', exact: true }).click();
      await expect(page.locator('iframe')).toHaveCount(count);
      for (const frame of await page.locator('iframe').all()) await expect(frame.contentFrame().getByRole('heading', { name: 'Live canvas fixture' })).toBeVisible();
      const occupancy = () => canvas.evaluate(node => {
        const area = node.getBoundingClientRect(), workspace = document.querySelector('.workspace-content')!.getBoundingClientRect();
        return { fraction: area.width * area.height / (workspace.width * workspace.height), width: area.width, height: area.height, overflow: document.documentElement.scrollWidth - innerWidth };
      });
      await expect.poll(async () => (await occupancy()).fraction).toBeGreaterThanOrEqual(0.7);
      const before = await occupancy();
      expect(before.overflow).toBe(0);
      measurements.push({ studioWidth: width, views: count, ...before });
      const tools = page.getByLabel('Preview tools', { exact: true });
      await tools.focus(); await page.keyboard.press('Enter');
      await expect(page.getByRole('button', { name: 'Project settings', exact: true })).toBeVisible();
      expect(await occupancy()).toEqual(before);
      await page.getByRole('button', { name: 'Project settings', exact: true }).focus(); await page.keyboard.press('Escape');
      await expect(tools).toBeFocused();
      await expect(page.getByRole('button', { name: 'Project settings', exact: true })).toBeHidden();
      await tools.click();
      const routes = page.getByRole('button', { name: 'Project routes', exact: true });
      await routes.focus(); await page.keyboard.press('Space');
      await expect(page.getByLabel('Agent-added screen')).toBeVisible();
      expect(await occupancy()).toEqual(before);
      await page.getByLabel('Agent-added screen').focus(); await page.keyboard.press('Escape');
      await expect(tools).toBeFocused();
      if (count === 2) await page.getByRole('button', { name: 'Focus', exact: true }).click();
    }
    await page.screenshot({ path: testInfo.outputPath(`canvas-occupancy-${width}.png`) });
  }
  expect(await mounted!.evaluate(node => node.isConnected)).toBe(true);
  await expect(page.frameLocator('iframe').getByLabel('App draft')).toHaveValue('Keep my canvas draft');
  await testInfo.attach('canvas-occupancy', { body: JSON.stringify(measurements, null, 2), contentType: 'application/json' });
});
