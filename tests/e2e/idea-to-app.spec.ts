import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Engine } from '../../packages/core/src/engine.js';
import { Projects } from '../../packages/core/src/projects.js';
import { startDesktopMcp } from '../../packages/mcp/src/socket.js';
import { startStudio } from '../../packages/cli/src/studio-server.js';
import { AssistantService } from '../../packages/assistant/src/service.js';
import { McpGateway } from '../../packages/assistant/src/mcp-bridge.js';
import type { RunHarness } from '../../packages/assistant/src/contracts.js';
import { ProjectJourney } from '../../packages/core/src/journey.js';
import { selectProject } from './project-picker.js';

test.use({ trace: 'off', actionTimeout: 15_000 });
let root: string, engine: Engine, studio: Awaited<ReturnType<typeof startStudio>>, endpoint: Awaited<ReturnType<typeof startDesktopMcp>>, assistant: AssistantService;
let behavior: RunHarness['run'], calls: number, starts: number, previewReady: boolean, app: Server, origin: string;
const brief = 'An anime-inspired bonsai companion with a garden, daily care rituals, a growth journal, and lessons from a friendly mentor.';
const sizes = [{ width: 1440, height: 1000 }, { width: 375, height: 812 }, { width: 430, height: 932 }];
const panel = (page: Page) => page.getByRole('dialog', { name: 'Assistant', exact: true });
test.beforeEach(async () => {
  test.skip(!!process.env.VISUAL, 'Offline workflow qualification');
  root = await mkdtemp(path.join(os.tmpdir(), 'dunara-idea-'));
  const protection = { kind: 'configured' as const, key: 'e'.repeat(64) };
  engine = new Engine(await Projects.open(path.join(root, 'apps'), path.join(root, 'home')), true, false, undefined, {}, {}, undefined, { encryptionKey: protection.key });
  await engine.mediaJobs.configureProvider({ action: 'replace', key: 'offline-idea-to-app-fixture', expectedRevision: engine.mediaJobs.providerStatus().revision });
  calls = 0; starts = 0; previewReady = false;
  // A deterministic interactive preview verifies Studio handoff, not generated aesthetics.
  app = createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><html><body><h1>Offline interaction fixture</h1><button onclick="this.textContent=\'Care completed\'">Complete care</button></body></html>'); });
  await new Promise<void>(resolve => app.listen(0, '127.0.0.1', resolve));
  const address = app.address(); if (!address || typeof address === 'string') throw new Error('No fixture port'); origin = `http://localhost:${address.port}`;
  engine.previews.status = id => ({ projectId: id, status: previewReady ? 'ready' : 'stopped', ...(previewReady ? { url: origin } : {}) });
  engine.previews.start = async id => { starts++; previewReady = true; engine.diagnostics.emit('change', id); return engine.previews.status(id); };
  behavior = async (input, callbacks, signal) => {
    expect(input.mode).toBe('build'); expect(input.projectId).toBeTruthy();
    await callbacks.tool('assistant_update_tasks', { tasks: [{ id: 'implement', label: 'Shape the app', status: 'in_progress' }] }, signal);
    const source = await engine.files.read(input.projectId!, 'app/index.tsx');
    const result = await callbacks.tool('project_write_files', { projectId: input.projectId, writes: [{ path: source.path, expectedRevision: source.revision, content: source.content + '\n// Verified offline handoff edit\n' }] }, signal);
    if (result.isError) throw new Error('Fixture source edit failed');
    await callbacks.tool('assistant_update_tasks', { tasks: [{ id: 'implement', label: 'Shape the app', status: 'completed' }] }, signal);
    callbacks.text('The offline build handoff is complete. Try the preview interaction.');
  };
  endpoint = await startDesktopMcp(engine);
  assistant = new AssistantService({ secretProtection: protection, home: path.join(root, 'home'), createHarness: () => ({ async run(...args) { calls++; await behavior(...args); }, async close() {} }), createGateway: (binding, signal, context) => McpGateway.open(endpoint.socketPath, binding, signal, context) });
  studio = await startStudio(engine, path.resolve('dist/studio'), assistant);
});
test.afterEach(async ({ page }) => {
  if (process.env.VISUAL) return;
  await page.close(); await assistant.close(); await endpoint.close(); await studio.close(); await engine.close(); app.closeAllConnections();
  await new Promise<void>(resolve => app.close(() => resolve())); await rm(root, { recursive: true, force: true });
});
async function screenshots(page: Page, info: TestInfo, state: string) {
  for (const size of sizes) {
    await page.setViewportSize(size);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    if (state === 'result') {
      const refine = panel(page).getByRole('button', { name: 'Refine the design', exact: true });
      await expect(async () => { await refine.scrollIntoViewIfNeeded(); await expect(refine).toBeInViewport({ ratio: 1 }); }).toPass({ timeout: 5000 });
    }
    const dialog = page.getByRole('dialog').last();
    expect(await dialog.evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: info.outputPath(`${state}-${size.width}.png`) });
  }
}
async function create(page: Page) {
  await page.getByRole('button', { name: '+ New app', exact: true }).click();
  await page.getByLabel('App name', { exact: true }).fill('Bonsai Master');
  await page.getByLabel('The idea', { exact: false }).fill(brief);
  await page.getByLabel('Build my idea with the Assistant').uncheck();
  await page.getByRole('button', { name: 'Create app', exact: true }).click();
  await expect(panel(page).getByLabel('Message assistant')).toHaveValue(new RegExp(brief.replaceAll('.', '\\.')));
  await expect(panel(page).getByRole('button', { name: 'Send message' })).toBeEnabled();
}

