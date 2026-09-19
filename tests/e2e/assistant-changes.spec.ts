import { test, expect, type Page } from '@playwright/test';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Engine } from '../../packages/core/src/engine.js';
import { Projects } from '../../packages/core/src/projects.js';
import { startDesktopMcp } from '../../packages/mcp/src/socket.js';
import { startStudio } from '../../packages/cli/src/studio-server.js';
import { AssistantService } from '../../packages/assistant/src/service.js';
import { McpGateway } from '../../packages/assistant/src/mcp-bridge.js';
import type { RunHarness } from '../../packages/assistant/src/contracts.js';

test.use({ trace: 'off', actionTimeout: 20_000 });
let root: string, projectId: string, app: string, engine: Engine, studio: Awaited<ReturnType<typeof startStudio>>, endpoint: Awaited<ReturnType<typeof startDesktopMcp>>, assistant: AssistantService;
let behavior: RunHarness['run'];
const protection = { kind: 'configured' as const, key: 'a'.repeat(64) };
const sourcePath = 'src/welcome.ts';
const before = 'export const welcome = {\n  title: "Welcome back",\n  subtitle: "Your ideas start here.",\n};\n';
const after = 'export const welcome = {\n  title: "A little inspiration",\n  subtitle: "Make room for your next idea.",\n};\n';
async function boot() {
  engine = new Engine(await Projects.open(path.join(root, 'apps'), path.join(root, 'home')), true, false, undefined, {}, {}, undefined, { encryptionKey: protection.key });
  endpoint = await startDesktopMcp(engine);
  assistant = new AssistantService({ secretProtection: protection, home: path.join(root, 'home'), createHarness: () => ({ async run(...args) { await behavior(...args); }, async close() {} }), createGateway: (binding, signal, context) => McpGateway.open(endpoint.socketPath, binding, signal, context) });
  studio = await startStudio(engine, path.resolve('dist/studio'), assistant);
  await engine.mediaJobs.configureProvider({ action: 'replace', key: 'fake-source-recovery-test-key', expectedRevision: engine.mediaJobs.providerStatus().revision });
}
async function shutdown() { await assistant.close(); await endpoint.close(); await studio.close(); await engine.close(); }
test.beforeEach(async () => {
  test.skip(!!process.env.VISUAL, 'Deterministic workflow suite');
  root = await mkdtemp(path.join(os.tmpdir(), 'studio-source-recovery-'));
  await boot(); const project = await engine.projects.create({ name: 'Quiet Ideas', slug: 'quiet-ideas' }); projectId = project.id; app = project.root;
  await engine.files.write(projectId, [{ path: sourcePath, content: before, expectedRevision: null }]);
  behavior = async (_, callbacks, signal) => {
    const source = await engine.files.read(projectId, sourcePath);
    const result = await callbacks.tool('project_write_files', { projectId, writes: [
      { path: sourcePath, content: after, expectedRevision: source.revision },
      { path: 'app/ideas.tsx', content: 'export default function Ideas() { return null; }\n', expectedRevision: null },
    ] }, signal);
    if (result.isError) throw new Error(JSON.stringify(result));
    callbacks.text('The welcome copy and a new ideas screen are ready for review.');
  };
});
test.afterEach(async ({ page }) => { if (process.env.VISUAL) return; await page.close(); await shutdown(); await rm(root, { recursive: true, force: true }); });
async function send(page: Page) {
  await page.goto(studio.launchUrl); await page.getByRole('button', { name: 'Assistant', exact: true }).click();
  const panel = page.getByRole('dialog', { name: 'Assistant', exact: true });
  await panel.getByLabel('Message assistant').fill('Refine the welcome copy and add an ideas screen');
  await panel.getByRole('button', { name: 'Send message' }).click();
  await expect(panel.getByText('The welcome copy and a new ideas screen are ready for review.')).toBeVisible();
  return panel;
}

