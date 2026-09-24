import { AssistantDrafts } from '../../packages/assistant/src/drafts.js';
import { closeMediaDrawer } from './media-workspace-helpers.js';
import { test, expect } from '@playwright/test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { Engine } from '../../packages/core/src/engine.js';
import { Projects } from '../../packages/core/src/projects.js';
import { startDesktopMcp } from '../../packages/mcp/src/socket.js';
import { startStudio } from '../../packages/cli/src/studio-server.js';
import { AssistantService } from '../../packages/assistant/src/service.js';
import { McpGateway } from '../../packages/assistant/src/mcp-bridge.js';
import type { RunHarness } from '../../packages/assistant/src/contracts.js';
import { selectProject } from './project-picker.js';

test.use({ trace: 'off' });
let root: string, engine: Engine, studio: Awaited<ReturnType<typeof startStudio>>, endpoint: Awaited<ReturnType<typeof startDesktopMcp>>, assistant: AssistantService;
let calls: number, behavior: RunHarness['run'];
const protection = { kind: 'configured' as const, key: 'a'.repeat(64) };
const secret = 'fake-assistant-session-privacy-sentinel';
test.beforeEach(async () => {
  test.skip(!!process.env.VISUAL, 'Visual suite only');
  root = await mkdtemp(path.join(os.tmpdir(), 'studio-assistant-')); calls = 0;
  engine = new Engine(await Projects.open(path.join(root, 'apps'), path.join(root, 'home')), true, false, undefined, {}, {}, undefined, { encryptionKey: protection.key });
  endpoint = await startDesktopMcp(engine);
  behavior = async (_, callbacks) => { callbacks.text('A local fixture answer.'); };
  assistant = new AssistantService({ secretProtection: protection, home: path.join(root, 'home'), createHarness: () => ({ async run(...args) { calls++; await behavior(...args); }, async close() {} }), createGateway: (binding, signal, context) => McpGateway.open(endpoint.socketPath, binding, signal, context) });
  studio = await startStudio(engine, path.resolve('dist/studio'), assistant);
});
test.afterEach(async ({ page }) => { if (process.env.VISUAL) return; await page.close(); await assistant.close(); await endpoint.close(); await studio.close(); await engine.close(); await rm(root, { recursive: true, force: true }); });

test('one masked OpenAI key configures both features and the selected model reaches the harness', async ({ page }) => {
  const responses: string[] = [], errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => { if (response.url().includes('/api/')) void response.text().then(text => responses.push(text)).catch(() => {}); });
  await page.goto(studio.launchUrl); await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const section = page.getByRole('region', { name: 'Assistant configuration' });
  const key = page.getByLabel('OpenAI API key', { exact: true });
  await page.getByText('Use another image connection', { exact: true }).click();
  await expect(key).toHaveAttribute('type', 'password');
  await expect(section.locator('input[type="password"]:visible')).toHaveCount(0);
  await key.fill(secret); await page.getByRole('button', { name: 'Save for this Dunara session', exact: true }).click();
  await expect(key).toHaveValue(''); await expect.poll(() => assistant.status().source).toBe('session'); await expect(section.getByRole('group', { name: 'Active AI connection' })).toContainText('OpenAI');
  expect(assistant.status().configured).toBe(true); expect(engine.mediaJobs.providerStatus().configured).toBe(true); expect(calls).toBe(0);
  await section.getByText('Change model', { exact: true }).click();
  await section.getByLabel('Assistant model', { exact: true }).selectOption('openai:gpt-5.6-sol');
  await expect.poll(() => assistant.status().model).toBe('gpt-5.6-sol');
  expect(assistant.status().model).toBe('gpt-5.6-sol'); expect(calls).toBe(0);
  for (const [width, height] of [[375, 812], [430, 932], [1280, 900]]) {
    await page.setViewportSize({ width: width!, height: height! }); await section.scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`shared-settings-${width}.png`) });
  }
  behavior = async (input, callbacks) => { expect(input.apiKey).toBe(secret); expect(input.model).toBe('gpt-5.6-sol'); callbacks.text('Selected model used.'); };
  await page.getByRole('button', { name: 'Assistant', exact: true }).click();
  const panel = page.getByRole('dialog', { name: 'Assistant', exact: true });
  await panel.getByLabel('Model and reasoning', { exact: true }).click();
  await expect(panel.getByRole('combobox', { name: 'Chat model' })).toHaveValue('openai:gpt-5.6-sol');
  await panel.getByLabel('Model and reasoning', { exact: true }).click();
  await panel.getByLabel('Message assistant').fill('Use my chosen model'); await panel.getByRole('button', { name: 'Send message' }).click();
  await expect(panel.getByText('Selected model used.')).toBeVisible();
  await panel.getByRole('button', { name: 'Close assistant' }).click();
  await page.getByRole('button', { name: 'Disconnect OpenAI' }).click();
  await expect(section.getByLabel('Assistant model')).toBeHidden();
  expect(assistant.status().configured).toBe(false); expect(engine.mediaJobs.providerStatus().configured).toBe(false);
  expect(JSON.stringify(await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } })))).not.toContain(secret);
  expect(await page.content()).not.toContain(secret); expect(responses.join('')).not.toContain(secret); expect(errors).toEqual([]); expect(calls).toBe(1);
});

test('Remember persists a shared key and independent model choice across restart', async ({ page }) => {
  await page.goto(studio.launchUrl); await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const section = page.getByRole('region', { name: 'OpenAI configuration' });
  await section.getByText('Use another image connection', { exact: true }).click();
  await section.getByLabel('OpenAI API key', { exact: true }).fill(secret);
  await section.getByLabel('Remember on this computer').check();
  await section.getByRole('button', { name: 'Save on this computer', exact: true }).click();
  await expect(section.getByText('saved', { exact: true })).toBeVisible();
  await page.getByText('Change model', { exact: true }).click();
  await page.getByLabel('Assistant model', { exact: true }).selectOption('openai:gpt-5.6-luna');
  await expect.poll(() => assistant.status().model).toBe('gpt-5.6-luna');
  await page.goto('about:blank'); await assistant.close(); await endpoint.close(); await studio.close(); await engine.close();
  const home = path.join(root, 'home');
  engine = new Engine(await Projects.open(path.join(root, 'apps'), home), true, false, undefined, {}, {}, undefined, { encryptionKey: protection.key });
  endpoint = await startDesktopMcp(engine);
  assistant = new AssistantService({ secretProtection: protection, home, createHarness: () => ({ async run() { calls++; }, async close() {} }), createGateway: (binding, signal, context) => McpGateway.open(endpoint.socketPath, binding, signal, context) });
  studio = await startStudio(engine, path.resolve('dist/studio'), assistant);
  await page.goto(studio.launchUrl); await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect.poll(() => assistant.status().source).toBe('saved'); await expect(page.getByRole('group', { name: 'Active AI connection' })).toContainText('OpenAI');
  await page.getByText('Change model', { exact: true }).click();
  await expect(page.getByLabel('Assistant model', { exact: true })).toHaveValue('openai:gpt-5.6-luna');
  await expect(section.getByLabel('OpenAI API key', { exact: true })).toHaveValue('');
  await page.getByRole('button', { name: 'Disconnect OpenAI' }).click();
  await expect(section.getByText('none', { exact: true })).toBeVisible();
  for (const slot of ['openai-assistant', 'openai-images']) await expect(readFile(path.join(home, 'credentials', `${slot}.json`))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(assistant.status()).toMatchObject({ configured: false, model: 'gpt-5.6-luna' }); expect(calls).toBe(0);
});

test('panel streams safe text, retains drafts when closed, reconnects without resubmission and deletes local history', async ({ page }) => {
  await engine.mediaJobs.configureProvider({ action: 'replace', key: secret, expectedRevision: engine.mediaJobs.providerStatus().revision });
  let finish!: () => void;
  const waiting = new Promise<void>(resolve => { finish = resolve; });
  behavior = async (_, callbacks, signal) => {
    callbacks.text('Streaming fixture <img src="https://untrusted.invalid/image" onerror="alert(1)">');
    await Promise.race([waiting, new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))]);
    if (!signal.aborted) callbacks.text('\nFinished without retry.');
  };
  await page.setViewportSize({ width: 1280, height: 900 }); await page.goto(studio.launchUrl);
  const toggle = page.getByRole('button', { name: 'Assistant', exact: true });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false'); await toggle.click();
  const panel = page.getByRole('dialog', { name: 'Assistant', exact: true });
  const message = panel.getByLabel('Message assistant');
  await message.fill('A retained unsent draft'); await page.keyboard.press('Escape'); await expect(toggle).toBeFocused();
  await toggle.click(); await expect(message).toHaveValue('A retained unsent draft');
  await panel.getByRole('button', { name: 'Send message' }).click();
  await expect(panel.getByText(/Streaming fixture/)).toBeVisible(); expect(calls).toBe(1); await expect(panel.locator('img')).toHaveCount(0);
  await panel.getByRole('button', { name: 'Close assistant' }).click(); expect(assistant.status().busy).toBe(true);
  await page.goto(studio.issueLaunchUrl()); await toggle.click();
  await expect(panel.getByText(/Streaming fixture/)).toBeVisible(); expect(calls).toBe(1);
  finish(); await expect(panel.getByText(/Finished without retry/)).toBeVisible(); await expect(panel.getByRole('button', { name: 'Stop turn' })).toHaveCount(0);
  await panel.getByRole('button', { name: 'Conversation history', exact: true }).click();
  await panel.getByRole('button', { name: 'Delete conversation', exact: true }).click();
  await expect(panel.getByRole('region', { name: 'Delete local conversation' })).toBeVisible(); expect(await assistant.conversations(null)).toHaveLength(1);
  await panel.getByRole('button', { name: 'Permanently delete history' }).click();
  await expect(panel.getByText('What would you like to build?')).toBeVisible(); expect(await assistant.conversations(null)).toHaveLength(0); expect(calls).toBe(1);
});

