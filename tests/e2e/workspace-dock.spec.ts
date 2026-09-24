import { test, expect, type Page } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Engine } from '../../packages/core/src/engine.js';
import { Projects } from '../../packages/core/src/projects.js';
import { startStudio } from '../../packages/cli/src/studio-server.js';
import { AssistantService } from '../../packages/assistant/src/service.js';
import { startDesktopMcp } from '../../packages/mcp/src/socket.js';
import { McpGateway } from '../../packages/assistant/src/mcp-bridge.js';

let root: string, engine: Engine, studio: Awaited<ReturnType<typeof startStudio>>, assistant: AssistantService, endpoint: Awaited<ReturnType<typeof startDesktopMcp>>, app: Server;
test.use({ trace: 'off', viewport: { width: 1600, height: 1000 } });
test.beforeEach(async ({ page }) => {
  root = await mkdtemp(path.join(os.tmpdir(), 'builder-dock-'));
  engine = new Engine(await Projects.open(path.join(root, 'apps'), path.join(root, 'home')), true);
  const project = await engine.projects.create({ name: 'Lune workspace', slug: 'lune-workspace' });
  engine.diagnostics.add(project.id, 'builder', 'error', 'A sample layout issue\nDetails stay available while moving panels.');
  app = createServer((_request, response) => { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end('<!doctype html><html><body style="margin:0;padding:24px;background:#18172e;color:#ede8ff;font:16px system-ui"><p>☾ LUNE</p><h1 style="font:38px Georgia">Make room<br>for rest.</h1><p>Your evening, at your pace.</p><input aria-label="App note" placeholder="Tonight’s intention"><div style="height:1000px"></div></body></html>'); });
  await new Promise<void>(resolve => app.listen(0, '127.0.0.1', resolve)); const address = app.address(); if (!address || typeof address === 'string') throw new Error('App unavailable');
  engine.previews.status = id => ({ projectId: id, status: 'ready', url: `http://localhost:${address.port}` });
  endpoint = await startDesktopMcp(engine);
  assistant = new AssistantService({ home: path.join(root, 'home'), createHarness: () => ({ async run() { throw new Error('No model calls belong in a layout test'); }, async close() {} }), createGateway: (binding, signal, context) => McpGateway.open(endpoint.socketPath, binding, signal, context) });
  assistant.configure({ action: 'connect', key: 'fake-layout-test-key' });
  studio = await startStudio(engine, path.resolve('dist/studio'), assistant);
  await page.goto(studio.launchUrl);
  await expect(page.frameLocator('iframe').getByLabel('App note')).toBeVisible();
});
test.afterEach(async ({ page }) => { await page.close(); await assistant?.close(); await endpoint?.close(); await studio?.close(); await engine?.close(); app?.closeAllConnections(); await new Promise<void>(resolve => app?.close(() => resolve())); await rm(root, { recursive: true, force: true }); });

async function move(page: Page, label: string, position: string) {
  await page.getByLabel(`Arrange ${label} panel`, { exact: true }).click();
  await page.getByRole('button', { name: `Move to ${position}`, exact: true }).click();
}
async function dragPanel(page: Page, label: string, position: string) {
  const handle = page.getByRole('button', { name: `Drag ${label} panel`, exact: true });
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down(); await page.mouse.move(box.x + 40, box.y + 15, { steps: 6 });
  await expect(page.getByTestId(`dock-drop-${position}`)).toBeVisible();
  const target = (await page.getByTestId(`dock-drop-${position}`).boundingBox())!;
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 10 }); await page.mouse.up();
  await expect(page.locator('.dock-drop-overlay')).toHaveCount(0);
}

