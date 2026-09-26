import { test, expect } from '@playwright/test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Engine } from '../../packages/core/src/engine.js';
import { Projects } from '../../packages/core/src/projects.js';
import { startStudio } from '../../packages/cli/src/studio-server.js';
import { makeLegacyApp } from '../fixtures/legacy-app.js';
import { PlatformStore } from '../../packages/platform/src/store.js';
import { SecretBox } from '../../packages/platform/src/crypto.js';
import type { Preview } from '../../packages/core/src/contracts.js';

let root: string, engine: Engine, studio: Awaited<ReturnType<typeof startStudio>>, projectId: string;
const ref = 'abcdefghijklmnopqrst';
let catalogCount = 1;
let authFields: Record<string, unknown> = {};
let environmentWrites: unknown[] = [];
test.use({ trace: 'off', actionTimeout: 15_000 });
test.beforeEach(async ({ page }) => {
  catalogCount = 1;
  environmentWrites = [];
  authFields = { site_url: 'https://fixture.example', uri_allow_list: '', external_email_enabled: true, mailer_autoconfirm: false, smtp_pass: 'smtp-private-canary' };
  root = await mkdtemp(path.join(os.tmpdir(), 'builder-backend-ui-'));
  engine = new Engine(await Projects.open(path.join(root, 'apps'), path.join(root, 'home')), false, false, undefined, {}, {
    fetch: async (input, init) => {
      const url = String(input);
      if (url.endsWith('/organizations')) return Response.json([{ slug: 'studio-test', name: 'Studio test' }]);
      const project = { id: ref, organization_slug: 'studio-test', name: 'Wellness development', region: 'eu-central-1', status: 'ACTIVE_HEALTHY' };
      if (url.endsWith('/projects')) return Response.json([project, ...Array.from({ length: catalogCount - 1 }, (_, index) => ({ ...project, id: index.toString(36).padStart(20, 'z'), name: 'Same name' }))]);
      if (url.endsWith(`/projects/${ref}`)) return Response.json(project);
      if (url.includes('/health?')) return Response.json([{ name: 'db', status: 'ACTIVE_HEALTHY' }]);
      if (url.includes('/api-keys?')) return Response.json([{ type: 'publishable', api_key: 'sb_publishable_test_only' }]);
      if (url.endsWith('/database/migrations')) return Response.json([]);
      if (url.endsWith('/config/auth')) { if (init?.method === 'PATCH') Object.assign(authFields, JSON.parse(String(init.body))); return Response.json(authFields); }
      if (url.endsWith('/secrets') && init?.method === 'POST') { environmentWrites.push(JSON.parse(String(init.body))); return new Response(null, { status: 201 }); }
      throw new Error('Unexpected fixture provider request');
    },
  });
  projectId = (await engine.projects.create({ name: 'Still Connected', slug: 'still-connected' })).id;
  studio = await startStudio(engine, path.resolve('dist/studio'));
  await page.goto(studio.launchUrl);
});