test('reviews real MCP edits at phone and desktop sizes, restores them, and keeps history across reload', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const panel = await send(page);
  const review = page.getByRole('dialog', { name: 'Source changes', exact: true });
  await expect(panel.getByRole('button', { name: 'Stop turn' })).toHaveCount(0);
  for (const [width, height] of [[375, 812], [430, 932], [1440, 1100]]) {
    await page.setViewportSize({ width: width!, height: height! });
    await panel.getByRole('button', { name: 'Review source changes' }).click();
    await expect(review.getByRole('region', { name: `Diff for ${sourcePath}` })).toContainText('A little inspiration');
    await expect(review.getByRole('button', { name: 'Restore this turn' })).toBeDisabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const bounds = await review.boundingBox(); expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width! + 1); expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(height! + 1);
    await page.screenshot({ path: test.info().outputPath(`source-review-${width}.png`) });
    await review.getByRole('button', { name: 'Close source changes' }).click();
  }
  await panel.getByRole('button', { name: 'Review source changes' }).click();
  await review.getByRole('button', { name: 'app/ideas.tsx Added' }).click();
  await expect(review.getByRole('region', { name: 'Diff for app/ideas.tsx' })).toContainText('export default function Ideas');
  await review.getByLabel('I reviewed these files and want to undo this turn’s source edits.').check();
  await review.getByRole('button', { name: 'Restore this turn' }).click();
  await expect(review.getByText('This turn’s source changes were restored.')).toBeVisible();
  expect(await readFile(path.join(app, sourcePath), 'utf8')).toBe(before);
  await expect(readFile(path.join(app, 'app/ideas.tsx'))).rejects.toMatchObject({ code: 'ENOENT' });
  await page.goto('about:blank'); await page.goto(studio.issueLaunchUrl()); await page.getByRole('button', { name: 'Assistant', exact: true }).click();
  await panel.getByRole('button', { name: 'Review source changes' }).click();
  await expect(review.getByText('This turn’s source changes were restored.')).toBeVisible();
  expect(errors).toEqual([]);
});

test('a manual edit after review blocks the entire restore and identifies the conflict', async ({ page }) => {
  const panel = await send(page), review = page.getByRole('dialog', { name: 'Source changes', exact: true });
  await panel.getByRole('button', { name: 'Review source changes' }).click();
  await expect(review.getByRole('region', { name: `Diff for ${sourcePath}` })).toBeVisible();
  await writeFile(path.join(app, sourcePath), '// A newer manual correction\n');
  await review.getByLabel('I reviewed these files and want to undo this turn’s source edits.').check();
  await review.getByRole('button', { name: 'Restore this turn' }).click();
  await expect(review.getByRole('alert')).toContainText('Restore is blocked');
  await review.getByRole('button', { name: 'Refresh review' }).click();
  await expect(review.getByRole('alert')).toContainText('Newer edits need your attention');
  await expect(review.getByRole('button', { name: 'Restore this turn' })).toBeDisabled();
  expect(await readFile(path.join(app, sourcePath), 'utf8')).toBe('// A newer manual correction\n');
  expect(await readFile(path.join(app, 'app/ideas.tsx'), 'utf8')).toContain('Ideas');
  await review.getByRole('button', { name: 'Close source changes' }).click();
  await page.setViewportSize({ width: 375, height: 812 });
  await panel.getByRole('button', { name: 'Review source changes' }).click();
  await expect(review.getByRole('alert')).toContainText('Newer edits need your attention');
  await page.screenshot({ path: test.info().outputPath('source-conflict-375.png') });
});

test('stopped turns keep recoverable writes across a backend restart and conversation deletion forgets the checkpoint', async ({ page }) => {
  const writeBehavior = behavior;
  behavior = async (...args) => { await writeBehavior(...args); await new Promise<void>(resolve => args[2].addEventListener('abort', () => resolve(), { once: true })); };
  const panel = await send(page);
  await panel.getByRole('button', { name: 'Stop turn' }).click(); await expect(panel.getByRole('button', { name: 'Stop turn' })).toHaveCount(0);
  const conversation = (await assistant.conversations(projectId))[0]!, turn = (await assistant.conversation(conversation.id)).turns[0]!;
  expect(turn.state).toBe('cancelled'); expect((await assistant.reviewChanges(conversation.id, turn.id)).canRestore).toBe(true);
  await page.goto('about:blank'); await shutdown(); await boot(); await page.goto(studio.launchUrl);
  await page.getByRole('button', { name: 'Assistant', exact: true }).click();
  await panel.getByRole('button', { name: 'Review source changes' }).click();
  const review = page.getByRole('dialog', { name: 'Source changes', exact: true });
  await review.getByLabel('I reviewed these files and want to undo this turn’s source edits.').check();
  await review.getByRole('button', { name: 'Restore this turn' }).click();
  await expect(review.getByText('This turn’s source changes were restored.')).toBeVisible();
  await review.getByRole('button', { name: 'Close source changes' }).click();
  await panel.getByRole('button', { name: 'Conversation history', exact: true }).click();
  await panel.getByRole('button', { name: 'Delete conversation', exact: true }).click();
  await expect(panel.getByRole('region', { name: 'Delete local conversation' })).toContainText('source checkpoints');
  await panel.getByRole('button', { name: 'Permanently delete history' }).click();
  await expect.poll(() => assistant.conversations(projectId)).toEqual([]);
  await expect(readFile(path.join(root, 'home', 'source-changes', `${turn.id}.json`))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(path.join(app, sourcePath), 'utf8')).toBe(before);
});