test('panel requires exact human review for project creation and supports stopping a waiting turn', async ({ page }) => {
  await engine.mediaJobs.configureProvider({ action: 'replace', key: secret, expectedRevision: engine.mediaJobs.providerStatus().revision });
  behavior = async (_, callbacks, signal) => {
    const result = await callbacks.tool('project_create', { name: 'Assistant Reviewed', slug: 'assistant-reviewed' }, signal);
    callbacks.text(result.isError ? 'The action was not performed.' : 'Created with your review.');
  };
  await page.goto(studio.launchUrl); await page.getByRole('button', { name: 'Assistant', exact: true }).click();
  const panel = page.getByRole('dialog', { name: 'Assistant', exact: true });
  await panel.getByLabel('Message assistant').fill('Create a new app'); await panel.getByRole('button', { name: 'Send message' }).click();
  const review = panel.getByRole('region', { name: 'Review project_create' });
  await expect(review).toBeVisible(); await expect(review.getByText(/assistant-reviewed/)).toBeVisible();
  expect(await engine.projects.list()).toHaveLength(0); await expect(review.getByRole('button', { name: 'Approve this action' })).toBeDisabled();
  for (const [width, height] of [[375, 812], [430, 932]] as const) {
    await page.setViewportSize({ width, height });
    await expect(async () => { await expect(review).toBeVisible(); await review.scrollIntoViewIfNeeded(); }).toPass({ timeout: 5000 });
    await page.screenshot({ path: test.info().outputPath(`chat-approval-${width}.png`) });
  }
  await page.setViewportSize({ width: 1440, height: 1100 });
  await review.getByLabel('I reviewed these exact inputs and consequences.').check(); await review.getByRole('button', { name: 'Approve this action' }).click();
  await expect.poll(async () => (await engine.projects.list()).length).toBe(1);
  await expect(panel.getByText('Created with your review.')).toBeVisible(); expect(calls).toBe(1);
  behavior = async (_, callbacks, signal) => { await callbacks.tool('project_create', { name: 'Do Not Create', slug: 'do-not-create' }, signal); };
  await panel.getByLabel('Message assistant').fill('Create another app'); await panel.getByRole('button', { name: 'Send message' }).click();
  await expect(panel.getByRole('region', { name: 'Review project_create' })).toBeVisible(); await panel.getByRole('button', { name: 'Stop turn' }).click();
  await expect(panel.getByText(/Stopped. Completed writes remain visible/)).toBeVisible(); expect(await engine.projects.list()).toHaveLength(1); expect(calls).toBe(2);
});

test('assistant stays beside the entire page and preserves exact phones and keyboard access at mobile and zoom layouts', async ({ page }) => {
  const project = await engine.projects.create({ name: 'Assistant Canvas', slug: 'assistant-canvas' });
  await engine.mediaJobs.configureProvider({ action: 'replace', key: secret, expectedRevision: engine.mediaJobs.providerStatus().revision });
  await page.route('**/*', route => route.request().isNavigationRequest() && route.request().frame().parentFrame()
    ? route.fulfill({ contentType: 'text/html', body: '<!doctype html><body><h1>Assistant phone fixture</h1><input aria-label="Phone draft"></body>' }) : route.continue());
  await page.route(`**/api/projects/${project.id}`, async route => {
    const response = await route.fetch(), state = await response.json();
    await route.fulfill({ response, json: { ...state, preview: { status: 'ready', url: studio.origin.replace('127.0.0.1', 'localhost') } } });
  });
  await page.setViewportSize({ width: 1440, height: 1000 }); await page.goto(studio.launchUrl);
  const phone = page.frameLocator('iframe'); await phone.getByLabel('Phone draft').fill('Do not remount');
  const mounted = await page.locator('iframe').elementHandle(), toggle = page.getByRole('button', { name: 'Assistant', exact: true });
  const design = page.getByRole('button', { name: 'Design', exact: true });
  const designHeading = page.getByRole('heading', { name: 'Design tokens', exact: true });
  await design.click(); await expect(designHeading).toBeVisible();
  await page.getByLabel('Corner radius').fill('31');
  await toggle.click();
  await expect(page.getByRole('dialog', { name: 'Assistant', exact: true })).toBeVisible();
  await expect(design).toHaveAttribute('aria-expanded', 'true');
  await expect(designHeading).toBeVisible();
  await design.click();
  await expect(page.getByRole('dialog', { name: 'Assistant', exact: true })).toBeVisible();
  await expect(designHeading).toBeHidden();
  await design.click();
  await expect(design).toHaveAttribute('aria-expanded', 'true');
  await expect(designHeading).toBeVisible();
  await expect(page.getByLabel('Corner radius')).toHaveValue('31');
  await page.getByRole('button', { name: 'Discard draft', exact: true }).click();
  await design.click(); await expect(designHeading).toBeHidden();
  await page.getByRole('button', { name: 'Close assistant', exact: true }).click();
  const geometry = () => page.locator('.live-board .device-area').evaluate(element => ({ width: element.clientWidth, height: element.clientHeight }));
  for (const width of [375, 430, 768, 1280, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const before = await geometry();
    if (width >= 768) expect(await page.locator('.live-board .device-area').evaluate(element => element.getBoundingClientRect().height / (document.querySelector('.workspace-content')!.getBoundingClientRect().bottom - element.getBoundingClientRect().top))).toBeGreaterThanOrEqual(.9);
    await toggle.click(); const panel = page.getByRole('dialog', { name: 'Assistant', exact: true });
    await expect(panel).toBeVisible();
    if (width >= 1280) expect((await geometry()).width).toBeLessThan(before.width); else expect(await geometry()).toEqual(before);
    await panel.getByLabel('Message assistant').fill(`Draft ${width}`); await expect(panel.getByRole('button', { name: 'Send message' })).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`assistant-${width}.png`) });
    await page.keyboard.press('Escape'); await expect(toggle).toBeFocused();
    expect(await mounted!.evaluate(element => element === document.querySelector('iframe'))).toBe(true);
    expect(await page.locator('iframe').evaluate(element => ({ width: element.clientWidth, height: element.clientHeight }))).toEqual({ width: 375, height: 812 });
    await expect(phone.getByLabel('Phone draft')).toHaveValue('Do not remount');
  }
  await page.setViewportSize({ width: 720, height: 500 }); await toggle.click();
  await expect(page.getByRole('button', { name: 'Send message' })).toBeInViewport();
  await page.keyboard.press('Escape'); await expect(toggle).toBeFocused();
  await expect(page.getByText('Local, shared workspace.')).toHaveCount(0); expect(calls).toBe(0);
  await page.unrouteAll({ behavior: 'wait' });
});

