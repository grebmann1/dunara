import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Engine } from '../../packages/core/src/engine.js';
import { Projects } from '../../packages/core/src/projects.js';
import { startStudio } from '../../packages/cli/src/studio-server.js';
import { AssistantService } from '../../packages/assistant/src/service.js';
import type { HarnessInput } from '../../packages/assistant/src/contracts.js';

test.use({ trace: 'off' });
let home: string, engine: Engine, assistant: AssistantService, studio: Awaited<ReturnType<typeof startStudio>>;
const calls: HarnessInput[] = [];
test.beforeEach(async () => {
  test.skip(!!process.env.VISUAL, 'Isolated connection fixtures only');
  home = await mkdtemp(path.join(os.tmpdir(), 'studio-ai-connections-')); calls.length = 0;
  engine = new Engine(await Projects.open(path.join(home, 'apps'), path.join(home, 'home')), false);
  await engine.projects.create({ name: 'Connection review', slug: 'connection-review' });
  assistant = new AssistantService({ home: path.join(home, 'home'), createHarness: () => ({ async run(input, callbacks) { calls.push(input); callbacks.text('Provider fixture completed.'); }, async close() {} }), createGateway: async () => ({ tools: [], async call() { return { content: [] }; }, async close() {} }) });
  studio = await startStudio(engine, path.resolve('dist/studio'), assistant);
});
test.afterEach(async () => { if (process.env.VISUAL) return; await assistant.close(); await studio.close(); await engine.close(); await rm(home, { recursive: true, force: true }); });

test('connects multiple providers, switches the chat model, and routes only explicit messages', async ({ page }, info) => {
  const responses: string[] = [];
  page.on('response', response => { if (response.url().includes('/api/')) void response.text().then(text => responses.push(text)).catch(() => {}); });
  await page.goto(studio.launchUrl); await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const configuration = page.getByRole('region', { name: 'Assistant configuration' });
  await expect(configuration.getByRole('button', { name: 'Sign in with ChatGPT', exact: true })).toBeVisible();
  await expect(configuration.getByRole('button', { name: 'Sign in with Grok', exact: true })).toBeVisible();
  await configuration.getByText('API keys & endpoints', { exact: false }).click();
  await configuration.getByLabel('Anthropic API key', { exact: true }).fill('fixture-anthropic-key-sentinel');
  await configuration.getByRole('button', { name: 'Save API connection' }).click();
  await expect(configuration.getByLabel('Anthropic API key', { exact: true })).toHaveValue('');
  await configuration.getByRole('button', { name: 'xAI', exact: true }).click();
  await configuration.getByLabel('xAI API key', { exact: true }).fill('fixture-xai-key-sentinel');
  await configuration.getByRole('button', { name: 'Save API connection' }).click();
  await expect(configuration.getByLabel('xAI API key', { exact: true })).toHaveValue('');
  await expect(configuration.getByLabel('Assistant provider')).toContainText('Anthropic');
  await configuration.getByLabel('Assistant provider').selectOption('xai');
  await configuration.getByRole('button', { name: 'Save assistant model' }).click();
  await expect.poll(() => assistant.status().providerId).toBe('xai'); expect(calls).toHaveLength(0);
  await page.getByRole('button', { name: 'Assistant', exact: true }).click();
  const chat = page.getByRole('dialog', { name: /Assistant/ });
  await expect(chat.getByRole('combobox', { name: 'Chat model' })).toHaveValue(`xai:${assistant.status().model}`);
  const anthropic = assistant.status().connections.find(item => item.id === 'anthropic')!.models[0]!.id;
  await chat.getByRole('combobox', { name: 'Chat model' }).selectOption(`anthropic:${anthropic}`);
  await expect.poll(() => assistant.status().providerId).toBe('anthropic');
  await expect(configuration.getByLabel('Assistant provider')).toHaveValue('anthropic');
  await chat.getByRole('textbox', { name: 'Message assistant' }).fill('Explain the current project');
  await chat.getByRole('button', { name: 'Send message' }).click();
  await expect(chat.getByText('Provider fixture completed.', { exact: true })).toBeVisible();
  for (const [width, height] of [[1440, 1000], [375, 812], [430, 932]] as const) {
    await page.setViewportSize({ width, height });
    await expect(chat.getByRole('combobox', { name: 'Chat model' })).toBeInViewport();
    await page.screenshot({ path: info.outputPath(`chat-model-${width}.png`), animations: 'disabled' });
  }
  expect(calls).toHaveLength(1); expect(calls[0]).toMatchObject({ provider: 'anthropic', model: anthropic, apiKey: 'fixture-anthropic-key-sentinel' });
  expect(JSON.stringify(responses)).not.toContain('fixture-anthropic-key-sentinel'); expect(JSON.stringify(responses)).not.toContain('fixture-xai-key-sentinel');
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain('key-sentinel');
});

