import { test, expect } from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Engine } from '../../packages/core/src/engine.js';
import { Projects } from '../../packages/core/src/projects.js';
import { startStudio } from '../../packages/cli/src/studio-server.js';
import { startDesktopMcp } from '../../packages/mcp/src/socket.js';
import { AssistantService } from '../../packages/assistant/src/service.js';
import { McpGateway } from '../../packages/assistant/src/mcp-bridge.js';
import type { RunHarness } from '../../packages/assistant/src/contracts.js';
import { selectProject } from './project-picker.js';

test.use({ trace: 'off', actionTimeout: 15_000 });
let root: string, engine: Engine, studio: Awaited<ReturnType<typeof startStudio>>, endpoint: Awaited<ReturnType<typeof startDesktopMcp>>, assistant: AssistantService;
let projectId: string, writes: unknown[], contexts: string[], calls: number, behavior: RunHarness['run'];
const ref = 'abcdefghijklmnopqrst', managementKey = 'fixture-management-private-canary', appKey = 'fixture-app-openai-private-canary';
test.beforeEach(async () => {
  test.skip(!!process.env.VISUAL, 'Visual suite only');
  root = await mkdtemp(path.join(os.tmpdir(), 'dunara-chat-setup-')); writes = []; contexts = []; calls = 0;
  engine = new Engine(await Projects.open(path.join(root, 'apps'), path.join(root, 'home')), false, false, undefined, {}, {
    fetch: async (input, init) => {
      const url = String(input), project = { id: ref, organization_slug: 'test-org', name: 'Habit development', region: 'eu-central-1', status: 'ACTIVE_HEALTHY' };
      if (url.endsWith('/organizations')) return Response.json([{ slug: 'test-org', name: 'My workspace' }]);
      if (url.endsWith('/projects')) return Response.json([project]);
      if (url.endsWith(`/projects/${ref}`)) return Response.json(project);
      if (url.includes('/health?')) return Response.json([{ name: 'db', status: 'ACTIVE_HEALTHY' }]);
      if (url.includes('/api-keys?')) return Response.json([{ type: 'publishable', api_key: 'sb_publishable_test_only' }]);
      if (url.endsWith('/secrets') && init?.method === 'POST') { writes.push(JSON.parse(String(init.body))); return new Response(null, { status: 201 }); }
      throw new Error('Unexpected fixture request');
    },
  }, undefined, { encryptionKey: 'a'.repeat(64) });
  projectId = (await engine.projects.create({ name: 'Habit Studio', slug: 'habit-studio' })).id;
  endpoint = await startDesktopMcp(engine);
  behavior = async (_, callbacks, signal) => {
    await callbacks.tool('assistant_request_setup', { kind: 'app_openai', environment: 'development' }, signal);
    callbacks.text('Use the private setup card to connect your app’s backend and OpenAI key.');
  };
  assistant = new AssistantService({ home: path.join(root, 'home'), secretProtection: { kind: 'configured', key: 'a'.repeat(64) }, createHarness: () => ({ async run(...args) { calls++; contexts.push(JSON.stringify(args[0])); await behavior(...args); }, async close() {} }), createGateway: (binding, signal, context) => McpGateway.open(endpoint.socketPath, binding, signal, context) });
  studio = await startStudio(engine, path.resolve('dist/studio'), assistant);
  assistant.connectionUpdate({ action: 'connect', provider: 'openai', expectedRevision: assistant.status().connectionRevision, key: 'fixture-builder-provider-only-canary', remember: false });
});
test.afterEach(async ({ page }) => {
  if (process.env.VISUAL) return;
  await page.close(); await assistant.close(); await endpoint.close(); await studio.close(); await engine.close(); await rm(root, { recursive: true, force: true });
});