test('console moves by drag and menu, resizes, persists and leaves the live app mounted', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.frameLocator('iframe').getByLabel('App note').fill('Keep this app state');
  const frame = await page.locator('iframe').elementHandle();
  await page.getByRole('button', { name: 'Diagnostics', exact: true }).click();
  await page.getByRole('searchbox', { name: 'Search diagnostics' }).fill('layout issue');
  await page.locator('.diagnostic-row summary').click();
  await page.screenshot({ path: info.outputPath('console-bottom.png') });
  await dragPanel(page, 'Console', 'left');
  await expect(page.locator('[data-panel=console]')).toHaveAttribute('data-position', 'left');
  await expect(page.getByRole('searchbox', { name: 'Search diagnostics' })).toHaveValue('layout issue');
  await expect(page.locator('.diagnostic-row')).toHaveAttribute('open', '');
  const separator = page.getByRole('separator', { name: 'Resize left panel' });
  const before = Number(await separator.getAttribute('aria-valuenow'));
  await separator.focus(); await separator.press('ArrowRight');
  await expect(separator).toHaveAttribute('aria-valuenow', String(before + 20));
  const box = (await separator.boundingBox())!;
  await page.mouse.move(box.x + 2, box.y + 90); await page.mouse.down(); await page.mouse.move(box.x + 42, box.y + 90, { steps: 5 }); await page.mouse.up();
  await expect(separator).toHaveAttribute('aria-valuenow', String(before + 60));
  await page.screenshot({ path: info.outputPath('console-left.png') });
  await move(page, 'Console', 'right');
  await expect(page.frameLocator('iframe').getByLabel('App note')).toHaveValue('Keep this app state');
  expect(await frame!.evaluate(node => node.isConnected)).toBe(true);
  await page.getByRole('button', { name: 'Collapse console' }).click();
  await expect(page.getByRole('button', { name: 'Diagnostics', exact: true })).toBeFocused();
  await page.goto(studio.issueLaunchUrl()); await page.getByRole('button', { name: 'Diagnostics', exact: true }).click();
  await expect(page.locator('[data-panel=console]')).toHaveAttribute('data-position', 'right');
  await page.getByLabel('Arrange Console panel', { exact: true }).click();
  await page.getByRole('button', { name: 'Reset workspace layout' }).click();
  await expect(page.locator('[data-panel=console]')).toHaveAttribute('data-position', 'bottom');
  expect(errors).toEqual([]);
});