test('Inspector stages an active selection and two canonical PNGs without sending until explicit Send', async ({ page }) => {
  test.setTimeout(240000);
  const project = await engine.projects.create({ name: 'Assistant Inspector', slug: 'assistant-inspector' });
  const png = await sharp({ create: { width: 16, height: 16, channels: 4, background: '#ffffff' } }).png().toBuffer();
  const first = await engine.assets.import(project.id, { expectedRevision: null, label: 'First fixture image', role: 'other', rightsNote: 'Local offline fixture', mediaType: 'image/png' }, png);
  const media = await engine.assets.list(project.id);
  const second = await engine.assets.import(project.id, { expectedRevision: media.revision, label: 'Second fixture image', role: 'other', rightsNote: 'Local offline fixture', mediaType: 'image/png' }, png);
  await engine.mediaJobs.configureProvider({ action: 'replace', key: secret, expectedRevision: engine.mediaJobs.providerStatus().revision });
  behavior = async (input, callbacks) => {
    expect(input.inspector?.projectId).toBe(project.id); expect(input.inspector?.selection.visibleText).toContain('A softer kind of day.');
    expect(JSON.stringify(input.inspector)).not.toContain(project.root); expect(input.images).toHaveLength(2);
    expect(input.images?.every(image => image.data === png.toString('base64'))).toBe(true);
    callbacks.imageAccepted?.(); callbacks.text('Selected context and two PNGs reached the fixture adapter.');
  };
  await page.setViewportSize({ width: 1440, height: 1000 }); await page.goto(studio.launchUrl);
  await page.getByRole('button', { name: 'Start preview' }).click();
  const heading = page.frameLocator('iframe').getByText('A softer kind of day.', { exact: false });
  await expect(heading).toBeVisible({ timeout: 180000 });
  const mounted = await page.locator('iframe').elementHandle();
  const inspect = page.getByRole('button', { name: 'Inspect', exact: true }); await expect(inspect).toBeEnabled(); await inspect.click(); await heading.click();
  await page.getByRole('button', { name: 'Preview context', exact: true }).click();
  await page.getByRole('button', { name: 'Ask assistant about this', exact: true }).click();
  const panel = page.getByRole('dialog', { name: 'Assistant', exact: true });
  await expect(panel.getByRole('region', { name: 'Staged Inspector context' })).toBeVisible();
  const context = page.getByRole('button', { name: 'Preview context', exact: true });
  await expect(context).toHaveAttribute('aria-expanded', 'false');
  await context.click();
  await expect(panel).toBeHidden();
  await expect(page.getByRole('region', { name: 'Selected preview context' })).toBeVisible();
  await expect(context).toHaveAttribute('aria-expanded', 'true');
  await page.getByRole('button', { name: 'Assistant', exact: true }).click();
  await expect(context).toHaveAttribute('aria-expanded', 'false');
  await context.click();
  await expect(page.getByRole('region', { name: 'Selected preview context' })).toBeVisible();
  await page.getByRole('button', { name: 'Assistant', exact: true }).click();
  await expect(panel.getByRole('region', { name: 'Staged Inspector context' })).toBeVisible();
  await panel.getByText('Review sanitized selection', { exact: true }).click(); await expect(panel.getByText(/Untrusted|A softer kind of day/).first()).toBeVisible();
  expect(calls).toBe(0); await panel.getByRole('button', { name: 'Choose existing images' }).click();
  const picker = panel.getByLabel('Attach image', { exact: true });
  await picker.selectOption(`media:${first.assets[0]!.id}`); await picker.selectOption(`media:${second.assets.find(asset => asset.label === 'Second fixture image')!.id}`);
  await expect(picker).toBeDisabled(); await expect(panel.getByAltText('Attached media')).toHaveCount(2);
  for (const [width, height] of [[375, 812], [430, 932]] as const) {
    await page.setViewportSize({ width, height }); await page.screenshot({ path: test.info().outputPath(`chat-attachments-${width}.png`) });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  expect(calls).toBe(0); await panel.getByLabel('Message assistant').fill('Review this active selection and the selected images');
  await panel.getByRole('button', { name: 'Send message' }).click();
  await expect(panel.getByText('Selected context and two PNGs reached the fixture adapter.')).toBeVisible();
  await expect(panel.getByText('Image content accepted by provider adapter', { exact: true })).toHaveCount(2);
  expect(calls).toBe(1); expect(await mounted!.evaluate(element => element === document.querySelector('iframe'))).toBe(true);
  await page.screenshot({ path: test.info().outputPath('assistant-inspector-images.png') });
});

test('project switching isolates drafts and late results while polling fallback never repeats Send', async ({ page }) => {
  const first = await engine.projects.create({ name: 'First Assistant', slug: 'first-assistant' });
  const second = await engine.projects.create({ name: 'Second Assistant', slug: 'second-assistant' });
  const initial = await engine.studio.snapshot(); await engine.studio.control({ expectedRevision: initial.revision, action: { type: 'select-project', projectId: first.id } });
  await engine.mediaJobs.configureProvider({ action: 'replace', key: secret, expectedRevision: engine.mediaJobs.providerStatus().revision });
  let finish!: () => void;
  const waiting = new Promise<void>(resolve => { finish = resolve; });
  behavior = async (_, callbacks, signal) => { callbacks.text('Only First Assistant sees this.'); await Promise.race([waiting, new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))]); if (!signal.aborted) callbacks.text(' Late first-project result.'); };
  await page.route('**/api/assistant/events', route => route.request().postDataJSON().stream ? route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }) : route.continue());
  await page.setViewportSize({ width: 1440, height: 1000 }); await page.goto(studio.launchUrl);
  const toggle = page.getByRole('button', { name: 'Assistant', exact: true }); await toggle.click();
  const panel = page.getByRole('dialog', { name: 'Assistant', exact: true }), message = panel.getByLabel('Message assistant');
  await message.fill('First project instruction'); await panel.getByRole('button', { name: 'Send message' }).click();
  await expect(panel.getByText(/Only First Assistant/)).toBeVisible(); await message.fill('First private draft');
  await selectProject(page, second.id);
  await expect(message).toHaveValue(''); await expect(panel.getByText(/Only First Assistant/)).toHaveCount(0);
  await message.fill('Second private draft'); await expect(panel.getByRole('button', { name: 'Stop turn' })).toBeVisible();
  await message.press('Enter'); expect(calls).toBe(1); expect(await assistant.conversations(second.id)).toHaveLength(0);
  finish(); await expect.poll(() => assistant.status().busy).toBe(false);
  await expect(panel.getByRole('button', { name: 'Send message' })).toBeEnabled();
  await expect(panel.getByText(/Late first-project result/)).toHaveCount(0); await expect(message).toHaveValue('Second private draft');
  await selectProject(page, first.id); await expect(message).toHaveValue('First private draft'); await expect(panel.getByText(/Late first-project result/)).toBeVisible();
  expect(await assistant.conversations(second.id)).toHaveLength(0); expect(calls).toBe(1);
  await page.unrouteAll({ behavior: 'wait' });
});

