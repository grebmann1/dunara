import { test, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Engine } from '../../packages/core/src/engine.js';
import { Projects } from '../../packages/core/src/projects.js';
import { AssistantService } from '../../packages/assistant/src/service.js';
import { startStudio } from '../../packages/cli/src/studio-server.js';

test.use({ trace: 'off' });
test('message composer grows for staged text and stays readable after reopening, resizing and a short viewport', async ({ page }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dunara-composer-'));
  const home = path.join(root, 'home'), engine = new Engine(await Projects.open(path.join(root, 'apps'), home), false);
  await engine.projects.create({ name: 'Bonsai Master', slug: 'bonsai-master' });
  let calls = 0;
  const assistant = new AssistantService({ home, createHarness: () => ({ async run() { calls++; }, async close() {} }), async createGateway() { throw Error('No send expected'); } });
  const studio = await startStudio(engine, path.resolve(process.env.DUNARA_STUDIO_TEST_ASSETS ?? 'dist/studio'), assistant);
  try {
    await engine.mediaJobs.configureProvider({ action: 'replace', key: 'fixture-composer-key', expectedRevision: engine.mediaJobs.providerStatus().revision });
    await page.goto(studio.launchUrl);
    const panel = page.getByRole('dialog', { name: 'Assistant', exact: true }), message = panel.getByLabel('Message assistant');
    const prompt = 'Use the approved illustration in Bonsai Master.\nKeep the Japanese anime art direction.\nPlace the scene above the daily care checklist.\nPreserve the tree and its ceramic bowl.\nUse warm light and subtle drifting petals.\nKeep the garden cards compact.\nCheck the small and large phone layouts.\nKeep my saved care and journal entries.';
    await page.getByRole('button', { name: 'Assistant', exact: true }).click();
    await expect(message).toBeEditable();
    await message.fill(prompt);
    for (const [width, height] of [[1440, 1000], [375, 812], [430, 932], [375, 450]] as const) {
      await page.setViewportSize({ width, height });
      await panel.getByRole('button', { name: 'Close assistant' }).click();
      await page.getByRole('button', { name: 'Assistant', exact: true }).click();
      await expect(message).toHaveValue(prompt);
      await expect.poll(async () => (await message.boundingBox())!.height).toBeGreaterThanOrEqual(height < 600 ? 100 : 160);
      const inputBounds = (await message.boundingBox())!, toolbar = (await panel.locator('.assistant-composer-toolbar').boundingBox())!;
      expect(inputBounds.y + inputBounds.height).toBeLessThanOrEqual(toolbar.y + 1);
      await expect(panel.getByRole('button', { name: 'Send message' })).toBeInViewport({ ratio: 1 });
      await expect(panel.getByRole('button', { name: 'Close assistant' })).toBeInViewport({ ratio: 1 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: info.outputPath(`composer-${width}x${height}.png`) });
    }
    await message.fill(Array.from({ length: 100 }, (_, index) => `Detailed note ${index + 1}`).join('\n'));
    expect(await message.evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true);
    await expect(panel.getByRole('button', { name: 'Send message' })).toBeInViewport({ ratio: 1 });
    expect(calls).toBe(0);
  } finally { await page.close(); await studio.close(); await assistant.close(); await engine.close(); await rm(root, { recursive: true, force: true }); }
});
