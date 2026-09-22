import { test, expect, type Page } from '@playwright/test';
import { mkdtemp, copyFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { build } from 'vite';
import { Engine } from '../../packages/core/src/engine.js';
import { Projects } from '../../packages/core/src/projects.js';
import { startStudio } from '../../packages/cli/src/studio-server.js';
import { AssistantService } from '../../packages/assistant/src/service.js';

let assets: string, root: string, engine: Engine, studio: Awaited<ReturnType<typeof startStudio>>, assistant: AssistantService;
test.use({ trace: 'off', actionTimeout: 10_000 });
test.setTimeout(45_000);
test.beforeAll(async () => {
  assets = await mkdtemp(path.join(os.tmpdir(), 'hosted-studio-assets-'));
  await build({ configFile: path.resolve('apps/studio/vite.config.ts'), root: path.resolve('tests/e2e/fixtures'), logLevel: 'error', build: { outDir: assets, rollupOptions: { input: path.resolve('tests/e2e/fixtures/hosted-studio.html') } } });
  await copyFile(path.join(assets, 'hosted-studio.html'), path.join(assets, 'index.html'));
});
test.afterAll(async () => { await rm(assets, { recursive: true, force: true }); });
test.beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'hosted-mobile-'));
  engine = new Engine(await Projects.open(path.join(root, 'apps'), path.join(root, 'home')), false);
  await engine.projects.create({ name: 'Garden notebook', slug: 'garden-notebook' });
  assistant = new AssistantService({ createGateway: async () => ({ tools: [], async call() { return { content: [] }; }, async close() {} }), home: path.join(root, 'home'), createHarness: () => ({ async run(_input, callbacks) { callbacks.text('Your garden notebook is ready for the next idea.'); }, async close() {} }) });
  await engine.mediaJobs.configureProvider({ action: 'replace', key: 'fake-layout-test-key', expectedRevision: engine.mediaJobs.providerStatus().revision });
  studio = await startStudio(engine, assets, assistant);
});
test.afterEach(async ({ page }) => { await page.close(); await assistant.close(); await studio.close(); await engine.close(); await rm(root, { recursive: true, force: true }); });

async function fits(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const workspace = (await page.locator('#workspace-content').boundingBox())!;
  const shell = (await page.locator('.studio').boundingBox())!;
  expect(workspace.width).toBeCloseTo(shell.width, 0);
}

