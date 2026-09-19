import { closeMediaDrawer } from './media-workspace-helpers.js';
import { selectProject } from './project-picker.js';
import { test, expect } from '@playwright/test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Engine } from '../../packages/core/src/engine.js';
import { Projects } from '../../packages/core/src/projects.js';
import { startStudio } from '../../packages/cli/src/studio-server.js';

// Deliberately fake credentials; do not retain credential input requests in traces.
test.use({ trace: 'off' });
let dir: string, engine: Engine, studio: Awaited<ReturnType<typeof startStudio>>, calls: number;
const secret = 'fake-session-UNIQUE-privacy-sentinel';
test.beforeEach(async () => {
  test.skip(!!process.env.VISUAL, 'Visual suite only');
  dir = await mkdtemp(path.join(os.tmpdir(), 'studio-settings-')); calls = 0;
  engine = new Engine(await Projects.open(path.join(dir, 'apps'), path.join(dir, 'home')), false, false, undefined, {
    startupKey: 'fake-startup-only', createProvider: () => ({ run: async () => { calls++; return []; } }),
  });
  studio = await startStudio(engine, path.resolve('dist/studio'));
});
test.afterEach(async () => { if (process.env.VISUAL) return; await studio.close(); await engine.close(); await rm(dir, { recursive: true, force: true }); });

test('global session setup clears secrets, never probes, and explicitly disconnects/restores startup configuration', async ({ page }) => {
  const responses: string[] = [], frames: string[] = [], errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => { if (response.url().includes('/api/')) void response.text().then(text => responses.push(text)).catch(() => {}); });
  page.on('websocket', socket => socket.on('framereceived', frame => frames.push(String(frame.payload))));
  await page.goto(studio.launchUrl);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Configured · not verified', exact: true })).toBeVisible();
  expect(await engine.projects.list()).toHaveLength(0);
  const key = page.getByLabel('OpenAI API key', { exact: true });
  await expect(key).toHaveAttribute('type', 'password');
  await key.fill(secret); await page.getByRole('button', { name: 'Cancel key entry' }).click(); await expect(key).toHaveValue('');
  await key.fill(secret); await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click(); await expect(key).toHaveValue('');
  await key.fill(secret); await page.getByRole('button', { name: 'Save for this Dunara session' }).click();
  await expect(key).toHaveValue('');
  await expect.poll(() => engine.mediaJobs.providerStatus().source).toBe('session');
  await expect(page.getByText('Configuration saved. Not verified; no provider request was made.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Disconnect OpenAI' }).click();
  await expect(page.getByRole('heading', { name: 'Not configured', exact: true })).toBeVisible();
  expect(engine.mediaJobs.providerStatus().source).toBe('none');
  await page.getByRole('button', { name: 'Use startup environment key' }).click();
  await expect.poll(() => engine.mediaJobs.providerStatus().source).toBe('environment');
  expect(calls).toBe(0);
  expect(JSON.stringify(await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } })))).not.toContain(secret);
  expect(JSON.stringify(responses)).not.toContain(secret); expect(JSON.stringify(frames)).not.toContain(secret);
  expect(await page.content()).not.toContain(secret); expect(errors).toEqual([]);
  await page.reload(); await expect(page.getByText('Session unavailable', { exact: true })).toBeVisible();
});

test('failed settings submissions clear input with sanitized recovery and no automatic retry', async ({ page }) => {
  await page.goto(studio.launchUrl); await page.getByRole('button', { name: 'Settings', exact: true }).click();
  let attempts = 0;
  await page.route('**/api/settings', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    attempts++; await route.fulfill({ status: 503, contentType: 'text/html', body: `<h1>${secret}</h1>` });
  });
  await page.getByLabel('OpenAI API key', { exact: true }).fill(secret);
  await page.getByRole('button', { name: 'Save for this Dunara session' }).click();
  await expect(page.getByLabel('OpenAI API key', { exact: true })).toHaveValue('');
  await expect(page.locator('.settings-error')).toBeVisible();
  expect(await page.locator('.settings-error').textContent()).not.toMatch(/Unexpected|<h1>|privacy-sentinel/);
  await page.waitForTimeout(4500); expect(attempts).toBe(1); expect(calls).toBe(0);
});

test('creative drafts survive destinations and project switching; provider changes reset paid consent', async ({ page }) => {
  const first = await engine.projects.create({ name: 'First Fixture', slug: 'first-fixture' });
  const second = await engine.projects.create({ name: 'Second Fixture', slug: 'second-fixture' });
  await page.goto(studio.launchUrl); await selectProject(page, first.id);
  await page.getByRole('button', { name: 'Assets', exact: true }).click();
  await page.getByRole('button', { name: 'Art direction', exact: true }).click();
  await page.getByRole('textbox', { name: 'Mood', exact: true }).fill('Keep this unsaved direction');
  await closeMediaDrawer(page);
  for (const name of ['App Icons', 'Activity', 'Settings', 'Assets']) await page.getByRole('button', { name, exact: true }).click();
  await page.getByRole('button', { name: 'Art direction', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Mood', exact: true })).toHaveValue('Keep this unsaved direction');
  await closeMediaDrawer(page);
  await selectProject(page, second.id);
  await page.getByRole('button', { name: 'Assets', exact: true }).click();
  await page.getByRole('button', { name: 'Art direction', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Mood', exact: true })).toHaveValue('');
  await closeMediaDrawer(page);
  await selectProject(page, first.id);
  await page.getByRole('button', { name: 'Art direction', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Mood', exact: true })).toHaveValue('Keep this unsaved direction');
  await closeMediaDrawer(page);
  await page.getByRole('button', { name: 'Generate', exact: true }).click();
  await page.getByLabel('Image prompt', { exact: true }).fill('A fake image request, staged only');
  await page.getByRole('button', { name: 'Stage request for review' }).click();
  await expect.poll(async () => (await engine.mediaJobs.list(first.id)).jobs.length).toBe(1);
  const consent = page.getByRole('checkbox', { name: /I authorize this exact paid request/ });
  await consent.check(); await expect(page.getByRole('button', { name: 'Approve paid request' })).toBeEnabled();
  await closeMediaDrawer(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByLabel('OpenAI API key', { exact: true }).fill(secret);
  await page.getByRole('button', { name: 'Save for this Dunara session' }).click();
  await expect.poll(() => engine.mediaJobs.providerStatus().source).toBe('session');
  await page.getByRole('button', { name: 'Assets', exact: true }).click();
  await page.getByRole('button', { name: 'Activity', exact: true }).click();
  await page.getByRole('button', { name: /^Open request / }).click();
  await expect(consent).not.toBeChecked(); await expect(page.getByRole('button', { name: 'Approve paid request' })).toBeDisabled();
  expect(calls).toBe(0);
  expect(await readFile(path.join(engine.projects.home, 'media-jobs.json'), 'utf8')).not.toContain(secret);
});