test('keeps the connection interface usable at desktop and phone sizes', async ({ page }, info) => {
  await page.goto(studio.launchUrl); await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const configuration = page.getByRole('region', { name: 'Assistant configuration' });
  await expect(configuration.getByRole('button', { name: 'Sign in with Grok' })).toBeVisible();
  for (const [width, height] of [[1440, 1000], [375, 812], [430, 932]] as const) {
    await page.setViewportSize({ width, height });
    await configuration.scrollIntoViewIfNeeded();
    await expect(configuration.getByRole('button', { name: 'Sign in with ChatGPT' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`ai-connections-${width}.png`), animations: 'disabled' });
  }
  await configuration.getByText('API keys & endpoints', { exact: false }).click();
  await configuration.getByLabel('Anthropic API key').fill('discard-this-unsaved-key');
  await configuration.getByRole('button', { name: 'Google Gemini', exact: true }).click();
  await expect(configuration.getByLabel('Google Gemini API key')).toHaveValue('');
});

test('subscription sign-in and cancellation preserve an unsaved API key', async ({ page }) => {
  let signIn: ReturnType<AssistantService['status']>['signIn'] = null;
  await page.route('**/api/assistant/status', route => route.fulfill({ json: { ...assistant.status(), signIn } }));
  await page.route('**/api/assistant/connections/sign-in', async route => {
    signIn = { id: randomUUID(), provider: 'grok', state: 'waiting', url: 'https://auth.x.ai/activate', code: 'TEST-CODE' };
    await route.fulfill({ json: { ...assistant.status(), signIn } });
  });
  await page.route('**/api/assistant/connections/cancel', async route => {
    signIn = { id: signIn!.id, provider: 'grok', state: 'cancelled' };
    await route.fulfill({ json: { ...assistant.status(), signIn } });
  });
  await page.goto(studio.launchUrl); await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const configuration = page.getByRole('region', { name: 'Assistant configuration' });
  await configuration.getByText('API keys & endpoints', { exact: false }).click();
  const key = configuration.getByLabel('Anthropic API key'); await key.fill('unsaved-api-key-sentinel');
  await configuration.getByRole('button', { name: 'Sign in with Grok' }).click();
  await expect(configuration.getByRole('link', { name: 'Continue in browser' })).toHaveAttribute('href', 'https://auth.x.ai/activate');
  await expect(configuration.getByText('TEST-CODE', { exact: true })).toBeVisible();
  await expect(key).toHaveValue('unsaved-api-key-sentinel'); await expect(key).toBeDisabled();
  await configuration.getByRole('button', { name: 'Cancel sign-in' }).click();
  await expect(configuration.getByText('Sign-in cancelled.', { exact: true })).toBeVisible();
  await expect(key).toHaveValue('unsaved-api-key-sentinel'); await expect(key).toBeEnabled();
  expect(calls).toHaveLength(0);
});
