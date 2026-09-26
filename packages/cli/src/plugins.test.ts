import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Engine } from '../../core/src/engine.js';
import { Projects } from '../../core/src/projects.js';
import { createMcpServer } from '../../mcp/src/server.js';
import { startStudio } from './studio-server.js';
import { scaffoldPlugin } from './plugin-commands.js';
import { inspectPackage } from '../../plugin-runtime/src/packages.js';
import { toolAllowedInMode } from '../../assistant/src/permissions.js';
let root: string, engine: Engine, studio: Awaited<ReturnType<typeof startStudio>>, headers: Record<string, string>, client: Client, server: ReturnType<typeof createMcpServer>;
const post = (route: string, value: unknown) => fetch(`${studio.origin}/api/plugins/${route}`, { method: 'POST', headers, body: JSON.stringify(value) });
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'plugin-api-')); engine = new Engine(await Projects.open(path.join(root, 'apps'), path.join(root, 'home')), false);
  studio = await startStudio(engine, path.resolve('dist/studio'));
  const auth = await fetch(`${studio.origin}/api/bootstrap`, { method: 'POST', headers: { Origin: studio.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket: new URL(studio.launchUrl).hash.slice(1) }) });
  headers = { Origin: studio.origin, Authorization: `Bearer ${(await auth.json()).token}`, 'Content-Type': 'application/json' };
  server = createMcpServer(engine); client = new Client({ name: 'plugin-test', version: '1' }); const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a); await client.connect(b);
});
afterEach(async () => { await client.close(); await server.close(); await studio.close(); await engine.close(); await rm(root, { recursive: true, force: true }); });
it('protects installation/review endpoints and exposes only public plugin metadata to MCP', async () => {
  expect((await fetch(`${studio.origin}/api/plugins`)).status).toBe(401);
  expect((await fetch(`${studio.origin}/api/plugins/restore`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"confirm":true}' })).status).toBe(403);
  const tools = (await client.listTools()).tools; expect(tools).toHaveLength(93); expect(tools.some(t => /install|approve/.test(t.name) && t.name.startsWith('plugin'))).toBe(false);
  const result = await client.callTool({ name: 'plugin_list', arguments: {} }); expect(JSON.stringify(result)).not.toContain(root);
});
it('exposes the available catalogue read-only and requires a human request to install a bundled plugin', async () => {
  const id = 'salesforce.mobile-sdk';
  await engine.plugins.change(id, 'uninstall');
  const available = engine.plugins.available().find(plugin => plugin.id === id)!;
  const value = { id, digest: available.digest, confirm: true };
  const catalogue = await fetch(`${studio.origin}/api/plugins`, { headers });
  expect(await catalogue.json()).toMatchObject({ available: [available] });
  const discovery = await client.callTool({ name: 'plugin_list', arguments: {} });
  expect(discovery.structuredContent).toMatchObject({ result: { available: [available] } });
  expect((await fetch(`${studio.origin}/api/plugins/install-bundled`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) })).status).toBe(403);
  expect((await post('install-bundled', { ...value, confirm: false })).status).toBe(400);
  expect((await post('install-bundled', value)).status).toBe(200);
  expect(engine.plugins.snapshot().find(plugin => plugin.id === id)?.status).toBe('active');
});
it('installs a user package, discovers its action, loads its panel and removes its tools on disable', async () => {
  const source = path.join(root, 'sample'); await scaffoldPlugin(source); const pkg = await inspectPackage(source);
  expect((await post('install', { source, digest: pkg.digest, trust: true })).status).toBe(200);
  const tools = (await client.listTools()).tools, action = tools.find(t => t.name.startsWith('mb_'))!;
  expect(action).toBeDefined(); expect(toolAllowedInMode(action.name, 'plan', action._meta)).toBe(true);
  const project = await engine.projects.create({ name: 'App', slug: 'app' });
  const output = await client.callTool({ name: action.name, arguments: { projectId: project.id, input: {} } }); expect(output.isError).not.toBe(true);
  const view = engine.plugins.snapshot().find(p => p.id === pkg.package.builder.id)!;
  const asset = await fetch(`${studio.origin}${view.appUrl}`); expect(asset.status).toBe(200); expect(asset.headers.get('content-type')).toBe('text/javascript');
  expect((await post('change', { id: view.id, operation: 'disable' })).status).toBe(200);
  expect((await client.listTools()).tools.some(t => t.name === action.name)).toBe(false);
  expect((await fetch(`${studio.origin}${view.appUrl}`)).status).toBe(400);
});
it('disables an existing feature on both HTTP and MCP while leaving project access available', async () => {
  const project = await engine.projects.create({ name: 'App', slug: 'app' });
  expect((await post('change', { id: 'builder.launch-kit', operation: 'disable' })).status).toBe(200);
  expect((await fetch(`${studio.origin}/api/projects/${project.id}/launch-kits`, { headers })).status).toBe(400);
  expect((await client.listTools()).tools.some(t => t.name === 'launch_kit_list')).toBe(false);
  expect((await client.callTool({ name: 'project_inspect', arguments: { projectId: project.id } })).isError).not.toBe(true);
  expect((await post('change', { id: 'builder.supabase', operation: 'disable' })).status).toBe(200);
  expect((await post('change', { id: 'builder.account', operation: 'disable' })).status).toBe(200);
  expect((await fetch(`${studio.origin}/api/account/workspaces`, { headers })).status).toBe(400);
  expect((await post('change', { id: 'builder.account', operation: 'enable' })).status).toBe(200);
  expect((await fetch(`${studio.origin}/api/account/status`, { headers })).status).toBe(200);
});

