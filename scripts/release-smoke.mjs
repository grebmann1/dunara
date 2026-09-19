import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { access, chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { chromium } from 'playwright';
import { expect } from '@playwright/test';
import sharp from 'sharp';
import { checkEnvironment } from './release-check.mjs';

// Test-only local assets/approvals, no provider requests or real credentials.
if (process.platform === 'win32') throw new Error('This private-candidate smoke is currently qualified on macOS only');
const root = await mkdtemp(path.join(os.tmpdir(), 'builder-release-smoke-'));
let client, browser, transport, projectId, previewUrl, studioOrigin;
let launchResolve;
async function startRuntime(env) {
  const launchPromise = new Promise(resolve => { launchResolve = resolve; });
  client = new Client({ name: 'private-release-smoke', version: '1' });
  transport = new StdioClientTransport({ command: process.execPath, args: [path.resolve('dist/packages/cli/src/index.js'), '--workspace', path.join(root, 'apps'), '--home', path.join(root, 'home'), '--builder-env-file', path.join(root, '.env'), '--studio', '--trust-execution'], env, stderr: 'pipe' });
  transport.stderr?.on('data', () => {});
  await client.connect(transport);
  const launch = await Promise.race([launchPromise, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Authenticated launch unavailable')), 20_000); timer.unref(); })]);
  const url = new URL(launch);
  assert.equal(url.protocol, 'http:'); assert.equal(url.hostname, '127.0.0.1');
  studioOrigin = url.origin;
  return launch;
}
async function assertStopped(origin) {
  const stopped = await fetch(origin, { signal: AbortSignal.timeout(2000) }).then(() => false, () => true);
  assert.ok(stopped, 'Owned runtime did not stop; temporary evidence retained');
}
const callbackPath = `/${randomUUID()}`;
const receiver = createServer((request, response) => {
  if (request.method !== 'POST' || request.url !== callbackPath) { response.writeHead(404).end(); return; }
  let body = '';
  request.on('data', chunk => { body += chunk; if (body.length > 4096) request.destroy(); });
  request.on('end', () => { response.writeHead(204).end(); launchResolve(body); });
});
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function tool(name, args) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 240_000 });
  assert.ok(!result.isError, `MCP ${name} failed: ${result.structuredContent?.error?.message ?? 'unknown error'}`);
  return result.structuredContent;
}
async function control(action) { return tool('studio_control', { expectedRevision: (await tool('studio_inspect', {})).revision, action }); }
try {
  await access('dist/studio/index.html');
  for (const file of ['package.json', 'package-lock.json']) assert.equal(hash(await readFile(`dist/packages/templates/expo/${file}`)), hash(await readFile(`packages/templates/expo/${file}`)));
  await new Promise(resolve => receiver.listen(0, '127.0.0.1', resolve));
  const callback = `http://127.0.0.1:${receiver.address().port}${callbackPath}`;
  const bin = path.join(root, 'bin'); await mkdir(bin);
  // Forward the one-use launch URL in memory, never into logs, files or browser traces.
  const opener = path.join(bin, process.platform === 'darwin' ? 'open' : 'xdg-open');
  await writeFile(opener, `#!${process.execPath}\nawait fetch(${JSON.stringify(callback)}, { method: 'POST', body: process.argv[2] });\n`);
  await chmod(opener, 0o700);
  const env = { ...checkEnvironment(), PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  const launch = await startRuntime(env);
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = []; page.on('pageerror', () => errors.push('pageerror'));
  await page.goto(launch);
  const project = (await tool('project_create', { name: 'Private Release Smoke', slug: 'private-release-smoke' })).project;
  projectId = project.id;
  await page.getByRole('combobox', { name: 'Project', exact: true }).filter({ hasText: project.name }).waitFor();
  let media = await tool('media_list', { projectId });
  assert.equal(media.capabilities.provider.configured, false);
  await tool('media_brief', { projectId, input: { expectedRevision: media.revision, brief: { purpose: 'Disposable offline release smoke' } } });
  media = await tool('media_list', { projectId });
  const png = await sharp({ create: { width: 64, height: 64, channels: 4, background: '#355e45' } }).png().toBuffer();
  await tool('media_import', { projectId, input: { metadata: { expectedRevision: media.revision, label: 'Offline smoke original', role: 'illustration', rightsNote: 'Locally authored solid-color test fixture; not production artwork', mediaType: 'image/png' }, data: png.toString('base64') } });
  media = await tool('media_list', { projectId });
  const original = media.assets[0];
  await tool('media_transform', { projectId, input: { assetId: original.id, expectedRevision: media.revision, width: 48, height: 48, fit: 'cover' } });
  media = await tool('media_list', { projectId });
  const child = media.assets.find(asset => asset.parentId === original.id);
  assert.ok(child);
  await tool('media_approve', { projectId, input: { assetId: child.id, expectedRevision: media.revision } });
  media = await tool('media_list', { projectId });
  assert.equal(media.assets.find(asset => asset.id === child.id).status, 'approved');
  assert.equal(media.assets.find(asset => asset.id === original.id).hash, original.hash);
  await tool('project_write_files', { projectId, writes: [{ path: 'app/release-smoke.tsx', expectedRevision: null, content: `import { Image, Text, View } from 'react-native';\nexport default function Smoke() { return <View><Text>Private offline release smoke</Text><Image source={require('../${child.path}')} style={{ width: 48, height: 48 }} /></View>; }\n` }] });
  await page.getByRole('button', { name: 'Assets', exact: true }).click();
  await page.getByRole('button', { name: new RegExp(child.label) }).first().waitFor();
  previewUrl = (await tool('preview_start', { projectId })).url;
  const appPage = await browser.newPage();
  await appPage.goto(`${previewUrl}/release-smoke`);
  await appPage.getByText('Private offline release smoke', { exact: true }).waitFor({ timeout: 60_000 });
  const capture = await tool('preview_capture', { projectId, route: '/release-smoke', viewport: 'compact' });
  assert.equal(capture.width, 375); assert.equal(capture.height, 812);
  await control({ type: 'navigate', workspace: 'preview' });
  await control({ type: 'canvas-mode', mode: 'focus' });
  const first = page.locator('.preview-phone').nth(0), second = page.locator('.preview-phone').nth(1);
  await expect(first.locator('iframe')).toBeVisible({ timeout: 60_000 });
  const sibling = await first.locator('iframe').elementHandle();
  const viewId = randomUUID();
  await control({ type: 'add', id: viewId });
  await control({ type: 'canvas-mode', mode: 'compare' });
  await control({ type: 'update', id: viewId, patch: { route: '/release-smoke', viewport: 'large' } });
  await expect(second.frameLocator('iframe').getByText('Private offline release smoke', { exact: true })).toBeVisible({ timeout: 60_000 });
  assert.deepEqual(await first.locator('iframe').evaluate(el => [el.clientWidth, el.clientHeight]), [375, 812]);
  await expect.poll(() => second.locator('iframe').evaluate(el => [el.clientWidth, el.clientHeight])).toEqual([430, 932]);
  await expect(first.locator('iframe')).toHaveAttribute('src', /\/$/);
  assert.equal((await tool('studio_inspect', {})).studio.board.views.length, 2);
  await page.getByRole('button', { name: 'Fit all', exact: true }).click();
  await page.getByRole('button', { name: 'Focus active view', exact: true }).click();
  await page.getByRole('button', { name: 'Reload preview', exact: true }).click();
  await expect(second.frameLocator('iframe').getByText('Private offline release smoke', { exact: true })).toBeVisible();
  assert.ok(await sibling.evaluate(el => el.isConnected));
  await page.getByRole('button', { name: 'Capture', exact: true }).click();
  let large;
  await expect.poll(async () => {
    const state = await tool('project_inspect', { projectId });
    large = state.captures.find(item => item.viewport === 'large' && item.route === '/release-smoke');
    return !!large;
  }, { timeout: 60_000 }).toBe(true);
  assert.equal(large.width, 430); assert.equal(large.height, 932);
  assert.equal((await tool('project_inspect', { projectId })).preview.url, previewUrl);
  await control({ type: 'remove', id: viewId });
  await expect(page.locator('iframe')).toHaveCount(1);
  assert.ok(await sibling.evaluate(el => el.isConnected));

  const kit = await tool('launch_kit_create', { projectId, input: { captureIds: [capture.id, large.id], listing: { name: 'Private release draft', summary: 'Offline smoke', description: 'User-authored test draft, not store qualification.' }, attribution: 'Local test fixture only', confirmed: true } });
  const bundleId = kit.manifest.id;
  const read = await tool('launch_kit_read', { projectId, bundleId });
  assert.deepEqual(read.manifest, kit.manifest);
  const files = new Map();
  for (const resource of read.resources) {
    const data = (await client.readResource({ uri: resource.uri })).contents[0];
    const bytes = data.blob ? Buffer.from(data.blob, 'base64') : Buffer.from(data.text);
    assert.equal(hash(bytes), kit.files.find(file => file.id === resource.fileId).sha256);
    files.set(resource.fileId, bytes);
  }
  await page.getByRole('button', { name: 'Assets', exact: true }).click();
  await page.getByRole('button', { name: 'Launch Kit', exact: true }).click();
  await expect(page.getByRole('heading', { name: kit.manifest.listing.name, exact: true })).toBeVisible();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download manifest.json', exact: true }).click();
  const download = await downloadPromise;
  assert.deepEqual(await readFile(await download.path()), files.get('manifest'));
  assert.equal((await tool('media_list', { projectId })).jobs.length, 0);
  await appPage.close();
  await page.goto('about:blank');
  await tool('preview_stop', { projectId });
  await client.close(); await transport.close();
  await assertStopped(previewUrl); await assertStopped(studioOrigin);
  const restartedLaunch = await startRuntime(env);
  const restarted = await tool('project_inspect', { projectId });
  assert.equal(restarted.preview.status, 'stopped'); assert.equal(restarted.captures.length, 0);
  const persisted = await tool('launch_kit_read', { projectId, bundleId });
  assert.deepEqual(persisted.manifest, kit.manifest);
  for (const resource of persisted.resources) {
    const data = (await client.readResource({ uri: resource.uri })).contents[0];
    assert.deepEqual(data.blob ? Buffer.from(data.blob, 'base64') : Buffer.from(data.text), files.get(resource.fileId));
  }
  await page.goto(restartedLaunch);
  await page.getByRole('button', { name: 'Assets', exact: true }).click();
  await page.getByRole('button', { name: 'Launch Kit', exact: true }).click();
  await expect(page.getByRole('heading', { name: kit.manifest.listing.name, exact: true })).toBeVisible();
  await tool('launch_kit_remove', { projectId, input: { bundleId, confirmed: true } });
  assert.deepEqual((await tool('launch_kit_list', { projectId })).kits, []);
  media = await tool('media_list', { projectId });
  assert.equal(media.capabilities.provider.configured, false); assert.equal(media.jobs.length, 0);
  assert.equal(errors.length, 0);
  console.log('PASS: built assets/pinned template; shared stdio MCP/authenticated Studio; offline media/revision-safe integration; two independent exact-size views on one preview, active reload/capture and sibling preservation; Launch Kit metadata/file hashes/download, full CLI restart with no captures or preview, persistence and confirmed deletion. No provider configured or requested.');
} finally {
  if (projectId) await tool('preview_stop', { projectId }).catch(() => {});
  await browser?.close();
  await client?.close();
  await transport?.close();
  await new Promise(resolve => receiver.close(resolve));
  for (const origin of [previewUrl, studioOrigin].filter(Boolean)) await assertStopped(origin);
  await rm(root, { recursive: true, force: true });
}