test('one-form creation stages the right project, retains other drafts, and persists before Send', async ({ page }, info) => {
  const previous = await engine.projects.create({ name: 'Other ideas', slug: 'other-ideas' });
  await page.goto(studio.launchUrl);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByText('Privacy & storage', { exact: true }).click();
  await page.getByLabel('Remember drafts on this computer').click();
  await expect(page.getByLabel('Remember drafts on this computer')).toBeChecked();
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await page.getByRole('button', { name: 'Assistant', exact: true }).click();
  await expect(panel(page).getByLabel('Message assistant')).toBeEditable();
  await panel(page).getByLabel('Message assistant').fill('Keep this other project draft.');
  await panel(page).getByRole('combobox', { name: 'Assistant mode' }).selectOption('plan');
  await panel(page).getByRole('button', { name: 'Close assistant' }).click();
  await page.getByRole('button', { name: '+ New app', exact: true }).click();
  await page.getByLabel('App name', { exact: true }).fill('Bonsai Master');
  await page.getByLabel('The idea', { exact: false }).fill(brief);
  await page.getByLabel('Build my idea with the Assistant').uncheck();
  await screenshots(page, info, 'create');
  await page.getByRole('button', { name: 'Create app', exact: true }).click();
  await expect(panel(page).getByLabel('Message assistant')).toHaveValue(/Build the first version of Bonsai Master/);
  await expect(panel(page).getByRole('combobox', { name: 'Assistant mode' })).toHaveValue('build');
  await expect(panel(page).getByRole('button', { name: 'Send message' })).toBeEnabled();
  await screenshots(page, info, 'handoff');
  const draft = await panel(page).getByLabel('Message assistant').inputValue();
  expect(draft).toContain(brief); expect(calls).toBe(0);
  const project = (await engine.projects.list()).find(item => item.name === 'Bonsai Master')!;
  const journey = new ProjectJourney(engine.projects, id => engine.boardCaptures.sourceRevision(id));
  await expect.poll(async () => (await journey.read(project.id)).preferences.brief).toBe(brief);
  const storedDraft = async () => JSON.parse(await readFile(path.join(root, 'home/credentials/assistant-drafts.json'), 'utf8')).rows.find((row: { projectId: string }) => row.projectId === project.id)?.value.text;
  await panel(page).getByRole('button', { name: 'Close assistant' }).click();
  await expect.poll(storedDraft).toBe(draft);
  await selectProject(page, previous.id); await page.getByRole('button', { name: 'Assistant', exact: true }).click();
  await expect(panel(page).getByLabel('Message assistant')).toHaveValue('Keep this other project draft.');
  await expect(panel(page).getByRole('combobox', { name: 'Assistant mode' })).toHaveValue('plan');
  await panel(page).getByRole('button', { name: 'Close assistant' }).click();
  await selectProject(page, project.id);
  expect(await storedDraft()).toBe(draft);
  await page.goto('about:blank'); await page.goto(studio.issueLaunchUrl());
  await page.getByRole('button', { name: 'Assistant', exact: true }).click();
  await expect(panel(page).getByLabel('Message assistant')).toHaveValue(draft);
  expect(calls).toBe(0);
});

