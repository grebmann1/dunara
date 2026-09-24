import { test, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Engine } from '../../packages/core/src/engine.js';
import { Projects } from '../../packages/core/src/projects.js';
import { ProjectJourney } from '../../packages/core/src/journey.js';
import { startStudio } from '../../packages/cli/src/studio-server.js';
import { AssistantService } from '../../packages/assistant/src/service.js';
import type { HarnessInput, RunHarness } from '../../packages/assistant/src/contracts.js';
import { closeMediaDrawer } from './media-workspace-helpers.js';
import { selectProject } from './project-picker.js';

test.use({ trace: 'off' });
let root: string, engine: Engine, studio: Awaited<ReturnType<typeof startStudio>>, assistant: AssistantService, projectId: string;
let behavior: RunHarness['run'], calls: HarnessInput[], imageCalls: number;
const idea = 'A windswept juniper bonsai beside a mossy stone lantern in a hand-painted Japanese anime garden. Warm sunrise filters through maple leaves, illuminating a tiny ceramic pot with rich forest-green foliage and an ivory backdrop. Keep the left third quiet for the app heading, with drifting petals guiding the eye toward the tree. No lettering or interface elements.';
test.beforeEach(async () => {
  test.skip(!!process.env.VISUAL, 'Visual suite only');
  root = await mkdtemp(path.join(os.tmpdir(), 'creative-suggestions-')); calls = []; imageCalls = 0;
  engine = new Engine(await Projects.open(path.join(root, 'apps'), path.join(root, 'home')), false, false, { async run() { imageCalls++; throw Error('Image generation must remain review-gated'); } });
  projectId = (await engine.projects.create({ name: 'Bonsai Master', slug: 'bonsai-master' })).id;
  const journey = new ProjectJourney(engine.projects, id => engine.boardCaptures.sourceRevision(id));
  await journey.update(projectId, { expectedRevision: (await journey.read(projectId)).revision, patch: { brief: 'Teach beginners to maintain bonsai, with daily care and a fully Japanese anime style.' } });
  await engine.assets.brief(projectId, null, { purpose: 'Bonsai care and maintenance', audience: 'New bonsai keepers', mood: 'Peaceful and magical', palette: 'Forest green and ivory', imageStyle: 'Japanese anime', avoid: 'Clutter and tiny text', referenceIds: [] });
  await engine.mediaJobs.configureProvider({ action: 'replace', expectedRevision: engine.mediaJobs.providerStatus().revision, key: 'offline-suggestion-fixture', remember: false });
  behavior = async (_, callbacks) => { callbacks.text(idea); };
  assistant = new AssistantService({ home: path.join(root, 'home'), createHarness: () => ({ async run(...args) { calls.push(args[0]); await behavior(...args); }, async close() {} }), async createGateway() { throw Error('Suggestions must not create a tool gateway'); } });
  studio = await startStudio(engine, path.resolve('dist/studio'), assistant);
});
test.afterEach(async ({ page }) => { if (process.env.VISUAL) return; await page.close(); await assistant.close(); await studio.close(); await engine.close(); await rm(root, { recursive: true, force: true }); });

test('suggests from the current app, preserves the draft, and reuses its history', async ({ page }) => {
  await page.goto(studio.launchUrl); await closeMediaDrawer(page); await page.getByRole('button', { name: 'Assets', exact: true }).click();
  await closeMediaDrawer(page); await page.getByRole('button', { name: 'Generate', exact: true }).click();
  const form = page.getByRole('form', { name: 'Image generation' });
  await form.getByRole('button', { name: /^Hero image/ }).click();
  await form.getByLabel('Image prompt', { exact: true }).fill('Keep my draft until I choose.');
  await form.getByRole('button', { name: 'Suggest', exact: true }).click();
  const result = form.getByRole('region', { name: 'Suggested image prompt' });
  await expect(result).toContainText(idea);
  await expect(form.getByLabel('Image prompt', { exact: true })).toHaveValue('Keep my draft until I choose.');
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ mode: 'plan', task: 'image-prompt', tools: [], projectId });
  for (const text of ['Teach beginners', 'Bonsai care', 'Japanese anime', 'Forest green and ivory', 'Hero image', '1536x1024', 'Keep my draft']) expect(calls[0]!.prompt).toContain(text);
  for (const [width, height] of [[1440, 1000], [375, 812], [430, 932]] as const) {
    await page.setViewportSize({ width, height });
    await result.scrollIntoViewIfNeeded();
    expect(await form.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`suggestion-${width}.png`) });
  }
  await result.getByRole('button', { name: 'Use suggestion' }).click();
  await expect(form.getByLabel('Image prompt', { exact: true })).toHaveValue(idea);
  await expect(result).toHaveCount(0);
  expect(imageCalls).toBe(0); expect((await engine.mediaJobs.list(projectId)).jobs).toHaveLength(0);
  await closeMediaDrawer(page); await page.getByRole('button', { name: 'Generate', exact: true }).click();
  await form.getByRole('button', { name: 'Suggest', exact: true }).click();
  await expect(result).toBeVisible();
  expect(calls).toHaveLength(2); expect(calls[1]!.conversationId).toBe(calls[0]!.conversationId);
});

