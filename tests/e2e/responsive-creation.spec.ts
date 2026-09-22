import { test, expect, type Locator, type Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { Engine } from '../../packages/core/src/engine.js';
import { Projects } from '../../packages/core/src/projects.js';
import { startDesktopMcp } from '../../packages/mcp/src/socket.js';
import { startStudio } from '../../packages/cli/src/studio-server.js';
import { AssistantService } from '../../packages/assistant/src/service.js';
import { McpGateway } from '../../packages/assistant/src/mcp-bridge.js';

let root: string, engine: Engine, studio: Awaited<ReturnType<typeof startStudio>>, endpoint: Awaited<ReturnType<typeof startDesktopMcp>>, assistant: AssistantService;
const sizes = [
  { width: 320, height: 568 }, { width: 375, height: 812 }, { width: 430, height: 932 },
  { width: 768, height: 1024 }, { width: 1024, height: 768 }, { width: 1280, height: 800 },
  { width: 1440, height: 900 }, { width: 1920, height: 1080 }, { width: 812, height: 375 },
];
test.use({ trace: 'off', actionTimeout: 10_000 });
test.beforeEach(async ({ page }) => {
  test.skip(!!process.env.VISUAL, 'Visual baseline suite only');
  root = await mkdtemp(path.join(os.tmpdir(), 'responsive-creation-'));
  const protection = { kind: 'configured' as const, key: 'c'.repeat(64) };
  engine = new Engine(await Projects.open(path.join(root, 'apps'), path.join(root, 'home')), false, false, undefined, {}, {}, undefined, { encryptionKey: protection.key });
  await engine.projects.create({ name: 'A calm place for everyday ideas', slug: 'everyday-ideas' });
  await engine.mediaJobs.configureProvider({ action: 'replace', key: 'offline-responsive-fixture', expectedRevision: engine.mediaJobs.providerStatus().revision });
  endpoint = await startDesktopMcp(engine);
  assistant = new AssistantService({ secretProtection: protection, home: path.join(root, 'home'), createHarness: () => ({ async run() { throw new Error('This layout check must not call a model'); }, async close() {} }), createGateway: (binding, signal, context) => McpGateway.open(endpoint.socketPath, binding, signal, context) });
  studio = await startStudio(engine, path.resolve('dist/studio'), assistant);
  await page.goto(studio.launchUrl);
  await expect(page.locator('.creation-guide')).toContainText('1/7 done');
});
test.afterEach(async ({ page }) => {
  if (process.env.VISUAL) return;
  await page.close(); await assistant.close(); await endpoint.close(); await studio.close(); await engine.close(); await rm(root, { recursive: true, force: true });
});
async function noOverflow(page: Page, regions: Locator[], label: string) {
  expect.soft(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), `${label}: page width`).toBeLessThanOrEqual(1);
  for (const region of regions) expect.soft(await region.evaluate(node => node.scrollWidth - node.clientWidth), `${label}: ${await region.getAttribute('class')}`).toBeLessThanOrEqual(1);
}
async function targetVisible(target: Locator) {
  await target.scrollIntoViewIfNeeded();
  await expect(target).toBeInViewport({ ratio: 1 });
  await target.click({ trial: true });
  const size = await target.boundingBox();
  expect.soft(size!.height, 'Control target height').toBeGreaterThanOrEqual((target.page().viewportSize()?.width ?? 1440) <= 760 ? 44 : 36);
}

