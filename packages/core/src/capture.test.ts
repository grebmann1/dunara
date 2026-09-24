import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import { chromium } from 'playwright';
import { Projects } from './projects.js';
import { Previews } from './preview.js';
import { Diagnostics } from './diagnostics.js';
import { Captures } from './capture.js';
let dir: string, previews: Previews, captures: Captures, id: string;
const servers: Server[] = [];
async function listen(server: Server) {
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No port');
  return `http://127.0.0.1:${address.port}`;
}
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'builder-capture-'));
  const projects = await Projects.open(path.join(dir, 'apps'), path.join(dir, 'home'));
  id = (await projects.create({ name: 'Capture', slug: 'capture' })).id;
  previews = new Previews(projects, new Diagnostics(), false); captures = new Captures(previews);
});
afterEach(async () => {
  await captures.close(); await previews.close();
  await Promise.all(servers.splice(0).map(s => new Promise<void>(resolve => { s.closeAllConnections(); s.close(() => resolve()); })));
  await rm(dir, { recursive: true, force: true }); vi.restoreAllMocks();
});
it('requires an active preview and rejects arbitrary URLs', async () => {
  await expect(captures.capture(id, '/', 'compact')).rejects.toMatchObject({ code: 'PREVIEW_NOT_READY' });
  for (const route of ['https://example.com', '//example.com', '/%2fexample.com', '/a/../b']) await expect(captures.capture(id, route, 'compact')).rejects.toThrow();
});
it('captures a real browser image, diagnostics, and scopes artifact access', async () => {
  const destinations: string[] = [];
  const url = await listen(createServer((req, res) => { destinations.push(req.url!); res.setHeader('Content-Type', 'text/html'); res.end('<h1>Local preview</h1><script>throw Error("fixture error")</script>'); }));
  vi.spyOn(previews, 'status').mockReturnValue({ projectId: id, status: 'ready', url });
  const result = await captures.capture(id, '/lessons?lesson=0', 'compact');
  expect(destinations).toContain('/lessons?lesson=0'); expect(result.meta.route).toBe('/lessons?lesson=0');
  expect(result.png.subarray(1, 4).toString()).toBe('PNG'); expect(result.meta.width).toBe(375);
  expect(captures.list(id)).toHaveLength(1); expect(captures.get(id, result.meta.id)).toStrictEqual(result);
  expect(() => captures.get('other', result.meta.id)).toThrow();
  expect(previews.diagnostics.read(id).entries.some(e => e.message.includes('fixture error'))).toBe(true);
  await captures.close(); expect(captures.list(id)).toHaveLength(0);
}, 30_000);
it('blocks external requests and redirects before reaching another origin', async () => {
  let requests = 0;
  const external = await listen(createServer((_req, res) => { requests++; res.end('private'); }));
  const url = await listen(createServer((req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, { location: external }); res.end(); }
    else { res.setHeader('Content-Type', 'text/html'); res.end(`<h1>Safe</h1><img src="${external}/image"><img src="/redirect">`); }
  }));
  vi.spyOn(previews, 'status').mockReturnValue({ projectId: id, status: 'ready', url });
  await captures.capture(id, '/', 'large');
  await expect(captures.capture(id, '/redirect', 'compact')).rejects.toThrow(); expect(requests).toBe(0);
}, 30_000);
it('allows managed-origin WebSockets without granting access to another origin', async () => {
  let localConnections = 0, externalConnections = 0;
  const externalServer = createServer();
  const external = await listen(externalServer);
  const externalSockets = new WebSocketServer({ server: externalServer });
  externalSockets.on('connection', () => { externalConnections++; });
  const localServer = createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(`<h1>Live preview</h1><script>
      const local = new WebSocket(location.origin.replace('http:', 'ws:') + '/hot');
      local.onerror = () => console.error('Managed socket failed');
      new WebSocket('${external.replace('http:', 'ws:')}/private');
    </script>`);
  });
  const url = (await listen(localServer)).replace('127.0.0.1', 'localhost');
  const localSockets = new WebSocketServer({ server: localServer });
  localSockets.on('connection', () => { localConnections++; });
  vi.spyOn(previews, 'status').mockReturnValue({ projectId: id, status: 'ready', url });
  try {
    await captures.capture(id, '/', 'compact');
    expect(localConnections).toBe(1);
    expect(externalConnections).toBe(0);
    expect(previews.diagnostics.read(id).entries.filter(e => e.level === 'error')).toEqual([]);
  } finally {
    for (const sockets of [localSockets, externalSockets]) {
      for (const client of sockets.clients) client.terminate();
      await new Promise<void>(resolve => sockets.close(() => resolve()));
    }
  }
}, 30_000);
it('does not finish a capture after shutdown while the browser is launching', async () => {
  const url = await listen(createServer((_req, res) => { res.end('<h1>Closing</h1>'); }));
  vi.spyOn(previews, 'status').mockReturnValue({ projectId: id, status: 'ready', url });
  const browser = await chromium.launch();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const launch = vi.spyOn(chromium, 'launch').mockImplementation(async () => { await gate; return browser; });
  const pending = captures.capture(id, '/', 'compact');
  const outcome = pending.then(() => 'completed', () => 'cancelled');
  try {
    await vi.waitFor(() => expect(launch).toHaveBeenCalledOnce());
    await captures.close(); release();
    expect(await outcome).toBe('cancelled');
    expect(browser.isConnected()).toBe(false);
    expect(captures.list(id)).toEqual([]);
  } finally { release(); await outcome; await browser.close(); }
}, 30_000);
it('expires and bounds retained artifacts without waiting an hour', async () => {
  const url = await listen(createServer((_req, res) => { res.end('<h1>Retention</h1>'); }));
  vi.spyOn(previews, 'status').mockReturnValue({ projectId: id, status: 'ready', url });
  const first = await captures.capture(id, '/', 'compact');
  for (let i = 0; i < 20; i++) await captures.capture(id, '/', 'compact');
  expect(captures.list(id)).toHaveLength(20);
  expect(() => captures.get(id, first.meta.id)).toThrow('Capture not found or expired');
  const last = captures.list(id).at(-1)!;
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(last.createdAt) + 3_600_000);
  try { expect(captures.list(id)).toEqual([]); expect(() => captures.get(id, last.id)).toThrow('expired'); }
  finally { clock.mockRestore(); }
}, 60_000);
it('rejects a third active capture, cancels inflight work and recovers capacity', async () => {
  let requests = 0;
  const url = await listen(createServer((req, res) => {
    if (req.url === '/held') { requests++; return; }
    res.end('<h1>Recovered</h1>');
  }));
  vi.spyOn(previews, 'status').mockReturnValue({ projectId: id, status: 'ready', url });
  const controllers = [new AbortController(), new AbortController()];
  const pending = controllers.map(c => captures.capture(id, '/held', 'compact', c.signal).then(() => 'completed', () => 'cancelled'));
  try {
    await vi.waitFor(() => expect(requests).toBe(2), { timeout: 10_000 });
    await expect(captures.capture(id, '/', 'compact')).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    controllers.forEach(c => c.abort());
    expect(await Promise.all(pending)).toEqual(['cancelled', 'cancelled']);
    expect(captures.list(id)).toEqual([]);
    expect((await captures.capture(id, '/', 'compact')).meta.width).toBe(375);
  } finally { controllers.forEach(c => c.abort()); await Promise.all(pending); }
}, 30_000);
it('honors pre-cancellation', async () => {
  vi.spyOn(previews, 'status').mockReturnValue({ projectId: id, status: 'ready', url: 'http://127.0.0.1:1' });
  await expect(captures.capture(id, '/', 'compact', AbortSignal.abort())).rejects.toThrow();
});


it('binds rendering evidence to source and measures browser errors without claiming interaction verification', async () => {
  const url = await listen(createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<h1>Capture evidence</h1><script>throw Error("fixture")</script>'); }));
  vi.spyOn(previews, 'status').mockReturnValue({ projectId: id, status: 'ready', url });
  const revision = vi.fn().mockResolvedValue('source-a');
  const verified = new Captures(previews, undefined, revision);
  try {
    expect((await verified.capture(id, '/', 'large')).meta).toMatchObject({ sourceRevision: 'source-a', changedDuringCapture: false, runtimeErrors: 1 });
    revision.mockResolvedValueOnce('source-a').mockResolvedValueOnce('source-b');
    expect((await verified.capture(id, '/', 'compact')).meta.changedDuringCapture).toBe(true);
  } finally { await verified.close(); }
});