test('assistant stays at the page edge across navigation, other panels and compact windows', async ({ page }, info) => {
  // Older saved dock preferences must not move the page-level Assistant.
  await page.evaluate(() => localStorage.setItem('builder.workspace-layout.v1', JSON.stringify({ positions: { assistant: 'left', design: 'right', console: 'bottom' }, left: 380, right: 400, bottom: 300 })));
  await page.goto(studio.issueLaunchUrl());
  await page.frameLocator('iframe').getByLabel('App note').fill('Keep the live preview mounted');
  const frame = await page.locator('iframe').elementHandle();
  await page.getByRole('button', { name: 'Assistant', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Message assistant' });
  await expect(input).toBeEditable();
  const singleLineHeight = (await input.boundingBox())!.height;
  await input.fill('First line\nSecond line\nThird line\nFourth line');
  await expect.poll(async () => (await input.boundingBox())!.height).toBeGreaterThan(singleLineHeight);
  await input.fill('A draft that stays with this panel');
  const panel = page.getByRole('dialog', { name: 'Assistant', exact: true });
  await expect(page.getByRole('button', { name: 'Drag Assistant panel' })).toHaveCount(0);
  await expect(page.getByLabel('Arrange Assistant panel', { exact: true })).toHaveCount(0);
  await expect(page.locator('.dock-slot[data-panel=assistant]')).toHaveCount(0);
  const shell = (await page.locator('.studio').boundingBox())!;
  let edge = (await panel.boundingBox())!;
  expect(edge.y).toBeCloseTo(shell.y, 0); expect(edge.height).toBeCloseTo(shell.height, 0);
  expect(edge.x + edge.width).toBeCloseTo(shell.x + shell.width, 0);
  expect(edge.width).toBeGreaterThan(430);
  const assistantResize = page.getByRole('separator', { name: 'Assistant width' });
  await expect(assistantResize).toBeVisible();
  await expect(assistantResize).toHaveAttribute('aria-valuenow', /\d+/);
  const assistantBefore = Number(await assistantResize.getAttribute('aria-valuenow'));
  await assistantResize.focus(); await assistantResize.press('ArrowLeft');
  await expect(assistantResize).toHaveAttribute('aria-valuenow', String(assistantBefore + 16));
  expect((await panel.boundingBox())!.width).toBeGreaterThan(edge.width);
  edge = (await panel.boundingBox())!;
  const header = (await panel.locator('.assistant-header').boundingBox())!;
  await page.mouse.move(header.x + 80, header.y + 30); await page.mouse.down();
  await page.mouse.move(300, 350, { steps: 8 }); await page.mouse.up();
  await page.evaluate(() => getSelection()?.removeAllRanges());
  await expect(page.locator('.dock-drop-overlay')).toHaveCount(0);
  expect((await panel.boundingBox())!.x).toBeCloseTo(edge.x, 0);
  expect((await input.boundingBox())!.height).toBeGreaterThanOrEqual(88);
  expect((await panel.locator('.assistant-input-box').boundingBox())!.height).toBeLessThanOrEqual(shell.height * .36);
  await page.screenshot({ path: info.outputPath('assistant-desktop.png') });
  for (const destination of ['Assets', 'App Icons', 'Activity']) {
    await page.getByRole('button', { name: destination, exact: true }).click();
    await expect(page.locator('.media-workbench:not([hidden])')).toBeVisible();
    await expect(page.locator('.workspace-content')).toHaveCSS('margin-right', '0px');
    await expect(input).toHaveValue('A draft that stays with this panel');
    await page.screenshot({ path: info.outputPath(`assistant-${destination.toLowerCase().replaceAll(' ', '-')}.png`) });
  }
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await page.getByRole('button', { name: 'Design', exact: true }).click();
  await page.getByLabel('Corner radius').fill('29');
  await expect(page.getByRole('tab', { name: 'Assistant', exact: true })).toHaveCount(0);
  await expect(input).toHaveValue('A draft that stays with this panel');
  await expect(page.getByLabel('Corner radius')).toHaveValue('29');
  const canvas = (await page.locator('.workspace-content').boundingBox())!;
  const design = (await page.locator('[data-panel=design]').boundingBox())!;
  expect(canvas.x + canvas.width).toBeLessThanOrEqual(design.x + 1);
  expect(design.x + design.width).toBeLessThanOrEqual(edge.x + 1);
  expect(canvas.width).toBeGreaterThanOrEqual(418);
  await page.screenshot({ path: info.outputPath('assistant-and-design.png') });
  await page.getByRole('button', { name: 'Diagnostics', exact: true }).click();
  expect((await panel.boundingBox())!.height).toBeCloseTo(shell.height, 0);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(input).toHaveValue('A draft that stays with this panel');
  expect((await panel.boundingBox())!.x).toBeCloseTo(edge.x, 0);
  await page.screenshot({ path: info.outputPath('assistant-settings.png') });
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  expect(await frame!.evaluate(node => node.isConnected)).toBe(true);
  await expect(page.frameLocator('iframe').getByLabel('App note')).toHaveValue('Keep the live preview mounted');
  for (const width of [375, 430]) {
    await page.setViewportSize({ width, height: width === 375 ? 812 : 932 });
    await expect(input).toBeVisible(); await expect(input).toHaveValue('A draft that stays with this panel');
    await expect(page.getByRole('button', { name: 'Drag Assistant panel' })).toHaveCount(0);
    await expect(page.getByRole('separator', { name: 'Assistant width' })).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
    expect((await panel.locator('.assistant-input-box').boundingBox())!.height).toBeLessThanOrEqual(150);
    await page.screenshot({ path: info.outputPath(`assistant-${width}.png`) });
  }
  await page.setViewportSize({ width: 1600, height: 1000 });
  await expect(page.getByLabel('Corner radius')).toHaveValue('29');
  await expect(input).toHaveValue('A draft that stays with this panel');
  expect((await panel.boundingBox())!.x).toBeCloseTo(edge.x, 0);
  await page.getByRole('button', { name: 'Close assistant', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Assistant', exact: true })).toBeFocused();
  await expect(page.locator('.studio-assistant')).toBeHidden();
  await page.getByRole('button', { name: 'Assistant', exact: true }).press('Enter');
  await expect(input).toHaveValue('A draft that stays with this panel');
  await panel.getByRole('button', { name: 'Conversation history' }).focus();
  await page.keyboard.press('Shift+Tab');
  expect(await panel.evaluate(node => node.contains(document.activeElement))).toBe(false);
  await page.setViewportSize({ width: 375, height: 812 });
  await expect(panel).toHaveAttribute('aria-modal', 'true');
  await panel.getByRole('button', { name: 'Conversation history' }).focus();
  for (let index = 0; index < 12; index++) {
    await page.keyboard.press('Tab');
    expect(await panel.evaluate(node => node.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press('Escape');
  // Closing the phone Assistant reveals the previously open Design dialog.
  const designDialog = page.getByRole('dialog', { name: 'App design', exact: true });
  await expect(designDialog).toBeVisible();
  await expect.poll(() => designDialog.evaluate(node => node.contains(document.activeElement))).toBe(true);
  await designDialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.getByRole('button', { name: 'Assistant', exact: true }).click();
  await expect(panel).toHaveAttribute('aria-modal', 'true');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Assistant', exact: true })).toBeFocused();
});

test('placement has keyboard alternatives and cancellation, and compact panels retain their drafts', async ({ page }, info) => {
  await page.getByRole('button', { name: 'Assistant', exact: true }).click();
  await page.getByRole('button', { name: 'Design', exact: true }).click();
  const grip = page.getByRole('button', { name: 'Drag Design panel' });
  await grip.focus(); await grip.press('Enter');
  await expect(page.getByRole('button', { name: 'Move to left', exact: true })).toBeVisible();
  await page.keyboard.press('Tab'); await page.keyboard.press('Enter');
  await expect(page.locator('[data-panel=design]')).toHaveAttribute('data-position', 'left');
  const box = (await grip.boundingBox())!;
  await page.mouse.move(box.x + 12, box.y + 12); await page.mouse.down(); await page.mouse.move(box.x + 50, box.y + 20, { steps: 4 });
  await expect(page.getByTestId('dock-drop-right')).toBeVisible();
  await page.screenshot({ path: info.outputPath('panel-drop-targets.png') });
  await page.keyboard.press('Escape'); await page.mouse.up();
  await expect(page.locator('.dock-drop-overlay')).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Message assistant' })).toBeVisible();
  await expect(page.locator('[data-panel=design]')).toHaveAttribute('data-position', 'left');
  const separator = page.getByRole('separator', { name: 'Resize left panel' });
  const value = await separator.getAttribute('aria-valuenow'), border = (await separator.boundingBox())!;
  await page.mouse.move(border.x + 2, border.y + 50); await page.mouse.down(); await page.mouse.move(border.x + 42, border.y + 50);
  await expect(separator).toBeFocused();
  await page.keyboard.press('Escape'); await page.mouse.up();
  await expect(separator).toHaveAttribute('aria-valuenow', value!); await expect(page.locator('.dock-resize-shield')).toHaveCount(0);
  await page.getByLabel('Corner radius').fill('27'); await page.getByLabel('Corner radius').press('Escape');
  await expect(page.getByRole('region', { name: 'App design', exact: true })).toBeHidden();
  await expect(page.getByRole('textbox', { name: 'Message assistant' })).toBeVisible();
  await page.getByRole('button', { name: 'Close assistant' }).click();
  await page.getByRole('button', { name: 'Design', exact: true }).click();
  await expect(page.getByRole('region', { name: 'App design', exact: true })).toBeVisible();
  for (const width of [375, 430]) {
    await page.setViewportSize({ width, height: width === 375 ? 812 : 932 });
    await expect(page.getByRole('dialog', { name: 'App design', exact: true })).toBeVisible();
    await expect(page.getByLabel('Corner radius')).toHaveValue('27');
    await page.screenshot({ path: info.outputPath(`design-${width}.png`) });
  }
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.getByRole('button', { name: 'Diagnostics', exact: true }).click();
  for (const width of [375, 430]) {
    await page.setViewportSize({ width, height: width === 375 ? 812 : 932 });
    await page.screenshot({ path: info.outputPath(`console-${width}.png`) });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});