test('chat guides connection, private app key and exact approval without exposing credentials to the model or history', async ({ page }, info) => {
  const responses: string[] = [], chatBodies: string[] = [], errors: string[] = [];
  page.on('response', response => { if (response.url().includes('/api/')) void response.text().then(text => responses.push(text)).catch(() => {}); });
  page.on('request', request => { if (request.url().includes('/api/assistant/')) chatBodies.push(request.postData() ?? ''); });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(studio.launchUrl); await selectProject(page, projectId);
  await page.getByRole('button', { name: 'Assistant', exact: true }).click();
  const panel = page.getByRole('dialog', { name: 'Assistant', exact: true });
  await panel.getByLabel('Message assistant').fill('Add AI coaching to my habit app'); await panel.getByRole('button', { name: 'Send message', exact: true }).click();
  const card = panel.locator('.assistant-setup');
  await expect(card).toContainText('Set up app AI');
  await card.getByLabel('Personal access token', { exact: true }).fill(managementKey);
  await card.getByRole('button', { name: 'Save Supabase connection' }).click();
  await expect(card.getByLabel('Personal access token', { exact: true })).toHaveCount(0);
  await card.getByRole('button', { name: 'Load Supabase projects', exact: true }).click();
  await expect(card.getByRole('combobox', { name: 'Organization', exact: true })).toHaveValue('');
  await card.getByRole('combobox', { name: 'Organization', exact: true }).selectOption('test-org');
  await card.getByRole('combobox', { name: 'Supabase project', exact: true }).selectOption(ref);
  await card.getByRole('button', { name: 'Review connection', exact: true }).click();
  await expect(card.getByText('Needs your review', { exact: true })).toBeVisible();
  expect(await engine.backends.binding(projectId)).toBeNull();
  await card.getByRole('button', { name: 'Approve connection', exact: true }).click();
  await expect(card.getByRole('button', { name: 'Add OpenAI key' })).toBeVisible();
  await card.getByRole('button', { name: 'Add OpenAI key' }).click();
  const privateInput = card.getByLabel('Private value', { exact: true });
  await expect(privateInput).toHaveAttribute('type', 'password');
  for (const [width, height] of [[1440, 1000], [375, 812], [430, 932]] as const) {
    await page.setViewportSize({ width, height }); await privateInput.click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await card.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    await page.screenshot({ path: info.outputPath(`chat-private-input-${width}.png`) });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(panel).not.toHaveAttribute('aria-modal', 'true');
  await expect(panel.getByRole('button', { name: 'Drag Assistant panel', exact: true })).toHaveCount(0);
  await expect(privateInput).toBeVisible();
  await privateInput.fill(appKey); await card.getByRole('button', { name: 'Save private input' }).click();
  await expect(card.getByLabel('Replace value')).toHaveValue('');
  expect(writes).toEqual([]); expect(calls).toBe(1);
  await expect(card.getByRole('button', { name: 'Continue in chat' })).toBeDisabled();
  await card.getByRole('button', { name: 'Review sending to Supabase' }).click();
  await expect(card.getByText('Needs your review', { exact: true })).toBeVisible(); expect(writes).toEqual([]);
  await card.getByRole('button', { name: 'Approve configuration on development' }).click();
  await expect(card.getByText('This key was sent to Supabase. App AI still needs implementation and testing.')).toBeVisible();
  expect(writes).toEqual([[{ name: 'OPENAI_API_KEY', value: appKey }]]);
  await page.goto(studio.issueLaunchUrl());
  if (!await panel.isVisible()) await page.getByRole('button', { name: 'Assistant', exact: true }).click();
  await expect(card.getByText('This key was sent to Supabase. App AI still needs implementation and testing.')).toBeVisible();
  expect(calls).toBe(1); expect(writes).toHaveLength(1);
  behavior = async (input, callbacks) => { expect(input.context).toContain('app_openai'); callbacks.text('I will inspect current setup before continuing.'); };
  await card.getByRole('button', { name: 'Continue in chat' }).click(); expect(calls).toBe(1);
  await expect(panel.getByLabel('Message assistant')).toHaveValue(/Inspect the current backend/);
  await panel.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(panel.getByText('I will inspect current setup before continuing.')).toBeVisible();
  const conversations = await assistant.conversations(projectId), history = JSON.stringify(await assistant.conversation(conversations[0]!.id));
  const source = await readFile(path.join((await engine.projects.get(projectId)).root, 'backend/configuration.json'), 'utf8');
  const storage = JSON.stringify(await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } })));
  for (const secret of [appKey, managementKey]) {
    for (const text of [responses.join(''), chatBodies.join(''), contexts.join(''), history, source, storage, await page.content()]) expect(text).not.toContain(secret);
  }
  expect(source).toContain('OPENAI_API_KEY'); expect(errors).toEqual([]);
});