test('supports icons, explicit fresh direction, failure recovery, and another app', async ({ page }) => {
  await page.goto(studio.launchUrl); await closeMediaDrawer(page); await page.getByRole('button', { name: 'App Icons', exact: true }).click();
  await page.getByRole('button', { name: 'Generate an icon', exact: true }).click();
  const form = page.getByRole('form', { name: 'Icon generation' });
  await form.getByRole('checkbox', { name: 'Match my app’s art direction' }).uncheck();
  behavior = async () => { throw Error('fixture provider unavailable'); };
  await form.getByRole('button', { name: 'Suggest', exact: true }).click();
  await expect(form.getByRole('alert')).toContainText('could not complete');
  await expect(form.getByLabel('Image prompt', { exact: true })).toHaveValue('');
  expect(calls[0]!.prompt).toContain('App icon'); expect(calls[0]!.prompt).toContain('fresh visual direction');
  expect(calls[0]!.prompt).not.toContain('Forest green and ivory');
  behavior = async (_, callbacks) => { callbacks.text('A single, bold bonsai silhouette in a ceramic bowl.'); };
  await form.getByRole('button', { name: 'Suggest', exact: true }).click();
  await expect(form.getByRole('region', { name: 'Suggested image prompt' })).toContainText('bold bonsai');
  const other = await engine.projects.create({ name: 'Orbit Notes', slug: 'orbit-notes' });
  await closeMediaDrawer(page); await selectProject(page, other.id); await closeMediaDrawer(page);
  await page.getByRole('button', { name: 'App Icons', exact: true }).click(); await page.getByRole('button', { name: 'Generate an icon', exact: true }).click();
  await expect(form.getByRole('region', { name: 'Suggested image prompt' })).toHaveCount(0);
  behavior = async (_, callbacks) => { callbacks.text('A luminous orbit around a folded notebook.'); };
  await form.getByRole('button', { name: 'Suggest', exact: true }).click();
  await expect(form.getByRole('region', { name: 'Suggested image prompt' })).toContainText('luminous orbit');
  expect(calls.at(-1)!.projectId).toBe(other.id); expect(calls.at(-1)!.prompt).not.toContain('Bonsai'); expect(imageCalls).toBe(0);
});

test('cancels on edits and close, and explains a missing Assistant connection', async ({ page }) => {
  behavior = async (_, callbacks, signal) => { await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); callbacks.text('Stale suggestion'); };
  await page.goto(studio.launchUrl); await closeMediaDrawer(page); await page.getByRole('button', { name: 'Assets', exact: true }).click();
  await closeMediaDrawer(page); await page.getByRole('button', { name: 'Generate', exact: true }).click();
  const form = page.getByRole('form', { name: 'Image generation' });
  await form.getByRole('button', { name: 'Suggest', exact: true }).click();
  await expect.poll(() => calls.length).toBe(1);
  await form.getByLabel('Image prompt', { exact: true }).fill('My newer idea');
  await expect.poll(() => assistant.status().busy).toBe(false);
  await expect(form.getByLabel('Image prompt', { exact: true })).toHaveValue('My newer idea');
  await expect(form.getByText('Stale suggestion')).toHaveCount(0);
  await form.getByRole('button', { name: 'Suggest', exact: true }).click();
  await expect.poll(() => calls.length).toBe(2);
  await closeMediaDrawer(page); await expect.poll(() => assistant.status().busy).toBe(false);
  await engine.mediaJobs.configureProvider({ action: 'disconnect', expectedRevision: engine.mediaJobs.providerStatus().revision });
  await page.getByRole('button', { name: 'Generate', exact: true }).click();
  await expect(form.getByRole('button', { name: 'Suggest', exact: true })).toBeDisabled();
  await expect(form.getByRole('button', { name: 'Connect Assistant', exact: true })).toBeVisible();
  expect(imageCalls).toBe(0);
});
