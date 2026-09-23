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
  await configuration.getByRole('button', { name: /Connect & use/ }).click();
  await expect(configuration.getByLabel('Anthropic API key', { exact: true })).toHaveValue('');
  await expect.poll(() => assistant.status().providerId).toBe('anthropic');
  await configuration.getByText('Manage connections', { exact: true }).click();
  await configuration.getByRole('button', { name: 'xAI', exact: true }).click();
  await configuration.getByLabel('xAI API key', { exact: true }).fill('fixture-xai-key-sentinel');
  await configuration.getByRole('button', { name: /Connect & use/ }).click();
  await expect(configuration.getByLabel('xAI API key', { exact: true })).toHaveValue('');
  await expect(configuration.getByRole('group', { name: 'Active AI connection' })).toContainText('xAI');
  await expect(configuration.getByRole('button', { name: 'Save assistant model' })).toHaveCount(0);
  await expect.poll(() => assistant.status().providerId).toBe('xai'); expect(calls).toHaveLength(0);
  await page.getByRole('button', { name: 'Assistant', exact: true }).click();
  const chat = page.getByRole('dialog', { name: /Assistant/ });
  await chat.getByLabel('Model and reasoning', { exact: true }).click();
  await expect(chat.getByRole('combobox', { name: 'Chat model' })).toHaveValue(`xai:${assistant.status().model}`);
  const anthropic = assistant.status().connections.find(item => item.id === 'anthropic')!.models[0]!.id;
  await chat.getByRole('combobox', { name: 'Chat model' }).selectOption(`anthropic:${anthropic}`);
  await expect.poll(() => assistant.status().providerId).toBe('anthropic');
  await expect(configuration.getByRole('group', { name: 'Active AI connection' })).toContainText('Anthropic');
  await chat.getByRole('textbox', { name: 'Message assistant' }).fill('Explain the current project');
  await chat.getByRole('button', { name: 'Send message' }).click();
  await expect(chat.getByText('Provider fixture completed.', { exact: true })).toBeVisible();
  for (const [width, height] of [[1440, 1000], [375, 812], [430, 932]] as const) {
    await page.setViewportSize({ width, height });
    await expect(chat.getByLabel('Model and reasoning', { exact: true })).toBeInViewport();
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

test('compact composer persists supported reasoning, keeps keyboard access and sends the chosen effort', async ({ page }, info) => {
  await engine.mediaJobs.configureProvider({ action: 'replace', key: 'fixture-openai-reasoning-key', expectedRevision: engine.mediaJobs.providerStatus().revision });
  await page.goto(studio.launchUrl);
  await page.getByRole('button', { name: 'Assistant', exact: true }).click();
  const chat = page.getByRole('dialog', { name: 'Assistant', exact: true });
  const menu = chat.getByLabel('Model and reasoning', { exact: true });
  const effort = chat.getByRole('combobox', { name: 'Reasoning level' });
  const message = chat.getByRole('textbox', { name: 'Message assistant' });
  await menu.focus(); await menu.press('Enter');
  await expect(effort).toHaveValue('auto');
  await expect(effort.locator('option[value=off]')).toHaveCount(0);
  await effort.selectOption('high');
  await expect.poll(() => assistant.status().reasoningEffort).toBe('high');
  await effort.press('Escape'); await expect(menu).toBeFocused(); await expect(chat).toBeVisible();
  expect(calls).toHaveLength(0);
  await chat.getByRole('button', { name: 'Close assistant' }).click();
  await page.goto('about:blank');
  await page.goto(studio.issueLaunchUrl()); await page.getByRole('button', { name: 'Assistant', exact: true }).click();
  for (const [width, height] of [[1440, 1000], [375, 812], [430, 932], [375, 450]] as const) {
    await page.setViewportSize({ width, height });
    await expect(message).toBeEditable();
    await expect.poll(async () => (await chat.locator('.assistant-input-box').boundingBox())?.height ?? Infinity).toBeLessThanOrEqual(110);
    await expect(chat.getByRole('combobox', { name: 'Assistant mode' })).toBeInViewport({ ratio: 1 });
    await expect(chat.getByRole('button', { name: 'Send message' })).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: info.outputPath(`composer-${width}x${height}.png`) });
    await menu.click(); await expect(effort).toHaveValue('high');
    await expect(effort).toBeInViewport({ ratio: 1 });
    await expect(chat.getByRole('combobox', { name: 'Chat model' })).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: info.outputPath(`reasoning-${width}x${height}.png`) });
    await effort.press('Escape'); await expect(menu).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await message.fill('Explain this app with high reasoning'); await message.press('Enter');
  await expect(chat.getByText('Provider fixture completed.', { exact: true })).toBeVisible();
  expect(calls).toHaveLength(1); expect(calls[0]?.reasoningEffort).toBe('high');
  await menu.click(); await chat.getByRole('combobox', { name: 'Chat model' }).selectOption('openai:gpt-4.1');
  await expect(effort).toHaveValue('auto'); await expect(effort).toBeDisabled();
  await expect(chat.getByText('This model does not offer adjustable reasoning.')).toBeVisible();
  expect(calls).toHaveLength(1);
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