for (const [width, height] of [[375, 812], [430, 932]]) {
  test(`hosted navigation dismisses and restores focus at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width: width!, height: height! });
    await page.goto(studio.launchUrl);
    const toggle = page.getByRole('button', { name: 'Expand sidebar', exact: true });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('#studio-sidebar')).toBeHidden();
    await fits(page);
    // This scenario expects focus on an enabled destination, not the loading drawer.
    await expect(page.locator('.connection')).toHaveClass(/online/);
    await page.screenshot({ path: info.outputPath(`workspace-${width}.png`) });
    await toggle.click();
    const drawer = page.getByRole('dialog', { name: 'Workspace', exact: true });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole('button', { name: 'Preview', exact: true })).toBeFocused();
    await fits(page);
    await expect(drawer.getByRole('button', { name: 'Settings', exact: true })).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: info.outputPath(`navigation-${width}.png`) });
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Shift+Tab');
    expect(await drawer.evaluate(node => node.contains(document.activeElement))).toBe(true);
    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden(); await expect(toggle).toBeFocused();
    await toggle.click();
    await page.locator('.sidebar-scrim').click({ position: { x: width! - 10, y: 200 } });
    await expect(drawer).toBeHidden(); await expect(toggle).toBeFocused();
    for (const destination of ['Assets', 'App Icons', 'Backend', 'Activity', 'Plugins', 'Settings']) {
      await toggle.click();
      await drawer.getByRole('button', { name: destination, exact: true }).click();
      await expect(drawer).toBeHidden();
      await expect(page.locator('#workspace-content')).toBeFocused();
      await fits(page);
    }
    await page.screenshot({ path: info.outputPath(`settings-${width}.png`) });
    await toggle.click();
    await drawer.getByRole('button', { name: 'Garden notebook', exact: true }).click();
    await expect(drawer).toBeHidden();
    await toggle.click();
    await drawer.getByRole('button', { name: '+ New app', exact: true }).click();
    await expect(drawer).toBeHidden();
    await expect(page.getByRole('dialog')).toBeVisible();
    expect(await page.getByRole('dialog').evaluate(node => node.contains(document.activeElement))).toBe(true);
    await page.screenshot({ path: info.outputPath(`create-${width}.png`) });
  });
}

test('hosted drawer follows the embedded width and preserves desktop preference', async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(studio.launchUrl);
  await expect(page.locator('#studio-sidebar')).toBeVisible();
  await expect(page.getByRole('button', { name: '+ New app', exact: true })).toBeEnabled();
  await page.screenshot({ path: info.outputPath('desktop.png') });
  await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click();
  await page.locator('#root').evaluate(node => { node.style.width = '600px'; });
  await page.getByRole('button', { name: 'Expand sidebar', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: 'Workspace', exact: true });
  await expect(drawer).toBeVisible();
  await fits(page);
  await page.keyboard.press('Escape');
  await page.locator('#root').evaluate(node => { node.style.width = ''; });
  await expect(page.locator('#studio-sidebar')).toBeHidden();
  await page.getByRole('button', { name: 'Expand sidebar', exact: true }).click();
  await expect(page.locator('#studio-sidebar')).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Workspace', exact: true })).toBeHidden();
});

test('hosted navigation stays compact during polling fallback', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.routeWebSocket('**/events', socket => socket.close());
  await page.goto(studio.launchUrl);
  await expect(page.locator('.connection')).toContainText('Connected · polling');
  await expect(page.locator('.studio')).toHaveAttribute('data-hosted', 'true');
  await expect(page.locator('#studio-sidebar')).toBeHidden();
  await page.getByRole('button', { name: 'Expand sidebar', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: 'Workspace', exact: true });
  await expect(drawer).toBeVisible();
  await drawer.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(drawer).toBeHidden();
  await fits(page);
});

test('chat keeps typing and sending inside the visible viewport', async ({ page }, info) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(studio.launchUrl);
  await page.getByRole('button', { name: 'Assistant', exact: true }).click();
  const panel = page.getByRole('dialog', { name: 'Assistant', exact: true });
  const input = panel.getByRole('textbox', { name: 'Message assistant' });
  await expect(input).toBeEditable();
  await input.fill('Help me build a garden notebook');
  for (const [width, height] of [[375, 812], [430, 932], [1440, 1000]]) {
    await page.setViewportSize({ width: width!, height: height! });
    await expect(panel.getByRole('button', { name: 'Send message' })).toBeInViewport({ ratio: 1 });
    await expect(input).toHaveValue('Help me build a garden notebook');
    if (width! < 760) await expect(input).toHaveCSS('font-size', '16px');
    await page.screenshot({ path: info.outputPath(`chat-${width}.png`) });
  }
  await page.setViewportSize({ width: 375, height: 460 });
  await expect(panel.getByRole('button', { name: 'Model & settings' })).toBeVisible();
  expect((await panel.locator('.assistant-conversation').boundingBox())!.height).toBeGreaterThan(100);
  await page.screenshot({ path: info.outputPath('chat-short.png') });
  await panel.getByRole('button', { name: 'Model & settings' }).click();
  await expect(panel.getByRole('combobox', { name: 'Chat model' })).toBeVisible();
  await panel.getByRole('button', { name: 'Model & settings' }).click();
  // A software keyboard may shrink only VisualViewport, leaving innerHeight unchanged.
  await page.setViewportSize({ width: 375, height: 812 });
  await page.evaluate(() => {
    Object.defineProperties(window.visualViewport!, { height: { configurable: true, value: 460 }, offsetTop: { configurable: true, value: 24 } });
    window.visualViewport!.dispatchEvent(new Event('resize'));
  });
  await expect(panel).toHaveAttribute('data-short-viewport', 'true');
  await expect.poll(async () => (await panel.boundingBox())!.y).toBe(24);
  await expect.poll(async () => (await panel.boundingBox())!.height).toBe(460);
  const send = panel.getByRole('button', { name: 'Send message' });
  const sendBox = (await send.boundingBox())!;
  expect(sendBox.y + sendBox.height).toBeLessThanOrEqual(484);
  await send.click();
  await expect(panel.getByText('Your garden notebook is ready for the next idea.')).toBeVisible();
  await page.evaluate(() => {
    Reflect.deleteProperty(window.visualViewport!, 'height'); Reflect.deleteProperty(window.visualViewport!, 'offsetTop');
    window.visualViewport!.dispatchEvent(new Event('resize'));
  });
  await expect(panel).not.toHaveAttribute('data-short-viewport');
  await expect(panel.getByRole('combobox', { name: 'Chat model' })).toBeVisible();
  await expect(input).toHaveValue('');
});