test('pages discovery, checks access, and switches a linked preview environment', async ({ page }, info) => {
  engine.backends.configure({ token: 'fixture-management-canary' }); catalogCount = 51;
  for (const environment of ['development', 'staging']) {
    const plan = await engine.backends.plan(projectId, { action: 'link', environment, projectRef: ref, organization: 'studio-test' });
    const operation = await engine.backends.submit(projectId, { plan, requestId: randomUUID() });
    await engine.backends.approve(projectId, { operationId: operation.id, planHash: operation.planHash });
    await expect.poll(async () => (await engine.backends.operation(projectId, operation.id)).state).toBe('succeeded');
  }
  await page.getByRole('button', { name: 'Backend', exact: true }).click();
  await page.getByRole('tab', { name: 'Projects', exact: true }).click();
  const configure = page.getByRole('region', { name: 'Configure backend' });
  await page.getByRole('button', { name: 'Load Supabase projects', exact: true }).click();
  await expect(configure).toContainText('50 of 51 projects loaded');
  await expect(page.getByRole('combobox', { name: 'Organization', exact: true })).toHaveValue('');
  await page.getByRole('button', { name: 'Load more projects', exact: true }).click();
  await expect(configure).toContainText('51 of 51 projects loaded');
  await expect(page.getByRole('button', { name: 'Load more projects', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Check Supabase access', exact: true }).click();
  await expect(configure).toContainText('6 access checks passed for development');
  for (const [width, height] of [[375, 812], [430, 932]] as const) {
    await page.setViewportSize({ width, height }); await configure.evaluate(node => node.scrollIntoView({ block: 'start' }));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`backend-access-${width}.png`) });
  }
  await page.getByRole('tab', { name: 'Overview', exact: true }).click();
  const staging = page.locator('.backend-environments > section').filter({ has: page.getByRole('heading', { name: 'staging', exact: true }) });
  const before = await engine.previews.configurationRevision(projectId);
  await staging.getByRole('button', { name: 'Use for preview', exact: true }).click();
  await expect(staging).toContainText('Preview'); expect(engine.previews.status(projectId).status).toBe('stopped');
  expect(await engine.previews.configurationRevision(projectId)).not.toBe(before);
  await page.getByRole('tab', { name: 'Projects', exact: true }).click();
  await expect(configure).not.toContainText('6 access checks passed');
  await expect(page.locator('body')).not.toContainText('canary');
});

test('explains locked encrypted settings and keeps the existing ciphertext', async ({ page }, info) => {
  const store = new PlatformStore(path.join(engine.projects.home, 'platform'), new SecretBox('ad'.repeat(32)));
  try { store.putSecret({ id: 'local-owner', workspaceId: store.identity(), role: 'owner', source: 'local-owner' }, 'supabase-management', 'saved-management-canary'); } finally { store.close(); }
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByRole('region', { name: 'Supabase connection', includeHidden: true });
  await expect(settings).toContainText('Saved connections are locked');
  await expect(settings.getByRole('checkbox', { name: 'Remember with encrypted storage' })).toBeDisabled();
  await expect(settings.getByRole('button', { name: 'Save Supabase connection', exact: true })).toBeDisabled();
  for (const [width, height] of [[375, 812], [430, 932]] as const) {
    await page.setViewportSize({ width, height }); await settings.evaluate(node => node.scrollIntoView({ block: 'start' }));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`backend-encryption-${width}.png`) });
  }
  const oauth = page.getByRole('region', { name: 'Connect Supabase with OAuth' });
  await expect(oauth).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText('saved-management-canary');
});
test.afterEach(async ({ page }) => { await page.close(); await studio?.close(); await engine?.close(); await rm(root, { recursive: true, force: true }); });

test('connects a backend through review and keeps management credentials out of rendered state', async ({ page }, info) => {
  await page.getByRole('button', { name: 'Backend', exact: true }).click();
  await expect(page.getByText('Connect Supabase to get started')).toBeVisible();
  await page.getByRole('tab', { name: 'Settings', exact: true }).click();
  const settings = page.getByRole('region', { name: 'Supabase connection', includeHidden: true });
  await expect(settings.getByLabel('Personal access token', { exact: true })).not.toHaveAttribute('placeholder');
  await settings.getByLabel('Personal access token', { exact: true }).fill('fixture-management-canary');
  await settings.getByRole('button', { name: 'Save Supabase connection' }).click();
  await expect(settings.getByLabel('Personal access token', { exact: true })).toHaveValue('');
  await expect(settings.getByLabel('Personal access token', { exact: true })).toHaveAttribute('placeholder', '••••••••');
  expect(await settings.getByLabel('Personal access token', { exact: true }).evaluate((input: HTMLInputElement) => input.validity.valueMissing)).toBe(true);
  await expect(settings).toContainText('Account saved');
  await page.getByRole('button', { name: 'Backend', exact: true }).click();
  await page.getByRole('button', { name: 'Load Supabase projects' }).click();
  await expect(page.getByRole('combobox', { name: 'Organization', exact: true })).toHaveValue('');
  await page.getByRole('combobox', { name: 'Organization', exact: true }).selectOption('studio-test');
  await page.getByRole('combobox', { name: /^Supabase project/ }).selectOption(ref);
  await page.getByRole('button', { name: 'Prepare for review' }).click();
  await expect(page.getByText('Needs your review', { exact: true })).toBeVisible();
  expect(await engine.backends.binding(projectId)).toBeNull();
  await page.getByRole('button', { name: 'Approve connection', exact: true }).click();
  await expect(page.getByText('Completed', { exact: true })).toBeVisible();
  expect((await engine.backends.binding(projectId))?.projectRef).toBe(ref);
  expect(await page.locator('body').innerText()).not.toContain('fixture-management-canary');
  for (const [width, height] of [[375, 812], [430, 932]] as const) {
    await page.setViewportSize({ width, height });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`backend-${width}.png`), fullPage: true });
  }
});

