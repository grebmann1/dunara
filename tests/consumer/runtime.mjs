/* global fetch, URL, console */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createBuilderRuntime } from '@mobile-builder/runtime';
import { studioAssets, templateAssets, pluginAssets } from '@mobile-builder/runtime/resources';
import { startStudio } from '@mobile-builder/runtime/http';
import { startDesktopMcp, connectDesktop } from '@mobile-builder/runtime/mcp';
import { snapshotSource } from '@mobile-builder/runtime/source';
import { AssistantService } from '@mobile-builder/runtime/assistant';
import { ExecutionProviders } from '@mobile-builder/plugin-sdk/execution';
import { vercelProvider } from '@mobile-builder/execution/vercel';
import { e2bProvider } from '@mobile-builder/execution/e2b';
import { dockerProvider } from '@mobile-builder/execution/docker';
import { presets } from '@mobile-builder/catalog';

assert.equal(typeof vercelProvider, 'function'); assert.equal(typeof e2bProvider, 'function'); assert.equal(typeof dockerProvider, 'function');
assert.deepEqual(new ExecutionProviders().list(), []); assert(presets.sage);
for (const resource of [studioAssets, templateAssets, pluginAssets]) assert(resource.includes('node_modules'));
assert((await readFile(path.join(studioAssets, 'index.html'), 'utf8')).includes('Dunara'));
const engine = await createBuilderRuntime({ home: path.resolve('state/home'), workspace: path.resolve('state/apps') });
let studio, mcp, transport;
try {
  assert(engine.plugins.snapshot().some(plugin => plugin.id === 'builder.expo' && plugin.status === 'active'));
  const providerRoot = path.resolve('state/provider-fixture');
  await mkdir(providerRoot, { recursive: true });
  await writeFile(path.join(providerRoot, 'package.json'), JSON.stringify({ name: 'consumer-backend', version: '1.0.0', type: 'module', builder: { id: 'consumer.backend', name: 'Consumer backend', description: 'Offline package fixture', apiVersion: 1, app: 'app.js', workspacePanel: 'backend', workspaceGroup: 'backend' } }));
  await writeFile(path.join(providerRoot, 'app.js'), "export default {apiVersion:1,panels:[{id:'backend',title:'Backend',scope:'project',mount(root){root.textContent='Fixture';}}]};");
  const inspected = await engine.plugins.inspect(providerRoot);
  await engine.plugins.install(providerRoot, inspected.digest, true);
  const provider = engine.plugins.snapshot().find(plugin => plugin.id === 'consumer.backend');
  assert.equal(provider.workspacePanel, 'backend'); assert.equal(provider.workspaceGroup, 'backend'); assert(provider.appUrl);
  const project = await engine.projects.create({ name: 'External package', slug: 'external-package' });
  const manifest = JSON.parse(await readFile(path.join(project.root, 'package.json'), 'utf8'));
  assert(!JSON.stringify(manifest).includes('@mobile-builder/'));
  assert(!(await readFile(path.join(project.root, 'package-lock.json'), 'utf8')).includes('/nexus/'));
  assert((await snapshotSource(project.root)).files.some(file => file.path === 'package.json'));
  await assert.rejects(engine.previews.start(project.id), /trust-execution/);
  const assistant = new AssistantService({ home: path.resolve('state/home') });
  assert.equal(assistant.status().configured, false); await assistant.close();
  studio = await startStudio(engine, studioAssets);
  assert.equal((await fetch(`${studio.origin}/api/projects`)).status, 401);
  const bootstrap = await fetch(`${studio.origin}/api/bootstrap`, { method: 'POST', headers: { Origin: studio.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket: new URL(studio.launchUrl).hash.slice(1) }) });
  assert.equal(bootstrap.status, 200); const { token } = await bootstrap.json();
  const protocol = await fetch(`${studio.origin}/api/protocol`, { headers: { Authorization: `Bearer ${token}` } });
  assert.deepEqual(await protocol.json(), { version: 1, sdkApi: 1 });
  mcp = await startDesktopMcp(engine);
  transport = await connectDesktop(mcp.socketPath);
  await transport.close(); transport = undefined;
  console.log('Installed runtime: resources, offline scaffold, plugin discovery, execution trust, HTTP protocol, MCP and cleanup passed.');
} finally { await transport?.close(); await mcp?.close(); await studio?.close(); await Promise.all([engine.close(), engine.close()]); }

const imageModel = 'gpt-image-2.5-sunburst-2026-09-08', astraModel = 'gpt-6-astra';
const managed = await createBuilderRuntime({ home: path.resolve('state/managed-home'), workspace: path.resolve('state/managed-apps'), host: {
  managedImages: { label: 'Fixture credits', apiKey: 'fixture-token', baseUrl: 'http://127.0.0.1:45678/v1', models: [{ id: imageModel, label: 'GPT Image' }] },
} });
try {
  const jobs = managed.mediaJobs, project = await managed.projects.create({ name: 'Managed package', slug: 'managed-package' });
  const request = { model: astraModel, requestId: randomUUID(), expectedRevision: null, prompt: 'Fixture', label: 'Fixture', operation: 'generate' };
  const select = action => jobs.configureProvider({ action, expectedRevision: jobs.providerStatus().revision });
  assert.deepEqual(jobs.capabilities().models.map(model => model.id), [imageModel]);
  await assert.rejects(jobs.request(project.id, request), /No provider call/);
  await jobs.configureProvider({ action: 'replace', key: 'fixture-personal-key', expectedRevision: jobs.providerStatus().revision });
  assert.equal(jobs.providerStatus().source, 'managed');
  await select('personal');
  assert.deepEqual(jobs.capabilities().models.map(model => model.id), [astraModel, imageModel]);
  const staged = await jobs.request(project.id, request);
  await select('managed');
  await assert.rejects(jobs.approve(project.id, staged.id, jobs.providerStatus().revision), /No provider call/);
  assert.equal((await jobs.get(project.id, staged.id)).state, 'awaiting-approval');
  assert.equal((await jobs.get(project.id, staged.id)).creditEstimate, undefined);
  console.log('Installed managed images: model allowlists, explicit funding selection and blocked historical approvals passed without provider calls.');
} finally { await managed.close(); }
