import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import { get } from 'node:http';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../../mcp/src/server.js';
import { Engine } from '../../core/src/engine.js';
import { Projects } from '../../core/src/projects.js';
import { launchKitManifestSchema } from '../../core/src/launch-kit-contracts.js';
import { BuilderError } from '../../core/src/contracts.js';
import { startStudio } from './studio-server.js';
let dir: string, engine: Engine, studio: Awaited<ReturnType<typeof startStudio>>, client: Client, server: ReturnType<typeof createMcpServer>;
let projectId: string, otherId: string, captureId: string, png: Buffer, headers: Record<string, string>;
const provider = vi.fn();
async function connect() {
  studio = await startStudio(engine, path.resolve('dist/studio'));
  const auth = await fetch(`${studio.origin}/api/bootstrap`, { method: 'POST', headers: { Origin: studio.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket: new URL(studio.launchUrl).hash.slice(1) }) });
  headers = { Origin: studio.origin, Authorization: `Bearer ${(await auth.json()).token}`, 'Content-Type': 'application/json' };
  server = createMcpServer(engine); client = new Client({ name: 'kit-parity-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a); await client.connect(b);
}
async function close() { await client.close(); await server.close(); await studio.close(); await engine.close(); }
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'builder-kit-api-')); provider.mockReset();
  engine = new Engine(await Projects.open(path.join(dir, 'apps'), path.join(dir, 'home')), false, false, { run: provider });
  projectId = (await engine.projects.create({ name: 'Kit API', slug: 'kit-api' })).id;
  otherId = (await engine.projects.create({ name: 'Other', slug: 'other' })).id; captureId = randomUUID();
  png = await sharp({ create: { width: 375, height: 812, channels: 3, background: '#448866' } }).png().toBuffer();
  vi.spyOn(engine.captures, 'get').mockImplementation((id, cid) => {
    if (id !== projectId || cid !== captureId) throw new BuilderError('INVALID_INPUT', 'Capture not found or expired');
    return { png, meta: { id: captureId, projectId, width: 375, height: 812, viewport: 'compact', route: '/', bytes: png.length, createdAt: '2026-09-15T00:00:00.000Z', rendering: 'React Native Web' } };
  });
  await connect();
});
afterEach(async () => { vi.restoreAllMocks(); await close(); await rm(dir, { recursive: true, force: true }); });
const endpoint = (suffix = '', id = projectId) => `${studio.origin}/api/projects/${id}/launch-kits${suffix}`;
const request = () => ({ captureIds: [captureId], listing: { name: 'Draft', summary: 'A local draft', description: 'Test description' }, attribution: 'Test-owned', confirmed: true });
const post = (suffix: string, input: unknown) => fetch(endpoint(suffix), { method: 'POST', headers, body: JSON.stringify(input) });
const metadataSchema = z.object({ manifest: launchKitManifestSchema, location: z.string(), files: z.array(z.object({ id: z.string(), name: z.string() }).passthrough()), resources: z.array(z.object({ fileId: z.string(), uri: z.string() })).optional() });
it('shares Studio-created metadata and each allowlisted file with MCP, including restart without a preview', async () => {
  const response = await post('/create', request()); expect(response.status).toBe(200);
  const kit = metadataSchema.parse(await response.json());
  const read = await client.callTool({ name: 'launch_kit_read', arguments: { projectId, bundleId: kit.manifest.id } });
  const mcpKit = metadataSchema.parse(read.structuredContent);
  expect(mcpKit.manifest).toEqual(kit.manifest); expect(mcpKit.files).toEqual(kit.files);
  for (const resource of mcpKit.resources!) {
    const result = await client.readResource({ uri: resource.uri });
    const data = z.object({ mimeType: z.string(), blob: z.string().optional(), text: z.string().optional() }).parse(result.contents[0]);
    const fromMcp = data.blob ? Buffer.from(data.blob, 'base64') : Buffer.from(data.text!);
    const download = await fetch(endpoint(`/${kit.manifest.id}/files/${resource.fileId}`), { headers });
    expect(download.status).toBe(200); expect(download.headers.get('cache-control')).toBe('no-store');
    expect(download.headers.get('x-content-type-options')).toBe('nosniff');
    expect(download.headers.get('content-disposition')).toMatch(/^attachment; filename="[a-z0-9.-]+"$/);
    expect(Buffer.from(await download.arrayBuffer())).toEqual(fromMcp);
  }
  expect(JSON.stringify(read)).not.toContain(png.toString('base64'));
  expect(JSON.stringify(read)).not.toContain(dir);
  await close();
  engine = new Engine(await Projects.open(path.join(dir, 'apps'), path.join(dir, 'home')), false, false, { run: provider }); await connect();
  const listed = await client.callTool({ name: 'launch_kit_list', arguments: { projectId } });
  expect(z.object({ kits: z.array(metadataSchema) }).parse(listed.structuredContent).kits[0]?.manifest).toEqual(kit.manifest);
  expect((await post('/create', request())).status).toBe(400);
  expect((await client.callTool({ name: 'launch_kit_remove', arguments: { projectId, input: { bundleId: kit.manifest.id, confirmed: false } } })).isError).toBe(true);
  expect((await client.callTool({ name: 'launch_kit_remove', arguments: { projectId, input: { bundleId: kit.manifest.id, confirmed: true } } })).isError).not.toBe(true);
  expect((await fetch(endpoint(), { headers })).status).toBe(200);
  expect(await (await fetch(endpoint(), { headers })).json()).toEqual({ kits: [] });
  expect(provider).not.toHaveBeenCalled();
});
it('creates via MCP, lists and removes through Studio, and advertises exact mutation boundaries', async () => {
  const tools = (await client.listTools()).tools; expect(tools).toHaveLength(65);
  for (const name of ['launch_kit_list', 'launch_kit_read']) expect(tools.find(t => t.name === name)?.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
  expect(tools.find(t => t.name === 'launch_kit_create')?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false });
  expect(tools.find(t => t.name === 'launch_kit_remove')?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  const result = await client.callTool({ name: 'launch_kit_create', arguments: { projectId, input: request() } });
  const kit = metadataSchema.parse(result.structuredContent);
  expect((await (await fetch(endpoint(), { headers })).json()).kits[0].manifest).toEqual(kit.manifest);
  expect((await post('/remove', { bundleId: kit.manifest.id, confirmed: false })).status).toBe(400);
  expect((await post('/remove', { bundleId: kit.manifest.id, confirmed: true })).status).toBe(200);
  expect(provider).not.toHaveBeenCalled();
});
it('rejects auth/origin/host, cross-project access, traversal, invalid file IDs, oversized and unconfirmed writes', async () => {
  expect((await fetch(endpoint())).status).toBe(401);
  expect((await fetch(endpoint(), { headers: { ...headers, Origin: 'https://evil.test' } })).status).toBe(403);
  const hostileHost = await new Promise<number | undefined>((resolve, reject) => {
    get(endpoint(), { headers: { ...headers, Host: 'hostile.example' } }, res => { res.resume(); resolve(res.statusCode); }).on('error', reject);
  });
  expect(hostileHost).toBe(403);
  const { Origin: _origin, ...withoutOrigin } = headers;
  expect(_origin).toBe(studio.origin);
  expect((await fetch(endpoint('/create'), { method: 'POST', headers: withoutOrigin, body: JSON.stringify(request()) })).status).toBe(403);
  expect((await post('/create', { ...request(), confirmed: false })).status).toBe(400);
  expect((await post('/create', { ...request(), listing: { ...request().listing, description: 'x'.repeat(70_000) } })).status).toBe(400);
  const kit = metadataSchema.parse(await (await post('/create', request())).json());
  for (const suffix of [`/${kit.manifest.id}`, `/${kit.manifest.id}/files/listing`]) expect((await fetch(endpoint(suffix, otherId), { headers })).status).toBe(400);
  for (const file of ['..%2fmanifest', 'not-allowed', 'icon']) expect((await fetch(endpoint(`/${kit.manifest.id}/files/${file}`), { headers })).status).toBeGreaterThanOrEqual(400);
  expect((await client.callTool({ name: 'launch_kit_read', arguments: { projectId: otherId, bundleId: kit.manifest.id } })).isError).toBe(true);
  await expect(client.readResource({ uri: `builder://projects/${otherId}/launch-kits/${kit.manifest.id}/files/listing` })).rejects.toThrow();
  expect((await fetch(endpoint(), { method: 'DELETE', headers })).status).toBe(405);
  expect(provider).not.toHaveBeenCalled();
});
