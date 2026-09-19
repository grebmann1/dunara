import { test, expect } from '@playwright/test';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { Processes, freePort } from '../../packages/core/src/processes.js';
import { templateRoot } from '../../packages/core/src/projects.js';

const processes = new Processes();
let origin: string, fixtureRoot: string;
const backend = 'https://abcdefghijklmnopqrst.supabase.co';
test.use({ trace: 'off', actionTimeout: 20_000 });
test.beforeAll(async () => {
  test.setTimeout(240_000);
  fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'builder-services-browser-'));
  await cp(templateRoot, fixtureRoot, { recursive: true, filter: source => !['node_modules', '.expo', 'dist'].includes(path.basename(source)) });
  // A fresh OSS checkout has no dependencies installed inside the template.
  // Exercise the generated app's own public lockfile in the disposable fixture.
  await promisify(execFile)('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org'], { cwd: fixtureRoot, timeout: 120_000, env: { ...process.env, NPM_CONFIG_USERCONFIG: os.devNull } });
  const configPath = path.join(fixtureRoot, 'backend/configuration.json'), config = JSON.parse(await readFile(configPath, 'utf8'));
  config.auth.settings.external_google_enabled = true;
  await writeFile(configPath, JSON.stringify(config));
  const port = await freePort(); origin = `http://localhost:${port}`;
  let log = '';
  processes.spawn(process.execPath, [path.join(fixtureRoot, 'node_modules/expo/bin/cli'), 'start', '--clear', '--web', '--go', '--localhost', '--port', String(port)], fixtureRoot, line => { log = (log + line).slice(-8000); }, { EXPO_PUBLIC_SUPABASE_URL: backend, EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_browser_fixture', EXPO_PUBLIC_BUILDER_ENVIRONMENT: 'development' });
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(origin, { signal: AbortSignal.timeout(3000) })).ok) return; } catch { /* Wait for the owned Metro server. */ }
    await delay(300);
  }
  throw new Error(`Template preview failed to start: ${log}`);
});
test.afterAll(async () => { await processes.close(); if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true }); });

test('the actual Expo account screen signs in, saves, reloads and separates users', async ({ page }, info) => {
  const notes = new Map<string, { id: string; body: string }[]>();
  const ids: Record<string, string> = { 'first@example.test': '11111111-1111-4111-8111-111111111111', 'second@example.test': '22222222-2222-4222-8222-222222222222' };
  let owner = '', failReads = false;
  await page.route(`${backend}/**`, async route => {
    const request = route.request(), url = new URL(request.url());
    const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
    if (url.pathname === '/auth/v1/otp') return route.fulfill({ json: {}, headers });
    if (url.pathname === '/auth/v1/verify') {
      const email = request.postDataJSON().email as string;
      owner = ids[email]!;
      const token = [Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'), Buffer.from(JSON.stringify({ sub: owner, email, aud: 'authenticated', role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url'), 'fixture-signature'].join('.');
      return route.fulfill({ headers, json: { access_token: token, refresh_token: `fixture-refresh-${owner}`, token_type: 'bearer', expires_in: 3600, user: { id: owner, email, aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() } } });
    }
    if (url.pathname === '/auth/v1/logout') return route.fulfill({ status: 204, headers });
    if (url.pathname === '/rest/v1/notes') {
      if (request.method() === 'POST') {
        const input = request.postDataJSON();
        expect(input.owner_id).toBe(owner);
        const note = { id: `note-${notes.size}`, body: String(input.body) };
        notes.set(owner, [note, ...(notes.get(owner) ?? [])]);
        return route.fulfill({ headers, json: note });
      }
      if (failReads) return route.fulfill({ headers, status: 503, json: { message: 'Fixture outage' } });
      return route.fulfill({ headers, json: notes.get(owner) ?? [] });
    }
    throw new Error(`Unexpected app backend fixture route: ${url.pathname}`);
  });
  await page.goto(`${origin}/account`);
  const signIn = async (email: string) => {
    await page.getByLabel('Email', { exact: true }).fill(email);
    await page.getByRole('button', { name: 'Send my code' }).click();
    await page.getByLabel('Email code', { exact: true }).fill('123456');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByText('Your notes', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save note' })).toBeEnabled();
  };
  for (const [width, height] of [[375, 812], [430, 932]] as const) {
    await page.setViewportSize({ width, height });
    await expect(page.getByText('Welcome in', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`account-sign-in-${width}.png`) });
  }
  await signIn('first@example.test');
  await page.getByLabel('New note').fill('A note to keep across app launches');
  await page.getByRole('button', { name: 'Save note' }).click();
  await expect(page.getByText('Note saved.', { exact: true })).toBeVisible();
  for (const [width, height] of [[375, 812], [430, 932]] as const) {
    await page.setViewportSize({ width, height });
    await page.screenshot({ path: info.outputPath(`account-notes-${width}.png`) });
  }
  await page.reload();
  await signIn('first@example.test');
  await expect(page.getByText('A note to keep across app launches', { exact: true })).toBeVisible();
  await page.getByLabel('New note').fill('A private unsaved draft');
  await page.getByRole('button', { name: 'Sign out' }).click();
  await signIn('second@example.test');
  await expect(page.getByText('A note to keep across app launches', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('New note')).toHaveValue('');
  await page.getByRole('button', { name: 'Sign out' }).click();
  failReads = true;
  await signIn('first@example.test');
  await expect(page.getByText('Your notes could not be loaded. Check the connection and try again.')).toBeVisible();
  failReads = false;
  await page.getByRole('button', { name: 'Reload notes' }).click();
  await expect(page.getByText('A note to keep across app launches', { exact: true })).toBeVisible();
});