test('creation guide fits phones, tablets, docked panes and enlarged layouts', async ({ page }, info) => {
  const guide = page.getByRole('dialog', { name: 'Your app journey', exact: true });
  await page.locator('.creation-guide-trigger').click();
  await guide.getByRole('button', { name: /Connect Supabase/ }).click();
  for (const size of sizes) {
    await page.setViewportSize(size);
    await targetVisible(guide.getByRole('button', { name: 'Set up Supabase', exact: true }));
    await noOverflow(page, [guide, guide.locator('.creation-guide-detail')], `${size.width}×${size.height}`);
    for (const step of await guide.locator('li button').all()) expect.soft(await step.evaluate(node => node.scrollWidth - node.clientWidth), `Stage label at ${size.width}`).toBeLessThanOrEqual(1);
    if ([375, 430, 768, 1280].includes(size.width)) {
      await guide.scrollIntoViewIfNeeded(); await page.screenshot({ path: info.outputPath(`guide-${size.width}.png`) });
    }
  }
  for (const width of [1280, 1440, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    await guide.getByRole('button', { name: 'Close dialog' }).click();
    await page.getByRole('button', { name: 'Assistant', exact: true }).click();
    await page.locator('.creation-guide-trigger').click();
    await expect(page.locator('.dock-workspace')).toHaveAttribute('data-docking', 'true');
    await noOverflow(page, [guide, guide.locator('.creation-guide-detail'), page.locator('#workspace-content')], `Docked ${width}`);
    await guide.scrollIntoViewIfNeeded(); await page.screenshot({ path: info.outputPath(`guide-docked-${width}.png`) });
    await guide.getByRole('button', { name: 'Close dialog' }).click();
    await page.getByRole('button', { name: 'Close assistant', exact: true }).click();
    await page.locator('.creation-guide-trigger').click();
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.evaluate(() => { document.documentElement.style.zoom = '2'; });
  await targetVisible(guide.getByRole('button', { name: 'Set up Supabase', exact: true }));
  await noOverflow(page, [guide, guide.locator('.creation-guide-detail')], '200 percent zoom');
  await page.screenshot({ path: info.outputPath('guide-zoom.png') });
});

test('chat retains reachable upload, remove, send and close controls on short screens', async ({ page }, info) => {
  await page.getByRole('button', { name: 'Assistant', exact: true }).click();
  const panel = page.getByRole('dialog', { name: 'Assistant', exact: true });
  await panel.getByLabel('Message assistant').fill('Please use these references.\nKeep the design calm and readable.\nInclude a welcoming home screen.\nMake the primary action clear.\nLeave room for the content.\nCheck both phone sizes.');
  for (const size of [...sizes, { width: 375, height: 450 }]) {
    await page.setViewportSize(size);
    await panel.getByLabel('Attachments', { exact: true }).click();
    await targetVisible(panel.getByRole('button', { name: 'Upload images', exact: true }));
    await panel.getByLabel('Attachments', { exact: true }).click();
  }
  await panel.getByLabel('Attachments', { exact: true }).click();
  const png = await sharp({ create: { width: 320, height: 180, channels: 4, background: '#d6b49c' } }).png().toBuffer();
  await panel.getByLabel('Upload chat images').setInputFiles([{ name: 'reference.png', mimeType: 'image/png', buffer: png }, { name: 'inspiration.png', mimeType: 'image/png', buffer: png }]);
  await expect(panel.getByAltText('Attached media')).toHaveCount(2);
  await expect(panel.getByRole('button', { name: 'Send message' })).toBeEnabled();
  for (const size of [...sizes, { width: 375, height: 450 }]) {
    await page.setViewportSize(size);
    await expect(panel).toBeInViewport({ ratio: .99 });
    await noOverflow(page, [panel, panel.locator('.assistant-input-box'), panel.locator('.assistant-attachment-picker')], `Chat ${size.width}×${size.height}`);
    await targetVisible(panel.getByRole('button', { name: 'Send message' }));
    await expect(panel.getByRole('button', { name: 'Close assistant' })).toBeInViewport({ ratio: 1 });
    await panel.getByRole('button', { name: 'Close assistant' }).click({ trial: true });
    await targetVisible(panel.getByRole('button', { name: 'Remove image' }).last());
    if ([375, 430, 768, 812, 1280].includes(size.width)) await page.screenshot({ path: info.outputPath(`chat-${size.width}x${size.height}.png`) });
  }
  await panel.getByRole('button', { name: 'Remove image' }).last().click();
  await expect(panel.getByAltText('Attached media')).toHaveCount(1);
  await panel.getByRole('button', { name: 'Close assistant' }).click();
  await expect(page.getByRole('button', { name: 'Assistant', exact: true })).toBeFocused();
});

test('Supabase setup and connection forms reflow without hiding actions', async ({ page }, info) => {
  await page.getByRole('button', { name: 'Backend', exact: true }).click();
  const setup = page.getByRole('region', { name: 'Supabase setup guide', exact: true });
  await setup.getByRole('button', { name: 'Connect Supabase account', exact: true }).click();
  const form = page.getByRole('region', { name: 'Supabase connection', exact: true });
  for (const size of sizes) {
    await page.setViewportSize(size);
    await noOverflow(page, [setup, form], `Supabase ${size.width}×${size.height}`);
    await form.getByRole('button', { name: 'Save Supabase connection', exact: true }).focus();
    await form.getByLabel('Personal access token', { exact: true }).focus();
    await expect(form.getByLabel('Personal access token', { exact: true })).toBeInViewport({ ratio: 1 });
    await targetVisible(form.getByRole('button', { name: 'Save Supabase connection', exact: true }));
    if ([375, 430, 768, 1024, 812].includes(size.width)) await page.screenshot({ path: info.outputPath(`supabase-${size.width}x${size.height}.png`) });
  }
});

test('chat history and privacy details remain usable in a short viewport', async ({ page }, info) => {
  await page.setViewportSize({ width: 375, height: 450 });
  await page.getByRole('button', { name: 'Assistant', exact: true }).click();
  const panel = page.getByRole('dialog', { name: 'Assistant', exact: true });
  await panel.getByLabel('Message assistant').fill('Keep this draft while I review my history.\nUse a welcoming home screen.\nKeep the main action clear.');
  await panel.getByRole('button', { name: 'Conversation history', exact: true }).click();
  await targetVisible(panel.getByRole('button', { name: 'Send message' }));
  await panel.getByRole('button', { name: 'Close assistant' }).click({ trial: true });
  await expect(panel.getByRole('button', { name: 'Model & settings' })).toBeInViewport({ ratio: 1 });
  await expect(panel.getByRole('combobox', { name: 'Chat model' })).toBeHidden();
  await page.screenshot({ path: info.outputPath('history-short.png') });
  await panel.getByRole('button', { name: 'Conversation history', exact: true }).click();
  await panel.getByRole('button', { name: 'Model & settings' }).click();
  await panel.locator('.assistant-disclosure > summary').filter({ hasText: 'Draft storage' }).click();
  await panel.locator('.assistant-disclosure > summary').filter({ hasText: 'Usage & privacy' }).click();
  for (const size of [{ width: 375, height: 450 }, { width: 812, height: 375 }]) {
    await page.setViewportSize(size);
    await targetVisible(panel.getByRole('button', { name: 'Send message' }));
    await panel.getByRole('button', { name: 'Close assistant' }).click({ trial: true });
    for (const disclosure of await panel.locator('.assistant-disclosure[open]').all()) {
      await disclosure.scrollIntoViewIfNeeded();
      // Nested scroll positions round to whole pixels while dvh can be fractional.
      await expect(disclosure).toBeInViewport({ ratio: .99 });
      expect(await disclosure.evaluate(node => { node.scrollTop = node.scrollHeight; return node.scrollTop; })).toBeGreaterThan(0);
    }
    await page.screenshot({ path: info.outputPath(`privacy-${size.width}x${size.height}.png`) });
  }
  for (const size of [{ width: 375, height: 812 }, { width: 430, height: 932 }, { width: 1440, height: 1000 }]) {
    await page.setViewportSize(size);
    await expect(panel.getByRole('button', { name: 'Send message' })).toBeInViewport({ ratio: 1 });
    await panel.getByRole('button', { name: 'Send message' }).click({ trial: true });
    for (const disclosure of await panel.locator('.assistant-disclosure').all()) {
      if (await disclosure.getAttribute('open') === null) await disclosure.locator('summary').click();
    }
    await expect(panel.locator('.assistant-disclosure[open]')).toHaveCount(2);
    for (const disclosure of await panel.locator('.assistant-disclosure[open]').all()) await expect(disclosure).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: info.outputPath(`privacy-${size.width}x${size.height}.png`) });
  }
});


test('planning from the guide carries the brief into an unsent Assistant draft', async ({ page }) => {
  await page.locator('.creation-guide-trigger').click();
  const guide = page.getByRole('dialog', { name: 'Your app journey', exact: true });
  await guide.getByLabel('Your app brief').fill('Help neighbors share garden notes.');
  await guide.getByRole('button', { name: 'Plan with Assistant', exact: true }).click();
  await expect(guide).toHaveCount(0);
  const assistant = page.getByRole('dialog', { name: 'Assistant', exact: true });
  await expect(assistant.getByLabel('Message assistant')).toHaveValue(/My app idea: Help neighbors share garden notes/);
  await expect(assistant.getByRole('button', { name: 'Plan mode', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(assistant.getByRole('button', { name: 'Stop turn', exact: true })).toHaveCount(0);
});