it('enables each backend only for the selected project and rejects agent actions until then', async () => {
  const a = await engine.projects.create({ name: 'App A', slug: 'app-a' }), b = await engine.projects.create({ name: 'App B', slug: 'app-b' });
  const session = await engine.studio.snapshot();
  await engine.studio.control({ expectedRevision: session.revision, action: { type: 'select-project', projectId: a.id } });
  const route = (project: string, plugin: string) => `${studio.origin}/api/projects/${project}/backend-plugins/${plugin}`;
  for (const id of ['builder.supabase', 'salesforce.mobile-sdk']) {
    expect(await engine.backendPluginState(a.id, id)).toMatchObject({ enabled: false, available: true });
    expect((await fetch(route(a.id, id), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true, expectedRevision: 'initial' }) })).status).toBe(403);
    expect((await fetch(route(b.id, id), { method: 'POST', headers, body: JSON.stringify({ enabled: true, expectedRevision: 'initial' }) })).status).toBe(400);
    const state = await fetch(route(a.id, id), { method: 'POST', headers, body: JSON.stringify({ enabled: true, expectedRevision: 'initial' }) });
    expect(state.status).toBe(200);
    expect(await state.json()).toMatchObject({ enabled: true });
    expect(await engine.backendPluginState(b.id, id)).toMatchObject({ enabled: false });
    expect((await fetch(route(a.id, id), { method: 'POST', headers, body: JSON.stringify({ enabled: false, expectedRevision: 'initial' }) })).status).toBe(400);
  }
  await expect(engine.plugins.invoke('salesforce.mobile-sdk', 'install-in-app', {}, b.id)).rejects.toThrow('Enable this backend for this app');
  const blocked = await client.callTool({ name: 'backend_catalog', arguments: { projectId: b.id } });
  expect(blocked.isError).toBe(true); expect(JSON.stringify(blocked)).toContain('Enable this backend for this app');
  expect((await fetch(`${studio.origin}/api/projects/${b.id}/backend/catalog`, { headers })).status).toBe(400);
  const review = await engine.plugins.invoke('salesforce.mobile-sdk', 'install-in-app', {}, a.id) as { reviewId: string };
  const state = await engine.backendPluginState(a.id, 'salesforce.mobile-sdk');
  await engine.setBackendPlugin(a.id, 'salesforce.mobile-sdk', { enabled: false, expectedRevision: state.revision });
  await expect(engine.plugins.answerReview(review.reviewId, true)).rejects.toThrow('unavailable');
  expect((await engine.inspect(a.id)).backendPlugins).toEqual(expect.arrayContaining([
    expect.objectContaining({ pluginId: 'builder.supabase', projectEnabled: true }),
    expect.objectContaining({ pluginId: 'salesforce.mobile-sdk', projectEnabled: false }),
  ]));
  await engine.projects.writeMetadata(a, (await engine.projects.metadata(a)).studio);
  expect(await engine.projects.backendPluginSelections(a.id)).toMatchObject({ 'builder.supabase': { enabled: true }, 'salesforce.mobile-sdk': { enabled: false } });
  expect((await client.listTools()).tools.some(tool => /backend.*enable|backend.*selection/.test(tool.name))).toBe(false);
});
