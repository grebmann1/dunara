import { mkdtemp, rm } from 'node:fs/promises';
import { get } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { chromium } from 'playwright';
import { WebSocket } from 'ws';
import { startStudio } from './studio-server.js';
import { Projects } from '../../core/src/projects.js';
import { Engine } from '../../core/src/engine.js';
let dir: string, engine: Engine, studio: Awaited<ReturnType<typeof startStudio>>;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'builder-studio-'));
  engine = new Engine(await Projects.open(path.join(dir, 'apps'), path.join(dir, 'home')), false);
  studio = await startStudio(engine, path.resolve('dist/studio'));
});
afterEach(async () => { await studio.close(); await engine.close(); await rm(dir, { recursive: true, force: true }); });
async function bootstrap() {
  const response = await fetch(`${studio.origin}/api/bootstrap`, { method: 'POST', headers: { Origin: studio.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket: new URL(studio.launchUrl).hash.slice(1) }) });
  return { response, data: await response.json() };
}
it('rejects unauthenticated access, hostile Host/Origin, missing origin and bootstrap replay', async () => {
  expect((await fetch(`${studio.origin}/api/projects`)).status).toBe(401);
  const hostileHost = await new Promise<number | undefined>((resolve, reject) => { get(studio.origin, { headers: { Host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); }).on('error', reject); });
  expect(hostileHost).toBe(403);
  expect((await fetch(studio.origin, { headers: { Origin: 'http://evil.example' } })).status).toBe(403);
  expect((await fetch(`${studio.origin}/api/bootstrap`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(403);
  const { response, data } = await bootstrap(); expect(response.ok).toBe(true); expect(data.token.length).toBe(64);
  expect((await bootstrap()).response.status).toBe(401);
  const headers = { Authorization: `Bearer ${data.token}` };
  expect((await fetch(`${studio.origin}/api/projects`, { headers })).status).toBe(200);
  expect((await fetch(`${studio.origin}/api/projects`, { headers: { ...headers, Origin: 'null' } })).status).toBe(403);
  expect((await fetch(`${studio.origin}/assets/%2e%2e/package.json`, { headers })).status).not.toBe(200);
});
it('rejects invalid and expired launch tickets without consuming a valid ticket', async () => {
  const invalid = await fetch(`${studio.origin}/api/bootstrap`, { method: 'POST', headers: { Origin: studio.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket: 'not-a-ticket' }) });
  expect(invalid.status).toBe(401);
  expect((await bootstrap()).response.status).toBe(200);
  await studio.close(); studio = await startStudio(engine, path.resolve('dist/studio'));
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 61_000);
  try { expect((await bootstrap()).response.status).toBe(401); }
  finally { clock.mockRestore(); }
});
it('reissues one-use desktop tickets without replacing the Engine or existing authenticated session', async () => {
  const { data } = await bootstrap();
  const first = studio.issueLaunchUrl();
  const second = studio.issueLaunchUrl();
  const redeem = (url: string) => fetch(`${studio.origin}/api/bootstrap`, { method: 'POST', headers: { Origin: studio.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket: new URL(url).hash.slice(1) }) });
  expect((await redeem(first)).status).toBe(401);
  const fresh = await redeem(second);
  expect(fresh.status).toBe(200);
  expect((await fresh.json()).token).toBe(data.token);
  expect((await redeem(second)).status).toBe(401);
  expect((await fetch(`${studio.origin}/api/projects`, { headers: { Authorization: `Bearer ${data.token}` } })).status).toBe(200);
});
it('rejects invalid writes, unknown projects and untrusted preview execution over HTTP', async () => {
  const { data } = await bootstrap();
  const headers = { Origin: studio.origin, Authorization: `Bearer ${data.token}`, 'Content-Type': 'application/json' };
  const project = await engine.projects.create({ name: 'HTTP boundaries', slug: 'http-boundaries' });
  const post = (suffix: string, body: unknown) => fetch(`${studio.origin}/api/projects/${project.id}/${suffix}`, { method: 'POST', headers, body: JSON.stringify(body) });
  expect((await post('start', {})).status).toBe(400);
  expect((await post('design', { tokens: { accent: 'red' } })).status).toBe(400);
  expect((await post('capture', { route: '//external', viewport: 'compact' })).status).toBe(400);
  expect((await fetch(`${studio.origin}/api/projects/00000000-0000-4000-8000-000000000000`, { headers })).status).toBe(400);
  expect(engine.previews.status(project.id).status).toBe('stopped');
});
it('authenticates websocket upgrades and reconciles bounded events', async () => {
  const { data } = await bootstrap();
  const url = studio.origin.replace('http:', 'ws:') + '/events';
  const invalid = new WebSocket(url, ['builder', 'bad'], { origin: studio.origin });
  await new Promise<void>(resolve => invalid.once('error', () => resolve()));
  const valid = new WebSocket(url, ['builder', data.token], { origin: studio.origin });
  try { const message = await new Promise<string>((resolve, reject) => { valid.once('message', value => resolve(value.toString())); valid.once('error', reject); }); expect(JSON.parse(message).type).toBe('reconcile'); }
  finally { valid.terminate(); }
});
it('renders the built studio, creates a project, edits a preset, and never enables untrusted execution', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } }); const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(studio.launchUrl);
    expect(await page.title()).toBe('Dunara Studio');
    const mark = page.getByRole('img', { name: 'Dunara', exact: true });
    await mark.evaluate((image: HTMLImageElement) => image.decode());
    const response = await fetch(new URL((await mark.getAttribute('src'))!, studio.origin));
    expect(response.headers.get('content-type')).toBe('image/svg+xml');
    await page.getByRole('button', { name: /Create your first app/ }).click();
    await page.getByLabel('App name', { exact: true }).fill('Studio test');
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByRole('radio', { name: /No backend for now/ }).check();
    await page.getByRole('button', { name: 'Create app', exact: true }).click();
    await page.getByRole('button', { name: 'Design', exact: true }).click();
    await page.getByRole('button', { name: 'clay', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.preset.clay')?.getAttribute('aria-pressed') === 'true');
    const project = (await engine.projects.list())[0]!;
    expect((await engine.designs.read(project.id)).preset).toBe('clay');
    expect(await page.getByRole('button', { name: /Start preview/ }).isDisabled()).toBe(true);
    expect(page.url()).toBe(studio.origin + '/'); expect(errors).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally { await browser.close(); }
}, 30_000);