test('manual cards clear unsaved values on close and project switch, and Plan mode disables setup', async ({ page }) => {
  await page.goto(studio.launchUrl); await selectProject(page, projectId);
  await page.getByRole('button', { name: 'Assistant', exact: true }).click();
  const panel = page.getByRole('dialog', { name: 'Assistant', exact: true });
  await panel.locator('.assistant-setup-menu > summary').click();
  await panel.getByRole('button', { name: 'Connect Supabase', exact: true }).click();
  const card = panel.locator('.assistant-setup');
  await card.getByLabel('Personal access token', { exact: true }).fill(managementKey);
  await card.locator(':scope > summary').click(); await card.locator(':scope > summary').click();
  await expect(card.getByLabel('Personal access token', { exact: true })).toHaveValue('');
  await card.getByLabel('Personal access token', { exact: true }).fill(managementKey);
  await panel.getByRole('button', { name: 'Close assistant', exact: true }).click();
  const other = await engine.projects.create({ name: 'Other App', slug: 'other-app' });
  await page.goto(studio.issueLaunchUrl()); await selectProject(page, other.id);
  await page.getByRole('button', { name: 'Assistant', exact: true }).click();
  await expect(card).toHaveCount(0);
  await panel.getByRole('combobox', { name: 'Assistant mode' }).selectOption('plan');
  await panel.locator('.assistant-setup-menu > summary').click();
  await expect(panel.getByRole('button', { name: 'Connect Supabase', exact: true })).toBeDisabled();
  expect(calls).toBe(0); expect(engine.backends.status().configured).toBe(false);
});

test('replacing a private key invalidates the pending approval and never sends the replacement under the old review', async ({ page }) => {
  engine.backends.configure({ token: managementKey });
  const plan = await engine.backends.plan(projectId, { action: 'link', environment: 'development', projectRef: ref, organization: 'test-org' });
  const operation = await engine.backends.submit(projectId, { plan, requestId: randomUUID() });
  await engine.backends.approve(projectId, { operationId: operation.id, planHash: operation.planHash });
  await expect.poll(async () => (await engine.backends.operation(projectId, operation.id)).state).toBe('succeeded');
  await page.goto(studio.launchUrl); await selectProject(page, projectId);
  await page.getByRole('button', { name: 'Assistant', exact: true }).click();
  const panel = page.getByRole('dialog', { name: 'Assistant', exact: true });
  await panel.locator('.assistant-setup-menu > summary').click(); await panel.getByRole('button', { name: 'Set up app AI', exact: true }).click();
  const card = panel.locator('.assistant-setup');
  await card.getByRole('button', { name: 'Add OpenAI key' }).click();
  await card.getByLabel('Private value', { exact: true }).fill(appKey); await card.getByRole('button', { name: 'Save private input' }).click();
  await card.getByRole('button', { name: 'Review sending to Supabase' }).click();
  await expect(card.getByText('Needs your review', { exact: true })).toBeVisible();
  const variable = (await engine.backends.configuration.functionEnvironment(projectId, 'development')).variables[0]!;
  engine.backends.configuration.secrets.supply(projectId, { environment: 'development', name: variable.secret, value: 'replacement-private-canary', expectedRevision: variable.input.revision });
  await card.getByRole('button', { name: 'Approve configuration on development' }).click();
  await expect(card.getByRole('alert').first()).toBeVisible();
  expect(writes).toEqual([]); expect(calls).toBe(0);
  await expect(card.getByRole('button', { name: 'Continue in chat' })).toBeDisabled();
});
