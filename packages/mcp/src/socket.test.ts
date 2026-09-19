import { chmod, mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createConnection } from 'node:net';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Engine } from '../../core/src/engine.js';
import { Projects } from '../../core/src/projects.js';
import { connectDesktop, startDesktopMcp } from './socket.js';
let root: string, engine: Engine, endpoint: Awaited<ReturnType<typeof startDesktopMcp>>;
const clients: Client[] = [];
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'desktop-mcp-test-'));
  engine = new Engine(await Projects.open(path.join(root, 'apps'), path.join(root, 'home')), false);
  endpoint = await startDesktopMcp(engine);
});
afterEach(async () => { await Promise.all(clients.splice(0).map(client => client.close())); await endpoint.close(); await engine.close(); await rm(root, { recursive: true, force: true }); });
async function client() {
  const client = new Client({ name: 'desktop-test', version: '1' }); clients.push(client);
  await client.connect(await connectDesktop(endpoint.socketPath)); return client;
}
it('shares one Engine across reconnecting MCP clients without closing it on disconnect', async () => {
  expect((await stat(endpoint.socketPath)).mode & 0o777).toBe(0o600);
  expect((await stat(path.dirname(endpoint.socketPath))).mode & 0o777).toBe(0o700);
  const first = await client();
  expect((await first.listTools()).tools).toHaveLength(65);
  expect((await first.callTool({ name: 'project_create', arguments: { name: 'Café desktop', slug: 'desktop' } })).isError).not.toBe(true);
  const project = (await engine.projects.list())[0]!;
  await first.close();
  const second = await client();
  expect((await second.callTool({ name: 'project_inspect', arguments: { projectId: project.id } })).isError).not.toBe(true);
  expect((await second.callTool({ name: 'preview_start', arguments: { projectId: project.id } })).isError).toBe(true);
  expect(engine.mediaJobs.providerStatus().configured).toBe(false);
});
it('rejects public socket permissions and malformed peers without damaging the runtime', async () => {
  await chmod(endpoint.socketPath, 0o666);
  await expect(connectDesktop(endpoint.socketPath)).rejects.toThrow('private socket');
  await chmod(endpoint.socketPath, 0o600);
  const peer = createConnection(endpoint.socketPath);
  await new Promise<void>((resolve, reject) => { peer.once('connect', resolve); peer.once('error', reject); });
  const closed = new Promise<void>(resolve => peer.once('close', () => resolve()));
  peer.write('not-json\n'); await closed;
  expect((await (await client()).listTools()).tools).toHaveLength(65);
});