test('shows a QR code with the current environment and removes it when the preview stops', async ({ page }, info) => {
  let ready = true;
  const sessionId = randomUUID();
  engine.previews.status = id => ready ? { projectId: id, status: 'ready', deviceUrl: 'exp://192.168.1.20:8081', sessionId, transport: 'lan', runtime: 'expo-go', sdkVersion: '57.0.22', environment: 'development', backendUrl: `https://${ref}.supabase.co` } : { projectId: id, status: 'stopped' };
  engine.diagnostics.emit('change', projectId);
  const button = page.getByRole('button', { name: 'Connect a device', exact: true });
  await button.click();
  const dialog = page.getByRole('dialog', { name: 'Connect a device', exact: true });
  await expect(dialog.getByRole('img', { name: 'Scan to open Still Connected in Expo Go' })).toBeVisible();
  const setup = dialog.locator('details.device-preview-account');
  await expect(setup).not.toHaveAttribute('open');
  await page.route('**/expo-account', route => route.fulfill({ json: { state: 'signed-in', message: 'Expo sign-in verified on this computer. Use the same account in Expo Go.' } }));
  await dialog.getByRole('button', { name: 'Check Expo sign-in' }).click();
  await expect(dialog.getByText('Expo sign-in verified on this computer. Use the same account in Expo Go.')).toBeVisible();
  await setup.locator('summary').click();
  await expect(setup.getByRole('heading', { name: 'Expo account' })).toBeVisible();
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await setup.getByRole('button', { name: 'Copy Expo login command' }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('npx expo login --browser');
  for (const [width, height] of [[1440, 1100], [375, 812], [430, 932]] as const) {
    await page.setViewportSize({ width, height });
    await setup.scrollIntoViewIfNeeded();
    expect(await dialog.evaluate(node => node.scrollWidth - node.clientWidth)).toBe(0);
    await page.screenshot({ path: info.outputPath(`expo-login-${width}.png`) });
  }
  await setup.locator('summary').click();
  await dialog.locator('.device-preview-app').scrollIntoViewIfNeeded();
  await expect(dialog).toContainText('development');
  await expect(dialog).toContainText(ref);
  expect(await dialog.getByRole('img').evaluate(node => {
    const canvas = node as HTMLCanvasElement;
    const pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
    return canvas.width === 256 && pixels.filter((value, index) => index % 4 === 0 && value === 0).length > 1000;
  })).toBe(true);
  for (const [width, height] of [[375, 812], [430, 932]] as const) {
    await page.setViewportSize({ width, height });
    await expect(dialog).toBeInViewport({ ratio: 0.99 });
    expect(await dialog.evaluate(node => node.scrollWidth - node.clientWidth)).toBe(0);
    await page.screenshot({ path: info.outputPath(`device-${width}.png`) });
  }
  ready = false; engine.diagnostics.emit('change', projectId);
  await expect(dialog.getByRole('img')).toHaveCount(0);
  await expect(dialog).toContainText('Test on your phone');
  await expect(dialog).not.toContainText('exp://');
  await dialog.press('Escape'); await expect(button).toBeFocused();
});

test('shows LAN discovery failures honestly and lets the user retry or return to this computer', async ({ page }, info) => {
  const publish = (state: Preview) => (engine.previews as unknown as { update(state: Preview): Preview }).update(state);
  const sessionId = randomUUID();
  publish({ projectId, status: 'ready', transport: 'lan', sessionId, deviceIssue: 'Expo has not reported a private LAN address. Check your network connection and restart the preview.' });
  const requests: unknown[] = [];
  engine.previews.setTransport = async (id, input) => {
    requests.push(input);
    const transport = (input as { transport: 'lan' | 'localhost' }).transport;
    publish({ projectId: id, status: 'starting', transport, sessionId: randomUUID() });
    return publish({ projectId: id, status: 'ready', transport, sessionId: randomUUID(), ...(transport === 'lan' ? { deviceUrl: 'exp://192.168.1.20:8081' } : {}) });
  };
  await page.getByRole('button', { name: 'Connect a device', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Connect a device', exact: true });
  await expect(dialog.locator('.device-preview-details')).toContainText('Local network · waiting for address');
  await expect(dialog.getByRole('button', { name: 'Use this computer only', exact: true })).toBeVisible();
  for (const [width, height] of [[1440, 1100], [375, 812], [430, 932]] as const) {
    await page.setViewportSize({ width, height });
    await dialog.locator('.device-preview-app').scrollIntoViewIfNeeded();
    expect(await dialog.evaluate(node => node.scrollWidth - node.clientWidth)).toBe(0);
    await page.screenshot({ path: info.outputPath(`phone-retry-${width}.png`) });
  }
  await dialog.getByRole('button', { name: 'Retry phone preview', exact: true }).click();
  await expect(dialog.getByRole('img')).toBeVisible();
  expect(requests[0]).toEqual({ transport: 'lan', expectedSessionId: sessionId });
  await expect(dialog).not.toContainText('waiting for address');
  for (const [width, height] of [[1440, 1100], [375, 812], [430, 932]] as const) {
    await page.setViewportSize({ width, height });
    await dialog.locator('.device-preview-app').scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`phone-ready-${width}.png`) });
  }
  await dialog.getByRole('button', { name: 'Use this computer only', exact: true }).click();
  await expect(dialog.getByRole('img')).toHaveCount(0);
  await expect(dialog.locator('.device-preview-details')).toContainText('This computer');
  await expect(dialog.getByRole('button', { name: 'Start phone preview', exact: true })).toBeVisible();
});