test('composer supports suggestions, multiline and IME input, Enter to send and safe formatted responses', async ({ page }) => {
  await engine.projects.create({ name: 'Composer App', slug: 'composer-app' });
  await engine.mediaJobs.configureProvider({ action: 'replace', key: secret, expectedRevision: engine.mediaJobs.providerStatus().revision });
  behavior = async (_, callbacks) => callbacks.text('## A calmer home screen\n\nStart with **clear hierarchy** and a little more room.\n\n- Keep the primary action visible\n- Use `spacing.md` consistently\n\n```tsx\nconst spacing = 16;\n```\n\n[Preview guide](https://example.com/guide)\n\n<script>window.chatInjected = true</script>\n\n[Unsafe](javascript:alert(1))');
  await page.setViewportSize({ width: 1440, height: 1000 }); await page.goto(studio.launchUrl);
  await page.getByRole('button', { name: 'Assistant', exact: true }).click();
  const panel = page.getByRole('dialog', { name: 'Assistant', exact: true }), message = panel.getByLabel('Message assistant');
  for (const [width, height] of [[375, 812], [430, 932], [1440, 1000]] as const) {
    await page.setViewportSize({ width, height }); await page.screenshot({ path: test.info().outputPath(`chat-empty-${width}.png`) });
  }
  await panel.getByRole('button', { name: /Refine this screen/ }).click();
  await expect(message).toHaveValue(/Review the current screen/); await expect(message).toBeFocused(); expect(calls).toBe(0);
  await message.fill('Make the home screen calmer.'); await message.press('Shift+Enter'); await message.press('A');
  await expect(message).toHaveValue('Make the home screen calmer.\nA'); expect(calls).toBe(0);
  await message.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true }); expect(calls).toBe(0);
  await message.fill('Make the home screen calmer.'); await message.press('Enter');
  await expect(panel.getByRole('heading', { name: 'A calmer home screen' })).toBeVisible();
  await expect(panel.locator('strong').filter({ hasText: 'clear hierarchy' })).toBeVisible();
  await expect(panel.locator('.assistant-answer li')).toHaveCount(2); await expect(panel.locator('pre code')).toHaveText('const spacing = 16;');
  await expect(panel.getByRole('link', { name: 'Preview guide' })).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(panel.getByRole('link', { name: 'Unsafe' })).toHaveCount(0); await expect(panel.locator('script')).toHaveCount(0);
  await expect(message).toHaveValue(''); await expect(message).toBeFocused(); expect(calls).toBe(1);
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { Reflect.set(window, 'copiedCode', text); } } }));
  await panel.locator('.assistant-code').getByRole('button', { name: 'Copy response' }).click();
  await expect(panel.locator('.assistant-code').getByRole('button', { name: 'Copied' })).toBeVisible();
  expect(await page.evaluate(() => Reflect.get(window, 'copiedCode'))).toBe('const spacing = 16;');
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined }));
  await panel.locator('.assistant-response > .assistant-copy').click();
  await expect(panel.getByRole('button', { name: 'Copy unavailable' })).toBeVisible();
  for (const [width, height] of [[1440, 1000], [375, 812], [430, 932]] as const) {
    await page.setViewportSize({ width, height });
    await expect(panel.getByRole('button', { name: 'Send message' })).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`chat-response-${width}.png`) });
  }
});

test('streamed Markdown tables render safely and scroll within narrow chat panels', async ({ page }) => {
  await engine.mediaJobs.configureProvider({ action: 'replace', key: secret, expectedRevision: engine.mediaJobs.providerStatus().revision });
  let append!: () => void;
  behavior = async (_, callbacks, signal) => {
    callbacks.text('Screen comparison\n| Screen | State | Route | Notes |\n| :--- | :---: | ---: |');
    await Promise.race([new Promise<void>(resolve => { append = resolve; }), new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))]);
    if (!signal.aborted) callbacks.text(' --- |\n| **Home** | Ready | `/home` | Clear hierarchy |\n| Profile | Review | `/profile` | Keep a\\|b together |\n| [Guide](https://example.com/guide) | <img src=x onerror=alert(1)> | [Unsafe](javascript:alert) | Final details |\n\nNext steps are ready.');
  };
  await page.goto(studio.launchUrl); await page.getByRole('button', { name: 'Assistant', exact: true }).click();
  const panel = page.getByRole('dialog', { name: 'Assistant', exact: true });
  await panel.getByLabel('Message assistant').fill('Compare these screens'); await panel.getByRole('button', { name: 'Send message' }).click();
  await expect(panel.getByText('Screen comparison', { exact: false })).toBeVisible();
  await expect(panel.getByRole('table')).toHaveCount(0);
  append();
  const table = panel.getByRole('table');
  await expect(table.getByRole('columnheader')).toHaveText(['Screen', 'State', 'Route', 'Notes']);
  await expect(table.getByRole('row')).toHaveCount(4);
  await expect(table.locator('strong')).toHaveText('Home');
  await expect(table.locator('code')).toHaveText(['/home', '/profile']);
  await expect(table.getByRole('cell', { name: 'Keep a|b together', exact: true })).toBeVisible();
  await expect(table.getByRole('columnheader', { name: 'State', exact: true })).toHaveCSS('text-align', 'center');
  await expect(table.getByRole('cell', { name: '/home', exact: true })).toHaveCSS('text-align', 'right');
  await expect(table.getByRole('link', { name: 'Guide', exact: true })).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(table.locator('img, script')).toHaveCount(0); await expect(table.getByRole('link', { name: 'Unsafe' })).toHaveCount(0);
  await expect(panel.getByText('Next steps are ready.', { exact: true })).toBeVisible();
  const scroll = panel.getByRole('region', { name: 'Response table', exact: true });
  for (const [width, height] of [[375, 812], [430, 932], [1440, 1000]] as const) {
    await page.setViewportSize({ width, height });
    await expect(async () => { await expect(scroll).toBeVisible(); await scroll.scrollIntoViewIfNeeded(); }).toPass({ timeout: 5000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await panel.locator('.assistant-transcript').evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
    await expect.poll(() => scroll.evaluate(node => node.scrollWidth - node.clientWidth)).toBeGreaterThan(0);
    await scroll.focus(); await page.keyboard.press('ArrowRight');
    await expect.poll(() => scroll.evaluate(node => node.scrollLeft)).toBeGreaterThan(0);
    await scroll.evaluate(node => { node.scrollLeft = 0; });
    await page.screenshot({ path: test.info().outputPath(`chat-table-${width}.png`) });
  }
  expect(calls).toBe(1);
});
test('Plan and Build modes preserve drafts, enforce read-only planning and implement a plan only after Send', async ({ page }) => {
  const project = await engine.projects.create({ name: 'Mode fixture', slug: 'mode-fixture' });
  await engine.mediaJobs.configureProvider({ action: 'replace', key: secret, expectedRevision: engine.mediaJobs.providerStatus().revision });
  let finishPlan!: () => void;
  const waiting = new Promise<void>(resolve => { finishPlan = resolve; });
  const writes = [{ path: 'app/planned.tsx', content: 'export default function Planned(){return null}', expectedRevision: null }];
  behavior = async (input, callbacks, signal) => {
    if (input.mode === 'plan') {
      expect(input.tools.map(tool => tool.name)).not.toContain('project_write_files');
      expect((await callbacks.tool('project_inspect', { projectId: project.id }, signal)).isError).not.toBe(true);
      await expect(callbacks.tool('project_write_files', { projectId: project.id, writes }, signal)).rejects.toThrow('Plan mode');
      callbacks.text('## Proposed screen\n\n1. Add the planned screen.\n2. Verify its route and layout.');
      await Promise.race([waiting, new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))]);
    } else {
      expect(input.mode).toBe('build'); expect(input.context).toContain('Proposed screen');
      expect((await callbacks.tool('project_write_files', { projectId: project.id, writes }, signal)).isError).not.toBe(true);
      callbacks.text('Implemented the planned screen.');
    }
  };
  await page.goto(studio.launchUrl); await page.getByRole('button', { name: 'Assistant', exact: true }).click();
  const panel = page.getByRole('dialog', { name: 'Assistant', exact: true }), message = panel.getByLabel('Message assistant');
  const mode = panel.getByRole('combobox', { name: 'Assistant mode' });
  await expect(mode).toHaveValue('build');
  await message.fill('Plan a new screen.'); await mode.selectOption('plan'); await expect(message).toHaveValue('Plan a new screen.');
  await panel.getByRole('button', { name: 'Close assistant' }).click(); await page.getByRole('button', { name: 'Assistant', exact: true }).click();
  await expect(mode).toHaveValue('plan'); await expect(message).toHaveValue('Plan a new screen.'); expect(calls).toBe(0);
  await message.press('Enter');
  await expect(panel.getByRole('heading', { name: 'Proposed screen' })).toBeVisible();
  await expect(mode).toBeDisabled();
  await expect(readFile(path.join(project.root, 'app/planned.tsx'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(assistant.status().active).toMatchObject({ mode: 'plan' });
  finishPlan(); await expect(panel.getByRole('button', { name: 'Build this plan' })).toBeEnabled();
  await panel.getByRole('button', { name: 'Close assistant' }).click();
  await page.goto('about:blank');
  await page.goto(studio.issueLaunchUrl()); await page.getByRole('button', { name: 'Assistant', exact: true }).click();
  await expect(mode).toHaveValue('plan');
  await expect(panel.locator('.assistant-mode-tag')).toHaveText(['Plan']);
  for (const [width, height] of [[375, 812], [430, 932], [1440, 1000]] as const) {
    await page.setViewportSize({ width, height });
    await expect(mode).toBeInViewport();
    await expect(panel.getByRole('button', { name: 'Send message' })).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`assistant-plan-${width}.png`) });
  }
  await panel.getByRole('button', { name: 'Build this plan' }).click();
  await expect(mode).toHaveValue('build'); await expect(message).toHaveValue(/Implement the plan/); expect(calls).toBe(1);
  await expect(readFile(path.join(project.root, 'app/planned.tsx'))).rejects.toMatchObject({ code: 'ENOENT' });
  await message.press('Enter'); await expect(panel.getByText('Implemented the planned screen.')).toBeVisible();
  await expect(panel.locator('.assistant-mode-tag')).toHaveText(['Plan', 'Build']);
  expect(await readFile(path.join(project.root, 'app/planned.tsx'), 'utf8')).toBe(writes[0]!.content);
  const records = await assistant.conversations(project.id);
  expect((await assistant.conversation(records[0]!.id)).turns.map(turn => turn.mode)).toEqual(['plan', 'build']); expect(calls).toBe(2);
});

