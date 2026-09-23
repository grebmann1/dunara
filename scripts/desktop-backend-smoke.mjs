import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import electronPath from 'electron';
import { _electron as electron } from 'playwright';
import { expect } from '@playwright/test';
import { desktopEnvironment } from '../dist/packages/desktop/src/security.js';
import { PlatformStore } from '../dist/packages/platform/src/store.js';
import { SecretBox } from '../dist/packages/platform/src/crypto.js';

// Isolated Electron acceptance for service configuration, encrypted persistence and detached diagnostics.
if (process.platform !== 'darwin') throw new Error('Desktop backend smoke is macOS-only');
const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'builder-desktop-backend-')));
const envFile = path.join(root, '.env'), home = path.join(root, 'home');
const encryption = 'ad'.repeat(32), management = 'desktop-fixture-private-token', accountKey = 'sb_publishable_desktop_fixture';
await writeFile(envFile, `BUILDER_BACKEND_ENCRYPTION_KEY=${'cd'.repeat(32)}\nBUILDER_ACCOUNT_SUPABASE_URL=https://account.example.invalid\nBUILDER_ACCOUNT_PUBLISHABLE_KEY=${accountKey}\nNODE_OPTIONS=--import=invalid-file\nNODE_TLS_REJECT_UNAUTHORIZED=0\n`, { mode: 0o600 });
let app;
const launch = () => electron.launch({ executablePath: electronPath, args: [path.resolve('dist/packages/desktop/src/main.js'), '--node', process.execPath, '--workspace', path.join(root, 'apps'), '--home', home, '--user-data', path.join(root, 'chromium'), '--builder-env-file', envFile], env: { ...desktopEnvironment(process.env), BUILDER_BACKEND_ENCRYPTION_KEY: encryption }, chromiumSandbox: true, timeout: 30_000 });
try {
  app = await launch();
  const page = await app.firstWindow(), errors = [];
  page.on('pageerror', () => errors.push('renderer error'));
  await page.getByRole('heading', { name: 'Create your first app', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => typeof process !== 'undefined' || typeof require !== 'undefined'), false);
  assert.equal(await app.evaluate(() => ['OPENAI_API_KEY', 'BUILDER_ASSISTANT_API_KEY', 'BUILDER_BACKEND_ENCRYPTION_KEY', 'BUILDER_ACCOUNT_SUPABASE_URL', 'BUILDER_ACCOUNT_PUBLISHABLE_KEY'].every(name => process.env[name] === undefined)), true);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByRole('region', { name: 'Supabase connection' });
  await expect(page.getByRole('region', { name: 'Dunara account' }).getByLabel('Email', { exact: true })).toBeEnabled();
  await expect(settings.getByRole('checkbox', { name: 'Remember with encrypted storage' })).toBeEnabled();
  await settings.getByLabel('Personal access token', { exact: true }).fill(management);
  await settings.getByRole('checkbox', { name: 'Remember with encrypted storage' }).check();
  await settings.getByRole('button', { name: 'Save Supabase connection', exact: true }).click();
  await expect(settings).toContainText('saved connection');
  await expect(settings.getByLabel('Personal access token', { exact: true })).toHaveValue('');
  for (const value of [encryption, management, accountKey]) await expect(page.locator('body')).not.toContainText(value);
  const origin = new URL(page.url()).origin;
  const sidebar = page.getByRole('separator', { name: 'Sidebar width', exact: true });
  await sidebar.focus(); await sidebar.press('End');
  await expect(sidebar).toHaveAttribute('aria-valuenow', '360');
  await page.evaluate(() => { globalThis.document.documentElement.dataset.restartCheck = 'old-document'; });
  await app.evaluate(({ dialog, Menu }) => {
    // Test-only native dialog answers; no real user settings or provider resources are involved.
    globalThis.backendSmokeErrors = [];
    dialog.showErrorBox = () => globalThis.backendSmokeErrors.push('error dialog');
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
    process.stderr.destroy(Object.assign(new Error('Detached fixture pipe'), { code: 'EPIPE' }));
    Menu.getApplicationMenu().items.find(item => item.label === 'Studio').submenu.items.find(item => item.label === 'Restart backend…').click();
  });
  await expect(page.locator('html')).not.toHaveAttribute('data-restart-check', 'old-document', { timeout: 30_000 });
  await page.getByRole('button', { name: 'Settings', exact: true }).waitFor();
  assert.equal(new URL(page.url()).origin, origin);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(settings).toContainText('saved connection');
  await expect(page.getByRole('region', { name: 'Dunara account' }).getByLabel('Email', { exact: true })).toBeEnabled();
  assert.deepEqual(await app.evaluate(() => globalThis.backendSmokeErrors), []); assert.deepEqual(errors, []);
  await app.close(); app = await launch();
  const reopened = await app.firstWindow();
  await reopened.getByRole('button', { name: 'Settings', exact: true }).click();
  assert.equal(new URL(reopened.url()).origin, origin);
  await expect(reopened.getByRole('separator', { name: 'Sidebar width', exact: true })).toHaveAttribute('aria-valuenow', '360');
  await expect(reopened.getByRole('region', { name: 'Supabase connection' })).toContainText('saved connection');
  await app.close(); app = undefined;
  const store = new PlatformStore(path.join(home, 'platform'), new SecretBox(encryption));
  try { assert.equal(store.getSecret({ id: 'local-owner', workspaceId: store.identity(), role: 'owner', source: 'local-owner' }, 'supabase-management'), management); }
  finally { store.close(); }
  console.log('PASS: actual Electron service settings, environment-over-file precedence, encrypted restart persistence, remembered origin/layout after full quit and relaunch, renderer isolation and simulated EPIPE recovery. No provider calls or user-app changes.');
} finally { await app?.close(); await rm(root, { recursive: true, force: true }); }