test('the private-files example uploads, reads and removes owner files in an isolated app session', async ({ page }, info) => {
  const owner = '11111111-1111-4111-8111-111111111111', email = 'uploads@example.test', files = new Map<string, string>();
  const user = { id: owner, email, aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() };
  await page.route(`${backend}/**`, async route => {
    const request = route.request(), url = new URL(request.url()), headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
    if (url.pathname === '/auth/v1/otp') return route.fulfill({ headers, json: {} });
    if (url.pathname === '/auth/v1/verify') {
      const token = [Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'), Buffer.from(JSON.stringify({ sub: owner, email, aud: 'authenticated', role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url'), 'fixture-signature'].join('.');
      return route.fulfill({ headers, json: { access_token: token, refresh_token: 'fixture-only-refresh', token_type: 'bearer', expires_in: 3600, user } });
    }
    if (url.pathname === '/auth/v1/user') return route.fulfill({ headers, json: user });
    if (url.pathname === '/rest/v1/notes') return route.fulfill({ headers, json: [] });
    if (url.pathname === '/storage/v1/object/list/private-uploads') {
      expect(request.postDataJSON().prefix).toBe(owner);
      return route.fulfill({ headers, json: [...files.keys()].map(key => ({ name: key.split('/').at(-1), id: key, metadata: {} })) });
    }
    if (url.pathname.startsWith('/storage/v1/object/sign/private-uploads/')) {
      const object = url.pathname.replace('/storage/v1/object/sign/private-uploads/', '');
      if (request.method() === 'POST') return route.fulfill({ headers, json: { signedURL: `/object/sign/private-uploads/${object}?token=fixture-only` } });
      return route.fulfill({ headers: { 'Content-Type': 'text/plain' }, body: files.get(object) ?? '' });
    }
    if (url.pathname === '/storage/v1/object/private-uploads' && request.method() === 'DELETE') {
      for (const key of request.postDataJSON().prefixes) { expect(key.startsWith(`${owner}/`)).toBe(true); files.delete(key); }
      return route.fulfill({ headers, json: [] });
    }
    if (url.pathname.startsWith(`/storage/v1/object/private-uploads/${owner}/`) && request.method() === 'POST') {
      const key = url.pathname.replace('/storage/v1/object/private-uploads/', ''); files.set(key, request.postData() ?? '');
      return route.fulfill({ headers, json: { Key: `private-uploads/${key}`, Id: 'fixture-object' } });
    }
    throw new Error(`Unexpected private-files fixture route: ${url.pathname}`);
  });
  await page.goto(`${origin}/private-files`);
  for (const [width, height] of [[375, 812], [430, 932]] as const) {
    await page.setViewportSize({ width, height }); await expect(page.getByText('Your private files.', { exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath(`private-files-sign-in-${width}.png`) });
  }
  await page.getByRole('button', { name: 'Go to your account' }).click();
  await page.getByLabel('Email', { exact: true }).fill(email); await page.getByRole('button', { name: 'Send my code' }).click();
  await page.getByLabel('Email code', { exact: true }).fill('123456'); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByText('Your notes', { exact: true })).toBeVisible(); await page.goBack();
  await page.getByLabel('Private file text').fill('A private thought to keep.'); await page.getByRole('button', { name: 'Save private file' }).click();
  await expect(page.getByRole('button', { name: 'Open file', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Open file', exact: true }).click();
  await expect(page.getByText('A private thought to keep.', { exact: true })).toBeVisible();
  for (const [width, height] of [[375, 812], [430, 932]] as const) {
    await page.setViewportSize({ width, height });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`private-files-owner-${width}.png`), fullPage: true });
  }
  await page.getByRole('button', { name: 'Remove file', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Open file', exact: true })).toHaveCount(0); expect(files.size).toBe(0);
});

test('Google web PKCE returns an in-memory app session and clears callback and verifier state', async ({ page }, info) => {
  const runtimeErrors: string[] = []; page.on('console', message => { if (message.type() === 'error') runtimeErrors.push(message.text()); });
  const owner = '11111111-1111-4111-8111-111111111111', email = 'social@example.test';
  const user = { id: owner, email, aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() };
  const token = [Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'), Buffer.from(JSON.stringify({ sub: owner, email, aud: 'authenticated', role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url'), 'fixture-social-signature'].join('.');
  let challenge = '', exchanges = 0;
  await page.route(`${backend}/**`, async route => {
    const request = route.request(), url = new URL(request.url()), headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
    if (url.pathname === '/auth/v1/authorize') {
      expect(url.searchParams.get('provider')).toBe('google'); expect(url.searchParams.get('redirect_to')).toBe(`${origin}/oauth-callback`);
      expect(url.searchParams.get('code_challenge_method')?.toLowerCase()).toBe('s256');
      challenge = url.searchParams.get('code_challenge')!; expect(challenge).toHaveLength(43);
      return route.fulfill({ status: 302, headers: { Location: `${origin}/oauth-callback?code=fixture-one-use-code` } });
    }
    if (url.pathname === '/auth/v1/token') {
      expect(url.searchParams.get('grant_type')).toBe('pkce'); const input = request.postDataJSON();
      expect(input.auth_code).toBe('fixture-one-use-code');
      expect(createHash('sha256').update(input.code_verifier).digest('base64url')).toBe(challenge); exchanges++;
      return route.fulfill({ headers, json: { access_token: token, refresh_token: 'private-social-refresh-canary', token_type: 'bearer', expires_in: 3600, user } });
    }
    if (url.pathname === '/auth/v1/user') return route.fulfill({ headers, json: user });
    if (url.pathname === '/rest/v1/notes') return route.fulfill({ headers, json: [] });
    throw new Error(`Unexpected social fixture route: ${url.pathname}`);
  });
  await page.goto(`${origin}/oauth-callback?error=access_denied`);
  await expect(page.getByText('This sign-in request is unavailable or expired. Please start again.')).toBeVisible();
  await expect(page).toHaveURL(`${origin}/oauth-callback`);
  for (const [width, height] of [[375, 812], [430, 932]] as const) {
    await page.setViewportSize({ width, height });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`oauth-callback-expired-${width}.png`) });
  }
  await page.goto(`${origin}/private-files`);
  await page.getByRole('button', { name: 'Continue with Google' }).click();
  await expect(page).toHaveURL(`${origin}/account`);
  await expect(page.getByText('Your notes', { exact: true })).toBeVisible();
  expect(exchanges).toBe(1); expect(runtimeErrors.some(message => /Unexpected text node|Maximum update depth/.test(message))).toBe(false);
  const stored = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
  expect(stored).not.toContain('private-social-refresh-canary'); expect(stored).not.toContain(token); expect(stored).not.toContain('code-verifier');
  await page.reload();
  await expect(page.getByText('Welcome in', { exact: true })).toBeVisible();
});