test('explains provider-specific credentials and keeps startup guidance scoped to images', async ({ page }, info) => {
  await page.goto(studio.launchUrl); await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const spending = page.getByRole('region', { name: 'Connections and spending' });
  await expect(spending).toContainText('Messages use your selected provider and model.');
  await expect(spending).not.toContainText('OPENAI_API_KEY');
  const images = page.getByRole('region', { name: 'OpenAI configuration' });
  await images.getByText('OpenAI fallback and startup settings', { exact: true }).click();
  await expect(images.getByText(/Other Assistant providers use their own connections/)).toBeVisible();
  for (const [width, height] of [[1440, 1000], [375, 812], [430, 932]] as const) {
    await page.setViewportSize({ width, height });
    await images.scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`image-credentials-${width}.png`), animations: 'disabled' });
    await spending.scrollIntoViewIfNeeded();
    await expect(spending).toBeInViewport({ ratio: 1 });
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await page.screenshot({ path: info.outputPath(`connections-spending-${width}.png`), animations: 'disabled' });
  }
  expect(calls).toHaveLength(0);
});

test('explains how to recover when an old backend omits connection metadata', async ({ page }, info) => {
  await page.route('**/api/assistant/status', route => route.fulfill({ json: { ...assistant.status(), connections: undefined, rememberAvailable: undefined } }));
  await page.goto(studio.launchUrl); await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const configuration = page.getByRole('region', { name: 'Assistant configuration' });
  await expect(configuration.getByRole('status')).toHaveText('Restart Dunara to load AI connections.');
  await expect(configuration).toContainText('Save unsent drafts');
  await expect(configuration.getByText('API keys & endpoints', { exact: false })).toHaveCount(0);
  await expect(configuration).not.toContainText('Protected storage is unavailable');
  for (const [width, height] of [[1440, 1000], [375, 812], [430, 932]] as const) {
    await page.setViewportSize({ width, height });
    await configuration.scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`outdated-backend-${width}.png`), animations: 'disabled' });
  }
  expect(calls).toHaveLength(0);
});


test('sign-in selects a model automatically even after leaving Settings', async ({ page }, info) => {
  let view = assistant.status(), selections = 0;
  await page.route('**/api/assistant/status', route => route.fulfill({ json: view }));
  await page.route('**/api/assistant/connections/sign-in', async route => {
    view = { ...view, signIn: { id: randomUUID(), provider: 'chatgpt', state: 'waiting', url: 'https://auth.openai.com/authorize' } };
    await route.fulfill({ json: view });
  });
  await page.route('**/api/assistant/configure', async route => {
    selections++;
    const { provider, model } = route.request().postDataJSON();
    expect(provider).toBe('chatgpt');
    view = { ...view, providerId: provider, provider: 'ChatGPT', model, configured: true };
    await route.fulfill({ json: view });
  });
  await page.goto(studio.launchUrl); await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const configuration = page.getByRole('region', { name: 'Assistant configuration' });
  await configuration.getByRole('button', { name: 'Sign in with ChatGPT' }).click();
  await expect(configuration.getByRole('link', { name: 'Continue in browser' })).toBeVisible();
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(configuration).toBeHidden();
  view = { ...view, signIn: { ...view.signIn!, state: 'connected' }, connections: view.connections.map(item => item.id === 'chatgpt' ? { ...item, configured: true, source: 'session' } : item) };
  await expect.poll(() => selections).toBe(1);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const active = configuration.getByRole('group', { name: 'Active AI connection' });
  await expect(active).toContainText('ChatGPT');
  await expect(active).toContainText('Ready');
  await expect(configuration.getByLabel('Assistant model')).toBeHidden();
  await expect(configuration.getByRole('button', { name: 'Sign in again' })).toBeHidden();
  for (const [width, height] of [[1440, 1000], [375, 812], [430, 932]] as const) {
    await page.setViewportSize({ width, height }); await configuration.scrollIntoViewIfNeeded();
    await expect(active).toBeInViewport({ ratio: 1 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`ready-connection-${width}.png`), animations: 'disabled' });
  }
  await active.getByText('Change model', { exact: true }).click();
  const alternative = view.connections.find(item => item.id === 'chatgpt')!.models.find(item => item.id !== view.model)!;
  await configuration.getByLabel('Assistant model').selectOption(`chatgpt:${alternative.id}`);
  await expect.poll(() => view.model).toBe(alternative.id);
  expect(selections).toBe(2); expect(calls).toHaveLength(0);
  // Revisiting a completed login must not replay an old selection.
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(active).toContainText(alternative.label);
  expect(selections).toBe(2);
});

