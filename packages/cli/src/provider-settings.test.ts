import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { get } from 'node:http';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../../mcp/src/server.js';
import { Engine } from '../../core/src/engine.js';
import { Projects } from '../../core/src/projects.js';
import { startStudio } from './studio-server.js';

let dir: string, engine: Engine, studio: Awaited<ReturnType<typeof startStudio>>, headers: Record<string, string>;
const run = vi.fn(); const secret = 'unique-credential-INPUT-sentinel';
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'settings-api-')); run.mockReset().mockResolvedValue([]);
  engine = new Engine(await Projects.open(path.join(dir, 'apps'), path.join(dir, 'home')), false, false, undefined, { createProvider: () => ({ run }) });
  studio = await startStudio(engine, path.resolve('dist/studio'));
  const auth = await fetch(`${studio.origin}/api/bootstrap`, { method: 'POST', headers: { Origin: studio.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket: new URL(studio.launchUrl).hash.slice(1) }) });
  headers = { Origin: studio.origin, Authorization: `Bearer ${(await auth.json()).token}`, 'Content-Type': 'application/json' };
});
afterEach(async () => { await studio.close(); await engine.close(); await rm(dir, { recursive: true, force: true }); });
const post = (input: unknown, extra: Record<string, string> = {}) => fetch(`${studio.origin}/api/settings`, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(input) });
const input = () => ({ action: 'replace', key: secret, expectedRevision: engine.mediaJobs.providerStatus().revision });
it('works with an empty registry, sends only generic events, and reconciles MCP availability without exposing credential tools', async () => {
  const ws = new WebSocket(studio.origin.replace('http:', 'ws:') + '/events', ['builder', headers.Authorization!.slice(7)], { origin: studio.origin });
  const frames: string[] = []; ws.on('message', data => frames.push(data.toString()));
  await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const server = createMcpServer(engine), client = new Client({ name: 'settings-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a); await client.connect(b);
  try {
    expect((await engine.projects.list())).toHaveLength(0);
    const status = await fetch(`${studio.origin}/api/settings`, { headers }); expect(status.headers.get('cache-control')).toBe('no-store');
    expect(await status.json()).toMatchObject({ configured: false, source: 'none' });
    const response = await post(input()); const text = await response.text();
    expect(response.status).toBe(200); expect(text).not.toContain(secret); expect(JSON.parse(text)).toMatchObject({ configured: true, source: 'session' });
    await vi.waitFor(() => expect(frames.length).toBeGreaterThanOrEqual(2));
    expect(frames.every(frame => frame === JSON.stringify({ type: 'reconcile' }))).toBe(true);
    const tools = (await client.listTools()).tools.map(tool => tool.name);
    expect(tools).toHaveLength(65); expect(tools.some(name => /settings|credential|provider|key/.test(name))).toBe(false);
    const project = await engine.projects.create({ name: 'Observe', slug: 'observe' });
    expect((await client.callTool({ name: 'media_list', arguments: { projectId: project.id } })).structuredContent).toMatchObject({ capabilities: { available: true, provider: { source: 'session' } } });
    await post({ action: 'disconnect', expectedRevision: engine.mediaJobs.providerStatus().revision });
    expect((await client.callTool({ name: 'media_list', arguments: { projectId: project.id } })).structuredContent).toMatchObject({ capabilities: { available: false } });
    expect(run).not.toHaveBeenCalled(); expect(JSON.stringify(engine.diagnostics)).not.toContain(secret);
  } finally { ws.close(); await client.close(); await server.close(); }
});
it('rejects forged origins/hosts, missing authentication, query credentials and wrong methods', async () => {
  expect((await post(input(), { Authorization: '' })).status).toBe(401);
  expect((await post(input(), { Origin: 'http://localhost:4321' })).status).toBe(403);
  expect((await post(input(), { Origin: 'null' })).status).toBe(403);
  expect((await post(input(), { Origin: '' })).status).toBe(403);
  const hostileHost = await new Promise<number | undefined>((resolve, reject) => { get(`${studio.origin}/api/settings`, { headers: { ...headers, Host: 'hostile.example' } }, res => { res.resume(); resolve(res.statusCode); }).on('error', reject); });
  expect(hostileHost).toBe(403);
  expect((await fetch(`${studio.origin}/api/settings?key=${secret}`, { headers })).status).toBe(400);
  for (const method of ['PUT', 'DELETE', 'PATCH']) expect((await fetch(`${studio.origin}/api/settings`, { method, headers })).status).toBe(405);
  expect(engine.mediaJobs.providerStatus().configured).toBe(false); expect(run).not.toHaveBeenCalled();
});
it('bounds and sanitizes credential bodies, invalid JSON, compression and schema errors', async () => {
  const before = engine.mediaJobs.providerStatus();
  for (const value of [{ ...input(), unexpected: secret }, { ...input(), expectedRevision: secret }, { ...input(), key: `bad ${secret}` }, { ...input(), key: 'x'.repeat(9000) }]) {
    const response = await post(value); expect(response.status).toBe(400); expect(await response.text()).not.toContain(secret);
  }
  expect((await post(input(), { 'Content-Encoding': 'gzip' })).status).toBe(400);
  expect((await post(input(), { 'Content-Type': 'text/plain' })).status).toBe(400);
  const malformed = await fetch(`${studio.origin}/api/settings`, { method: 'POST', headers, body: `{"key":"${secret}` });
  expect(malformed.status).toBe(400); expect(await malformed.text()).not.toContain(secret);
  expect(engine.mediaJobs.providerStatus()).toEqual(before); expect(run).not.toHaveBeenCalled();
});
it('rejects stale tabs and requires the disclosed revision at the paid HTTP boundary', async () => {
  const project = await engine.projects.create({ name: 'Review', slug: 'review' });
  const job = await engine.mediaJobs.request(project.id, { requestId: randomUUID(), expectedRevision: null, prompt: 'Test', label: 'Test', operation: 'generate' });
  const old = input(); await post(old);
  expect((await post(old)).status).toBe(400);
  for (const body of [{ jobId: job.id }, { jobId: job.id, expectedConfigurationRevision: old.expectedRevision }]) {
    const response = await fetch(`${studio.origin}/api/projects/${project.id}/media/job-approve`, { method: 'POST', headers, body: JSON.stringify(body) });
    expect(response.status).toBe(400);
  }
  expect((await engine.mediaJobs.get(project.id, job.id)).state).toBe('awaiting-approval'); expect(run).not.toHaveBeenCalled();
});