test('starts phone sharing from Studio and records session-scoped iPhone and Android observations', async ({ page }, info) => {
  // Simulate only Expo startup. The authenticated transport and phone-test routes remain real.
  const publish = (state: Preview) => (engine.previews as unknown as { update(state: Preview): Preview }).update(state);
  const requests: unknown[] = [];
  engine.previews.setTransport = async (id, input) => {
    requests.push(input);
    const transport = (input as { transport: 'lan' | 'localhost' }).transport;
    return publish({ projectId: id, status: 'ready', transport, sessionId: randomUUID(), configurationRevision: await engine.previews.configurationRevision(id), ...(transport === 'lan' ? { deviceUrl: 'exp://192.168.1.20:8081' } : {}) });
  };
  await page.getByRole('button', { name: 'Connect a device', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Connect a device', exact: true });
  await expect(dialog.getByRole('button', { name: 'Start phone preview', exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Start phone preview', exact: true }).click();
  await expect.poll(() => requests).toEqual([{ transport: 'lan', expectedSessionId: null }]);
  await expect(dialog.getByRole('img')).toBeVisible();
  await expect(dialog.getByLabel('A saved code change appeared', { exact: true })).toBeDisabled();
  await dialog.getByLabel('App opened on my phone', { exact: true }).check();
  await expect(dialog.getByLabel('A saved code change appeared', { exact: true })).toBeEnabled();
  await dialog.getByLabel('A saved code change appeared', { exact: true }).check();
  await expect.poll(() => engine.previews.status(projectId).phoneTests?.[0]?.checks).toEqual(['opened', 'live_refresh']);
  await dialog.getByLabel('Test device', { exact: true }).selectOption('android');
  await expect(dialog.getByLabel('App opened on my phone', { exact: true })).not.toBeChecked();
  await dialog.getByLabel('App opened on my phone', { exact: true }).check();
  await expect.poll(() => engine.previews.status(projectId).phoneTests?.length).toBe(2);
  expect((await engine.inspect(projectId)).preview.phoneTests?.every(item => item.evidence === 'user_reported')).toBe(true);
  for (const [width, height] of [[375, 812], [430, 932]] as const) {
    await page.setViewportSize({ width, height });
    await dialog.locator('.device-phone-tests').evaluate(node => node.scrollIntoView({ block: 'start' }));
    expect(await dialog.evaluate(node => node.scrollWidth - node.clientWidth)).toBe(0);
    await page.screenshot({ path: info.outputPath(`phone-checklist-${width}.png`) });
    await dialog.locator('.device-preview-app').scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`phone-connect-${width}.png`) });
  }
  const sessionId = engine.previews.status(projectId).sessionId;
  await dialog.getByRole('button', { name: 'Use this computer only', exact: true }).click();
  await expect(dialog.getByRole('img')).toHaveCount(0);
  expect(requests.at(-1)).toEqual({ transport: 'localhost', expectedSessionId: sessionId });
  expect(engine.previews.status(projectId).phoneTests).toBeUndefined();
});

test('adds a private Supabase environment variable and publishes only after the exact review is approved', async ({ page }, info) => {
  engine.backends.configure({ token: 'fixture-management-canary' });
  const plan = await engine.backends.plan(projectId, { action: 'link', environment: 'development', projectRef: ref, organization: 'studio-test' });
  const linked = await engine.backends.submit(projectId, { plan, requestId: randomUUID() });
  await engine.backends.approve(projectId, { operationId: linked.id, planHash: linked.planHash });
  await expect.poll(async () => (await engine.backends.operation(projectId, linked.id)).state).toBe('succeeded');
  await page.getByRole('button', { name: 'Backend', exact: true }).click();
  await page.getByRole('tab', { name: 'Variables', exact: true }).click();
  const variables = page.getByRole('region', { name: 'Supabase environment variables', exact: true });
  await variables.getByLabel('Variable name', { exact: true }).fill('PAYMENTS_API_KEY');
  await variables.getByRole('button', { name: 'Add variable', exact: true }).click();
  await expect(variables.getByRole('heading', { name: 'PAYMENTS_API_KEY', exact: true })).toBeVisible();
  await expect(variables.getByRole('button', { name: 'Review variable changes', exact: true })).toBeDisabled();
  await variables.getByLabel('Private value', { exact: true }).fill('private-ui-environment-canary');
  await variables.getByRole('button', { name: 'Save private input', exact: true }).click();
  await expect(variables.getByLabel('Replace value', { exact: true })).toHaveValue('');
  for (const [width, height] of [[375, 812], [430, 932]] as const) {
    await page.setViewportSize({ width, height });
    await variables.evaluate(node => node.scrollIntoView({ block: 'start' }));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`environment-setup-${width}.png`) });
    await variables.getByRole('button', { name: 'Review variable changes', exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`environment-input-${width}.png`) });
  }
  await variables.getByRole('button', { name: 'Review variable changes', exact: true }).click();
  const review = page.locator('.backend-operation').filter({ has: page.getByRole('heading', { name: 'Configure app services' }) });
  await expect(review.getByRole('heading', { name: 'Edge Function environment variables', exact: true })).toBeVisible();
  expect(environmentWrites).toEqual([]);
  await expect(page.locator('body')).not.toContainText('private-ui-environment-canary');
  await review.getByRole('button', { name: 'Approve configuration on development' }).click();
  await expect(review.getByText('Completed', { exact: true })).toBeVisible();
  expect(environmentWrites).toEqual([[{ name: 'PAYMENTS_API_KEY', value: 'private-ui-environment-canary' }]]);
  expect(authFields.site_url).toBe('https://fixture.example');
  expect((await engine.files.read(projectId, 'backend/configuration.json')).content).not.toContain('canary');
});