test('failed automatic model save preserves the active model and offers recovery', async ({ page }) => {
  await engine.mediaJobs.configureProvider({ action: 'replace', key: 'fixture-openai-model-save', expectedRevision: engine.mediaJobs.providerStatus().revision });
  const original = assistant.status().model;
  await page.route('**/api/assistant/configure', route => route.fulfill({ status: 409, json: { error: { message: 'A turn started. Try again when it finishes.' } } }));
  await page.goto(studio.launchUrl); await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const configuration = page.getByRole('region', { name: 'Assistant configuration' });
  await configuration.getByText('Change model', { exact: true }).click();
  const model = configuration.getByLabel('Assistant model');
  await model.selectOption('openai:gpt-5.6-sol');
  await expect(configuration.getByRole('alert')).toContainText('A turn started');
  await expect(model).toHaveValue(`openai:${original}`);
  expect(assistant.status().model).toBe(original); expect(calls).toHaveLength(0);
});

test('remembers a connected provider, storage preference, draft and layout across a backend restart', async ({ page }, info) => {
  const options = {
    home: path.join(home, 'home'), secretProtection: { kind: 'configured' as const, key: 'ce'.repeat(32) },
    createHarness: () => ({ async run(input: HarnessInput) { calls.push(input); }, async close() {} }),
    createGateway: async () => ({ tools: [], async call() { return { content: [] }; }, async close() {} }),
  };
  await assistant.close(); await studio.close();
  assistant = new AssistantService(options);
  studio = await startStudio(engine, path.resolve('dist/studio'), assistant);
  assistant.connectionUpdate({ action: 'connect', provider: 'anthropic', key: 'fixture-persistence-key-sentinel', remember: false, expectedRevision: assistant.status().connectionRevision });
  assistant.configure({ action: 'model', provider: 'anthropic', model: assistant.status().connections.find(item => item.id === 'anthropic')!.models[0]!.id });
  await page.goto(studio.launchUrl);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const configuration = page.getByRole('region', { name: 'Assistant configuration' });
  await configuration.getByRole('button', { name: 'Remember Anthropic connection', exact: true }).click();
  await expect(configuration.getByRole('group', { name: 'Active AI connection' })).toContainText('Remembered');
  await configuration.getByText('Manage connections', { exact: true }).click();
  await configuration.getByRole('checkbox', { name: 'Remember new connections on this computer' }).click();
  await expect(configuration.getByRole('checkbox', { name: 'Remember new connections on this computer' })).toBeChecked();
  await configuration.getByText('Privacy & storage', { exact: true }).click();
  await configuration.getByRole('checkbox', { name: 'Remember drafts on this computer' }).click();
  await expect(configuration.getByRole('checkbox', { name: 'Remember drafts on this computer' })).toBeChecked();
  await expect.poll(() => assistant.status().rememberNewConnections).toBe(true);
  for (const [width, height] of [[1440, 1000], [375, 812], [430, 932]] as const) {
    await page.setViewportSize({ width, height });
    await configuration.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`remembered-${width}.png`), animations: 'disabled' });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  const sidebar = page.getByRole('separator', { name: 'Sidebar width', exact: true });
  await sidebar.focus(); await sidebar.press('End'); await expect(sidebar).toHaveAttribute('aria-valuenow', '360');
  await page.getByRole('button', { name: 'Assistant', exact: true }).click();
  const chat = page.getByRole('dialog', { name: 'Assistant', exact: true });
  await chat.getByRole('textbox', { name: 'Message assistant' }).fill('Keep this unsent Bonsai refinement');
  await chat.getByRole('button', { name: 'Close assistant' }).click();
  const origin = studio.origin;
  await page.goto('about:blank');
  await assistant.close(); await studio.close(); await engine.close();
  engine = new Engine(await Projects.open(path.join(home, 'apps'), path.join(home, 'home')), false);
  assistant = new AssistantService(options);
  studio = await startStudio(engine, path.resolve('dist/studio'), assistant, { port: Number(new URL(origin).port) });
  await page.goto(studio.launchUrl);
  await expect(page.getByRole('separator', { name: 'Sidebar width', exact: true })).toHaveAttribute('aria-valuenow', '360');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(configuration.getByRole('group', { name: 'Active AI connection' })).toContainText('Remembered');
  await configuration.getByText('Manage connections', { exact: true }).click();
  await expect(configuration.getByRole('checkbox', { name: 'Remember new connections on this computer' })).toBeChecked();
  await page.getByRole('button', { name: 'Assistant', exact: true }).click();
  await expect(chat.getByRole('textbox', { name: 'Message assistant' })).toHaveValue('Keep this unsent Bonsai refinement');
  expect(calls).toHaveLength(0);
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain('fixture-persistence-key-sentinel');
});