test('completed Build opens a working preview without restarting it and stages refinement safely', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(studio.launchUrl); await create(page);
  await panel(page).getByRole('button', { name: 'Send message' }).click();
  const result = panel(page).getByRole('region', { name: 'Try and refine your app' });
  await expect(result).toBeVisible();
  await expect(result.getByRole('button', { name: 'Refine the design', exact: true })).toBeInViewport({ ratio: 1 });
  expect(calls).toBe(1); expect(starts).toBe(0);
  await expect(panel(page).getByRole('button', { name: 'Review source changes' })).toBeVisible();
  await screenshots(page, info, 'result');
  await result.getByRole('button', { name: 'Start preview', exact: true }).click();
  await expect(panel(page)).toHaveCount(0);
  await page.frameLocator('iframe').getByRole('button', { name: 'Complete care' }).click();
  await expect(page.frameLocator('iframe').getByRole('button', { name: 'Care completed' })).toBeVisible();
  await page.getByRole('button', { name: 'Assistant', exact: true }).click();
  await result.getByRole('button', { name: 'Try your app', exact: true }).click();
  await expect(page.frameLocator('iframe').getByRole('button', { name: 'Care completed' })).toBeVisible();
  expect(starts).toBe(1);
  await page.getByRole('button', { name: 'Assistant', exact: true }).click();
  await result.getByRole('button', { name: 'Refine the design', exact: true }).click();
  await expect(panel(page).getByLabel('Message assistant')).toHaveValue(/Preserve the working features/);
  await expect(result.getByRole('button', { name: 'Refine the design', exact: true })).toBeDisabled();
  expect(calls).toBe(1);
  await result.getByRole('button', { name: 'Review screens', exact: true }).click();
  await expect(page.getByRole('button', { name: 'All screens', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect(errors).toEqual([]);
});

test('brief recovery appends to an unsent draft and saves before opening Build', async ({ page }) => {
  const project = await engine.projects.create({ name: 'Garden notes', slug: 'garden-notes' });
  await page.goto(studio.launchUrl); await page.getByRole('button', { name: 'Assistant', exact: true }).click();
  await expect(panel(page).getByLabel('Message assistant')).toBeEditable();
  await panel(page).getByLabel('Message assistant').fill('Keep my existing thought.');
  await panel(page).getByRole('button', { name: 'Close assistant' }).click();
  await page.locator('.creation-guide-trigger').click();
  const guide = page.getByRole('dialog', { name: 'Your app journey', exact: true });
  await guide.getByLabel('Your app brief').fill(brief);
  await guide.getByRole('button', { name: 'Build from brief', exact: true }).click();
  await expect(panel(page).getByLabel('Message assistant')).toHaveValue(/^Keep my existing thought\.[\s\S]*Build the first version of Garden notes/);
  const journey = new ProjectJourney(engine.projects, id => engine.boardCaptures.sourceRevision(id));
  expect((await journey.read(project.id)).preferences.brief).toBe(brief); expect(calls).toBe(0);
});

test('failed and Plan turns never offer the completed Build actions', async ({ page }) => {
  await page.goto(studio.launchUrl); await create(page);
  behavior = async () => { throw new Error('Offline provider unavailable'); };
  await panel(page).getByRole('button', { name: 'Send message' }).click();
  await expect(panel(page).getByRole('button', { name: 'Continue', exact: true })).toBeVisible();
  await expect(panel(page).getByRole('region', { name: 'Try and refine your app' })).toHaveCount(0);
  behavior = async (_, callbacks) => { callbacks.text('An offline plan for three screens.'); };
  await panel(page).getByRole('combobox', { name: 'Assistant mode' }).selectOption('plan');
  await panel(page).getByLabel('Message assistant').fill('Plan the screens.');
  await panel(page).getByRole('button', { name: 'Send message' }).click();
  await expect(panel(page).getByRole('button', { name: 'Build this plan', exact: true })).toBeVisible();
  await expect(panel(page).getByRole('region', { name: 'Try and refine your app' })).toHaveCount(0);
});