test('reviews a legacy app upgrade, refuses stale edits, and applies the exact files without a provider connection', async ({ page }, info) => {
  const project = await engine.projects.get(projectId); await makeLegacyApp(project.root);
  const manifestPath = path.join(project.root, 'package.json'), original = await readFile(manifestPath, 'utf8');
  const navigation = await readFile(path.join(project.root, 'src/ui/index.tsx'), 'utf8');
  await page.getByRole('button', { name: 'Backend', exact: true }).click();
  await page.getByRole('tab', { name: 'Settings', exact: true }).click();
  await page.getByText('Advanced app setup', { exact: true }).click();
  const panel = page.getByRole('region', { name: 'App backend support' });
  await panel.getByRole('button', { name: 'Review upgrade', exact: true }).click();
  await expect(panel).toContainText('supabase-notes-v1'); await expect(panel).toContainText('12 file changes');
  const manifest = panel.locator('.recipe-files > details').filter({ has: page.locator('summary', { hasText: 'Update package.json' }) });
  await manifest.locator(':scope > summary').click();
  await manifest.getByText('After', { exact: true }).click();
  await expect(manifest.locator('pre').last()).toContainText('"@supabase/supabase-js": "2.116.0"');
  const lock = panel.locator('.recipe-files > details').filter({ has: page.locator('summary', { hasText: 'Update package-lock.json' }) });
  await lock.locator(':scope > summary').click(); await lock.getByText('After', { exact: true }).click();
  await expect(lock.locator('pre').last()).toContainText('node_modules/expo-secure-store');
  await lock.locator(':scope > summary').click(); await manifest.locator(':scope > summary').click();
  expect(await readFile(manifestPath, 'utf8')).toBe(original);
  for (const [width, height] of [[375, 812], [430, 932]] as const) {
    await page.setViewportSize({ width, height }); await panel.evaluate(node => node.scrollIntoView({ block: 'start' }));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`upgrade-review-${width}.png`) });
    const approve = panel.getByRole('button', { name: 'Approve app upgrade', exact: true });
    await approve.scrollIntoViewIfNeeded(); await expect(approve).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: info.outputPath(`upgrade-review-actions-${width}.png`) });
  }
  const collision = path.join(project.root, 'app/account.js'); await writeFile(collision, '// Concurrent editor');
  await panel.getByRole('button', { name: 'Approve app upgrade', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('changed');
  expect(await readFile(manifestPath, 'utf8')).toBe(original);
  await panel.getByRole('button', { name: 'Review upgrade', exact: true }).click();
  await expect(panel).toContainText('Manual merge needed'); await expect(panel.getByRole('button', { name: 'Approve app upgrade' })).toHaveCount(0);
  for (const [width, height] of [[375, 812], [430, 932]] as const) {
    await page.setViewportSize({ width, height }); await panel.evaluate(node => node.scrollIntoView({ block: 'start' })); await page.screenshot({ path: info.outputPath(`upgrade-conflict-${width}.png`) });
  }
  await rm(collision); await panel.getByRole('button', { name: 'Refresh review', exact: true }).click();
  await panel.getByRole('button', { name: 'Approve app upgrade', exact: true }).click();
  await expect(panel.getByRole('status')).toContainText('Backend support added');
  expect(JSON.parse(await readFile(manifestPath, 'utf8')).dependencies['@supabase/supabase-js']).toBe('2.116.0');
  expect(await readFile(path.join(project.root, 'src/ui/index.tsx'), 'utf8')).toBe(navigation);
  expect(engine.backends.status().configured).toBe(false);
  for (const [width, height] of [[375, 812], [430, 932]] as const) {
    await page.setViewportSize({ width, height }); await panel.evaluate(node => node.scrollIntoView({ block: 'start' })); await page.screenshot({ path: info.outputPath(`upgrade-complete-${width}.png`) });
  }
});

