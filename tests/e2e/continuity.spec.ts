import { test, expect } from '@playwright/test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Engine } from '../../packages/core/src/engine.js';
import { Projects } from '../../packages/core/src/projects.js';
import { startStudio } from '../../packages/cli/src/studio-server.js';
import { AssistantService } from '../../packages/assistant/src/service.js';
import { AccountProvider } from '../../packages/platform/src/accounts.js';

test.use({ trace: 'off' });
const protection = { kind: 'configured' as const, key: 'c'.repeat(64) };
let root: string, engine: Engine, assistant: AssistantService, studio: Awaited<ReturnType<typeof startStudio>>, calls: number;
const user = { id: randomUUID(), email: 'fixture@example.test' }, workspace = randomUUID();
const provider = () => new AccountProvider({ url: 'https://accounts.example.test', publishableKey: 'sb_publishable_fixture_account', allowLocal: false }, async url => {
  if (String(url).includes('/auth/v1/verify') || String(url).includes('/auth/v1/token?')) return Response.json({ access_token: 'account-private-access-canary', refresh_token: 'account-private-refresh-canary', expires_in: 3600, user });
  if (String(url).includes('ensure_personal_workspace')) return Response.json(workspace);
  if (String(url).includes('/workspaces?')) return Response.json([]);
  return Response.json({});
});
async function start() {
  const home = path.join(root, 'home');
  engine = new Engine(await Projects.open(path.join(root, 'apps'), home), false, false, undefined, { startupKey: 'offline-provider-canary' }, {}, provider(), { encryptionKey: protection.key });
  assistant = new AssistantService({ home, secretProtection: protection, createHarness: () => ({ async run(_input, callbacks) { calls++; callbacks.text('Explicitly sent fixture message.'); }, async close() {} }), createGateway: async () => ({ tools: [], async call() { return { content: [] }; }, async close() {} }) });
  studio = await startStudio(engine, path.resolve('dist/studio'), assistant);
}
async function stop() { await assistant.close(); await studio.close(); await engine.close(); }
test.beforeEach(async () => { test.skip(!!process.env.VISUAL); root = await mkdtemp(path.join(os.tmpdir(), 'continuity-browser-')); calls = 0; await start(); });
test.afterEach(async ({ page }) => { if (process.env.VISUAL) return; await page.close(); await stop(); await rm(root, { recursive: true, force: true }); });
for (const [width, height] of [[375, 812], [430, 932]] as const) {
  test(`opted-in drafts survive restart without sending at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.goto(studio.launchUrl);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByText('Privacy & storage', { exact: true }).click();
    const remember = page.getByLabel('Remember drafts on this computer');
    await expect(remember).toBeEnabled();
    await remember.click();
    await expect(remember).toBeChecked();
    await page.getByRole('button', { name: 'Assistant', exact: true }).click();
    const panel = page.getByRole('dialog', { name: 'Assistant', exact: true });
    await expect(panel.getByRole('textbox', { name: 'Message assistant' })).toBeEditable();
    await panel.getByRole('combobox', { name: 'Assistant mode' }).selectOption('plan');
    await panel.getByRole('textbox', { name: 'Message assistant' }).fill('Keep this unsent fixture idea after restart.');
    await expect.poll(async () => JSON.parse(await readFile(path.join(root, 'home/credentials/assistant-drafts.json'), 'utf8')).rows[0]?.value.text).toBe('Keep this unsent fixture idea after restart.');
    await page.goto('about:blank'); await stop(); await start();
    await page.goto(studio.launchUrl); await page.getByRole('button', { name: 'Assistant', exact: true }).click();
    await expect(panel.getByRole('textbox', { name: 'Message assistant' })).toHaveValue('Keep this unsent fixture idea after restart.');
    await expect(panel.getByRole('combobox', { name: 'Assistant mode' })).toHaveValue('plan'); expect(calls).toBe(0);
    await panel.getByRole('button', { name: 'Close assistant', exact: true }).click();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page.getByLabel('Remember drafts on this computer')).toBeChecked();
    await page.getByRole('button', { name: 'Assistant', exact: true }).click();
    await mkdir('.builder/continuity-review', { recursive: true });
    await page.screenshot({ path: `.builder/continuity-review/draft-${width}.png` });
    await panel.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(panel.getByText('Explicitly sent fixture message.', { exact: true })).toBeVisible(); expect(calls).toBe(1);
    await expect(panel.getByRole('textbox', { name: 'Message assistant' })).toHaveValue('');
    await expect.poll(async () => JSON.parse(await readFile(path.join(root, 'home/credentials/assistant-drafts.json'), 'utf8')).rows.every((row: { value: { text: string } }) => !row.value.text)).toBe(true);
    await page.goto('about:blank'); await stop(); await start();
    await page.goto(studio.launchUrl); await page.getByRole('button', { name: 'Assistant', exact: true }).click();
    await expect(panel.getByRole('textbox', { name: 'Message assistant' })).toHaveValue(''); expect(calls).toBe(1);
  });
  test(`remembered account restores privately and sign-out forgets it at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height }); await page.goto(studio.launchUrl);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const account = page.getByRole('region', { name: 'Dunara account' });
    await account.getByLabel('Email', { exact: true }).fill(user.email); await account.getByRole('button', { name: 'Send sign-in code' }).click();
    await account.getByLabel('Email code').fill('123456'); await account.getByLabel('Remember my Dunara account on this computer').check();
    await account.getByRole('button', { name: 'Sign in to Dunara' }).click();
    await expect(account.getByText(user.email, { exact: true })).toBeVisible();
    await page.goto('about:blank'); await stop(); await start();
    await page.goto(studio.launchUrl); await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(account.getByText(user.email, { exact: true })).toBeVisible(); expect(engine.account.status().lifetime).toBe('remembered');
    expect(await page.content()).not.toContain('account-private');
    expect(await readFile(path.join(root, 'home/credentials/builder-account.json'), 'utf8')).not.toContain('account-private');
    await account.scrollIntoViewIfNeeded(); await mkdir('.builder/continuity-review', { recursive: true });
    await page.screenshot({ path: `.builder/continuity-review/account-${width}.png` });
    await page.getByRole('region', { name: 'OpenAI configuration' }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: `.builder/continuity-review/openai-${width}.png` });
    await account.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(account.getByRole('button', { name: 'Send sign-in code' })).toBeVisible();
    await page.goto('about:blank'); await stop(); await start(); expect(engine.account.status().signedIn).toBe(false);
  });
}
