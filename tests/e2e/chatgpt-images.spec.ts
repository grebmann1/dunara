import { test, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { Engine } from '../../packages/core/src/engine.js';
import { Projects } from '../../packages/core/src/projects.js';
import { AssistantConnections } from '../../packages/assistant/src/connections.js';
import { AssistantService } from '../../packages/assistant/src/service.js';
import { startStudio } from '../../packages/cli/src/studio-server.js';
import { closeMediaDrawer } from './media-workspace-helpers.js';

test.use({ trace: 'off' });
test('creates a library candidate with the connected ChatGPT account and no image API key', async ({ page }, info) => {
  test.skip(!!process.env.VISUAL, 'Visual suite only');
  const root = await mkdtemp(path.join(os.tmpdir(), 'chatgpt-images-'));
  const home = path.join(root, 'home'), protection = { kind: 'configured' as const, key: 'a'.repeat(64) };
  const access = `fixture.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture-account', chatgpt_plan_type: 'plus' } })).toString('base64url')}.fixture`;
  const manager = new AssistantConnections(home, protection, () => {}, () => {}, () => ({ name: 'Offline ChatGPT fixture',
    async login() { return { type: 'oauth', access, refresh: 'offline-fixture-refresh', expires: Date.now() + 3600000 }; },
    async refresh() { throw Error('No live OAuth calls'); }, async toAuth(value) { return { apiKey: value.access }; },
  }));
  const engine = new Engine(await Projects.open(path.join(root, 'apps'), home), false, false);
  let calls = 0, assistant: AssistantService | undefined, studio: Awaited<ReturnType<typeof startStudio>> | undefined;
  const bytes = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: '#295946' } }).png().toBuffer();
  try {
    await manager.begin({ provider: 'chatgpt', remember: true, expectedRevision: manager.status({ key: '', source: 'none' }).connectionRevision });
    await expect.poll(() => manager.status({ key: '', source: 'none' }).signIn?.state).toBe('connected'); manager.close();
    const project = await engine.projects.create({ name: 'Bonsai Master', slug: 'bonsai-master' });
    assistant = new AssistantService({ home, secretProtection: protection, imageRuntime: { command: 'offline-fixture', async run(_command, auth, request) {
      expect(auth).toEqual({ accessToken: access, chatgptAccountId: 'fixture-account', chatgptPlanType: 'plus' });
      expect(request).toMatchObject({ model: 'chatgpt-image', count: 1 }); calls++; return [bytes];
    } } });
    studio = await startStudio(engine, path.resolve('dist/studio'), assistant);
    await page.goto(studio.launchUrl); await closeMediaDrawer(page); await page.getByRole('button', { name: 'Assets', exact: true }).click();
    await closeMediaDrawer(page); await page.getByRole('button', { name: 'Generate', exact: true }).click();
    const form = page.getByRole('form', { name: 'Image generation', exact: true });
    await form.getByLabel('Image prompt', { exact: true }).fill('A Japanese anime bonsai garden at dawn, with jade foliage and warm ivory light.');
    await expect(form).toContainText('Uses your ChatGPT/Codex allowance');
    await expect(form.getByRole('region', { name: 'Image generation setup' })).toHaveCount(0);
    for (const [width, height] of [[1440, 1000], [375, 812], [430, 932]] as const) {
      await page.setViewportSize({ width, height }); await form.locator('.creative-footer').scrollIntoViewIfNeeded();
      expect(await form.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
      await page.screenshot({ path: info.outputPath(`chatgpt-create-${width}.png`) });
    }
    expect(calls).toBe(0);
    await form.getByRole('button', { name: 'Stage request for review' }).click();
    const job = page.getByRole('article', { name: 'New illustration request', exact: true });
    await expect(job.getByRole('button', { name: 'Generate with ChatGPT' })).toBeDisabled();
    for (const [width, height] of [[1440, 1000], [375, 812], [430, 932]] as const) {
      await page.setViewportSize({ width, height }); await job.getByRole('checkbox').scrollIntoViewIfNeeded();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: info.outputPath(`chatgpt-review-${width}.png`) });
    }
    await job.getByRole('checkbox', { name: 'Use my ChatGPT allowance for this image request.' }).check();
    await job.getByRole('button', { name: 'Generate with ChatGPT' }).click();
    await expect(job.getByRole('button', { name: 'Review New illustration' })).toBeVisible();
    expect(calls).toBe(1);
    const library = await engine.assets.list(project.id);
    expect(library.assets).toHaveLength(1);
    expect(library.assets[0]).toMatchObject({ status: 'candidate', provenance: 'generated', model: 'ChatGPT · built-in image generation' });
    expect(engine.mediaJobs.providerStatus()).toMatchObject({ configured: true, source: 'chatgpt', personalConfigured: false });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.screenshot({ path: info.outputPath('chatgpt-result.png') });
    await closeMediaDrawer(page); await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const images = page.getByRole('region', { name: 'OpenAI configuration', exact: true });
    await expect(images.getByRole('button', { name: 'ChatGPT selected' })).toBeDisabled();
    await expect(images).toContainText('No API key needed.');
    for (const [width, height] of [[1440, 1000], [375, 812], [430, 932]] as const) {
      await page.setViewportSize({ width, height }); await images.scrollIntoViewIfNeeded();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: info.outputPath(`chatgpt-settings-${width}.png`) });
    }
  } finally {
    await page.close(); manager.close(); await assistant?.close(); await studio?.close(); await engine.close(); await rm(root, { recursive: true, force: true });
  }
});