test('collects private SMTP input, reviews exact Auth changes, verifies readback and displays backend activity', async ({ page }, info) => {
  engine.backends.configure({ token: 'fixture-management-canary' });
  const linked = await engine.backends.plan(projectId, { action: 'link', environment: 'development', projectRef: ref, organization: 'studio-test' });
  const operation = await engine.backends.submit(projectId, { plan: linked, requestId: randomUUID() });
  await engine.backends.approve(projectId, { operationId: operation.id, planHash: operation.planHash });
  await expect.poll(async () => (await engine.backends.operation(projectId, operation.id)).state).toBe('succeeded');
  const source = await engine.files.read(projectId, 'backend/configuration.json');
  await engine.files.write(projectId, [{ path: source.path, expectedRevision: source.revision, content: JSON.stringify({ version: 1, auth: { settings: { site_url: 'https://new.example', external_email_enabled: true }, secrets: [{ field: 'smtp_pass', secret: 'mail_password' }] }, requirements: [{ name: 'mail_password', purpose: 'smtp', label: 'SMTP password' }] }) }]);
  await page.getByRole('button', { name: 'Backend', exact: true }).click();
  await page.getByRole('tab', { name: 'Services', exact: true }).click();
  const services = page.getByRole('region', { name: 'App services configuration' });
  await services.getByRole('button', { name: 'Check required inputs', exact: true }).click();
  await expect(services.getByText('Input required', { exact: false })).toBeVisible();
  for (const [width, height] of [[375, 812], [430, 932]] as const) {
    await page.setViewportSize({ width, height }); await services.locator('.backend-private-input').scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`backend-private-input-${width}.png`) });
  }
  await services.getByLabel('Private value', { exact: true }).fill('private-smtp-input-canary');
  await services.getByRole('button', { name: 'Save private input', exact: true }).click();
  await expect(services).toContainText('Available · this session');
  await expect(services.getByLabel('Replace value', { exact: true })).toHaveValue('');
  await services.getByRole('button', { name: 'Review service changes', exact: true }).click();
  const review = page.locator('.backend-operation').filter({ has: page.getByRole('heading', { name: 'Configure app services' }) });
  await expect(review).toContainText('https://new.example');
  await expect(review).toContainText('https://fixture.example');
  await expect(page.locator('body')).not.toContainText('private-smtp-input-canary');
  for (const [width, height] of [[375, 812], [430, 932]] as const) {
    await page.setViewportSize({ width, height }); await review.evaluate(node => node.scrollIntoView({ block: 'start' }));
    await page.screenshot({ path: info.outputPath(`backend-config-review-${width}.png`) });
    await review.getByRole('button', { name: 'Approve configuration on development' }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`backend-config-actions-${width}.png`) });
  }
  expect(authFields.site_url).toBe('https://fixture.example');
  await review.getByRole('button', { name: 'Approve configuration on development' }).click();
  await expect(review.getByText('Completed', { exact: true })).toBeVisible();
  expect(authFields.site_url).toBe('https://new.example'); expect(authFields.smtp_pass).toBe('private-smtp-input-canary');
  await page.getByRole('tab', { name: 'Services', exact: true }).click();
  await services.getByRole('button', { name: 'Validate configuration', exact: true }).click();
  await expect(services).toContainText('Validation · pass');
  await expect(services).toContainText('email delivery: not run');
  for (const [width, height] of [[375, 812], [430, 932]] as const) {
    await page.setViewportSize({ width, height }); await services.locator('.backend-validation').evaluate(node => node.scrollIntoView({ block: 'start' }));
    await page.screenshot({ path: info.outputPath(`backend-validation-${width}.png`) });
  }
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.getByRole('button', { name: 'Activity', exact: true }).click();
  await page.getByRole('group', { name: 'Activity categories' }).getByRole('button', { name: 'Backend', exact: true }).click();
  const activity = page.getByRole('region', { name: 'Backend activity', exact: true });
  await expect(activity).toContainText('development · succeeded'); await expect(activity).toContainText('auth.receipt · completed');
  for (const [width, height] of [[375, 812], [430, 932]] as const) {
    await page.setViewportSize({ width, height });
    await activity.getByRole('heading', { name: 'Backend setup' }).scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`backend-activity-${width}.png`) });
  }
  await activity.getByRole('button', { name: 'Open Backend reviews' }).click();
  await expect(page.getByRole('tab', { name: 'Reviews', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('region', { name: 'Backend operations' })).toBeVisible();
});