test('a failed Plan send keeps its mode and draft when retried explicitly', async ({ page }) => {
  await engine.mediaJobs.configureProvider({ action: 'replace', key: secret, expectedRevision: engine.mediaJobs.providerStatus().revision });
  behavior = async (input, callbacks) => { expect(input.mode).toBe('plan'); callbacks.text('Plan preserved.'); };
  await page.route('**/api/assistant/turns/start', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Offline mode fixture' } }) }));
  await page.goto(studio.launchUrl); await page.getByRole('button', { name: 'Assistant', exact: true }).click();
  const panel = page.getByRole('dialog', { name: 'Assistant', exact: true }), message = panel.getByLabel('Message assistant');
  await panel.getByRole('combobox', { name: 'Assistant mode' }).selectOption('plan'); await message.fill('Plan without editing'); await message.press('Enter');
  await expect(panel.getByRole('alert')).toContainText('Offline mode fixture');
  await expect(panel.getByRole('combobox', { name: 'Assistant mode' })).toHaveValue('plan');
  await expect(message).toHaveValue('Plan without editing'); expect(calls).toBe(0);
  await page.unroute('**/api/assistant/turns/start'); await message.press('Enter');
  await expect(panel.getByText('Plan preserved.')).toBeVisible(); expect(calls).toBe(1);
});
test('task checklists update live, survive stopping and reload, and Continue stages only the remaining work', async ({ page }) => {
  await engine.projects.create({ name: 'Task progress', slug: 'task-progress' });
  await engine.mediaJobs.configureProvider({ action: 'replace', key: secret, expectedRevision: engine.mediaJobs.providerStatus().revision });
  const planned = [{ id: 'inspect', label: 'Inspect the screens', status: 'pending' }, { id: 'build', label: 'Build the layout', status: 'pending' }, { id: 'verify', label: 'Verify the result', status: 'pending' }];
  let advance!: () => Promise<void>;
  behavior = async (input, callbacks, signal) => {
    if (input.mode === 'plan') {
      await callbacks.tool('assistant_update_tasks', { tasks: planned }, signal); callbacks.text('The plan is ready.'); return;
    }
    if (input.prompt.startsWith('Continue')) {
      expect(input.context).toContain('"state":"cancelled"'); expect(input.context).toContain('Verify the result');
      await callbacks.tool('assistant_update_tasks', { tasks: planned.map(task => ({ ...task, status: 'completed' })) }, signal);
      callbacks.text('Finished the remaining verification.'); return;
    }
    await callbacks.tool('assistant_update_tasks', { tasks: planned.map((task, index) => ({ ...task, status: index === 0 ? 'completed' : index === 1 ? 'in_progress' : 'pending' })) }, signal);
    advance = async () => { await callbacks.tool('assistant_update_tasks', { tasks: planned.map((task, index) => ({ ...task, status: index < 2 ? 'completed' : 'in_progress' })) }, signal); };
    callbacks.text('Working through the layout.');
    await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
  };
  await page.goto(studio.launchUrl); await page.getByRole('button', { name: 'Assistant', exact: true }).click();
  const panel = page.getByRole('dialog', { name: 'Assistant', exact: true }), message = panel.getByLabel('Message assistant');
  await panel.getByRole('combobox', { name: 'Assistant mode' }).selectOption('plan'); await message.fill('Plan a layout improvement'); await message.press('Enter');
  await expect(panel.locator('.assistant-tasks')).toContainText('0 of 3 complete');
  await expect(panel.getByRole('button', { name: 'Build this plan' })).toBeEnabled();
  await panel.getByRole('button', { name: 'Build this plan' }).click(); await message.press('Enter');
  await expect(panel.locator('.assistant-tasks').last()).toContainText('1 of 3 complete');
  await expect(panel.locator('.assistant-tasks').last().getByText('In progress', { exact: true })).toBeVisible();
  // Task events may render before the fixture's awaited tool call returns.
  await expect.poll(() => typeof advance).toBe('function');
  await advance(); await expect(panel.locator('.assistant-tasks').last()).toContainText('2 of 3 complete');
  await page.screenshot({ path: test.info().outputPath('tasks-live-1440.png') });
  await panel.getByRole('button', { name: 'Stop turn' }).click();
  await expect(panel.locator('.assistant-tasks').last().getByText('Paused', { exact: true })).toBeVisible();
  await page.goto('about:blank'); await page.goto(studio.issueLaunchUrl()); await page.getByRole('button', { name: 'Assistant', exact: true }).click();
  await expect(panel.locator('.assistant-tasks').last()).toContainText('2 of 3 complete');
  await expect(panel.locator('.assistant-tasks').last().getByText('Paused', { exact: true })).toBeVisible(); expect(calls).toBe(2);
  const resume = panel.getByRole('button', { name: 'Continue', exact: true });
  await message.fill('Keep this unsent thought'); await expect(resume).toBeDisabled(); await message.fill(''); await resume.click();
  await expect(message).toHaveValue(/Keep completed changes/); await expect(panel.getByRole('combobox', { name: 'Assistant mode' })).toHaveValue('build'); expect(calls).toBe(2);
  await message.press('Enter'); await expect(panel.getByText('Finished the remaining verification.')).toBeVisible();
  await expect(panel.locator('.assistant-tasks').last()).toContainText('3 of 3 complete');
  await expect(panel.locator('.assistant-tasks').last().getByRole('progressbar')).toHaveAttribute('value', '3');
  for (const [width, height] of [[375, 812], [430, 932], [1440, 1000]] as const) {
    await page.setViewportSize({ width, height });
    await expect(panel.getByRole('button', { name: 'Send message' })).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`tasks-finished-${width}.png`) });
  }
  expect(calls).toBe(3);
});

test('conversation search finds response text and task labels and exports original Markdown without sending', async ({ page }) => {
  await engine.mediaJobs.configureProvider({ action: 'replace', key: secret, expectedRevision: engine.mediaJobs.providerStatus().revision });
  const response = '| Screen | Status |\n| --- | --- |\n| Home | Accessible navigation |';
  behavior = async (input, callbacks, signal) => {
    if (input.prompt === 'First idea') {
      await callbacks.tool('assistant_update_tasks', { tasks: [{ id: 'contrast', label: 'Check lavender contrast', status: 'pending' }] }, signal); callbacks.text(response);
    } else callbacks.text('A separate app idea.');
  };
  await page.goto(studio.launchUrl); await page.getByRole('button', { name: 'Assistant', exact: true }).click();
  const panel = page.getByRole('dialog', { name: 'Assistant', exact: true }), message = panel.getByLabel('Message assistant');
  await message.fill('First idea'); await message.press('Enter'); await expect(panel.getByRole('table')).toBeVisible();
  const first = (await assistant.conversations(null))[0]!.id;
  await panel.getByRole('button', { name: 'New conversation' }).click(); await message.fill('Second idea'); await message.press('Enter');
  await expect(panel.getByText('A separate app idea.')).toBeVisible();
  await panel.getByRole('button', { name: 'Conversation history' }).click();
  const search = panel.getByRole('searchbox', { name: 'Search conversations' }), select = panel.getByLabel('Select conversation');
  await search.fill('LAVENDER'); await expect(select).toBeEnabled();
  await expect(select.locator('option:not([disabled])')).toHaveText(['First idea']);
  await search.fill('navigation'); await expect(select).toBeEnabled(); await expect(select.locator('option:not([disabled])')).toHaveText(['First idea']);
  await search.fill('no matching phrase'); await expect(select).toBeDisabled(); await expect(select).toContainText('No matching conversations');
  await search.fill('navigation'); await expect(select).toBeEnabled(); await select.selectOption(first);
  await expect(panel.getByRole('table')).toBeVisible();
  await panel.getByRole('button', { name: 'Conversation history' }).click();
  const downloadEvent = page.waitForEvent('download'); await panel.getByRole('button', { name: 'Export conversation' }).click();
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toMatch(/^first-idea-[a-f0-9]{8}\.md$/);
  const filename = test.info().outputPath('conversation.md'); await download.saveAs(filename);
  const exported = await readFile(filename, 'utf8');
  expect(exported).toContain(response); expect(exported).toContain('## You · Build'); expect(exported).toContain('- [ ] Check lavender contrast'); expect(exported).not.toContain('Second idea'); expect(exported).not.toContain(secret);
  for (const [width, height] of [[375, 812], [430, 932], [1440, 1000]] as const) {
    await page.setViewportSize({ width, height });
    await expect(panel.getByRole('button', { name: 'Export conversation' })).toBeInViewport(); await expect(panel.getByRole('button', { name: 'Send message' })).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`history-export-${width}.png`) });
  }
  expect(calls).toBe(2);
});

