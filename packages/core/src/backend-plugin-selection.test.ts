import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Engine } from './engine.js';
import { Projects } from './projects.js';

let root: string, engine: Engine;
const ref = 'abcdefghijklmnopqrst';
async function start() {
  engine = new Engine(await Projects.open(path.join(root, 'apps'), path.join(root, 'home')), false, false, undefined, {}, { fetch: async input => {
    const url = String(input);
    if (url.endsWith(`/projects/${ref}`)) return Response.json({ id: ref, organization_slug: 'fixture', name: 'Existing', region: 'eu-central-1', status: 'ACTIVE_HEALTHY' });
    if (url.includes('/health?')) return Response.json([{ name: 'db', status: 'ACTIVE_HEALTHY' }]);
    if (url.includes('/api-keys?')) return Response.json([{ type: 'publishable', api_key: 'sb_publishable_fixture' }]);
    throw Error('Unexpected provider request');
  } });
  await engine.plugins.ready;
}
async function select(id: string) { const state = await engine.studio.snapshot(); await engine.studio.control({ expectedRevision: state.revision, action: { type: 'select-project', projectId: id } }); }
async function enable(projectId: string, pluginId: string, enabled: boolean) { const state = await engine.backendPluginState(projectId, pluginId); return engine.setBackendPlugin(projectId, pluginId, { enabled, expectedRevision: state.revision }); }
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), 'project-backends-')); await start(); });
afterEach(async () => { await engine.close(); await rm(root, { recursive: true, force: true }); });
it('persists independent project choices and keeps source through disable and re-enable', async () => {
  const a = await engine.projects.create({ name: 'App A', slug: 'app-a' }), b = await engine.projects.create({ name: 'App B', slug: 'app-b' });
  await select(a.id);
  for (const id of ['salesforce.mobile-sdk', 'builder.supabase']) { await enable(a.id, id, true); expect((await engine.backendPluginState(b.id, id)).enabled).toBe(false); }
  const review = await engine.plugins.invoke('salesforce.mobile-sdk', 'install-in-app', {}, a.id) as { reviewId: string };
  await engine.plugins.answerReview(review.reviewId, true);
  const source = await engine.files.read(a.id, 'src/salesforce/client.ts');
  await enable(a.id, 'salesforce.mobile-sdk', false);
  await engine.close(); await start();
  expect((await engine.backendPluginState(a.id, 'builder.supabase')).enabled).toBe(true);
  expect((await engine.backendPluginState(a.id, 'salesforce.mobile-sdk')).enabled).toBe(false);
  expect(await engine.files.read(a.id, source.path)).toEqual(source);
  await expect(engine.plugins.invoke('salesforce.mobile-sdk', 'install-in-app', {}, a.id)).rejects.toThrow('Enable this backend');
  await enable(a.id, 'salesforce.mobile-sdk', true);
  expect(await engine.plugins.invoke('salesforce.mobile-sdk', 'inspect', {}, a.id)).toMatchObject({ installation: { state: 'installed' } });
  expect((await engine.backendPluginState(b.id, 'salesforce.mobile-sdk')).enabled).toBe(false);
  await engine.plugins.change('salesforce.mobile-sdk', 'uninstall');
  const available = engine.plugins.available().find(plugin => plugin.id === 'salesforce.mobile-sdk')!;
  await engine.plugins.installBundled(available.id, available.digest);
  expect((await engine.backendPluginState(a.id, available.id)).enabled).toBe(true);
  expect((await engine.backendPluginState(b.id, available.id)).enabled).toBe(false);
});
it('preserves legacy connected apps, stops Supabase preview injection on disable and restores it on re-enable', async () => {
  const app = await engine.projects.create({ name: 'Legacy app', slug: 'legacy-app' });
  const metadataFile = path.join(app.root, '.mobile-builder.json'), metadata = JSON.parse(await readFile(metadataFile, 'utf8'));
  delete metadata.backendPlugins; await writeFile(metadataFile, JSON.stringify(metadata));
  engine.backends.configure({ token: 'fixture-management-token' });
  const plan = await engine.backends.plan(app.id, { action: 'link', environment: 'development', projectRef: ref, organization: 'fixture' });
  const operation = await engine.backends.submit(app.id, { plan, requestId: randomUUID() });
  await engine.backends.approve(app.id, { operationId: operation.id, planHash: operation.planHash });
  await vi.waitFor(async () => expect((await engine.backends.operation(app.id, operation.id)).state).toBe('succeeded'));
  expect((await engine.backendPluginState(app.id, 'builder.supabase')).enabled).toBe(true);
  await select(app.id);
  // Choosing a different provider must preserve the older Supabase setup.
  await enable(app.id, 'salesforce.mobile-sdk', true);
  expect((await engine.backendPluginState(app.id, 'builder.supabase')).enabled).toBe(true);
  const before = await engine.backends.appEnvironment(app.id);
  expect(before.EXPO_PUBLIC_SUPABASE_URL).toContain(ref);
  await enable(app.id, 'builder.supabase', false);
  expect(await engine.backends.appEnvironment(app.id)).toEqual({});
  expect(await engine.backends.inspect(app.id)).toMatchObject({ enabled: false, readiness: { preview: 'disabled' } });
  expect(await engine.backends.binding(app.id)).not.toBeNull();
  await enable(app.id, 'builder.supabase', true);
  expect(await engine.backends.appEnvironment(app.id)).toEqual(before);
});
it('does not let source files opt a new app into a backend', async () => {
  const app = await engine.projects.create({ name: 'New app', slug: 'new-app' });
  await engine.files.write(app.id, [{ path: 'backend/salesforce-installation.json', expectedRevision: null, content: JSON.stringify({ version: 1, provider: 'salesforce.mobile-sdk', integrationVersion: '0.1.0', enabled: true }) }]);
  const connection = await engine.files.read(app.id, 'backend/connection.json');
  await engine.files.write(app.id, [{ path: connection.path, expectedRevision: connection.revision, content: JSON.stringify({ environment: 'development', url: `https://${ref}.supabase.co`, publishableKey: 'sb_publishable_fixture' }) }]);
  for (const id of ['builder.supabase', 'salesforce.mobile-sdk']) expect((await engine.backendPluginState(app.id, id)).enabled).toBe(false);
  await engine.plugins.change('builder.supabase', 'uninstall');
  expect(await engine.backends.appEnvironment(app.id)).toEqual({});
});