test('guides creation stages and connects Supabase inline before an explicit project review', async ({ page }, info) => {
  const guide = page.getByRole('dialog', { name: 'Your app journey', exact: true });
  await expect.poll(() => page.getByAltText('Dunara', { exact: true }).evaluate(node => (node as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  await page.locator('.creation-guide-trigger').click();
  await expect(page.locator('.creation-guide')).toContainText('Next: Ideate');
  await guide.getByRole('button', { name: 'Save & continue', exact: true }).click();
  await expect(page.locator('.creation-guide')).toContainText('Next: Connect Supabase');
  await guide.getByRole('button', { name: /Add assets/ }).click();
  await guide.getByRole('button', { name: 'Do this later', exact: true }).click();
  for (const [width, height] of [[1440, 1000], [375, 812], [430, 932]] as const) {
    await page.setViewportSize({ width, height }); await guide.scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`creation-guide-${width}.png`) });
  }
  await guide.getByRole('button', { name: 'Set up Supabase', exact: true }).click();
  const setup = page.getByRole('region', { name: 'Supabase setup guide', exact: true });
  await expect(setup).toContainText('STEP 1 OF 3');
  await expect(guide).toHaveCount(0);
  for (const [width, height] of [[1440, 1000], [375, 812], [430, 932]] as const) {
    await page.setViewportSize({ width, height }); await setup.evaluate(node => node.scrollIntoView({ block: 'start' }));
    await page.screenshot({ path: info.outputPath(`supabase-guide-${width}.png`) });
  }
  await setup.getByRole('button', { name: 'Connect Supabase account', exact: true }).click();
  const connection = page.getByRole('region', { name: 'Supabase connection', exact: true });
  await expect(connection.getByLabel('Personal access token', { exact: true })).toBeEnabled();
  for (const [width, height] of [[1440, 1000], [375, 812], [430, 932]] as const) {
    await page.setViewportSize({ width, height }); await connection.evaluate(node => node.scrollIntoView({ block: 'start' }));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`supabase-connect-${width}.png`) });
  }
  await connection.getByLabel('Personal access token', { exact: true }).fill('fixture-guided-management-token');
  await connection.getByRole('button', { name: 'Save Supabase connection', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Projects', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('combobox', { name: 'Organization', exact: true }).locator('option')).toHaveCount(2);
  await page.getByRole('combobox', { name: 'Organization', exact: true }).selectOption('studio-test');
  await page.getByRole('combobox', { name: 'Supabase project', exact: true }).selectOption(ref);
  await page.getByRole('button', { name: 'Prepare for review', exact: true }).click();
  expect((await engine.backends.inspect(projectId)).environments).toHaveLength(0);
  await page.getByRole('button', { name: 'Approve connection', exact: true }).click();
  await page.getByRole('tab', { name: 'Overview', exact: true }).click();
  await expect(setup).toContainText('PROJECT CONNECTED');
  await expect(page.locator('.creation-guide')).toContainText('Next: Preview & test');
  expect(await page.content()).not.toContain('fixture-guided-management-token');
  await page.goto(studio.issueLaunchUrl());
  await expect(page.locator('.creation-guide')).toContainText('Next: Preview & test');
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await page.locator('.creation-guide-trigger').click();
  await expect(guide.getByRole('button', { name: 'I’ve tested my app', exact: true })).toBeDisabled();
});