test('a rejected first Send preserves its draft and conversation, then allows one explicit retry', async ({ page }) => {
  await engine.mediaJobs.configureProvider({ action: 'replace', key: secret, expectedRevision: engine.mediaJobs.providerStatus().revision });
  await page.route('**/api/assistant/turns/start', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Offline fixture: send unavailable.' } }) }));
  await page.setViewportSize({ width: 375, height: 812 }); await page.goto(studio.launchUrl);
  await page.getByRole('button', { name: 'Assistant', exact: true }).click();
  const panel = page.getByRole('dialog', { name: 'Assistant', exact: true }), message = panel.getByLabel('Message assistant');
  await message.fill('Keep this idea even if sending fails.'); await message.press('Enter');
  await expect(panel.getByRole('alert')).toContainText('Offline fixture: send unavailable.');
  await expect(message).toHaveValue('Keep this idea even if sending fails.');
  expect(await assistant.conversations(null)).toHaveLength(1); expect(calls).toBe(0);
  await page.screenshot({ path: test.info().outputPath('chat-failed-send-375.png') });
  await page.keyboard.press('Escape'); await page.getByRole('button', { name: 'Assistant', exact: true }).click();
  await expect(message).toHaveValue('Keep this idea even if sending fails.');
  await page.unroute('**/api/assistant/turns/start'); await message.press('Enter');
  await expect(panel.getByText('A local fixture answer.')).toBeVisible();
  await expect(message).toHaveValue(''); expect(calls).toBe(1); expect(await assistant.conversations(null)).toHaveLength(1);
});

test('reading earlier messages stays put during streaming and Latest message returns to the response', async ({ page }) => {
  await engine.mediaJobs.configureProvider({ action: 'replace', key: secret, expectedRevision: engine.mediaJobs.providerStatus().revision });
  let append!: () => void, finish!: () => void;
  const waiting = new Promise<void>(resolve => { finish = resolve; });
  behavior = async (_, callbacks, signal) => {
    callbacks.text(Array.from({ length: 35 }, (_, i) => `Paragraph ${i + 1}. Give the content room to breathe and keep each action easy to find.`).join('\n\n'));
    append = () => callbacks.text('\n\nThe newest streamed detail.');
    await Promise.race([waiting, new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))]);
  };
  await page.setViewportSize({ width: 430, height: 932 }); await page.goto(studio.launchUrl);
  await page.getByRole('button', { name: 'Assistant', exact: true }).click();
  const panel = page.getByRole('dialog', { name: 'Assistant', exact: true }), message = panel.getByLabel('Message assistant');
  await message.fill('Walk me through the design.'); await message.press('Enter');
  await expect(panel.getByText(/Paragraph 35/)).toBeVisible();
  const transcript = panel.locator('.assistant-transcript');
  await transcript.evaluate(element => {
    element.scrollTop = 100;
    // A layout update can arrive before the browser dispatches its scroll event.
    document.querySelector<HTMLButtonElement>('button[aria-label="Conversation history"]')!.click();
  });
  await expect(panel.getByRole('button', { name: 'Latest message' })).toBeVisible();
  await panel.getByRole('button', { name: 'Conversation history' }).click();
  append(); await expect(panel.getByText('The newest streamed detail.')).toBeAttached();
  await expect.poll(() => transcript.evaluate(element => element.scrollTop)).toBe(100);
  await panel.getByRole('button', { name: 'Latest message' }).click(); await expect(panel.getByText('The newest streamed detail.')).toBeInViewport();
  await expect(panel.getByRole('button', { name: 'Stop turn' })).toBeInViewport();
  await page.screenshot({ path: test.info().outputPath('chat-streaming-430.png') });
  finish(); await expect(panel.getByRole('button', { name: 'Send message' })).toBeVisible(); expect(calls).toBe(1);
});

