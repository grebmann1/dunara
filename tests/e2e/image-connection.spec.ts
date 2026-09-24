import { test, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Engine } from '../../packages/core/src/engine.js';
import { Projects } from '../../packages/core/src/projects.js';
import { AssistantConnections } from '../../packages/assistant/src/connections.js';
import { AssistantService } from '../../packages/assistant/src/service.js';
import { startStudio } from '../../packages/cli/src/studio-server.js';
import { closeMediaDrawer } from './media-workspace-helpers.js';

test.use({ trace: 'off' });
test('acknowledges ChatGPT while explaining image API setup, focuses settings and retains the draft', async ({ page }, info) => {
  test.skip(!!process.env.VISUAL, 'Visual suite only');
  const root = await mkdtemp(path.join(os.tmpdir(), 'image-connection-'));
  const home = path.join(root, 'home'), protection = { kind: 'configured' as const, key: 'a'.repeat(64) };
  const manager = new AssistantConnections(home, protection, () => {}, () => {}, () => ({ name: 'Offline ChatGPT fixture',
    async login() { return { type: 'oauth', access: 'offline-chatgpt-fixture-access', refresh: 'offline-fixture-refresh', expires: Date.now() + 3600000 }; },
    async refresh() { throw Error('No live OAuth calls'); }, async toAuth(value) { return { apiKey: value.access }; },
  }));
  const engine = new Engine(await Projects.open(path.join(root, 'apps'), home), false, false);
  let calls = 0;
  const suggestion = 'A bonsai silhouetted against a soft sunrise in a Japanese anime garden.';
  let assistant: AssistantService | undefined, studio: Awaited<ReturnType<typeof startStudio>> | undefined;
  try {
    await manager.begin({ provider: 'chatgpt', remember: true, expectedRevision: manager.status({ key: '', source: 'none' }).connectionRevision });
    await expect.poll(() => manager.status({ key: '', source: 'none' }).signIn?.state).toBe('connected');
    manager.close();
    const project = await engine.projects.create({ name: 'Bonsai Master', slug: 'bonsai-master' });
    assistant = new AssistantService({ home, secretProtection: protection,
      createHarness: () => ({ async run(input, callbacks) { expect(input.provider).toBe('chatgpt'); expect(input.tools).toEqual([]); calls++; callbacks.text(suggestion); }, async close() {} }),
      async createGateway() { throw Error('No tools in suggestions'); },
    });
    studio = await startStudio(engine, path.resolve('dist/studio'), assistant);
    assistant.configure({ action: 'model', provider: 'chatgpt', model: 'gpt-6-astra' });
    await page.goto(studio.launchUrl); await closeMediaDrawer(page); await page.getByRole('button', { name: 'Assets', exact: true }).click();
    await expect(page.getByText('Asset library ready · Image generation needs setup')).toBeVisible();
    await closeMediaDrawer(page); await page.getByRole('button', { name: 'Generate', exact: true }).click();
    const form = page.getByRole('form', { name: 'Image generation', exact: true });
    const notice = form.getByRole('region', { name: 'Image generation setup', exact: true });
    await expect(notice).toContainText('ChatGPT is connected');
    await expect(notice).toContainText('OpenAI API key');
    await expect(notice).toContainText('billed separately from ChatGPT');
    await expect(form.getByRole('button', { name: 'Connect OpenAI', exact: true })).toHaveCount(0);
    await form.getByRole('button', { name: 'Suggest', exact: true }).click();
    await form.getByRole('button', { name: 'Use suggestion', exact: true }).click();
    await expect(form.getByLabel('Image prompt', { exact: true })).toHaveValue(suggestion);
    for (const [width, height] of [[1440, 1000], [375, 812], [430, 932]] as const) {
      await page.setViewportSize({ width, height }); await notice.scrollIntoViewIfNeeded();
      expect(await form.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
      await page.screenshot({ path: info.outputPath(`image-setup-${width}.png`) });
    }
    await notice.getByRole('button', { name: 'Set up image generation' }).click();
    const images = page.getByRole('region', { name: 'OpenAI configuration', exact: true });
    await expect(images).toBeFocused();
    await expect(images).toContainText('ChatGPT sign-in connects Assistant and Suggest.');
    await expect(images.getByLabel('OpenAI API key', { exact: true })).toBeInViewport();
    for (const [width, height] of [[1440, 1000], [375, 812], [430, 932]] as const) {
      await page.setViewportSize({ width, height }); await images.scrollIntoViewIfNeeded();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: info.outputPath(`image-settings-${width}.png`) });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole('button', { name: 'Assets', exact: true }).click(); await page.getByRole('button', { name: 'Generate', exact: true }).click();
    await expect(form.getByLabel('Image prompt', { exact: true })).toHaveValue(suggestion);
    expect(assistant.status()).toMatchObject({ providerId: 'chatgpt', configured: true });
    expect(engine.mediaJobs.providerStatus().configured).toBe(false);
    expect((await engine.mediaJobs.list(project.id)).jobs).toHaveLength(0); expect(calls).toBe(1);
  } finally {
    await page.close(); manager.close(); await assistant?.close(); await studio?.close(); await engine.close(); await rm(root, { recursive: true, force: true });
  }
});