test('a staged message waits for draft restoration before Send becomes available', async ({ page }) => {
  await engine.projects.create({ name: 'Draft App', slug: 'draft-app' });
  await engine.mediaJobs.configureProvider({ action: 'replace', key: secret, expectedRevision: engine.mediaJobs.providerStatus().revision });
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/assistant/drafts/read', async route => { await pending; await route.continue(); });
  try {
    await page.goto(studio.launchUrl); await page.getByRole('button', { name: 'Assistant', exact: true }).click();
    const panel = page.getByRole('dialog', { name: 'Assistant', exact: true }), message = panel.getByLabel('Message assistant');
    await panel.getByRole('button', { name: /^Refine this screen/ }).click();
    await expect(message).toHaveValue('Review the current screen and suggest improvements to its layout, spacing, and typography.');
    await expect(message).toHaveAttribute('readonly', '');
    await expect(panel.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled();
    expect(calls).toBe(0);
    release();
    await expect(message).not.toHaveAttribute('readonly');
    await panel.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(panel.getByText('A local fixture answer.')).toBeVisible(); expect(calls).toBe(1);
  } finally { release(); await page.unrouteAll({ behavior: 'ignoreErrors' }); }
});

test('failed turns can be edited without resubmitting automatically', async ({ page }) => {
  await engine.mediaJobs.configureProvider({ action: 'replace', key: secret, expectedRevision: engine.mediaJobs.providerStatus().revision });
  behavior = async () => { throw new Error('Offline fixture failure'); };
  await page.goto(studio.launchUrl); await page.getByRole('button', { name: 'Assistant', exact: true }).click();
  const panel = page.getByRole('dialog', { name: 'Assistant', exact: true }), message = panel.getByLabel('Message assistant');
  await message.fill('Help me refine this layout.'); await message.press('Enter');
  await expect(panel.getByText(/could not complete this turn/)).toBeVisible();
  await panel.getByRole('button', { name: 'Edit and resend' }).click();
  await expect(message).toHaveValue('Help me refine this layout.'); await expect(message).toBeFocused(); expect(calls).toBe(1);
  behavior = async (_, callbacks) => callbacks.text('The explicit retry completed.');
  await message.press('Enter'); await expect(panel.getByText('The explicit retry completed.')).toBeVisible(); expect(calls).toBe(2);
});

test('a delayed busy status cannot overwrite a completed turn event', async ({ page }) => {
  await engine.mediaJobs.configureProvider({ action: 'replace', key: secret, expectedRevision: engine.mediaJobs.providerStatus().revision });
  let finish!: () => void, releaseStatus!: () => void, held = false;
  const running = new Promise<void>(resolve => { finish = resolve; });
  const pendingStatus = new Promise<void>(resolve => { releaseStatus = resolve; });
  behavior = async (_, callbacks) => { await running; callbacks.text('The turn has finished.'); };
  await page.route('**/api/assistant/status', async route => {
    const response = await route.fetch();
    if ((await response.json()).busy) { held = true; await pendingStatus; }
    await route.fulfill({ response });
  });
  try {
    await page.goto(studio.launchUrl); await page.getByRole('button', { name: 'Assistant', exact: true }).click();
    const panel = page.getByRole('dialog', { name: 'Assistant', exact: true }), message = panel.getByLabel('Message assistant');
    await message.fill('Finish one turn'); await message.press('Enter');
    await expect.poll(() => held).toBe(true);
    finish(); await expect(panel.getByText('The turn has finished.')).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Stop turn' })).toHaveCount(0);
    releaseStatus(); await expect(message).toBeEditable();
    await expect(panel.getByRole('button', { name: 'Send message' })).toBeVisible();
    expect(calls).toBe(1);
  } finally { finish(); releaseStatus(); await page.unrouteAll({ behavior: 'wait' }); }
});

test('creating a conversation keeps the composer locked until its history is selected', async ({ page }) => {
  await engine.mediaJobs.configureProvider({ action: 'replace', key: secret, expectedRevision: engine.mediaJobs.providerStatus().revision });
  await page.goto(studio.launchUrl); await page.getByRole('button', { name: 'Assistant', exact: true }).click();
  const panel = page.getByRole('dialog', { name: 'Assistant', exact: true }), message = panel.getByLabel('Message assistant');
  await message.fill('First conversation'); await message.press('Enter');
  await expect(panel.getByText('A local fixture answer.')).toBeVisible();
  await expect(panel.getByRole('button', { name: 'New conversation' })).toBeEnabled();
  let release!: () => void, held = false;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/assistant/conversations/read', async route => { held = true; await pending; await route.continue(); });
  try {
    await panel.getByRole('button', { name: 'New conversation' }).click();
    await expect.poll(() => held).toBe(true);
    await expect(message).toHaveAttribute('readonly', '');
    release(); await expect(panel.getByText('What would you like to build?')).toBeVisible();
    await message.fill('Second conversation'); await message.press('Enter');
    await expect(panel.getByText('A local fixture answer.')).toBeVisible();
    expect(calls).toBe(2);
    const records = await assistant.conversations(null);
    expect(records).toHaveLength(2);
    expect((await Promise.all(records.map(record => assistant.conversation(record.id)))).map(record => record.turns[0]?.prompt).sort()).toEqual(['First conversation', 'Second conversation']);
  } finally { release(); await page.unrouteAll({ behavior: 'ignoreErrors' }); }
});

test('approved artwork opens a retained integration draft in existing chat history without sending', async ({ page }) => {
  const project = await engine.projects.create({ name: 'Artwork Handoff', slug: 'artwork-handoff' });
  const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#416a57' } }).png().toBuffer();
  const imported = await engine.assets.import(project.id, { expectedRevision: null, label: 'Quiet landscape', role: 'illustration', mediaType: 'image/png' }, png);
  const asset = imported.assets[0]!;
  await engine.assets.approve(project.id, asset.id, imported.revision);
  await engine.mediaJobs.configureProvider({ action: 'replace', key: secret, expectedRevision: engine.mediaJobs.providerStatus().revision });
  const conversation = await assistant.createConversation(project.id);
  behavior = async (input, callbacks) => {
    expect(input.prompt).toContain(asset.path);
    callbacks.text('The approved artwork context reached the assistant.');
  };
  await page.setViewportSize({ width: 430, height: 932 });
  await page.goto(studio.launchUrl);
  await page.getByRole('button', { name: 'Assets', exact: true }).click();
  await page.getByRole('button', { name: 'Quiet landscape', exact: true }).click();
  await page.getByRole('button', { name: 'Use in my app', exact: true }).click();
  const panel = page.getByRole('dialog', { name: 'Assistant', exact: true });
  const message = panel.getByLabel('Message assistant');
  await expect(panel.getByRole('button', { name: 'Send message' })).toBeEnabled();
  await expect(message).toHaveValue(new RegExp(asset.id));
  await panel.getByLabel('Assistant mode').selectOption('plan');
  await message.press('Escape');
  await page.getByRole('button', { name: 'Quiet landscape', exact: true }).click();
  await page.getByRole('button', { name: 'Use in my app', exact: true }).click();
  await expect(panel.getByLabel('Assistant mode')).toHaveValue('build');
  expect((await message.inputValue()).split('Asset ID:')).toHaveLength(2);
  await expect.poll(() => panel.evaluate(node => node.contains(document.activeElement))).toBe(true);
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect.poll(async () => {
    const workspace = await page.locator('.workspace-content').boundingBox(), chat = await panel.boundingBox();
    return !!workspace && !!chat && workspace.x + workspace.width <= chat.x;
  }).toBe(true);
  expect(calls).toBe(0);
  // Desktop Escape belongs to the focused panel after the responsive portal moves.
  await message.press('Escape');
  await expect(panel).toBeHidden();
  await page.getByRole('button', { name: 'Assistant', exact: true }).click();
  await expect(message).toHaveValue(new RegExp(asset.id));
  await message.press('Enter');
  await expect(panel.getByText('The approved artwork context reached the assistant.')).toBeVisible();
  expect(calls).toBe(1);
  expect((await assistant.conversation(conversation.id)).turns).toHaveLength(1);
});

test('drops and uploads chat images, rejects invalid files, and sends only on request', async ({ page }) => {
  const project = await engine.projects.create({ name: 'Image Chat', slug: 'image-chat' });
  await engine.mediaJobs.configureProvider({ action: 'replace', key: secret, expectedRevision: engine.mediaJobs.providerStatus().revision });
  const png = await sharp({ create: { width: 160, height: 100, channels: 4, background: '#cb9478' } }).png().toBuffer();
  behavior = async (input, callbacks) => { expect(input.images).toHaveLength(2); callbacks.imageAccepted?.(); callbacks.text('Both uploaded images arrived.'); };
  await page.goto(studio.launchUrl);
  await page.getByRole('button', { name: 'Assistant', exact: true }).click();
  const panel = page.getByRole('dialog', { name: 'Assistant', exact: true });
  await expect(panel.getByLabel('Message assistant')).toBeEditable();
  await panel.getByLabel('Message assistant').fill('Use these references');
  const drop = async (name: string, type: string) => {
    const dataTransfer = await page.evaluateHandle(({ name, type, bytes }) => {
      const transfer = new DataTransfer(); transfer.items.add(new File([new Uint8Array(bytes)], name, { type })); return transfer;
    }, { name, type, bytes: [...png] });
    await panel.dispatchEvent('dragenter', { dataTransfer });
    await expect(panel.getByText('Drop images into your message')).toBeVisible();
    await panel.dispatchEvent('drop', { dataTransfer }); await dataTransfer.dispose();
  };
  await drop('invalid.svg', 'image/svg+xml');
  await expect(panel.getByRole('alert')).toContainText('Choose PNG, JPEG or WebP');
  expect((await engine.assets.list(project.id)).assets).toHaveLength(0);
  await drop('reference.png', 'image/png');
  await expect(panel.getByAltText('Attached media')).toHaveCount(1);
  await expect(panel.getByRole('button', { name: 'Upload images', exact: true })).toBeEnabled();
  await panel.getByLabel('Upload chat images').setInputFiles({ name: 'second.png', mimeType: 'image/png', buffer: png });
  await expect(panel.getByAltText('Attached media')).toHaveCount(2);
  await expect(panel.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled();
  expect((await engine.assets.list(project.id)).assets).toHaveLength(2); expect(calls).toBe(0);
  await drop('third.png', 'image/png');
  await expect(panel.getByRole('alert')).toContainText('up to two images');
  expect((await engine.assets.list(project.id)).assets).toHaveLength(2);
  for (const [width, height] of [[1440, 1000], [375, 812], [430, 932]]) {
    await page.setViewportSize({ width: width!, height: height! });
    await expect(panel.getByRole('button', { name: 'Send message', exact: true })).toBeInViewport();
    expect(await panel.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`image-upload-${width}.png`) });
  }
  await panel.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(panel.getByText('Both uploaded images arrived.')).toBeVisible(); expect(calls).toBe(1);
});

test('keeps successful images after a partial upload failure and accepts a pasted retry', async ({ page }) => {
  const project = await engine.projects.create({ name: 'Image Retry', slug: 'image-retry' });
  await engine.mediaJobs.configureProvider({ action: 'replace', key: secret, expectedRevision: engine.mediaJobs.providerStatus().revision });
  const png = await sharp({ create: { width: 16, height: 16, channels: 4, background: '#ffffff' } }).png().toBuffer();
  await page.goto(studio.launchUrl); await page.getByRole('button', { name: 'Assistant', exact: true }).click();
  const panel = page.getByRole('dialog', { name: 'Assistant', exact: true });
  await expect(panel.getByLabel('Message assistant')).toBeEditable();
  await panel.getByLabel('Message assistant').fill('Keep this draft');
  await panel.getByLabel('Attachments', { exact: true }).click();
  let uploads = 0;
  await page.route('**/media/import', async route => { if (++uploads === 2) await route.fulfill({ status: 409, json: { error: { message: 'Library changed. Retry your image.' } } }); else await route.continue(); });
  await panel.getByLabel('Upload chat images').setInputFiles([{ name: 'first.png', mimeType: 'image/png', buffer: png }, { name: 'retry.png', mimeType: 'image/png', buffer: png }]);
  await expect(panel.getByRole('alert')).toContainText('Library changed');
  await expect(panel.getByAltText('Attached media')).toHaveCount(1);
  await expect(panel.getByLabel('Message assistant')).toHaveValue('Keep this draft');
  await expect(panel.getByLabel('Message assistant')).toBeEditable();
  await panel.getByLabel('Message assistant').evaluate((node, bytes) => {
    const clipboardData = new DataTransfer(); clipboardData.items.add(new File([new Uint8Array(bytes)], 'pasted.png', { type: 'image/png' }));
    node.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
  }, [...png]);
  await expect.poll(() => uploads).toBe(3);
  await expect(panel.getByAltText('Attached media')).toHaveCount(2);
  await expect(panel.getByRole('alert')).toHaveCount(0);
  expect((await engine.assets.list(project.id)).assets).toHaveLength(2); expect(calls).toBe(0);
});

test('does not attach a late image upload to another project', async ({ page }) => {
  const first = await engine.projects.create({ name: 'Upload Origin', slug: 'upload-origin' });
  const second = await engine.projects.create({ name: 'Upload Destination', slug: 'upload-destination' });
  await engine.mediaJobs.configureProvider({ action: 'replace', key: secret, expectedRevision: engine.mediaJobs.providerStatus().revision });
  const png = await sharp({ create: { width: 16, height: 16, channels: 4, background: '#ffffff' } }).png().toBuffer();
  await page.goto(studio.launchUrl); await selectProject(page, first.id);
  await page.getByRole('button', { name: 'Assistant', exact: true }).click();
  const panel = page.getByRole('dialog', { name: 'Assistant', exact: true });
  await expect(panel.getByLabel('Message assistant')).toBeEditable();
  await panel.getByLabel('Attachments', { exact: true }).click();
  let release!: () => void, arrived!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { arrived = resolve; });
  await page.route('**/media/import', async route => { const response = await route.fetch(); arrived(); await waiting; await route.fulfill({ response }); });
  try {
    await panel.getByLabel('Upload chat images').setInputFiles({ name: 'origin.png', mimeType: 'image/png', buffer: png });
    await started;
    await selectProject(page, second.id);
    await expect(panel).toContainText('Upload Destination');
  } finally { release(); }
  await expect(panel.getByLabel('Message assistant')).toBeEditable();
  await expect(panel.getByAltText('Attached media')).toHaveCount(0);
  expect((await engine.assets.list(first.id)).assets).toHaveLength(1);
  expect((await engine.assets.list(second.id)).assets).toHaveLength(0); expect(calls).toBe(0);
});

test('a fresh workspace offers app creation without suggesting a screen or project to repair', async ({ page }, info) => {
  await engine.mediaJobs.configureProvider({ action: 'replace', key: secret, expectedRevision: engine.mediaJobs.providerStatus().revision });
  await page.goto(studio.launchUrl);
  await page.getByRole('button', { name: 'Assistant', exact: true }).click();
  const panel = page.getByRole('dialog', { name: 'Assistant', exact: true });
  const start = panel.getByRole('button', { name: /Build something new/ });
  await expect(start).toBeVisible();
  await expect(panel.getByRole('button', { name: /Refine this screen|Find and fix an issue/ })).toHaveCount(0);
  for (const [width, height] of [[1440, 1000], [375, 812], [430, 932]] as const) {
    await page.setViewportSize({ width, height });
    await expect(start).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: info.outputPath(`new-workspace-assistant-${width}.png`) });
  }
  await start.click();
  await expect(panel.getByLabel('Message assistant')).toHaveValue(/Help me plan a new mobile app/);
  await expect(panel.getByLabel('Message assistant')).toBeFocused();
  expect(calls).toBe(0);
  await panel.getByRole('button', { name: 'Close assistant' }).click();
  await engine.projects.create({ name: 'Existing app', slug: 'existing-app' });
  await expect(page.getByRole('combobox', { name: 'Project', exact: true })).toHaveText('Existing app');
  await page.getByRole('button', { name: 'Assistant', exact: true }).click();
  await expect(panel.getByRole('button', { name: /Refine this screen/ })).toBeVisible();
  await expect(panel.getByRole('button', { name: /Find and fix an issue/ })).toBeVisible();
  expect(calls).toBe(0);
});


test('remembered creative work survives a fresh renderer and stays in its project', async ({ page }) => {
  const project = await engine.projects.create({ name: 'Creative Memory', slug: 'creative-memory' });
  const other = await engine.projects.create({ name: 'Other Memory', slug: 'other-memory' });
  const drafts = new AssistantDrafts(engine.projects.home, assistant.epoch, () => engine.account.context());
  const scope = { projectId: project.id, conversationId: null }, snapshot = drafts.read(scope);
  drafts.configure(scope, { context: snapshot.context, preferenceRevision: snapshot.preferenceRevision, enabled: true });
  await page.goto(studio.launchUrl); await selectProject(page, project.id);
  await page.getByRole('button', { name: 'Assets', exact: true }).click(); await closeMediaDrawer(page);
  await page.getByRole('button', { name: 'Generate', exact: true }).click();
  await page.getByLabel('Image prompt').fill('Anime bonsai under the moon, keep this unfinished artwork.');
  await expect.poll(() => drafts.readWorkspace(project.id).value?.generation?.assets?.prompt).toContain('Anime bonsai');
  await page.goto('about:blank'); await page.goto(studio.issueLaunchUrl());
  await page.getByRole('button', { name: 'Assets', exact: true }).click(); await closeMediaDrawer(page);
  await page.getByRole('button', { name: 'Generate', exact: true }).click();
  await expect(page.getByLabel('Image prompt')).toHaveValue('Anime bonsai under the moon, keep this unfinished artwork.');
  for (const [width, height] of [[375, 812], [430, 932], [1440, 1000]]) {
    await page.setViewportSize({ width: width!, height: height! });
    await page.screenshot({ path: test.info().outputPath(`creative-restored-${width}.png`) });
  }
  await closeMediaDrawer(page); await selectProject(page, other.id);
  await page.getByRole('button', { name: 'Assets', exact: true }).click(); await closeMediaDrawer(page);
  await page.getByRole('button', { name: 'Generate', exact: true }).click();
  await expect(page.getByLabel('Image prompt')).toHaveValue(''); expect(calls).toBe(0);
});

test('Create and build sends the idea once to the newly created app', async ({ page }) => {
  await engine.mediaJobs.configureProvider({ action: 'replace', key: secret, expectedRevision: engine.mediaJobs.providerStatus().revision });
  behavior = async (input, callbacks) => { expect(input.mode).toBe('build'); expect(input.projectId).toBeTruthy(); expect(input.prompt).toContain('A neon astronomy app with a working observation log'); callbacks.text('First version fixture completed.'); };
  await page.goto(studio.launchUrl); await page.getByRole('button', { name: '+ New app' }).click();
  await page.getByLabel('App name', { exact: true }).fill('Star Atlas');
  await page.getByLabel('The idea').fill('A neon astronomy app with a working observation log');
  await expect(page.getByRole('button', { name: 'Create and build', exact: true })).toBeEnabled();
  for (const [width, height] of [[375, 812], [430, 932], [1440, 1000]]) {
    await page.setViewportSize({ width: width!, height: height! });
    await page.screenshot({ path: test.info().outputPath(`create-build-${width}.png`) });
  }
  await page.getByRole('button', { name: 'Create and build', exact: true }).click();
  await expect(page.getByText('First version fixture completed.', { exact: true })).toBeVisible();
  expect(calls).toBe(1);
  await expect(page.getByLabel('Message assistant')).toHaveValue('');
});
