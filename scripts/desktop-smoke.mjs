import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import electronPath from 'electron';
import { _electron as electron } from 'playwright';
import { expect } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import sharp from 'sharp';
import { TOOL_POLICY } from '../dist/packages/assistant/src/permissions.js';
import { desktopEnvironment } from '../dist/packages/desktop/src/security.js';
import { assistantFixture, fixtureKey } from './assistant-desktop-fixture.mjs';

if (process.platform !== 'darwin') throw new Error('Desktop smoke is macOS-only');
const root = await mkdtemp(path.join(os.tmpdir(), 'builder-desktop-smoke-'));
const evidence = path.resolve('.builder/desktop-review'); await mkdir(evidence, { recursive: true });
const assistant = await assistantFixture();
let app, client, transport, origin, previewUrl, socket;
async function control(action) { return tool('studio_control', { expectedRevision: (await tool('studio_inspect', {})).revision, action }); }
async function command(name, args = {}) {
  const { stdout } = await promisify(execFile)(process.execPath, [path.resolve('dist/packages/cli/src/index.js'), '--desktop-connect', socket, 'call', name, '--input', JSON.stringify(args)], { env: desktopEnvironment(process.env), timeout: 20_000 });
  const result = JSON.parse(stdout); assert.ok(!result.isError); return result.structuredContent;
}
const errors = [];
async function tool(name, args) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 240_000 });
  assert.ok(!result.isError, `Desktop MCP ${name} failed`); return result.structuredContent;
}
async function menu(label) {
  await app.evaluate(({ Menu }, text) => {
    const item = Menu.getApplicationMenu().items.find(item => item.label === 'Studio').submenu.items.find(item => item.label === text);
    item.click();
  }, label);
}
async function connect() {
  await menu('Copy MCP socket path');
  socket = await app.evaluate(({ clipboard }) => { const value = clipboard.readText(); clipboard.clear(); return value; });
  client = new Client({ name: 'desktop-offline-smoke', version: '1' });
  transport = new StdioClientTransport({ command: process.execPath, args: [path.resolve('dist/packages/cli/src/index.js'), '--desktop-connect', socket], env: desktopEnvironment(process.env), stderr: 'pipe' });
  transport.stderr?.on('data', () => {});
  await client.connect(transport); assert.deepEqual((await client.listTools()).tools.map(tool => tool.name).sort(), Object.keys(TOOL_POLICY).sort());
}
try {
  app = await electron.launch({ executablePath: electronPath, args: [path.resolve('dist/packages/desktop/src/main.js'), '--node', process.execPath, '--workspace', path.join(root, 'apps'), '--home', path.join(root, 'home'), '--user-data', path.join(root, 'chromium'), '--trust-execution', '--assistant-offline-fixture', assistant.baseUrl], env: desktopEnvironment(process.env), chromiumSandbox: true, timeout: 30_000 });
  let page = await app.firstWindow(); page.on('pageerror', () => errors.push('pageerror'));
  await page.getByRole('heading', { name: 'Create your first app', exact: true }).waitFor();
  origin = new URL(page.url()).origin;
  assert.equal(await page.evaluate(() => typeof process !== 'undefined' || typeof require !== 'undefined'), false);
  const prefs = await app.evaluate(({ BrowserWindow }) => { const p = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences(); return { sandbox: p.sandbox, nodeIntegration: p.nodeIntegration, contextIsolation: p.contextIsolation, webSecurity: p.webSecurity }; });
  assert.deepEqual(prefs, { sandbox: true, nodeIntegration: false, contextIsolation: true, webSecurity: true });
  assert.equal((await fetch(`${origin}/api/projects`)).status, 401);
  await page.screenshot({ path: path.join(evidence, 'desktop-empty.png') });
  await connect();
  await assistant.configure(page);
  const { project } = await assistant.call(page, 'project_create', { name: 'Desktop Review', slug: 'desktop-review' });
  const projectId = project.id;
  await expect(page.getByRole('combobox', { name: 'Project', exact: true })).toContainText(project.name);
  await assistant.call(page, 'project_write_files', { projectId, writes: [{ path: 'app/desktop-review.tsx', expectedRevision: null, content: "import { Text, TextInput, View } from 'react-native';\nexport default function Review() { return <View style={{ padding: 24 }}><Text>Desktop second route</Text><TextInput accessibilityLabel=\"Desktop draft\" /></View>; }\n" }] });
  let media = await tool('media_list', { projectId }); assert.equal(media.capabilities.provider.configured, true); // Assistant and images now share the session credential.
  const png = await sharp({ create: { width: 64, height: 64, channels: 4, background: '#355e45' } }).png().toBuffer();
  await page.getByRole('button', { name: 'Assets', exact: true }).click();
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await page.getByLabel('Image file').setInputFiles({ name: 'desktop-fixture.png', mimeType: 'image/png', buffer: png });
  await page.getByRole('button', { name: 'Import candidate', exact: true }).click();
  await expect.poll(async () => (await tool('media_list', { projectId })).assets.length).toBe(1);
  await page.keyboard.press('Escape');
  media = await tool('media_list', { projectId }); assert.equal(media.assets[0].mediaType, 'image/png');
  previewUrl = (await assistant.call(page, 'preview_start', { projectId })).url;
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  const first = page.locator('.preview-phone').nth(0);
  await expect(first.frameLocator('iframe').getByText('A softer kind of day.')).toBeVisible({ timeout: 60_000 });
  const sibling = await first.locator('iframe').elementHandle();
  const viewId = randomUUID();
  await control({ type: 'add', id: viewId });
  await control({ type: 'canvas-mode', mode: 'compare' });
  const second = page.locator('.preview-phone').nth(1);
  await expect(second).toBeVisible();
  await command('studio_control', { expectedRevision: (await command('studio_inspect')).revision, action: { type: 'update', id: viewId, patch: { route: '/desktop-review' } } });
  await expect(page.locator('.preview-phones iframe').nth(1)).toHaveAttribute('src', /desktop-review/);
  await control({ type: 'update', id: viewId, patch: { viewport: 'large' } });
  await expect(second.frameLocator('iframe').getByText('Desktop second route', { exact: true })).toBeVisible({ timeout: 60_000 });
  await expect.poll(() => page.locator('.preview-phones iframe').evaluateAll(frames => frames.map(frame => ({ width: frame.offsetWidth, height: frame.offsetHeight })))).toEqual([{ width: 375, height: 812 }, { width: 430, height: 932 }]);
  for (const frame of page.frames().filter(frame => frame.parentFrame())) {
    const privileges = await frame.evaluate(() => {
      const runtime = globalThis.process;
      const modules = ['node:fs', 'electron'].map(name => {
        try { return !!globalThis.require?.(name); } catch { return false; }
      });
      return { node: !!runtime?.versions?.node, electron: !!runtime?.versions?.electron, binding: typeof runtime?.binding === 'function', modules };
    });
    assert.deepEqual(privileges, { node: false, electron: false, binding: false, modules: [false, false] });
  }
  await page.getByRole('button', { name: 'Inspect', exact: true }).click();
  await expect(second.frameLocator('iframe').locator('[data-builder-inspector-overlay]')).toHaveCount(1);
  // Electron frame-locator clicks omit the canvas transform; send a real mouse click at measured screen coordinates.
  const targetBox = await second.frameLocator('iframe').getByText('Desktop second route', { exact: true }).evaluate(element => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; });
  const frameBox = await second.locator('iframe').evaluate(element => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, scale: r.width / element.offsetWidth }; });
  await page.mouse.click(frameBox.x + (targetBox.x + targetBox.width / 2) * frameBox.scale, frameBox.y + (targetBox.y + targetBox.height / 2) * frameBox.scale);
  await page.getByRole('button', { name: 'Preview context', exact: true }).click();
  await expect(page.getByLabel('Copyable context')).toHaveValue(/Desktop second route/);
  await page.getByRole('button', { name: 'Ask assistant about this', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Assistant', exact: true })).toBeVisible();
  await page.screenshot({ path: path.join(evidence, 'desktop-assistant-inspector.png') });
  await assistant.call(page, 'studio_inspect');
  assert.ok(await sibling.evaluate(frame => frame.isConnected));
  await page.getByRole('button', { name: 'Inspect', exact: true }).click();
  await second.frameLocator('iframe').getByRole('textbox', { name: 'Desktop draft', exact: true }).fill('Retained desktop draft');
  await page.getByRole('button', { name: 'Fit all', exact: true }).click();
  await page.getByRole('button', { name: 'Focus active view', exact: true }).click();
  await expect(second.frameLocator('iframe').getByRole('textbox', { name: 'Desktop draft', exact: true })).toHaveValue('Retained desktop draft');
  assert.ok(await sibling.evaluate(frame => frame.isConnected));
  assert.equal((await command('studio_inspect')).studio.board.views[1].viewport, 'large');
  for (const [workspace, label] of [['activity', 'Activity'], ['icons', 'App Icons'], ['settings', 'Settings'], ['assets', 'Assets'], ['preview', 'Preview']]) {
    await control({ type: 'navigate', workspace });
    await expect(page.getByRole('button', { name: label, exact: true })).toHaveAttribute('aria-current', 'page');
  }
  await expect(second.frameLocator('iframe').getByRole('textbox', { name: 'Desktop draft', exact: true })).toHaveValue('Retained desktop draft');
  assert.ok(await sibling.evaluate(frame => frame.isConnected));
  await page.screenshot({ path: path.join(evidence, 'desktop-two-views.png') });
  await page.getByRole('button', { name: 'Reload preview', exact: true }).click();
  await expect(second.frameLocator('iframe').getByText('Desktop second route', { exact: true })).toBeVisible();
  assert.ok(await sibling.evaluate(frame => frame.isConnected));
  await page.getByRole('button', { name: 'Capture', exact: true }).click();
  let capture;
  await expect.poll(async () => { capture = (await tool('project_inspect', { projectId })).captures.find(item => item.route === '/desktop-review' && item.viewport === 'large'); return !!capture; }, { timeout: 60_000 }).toBe(true);
  assert.equal(capture.width, 430); assert.equal(capture.height, 932);
  // Captures are read through canonical MCP; current drawer rendering is covered by Studio E2E.
  const kit = await assistant.call(page, 'launch_kit_create', { projectId, input: { captureIds: [capture.id], listing: { name: 'Desktop local draft', summary: 'Offline test only', description: 'React Native Web capture, not a native screenshot.' }, confirmed: true } });
  const bundleId = kit.manifest.id;
  const resource = (await tool('launch_kit_read', { projectId, bundleId })).resources.find(item => item.fileId === 'manifest');
  const content = (await client.readResource({ uri: resource.uri })).contents[0];
  const expected = content.blob ? Buffer.from(content.blob, 'base64') : Buffer.from(content.text);
  await app.evaluate(({ BrowserWindow }, destination) => {
    BrowserWindow.getAllWindows()[0].webContents.session.once('will-download', (_event, item) => { item.setSavePath(destination); });
  }, path.join(root, 'manifest.json'));
  await page.getByRole('button', { name: 'Assets', exact: true }).click();
  await page.getByRole('button', { name: 'Launch Kit', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Desktop local draft', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Download manifest.json', exact: true }).click();
  await expect.poll(async () => readFile(path.join(root, 'manifest.json')).then(bytes => createHash('sha256').update(bytes).digest('hex'), () => ''), { timeout: 20_000 }).toBe(createHash('sha256').update(expected).digest('hex'));
  // Exercise local canonical operations through explicit panel turns and real Pi dispatch.
  // Provider mutations are separately qualified by controlled backend integration fixtures.
  const ask = (name, args = {}) => assistant.call(page, name, args);
  const inventory = await ask('builder_mcp_discover');
  assert.deepEqual(inventory.tools, (await client.listTools()).tools);
  assert.deepEqual(inventory.resources, (await client.listResources()).resources);
  assert.deepEqual(inventory.resourceTemplates, (await client.listResourceTemplates()).resourceTemplates);
  assert.deepEqual(inventory.prompts, (await client.listPrompts()).prompts);
  await ask('builder_mcp_get_prompt', { name: 'build-mobile-app', arguments: { brief: 'Offline desktop acceptance only' } });
  await ask('builder_mcp_read_resource', { uri: 'builder://guide' });
  await ask('project_list');
  await ask('project_open', { slug: project.slug });
  const inspected = await ask('project_inspect', { projectId, paths: ['app/desktop-review.tsx'] });
  await ask('design_apply', { projectId, update: { expectedRevision: inspected.design.revision, preset: 'sage', mode: 'light', tokens: { radius: 20 } } });
  await ask('project_diagnostics', { projectId });
  let library = await ask('media_list', { projectId });
  library = await ask('media_import', { projectId, input: { metadata: { expectedRevision: library.revision, label: 'Assistant offline icon', role: 'app-icon', mediaType: 'image/png' }, data: png.toString('base64') } });
  const assetId = library.assets.find(asset => asset.label === 'Assistant offline icon').id;
  await ask('media_read', { projectId, assetId });
  await ask('builder_mcp_read_resource', { uri: `builder://projects/${projectId}/media/${assetId}` });
  library = await ask('media_brief', { projectId, input: { expectedRevision: library.revision, brief: { mood: 'Calm offline fixture' } } });
  library = await ask('media_approve', { projectId, input: { expectedRevision: library.revision, assetId } });
  library = await ask('media_transform', { projectId, input: { expectedRevision: library.revision, assetId, width: 128, height: 128, fit: 'contain' } });
  await ask('icon_check', { projectId, input: { assetId } });
  library = await ask('icon_prepare', { projectId, input: { expectedRevision: library.revision, assetId, kind: 'master', fit: 'contain', background: '#ffffff' } });
  const masterId = library.assets.find(asset => asset.provenance === 'icon').id;
  library = await ask('media_approve', { projectId, input: { expectedRevision: library.revision, assetId: masterId } });
  const iconSelection = { masterId, background: '#ffffff' };
  const diff = await ask('icon_preview', { projectId, input: iconSelection });
  await ask('icon_apply', { projectId, input: { ...iconSelection, expectedConfigRevision: diff.expectedConfigRevision, expectedMediaRevision: diff.expectedMediaRevision, proposedRevision: diff.proposedRevision, confirmed: true } });
  const inspector = await ask('inspector_setup_preview', { projectId });
  await ask('inspector_setup_apply', { projectId, proposedRevision: inspector.proposedRevision, confirmed: true });
  const job = await ask('media_request', { projectId, input: { requestId: randomUUID(), expectedRevision: library.revision, prompt: 'Offline staged fixture, never execute', operation: 'generate', quality: 'low', size: '1024x1024', label: 'Offline', role: 'illustration' } });
  assert.equal((await ask('media_job', { projectId, jobId: job.id })).state, 'awaiting-approval');
  assert.equal((await ask('media_cancel', { projectId, jobId: job.id })).state, 'cancelled');
  await ask('activity_list', { projectId });
  const assistantCapture = await ask('preview_capture', { projectId, route: '/desktop-review', viewport: 'large' });
  assert.equal(assistantCapture.width, 430);
  await ask('builder_mcp_read_resource', { uri: `builder://projects/${projectId}/captures/${assistantCapture.id}` });
  await ask('launch_kit_list', { projectId });
  await ask('launch_kit_read', { projectId, bundleId });
  const disposable = await ask('launch_kit_create', { projectId, input: { captureIds: [assistantCapture.id], listing: { name: 'Disposable assistant kit', summary: '', description: '' }, confirmed: true } });
  await ask('launch_kit_remove', { projectId, input: { bundleId: disposable.manifest.id, confirmed: true } });
  await ask('builder_mcp_read_resource', { uri: resource.uri });
  await ask('preview_stop', { projectId });
  previewUrl = (await ask('preview_start', { projectId })).url;
  for (const workspace of ['activity', 'icons', 'preview', 'assets']) await ask('studio_control', { expectedRevision: (await tool('studio_inspect', {})).revision, action: { type: 'navigate', workspace } });
  await ask('studio_control', { expectedRevision: (await tool('studio_inspect', {})).revision, action: { type: 'assets-tab', tab: 'launch-kit' } });
  const environment = await ask('backend_environment_inspect', { projectId, input: { environment: 'development' } });
  await ask('backend_environment_declare', { projectId, input: { environment: 'development', name: 'DESKTOP_TEST_VALUE', expectedSourceRevision: environment.sourceRevision } });
  await ask('backend_inspect', { projectId });
  await ask('recipe_upgrade_preview', { projectId });
  await ask('native_build_inspect', { projectId });
  const configuration = { iosBundleIdentifier: 'com.builder.desktopfixture', androidPackage: 'com.builder.desktopfixture', scheme: 'builder-desktop-fixture' };
  const native = await ask('native_build_plan', { projectId, configuration });
  await ask('native_build_apply', { projectId, input: { configuration, proposedRevision: native.proposedRevision, confirmed: true } });
  assert.equal((await tool('native_build_inspect', { projectId })).configuration.scheme, configuration.scheme);
  const selection = { profile: 'preview', platform: 'all', environment: 'none' };
  const preparation = await ask('native_workspace_plan', { projectId, selection });
  const workspace = await ask('native_workspace_prepare', { projectId, input: { selection, proposedRevision: preparation.proposedRevision, requestId: randomUUID(), confirmed: true } });
  let prepared;
  await expect.poll(async () => { prepared = (await tool('native_workspace_list', { projectId })).workspaces.find(value => value.id === workspace.id); return prepared.state; }, { timeout: 120_000 }).toBe('ready');
  assert.deepEqual(prepared.exports.map(value => value.platform), ['web', 'ios', 'android']);
  await ask('native_workspace_list', { projectId });
  await ask('native_workspace_remove', { projectId, input: { workspaceId: prepared.id, expectedRevision: prepared.revision, confirmed: true } });
  await control({ type: 'navigate', workspace: 'preview' });
  await page.getByRole('button', { name: 'Connect a device', exact: true }).click();
  const phone = page.getByRole('dialog', { name: 'Connect a device', exact: true });
  await expect(phone.getByRole('button', { name: 'Start phone preview', exact: true })).toBeVisible();
  await phone.press('Escape');
  await page.getByLabel('Preview tools', { exact: true }).click();
  await page.getByRole('button', { name: 'Build setup', exact: true }).click();
  const build = page.getByRole('dialog', { name: 'Build setup', exact: true });
  await expect(build.getByLabel('iOS bundle identifier', { exact: true })).toHaveValue(configuration.iosBundleIdentifier);
  await build.press('Escape');
  await ask('studio_control', { expectedRevision: (await tool('studio_inspect', {})).revision, action: { type: 'navigate', workspace: 'assets' } });
  await ask('studio_control', { expectedRevision: (await tool('studio_inspect', {})).revision, action: { type: 'assets-tab', tab: 'launch-kit' } });
  previewUrl = (await tool('preview_start', { projectId })).url;
  const exercised = [...assistant.calls].filter(name => !name.startsWith('builder_mcp_')).sort();
  for (const name of exercised) assert.ok(inventory.tools.some(tool => tool.name === name), `Undiscovered tool: ${name}`);
  for (const required of ['project_create', 'project_write_files', 'preview_start', 'preview_capture', 'media_approve', 'icon_apply', 'launch_kit_create', 'backend_environment_declare', 'native_build_apply', 'native_workspace_prepare', 'native_workspace_remove']) assert.ok(exercised.includes(required));
  assert.ok(assistant.imageRequests >= 3, 'Actual canonical media/capture PNGs reached the real provider adapter');
  assert.deepEqual(assistant.failures, []);
  const beforeReconnect = assistant.requests;
  // Test-only dialog answers; real desktop actions always retain native confirmation.
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }); });
  await page.evaluate(() => { globalThis.document.documentElement.dataset.reconnectCheck = 'old-document'; });
  await menu('Reconnect Studio…');
  await expect(page.locator('html')).not.toHaveAttribute('data-reconnect-check', 'old-document');
  await expect.poll(() => new URL(page.url()).hash).toBe('');
  await expect(page.getByRole('combobox', { name: 'Project', exact: true })).toContainText(project.name);
  assert.equal((await tool('project_inspect', { projectId })).preview.url, previewUrl);
  await client.close(); await transport.close(); await connect();
  assert.equal((await tool('project_inspect', { projectId })).preview.url, previewUrl);
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].close(); });
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), false);
  assert.equal((await fetch(previewUrl)).status, 200); await menu('Show Studio');
  await page.evaluate(() => { globalThis.open('https://example.com'); const a = globalThis.document.createElement('a'); a.href = 'file:///etc/passwd'; globalThis.document.body.append(a); a.click(); a.remove(); });
  await expect.poll(() => app.windows().length).toBe(1); assert.equal(new URL(page.url()).origin, origin);
  await page.evaluate(() => { globalThis.document.documentElement.dataset.restartCheck = 'old-document'; });
  await menu('Restart backend…');
  await expect(page.locator('html')).not.toHaveAttribute('data-restart-check', 'old-document', { timeout: 30_000 });
  await expect(page.getByRole('combobox', { name: 'Project', exact: true })).toBeVisible();
  assert.equal(new URL(page.url()).origin, origin);
  await client.close(); await transport.close(); await connect();
  origin = new URL(page.url()).origin;
  const restarted = await tool('project_inspect', { projectId }); assert.equal(restarted.preview.status, 'stopped'); assert.equal(restarted.captures.length, 0);
  const remembered = await command('studio_inspect'); assert.equal(remembered.projectId, projectId); assert.equal(remembered.studio.workspace, 'assets'); assert.equal(remembered.studio.assetsTab, 'launch-kit');
  assert.equal(remembered.studio.board.views.length, 2); assert.equal(remembered.studio.board.views[1].route, '/desktop-review'); assert.equal(remembered.studio.board.views[1].refresh, 0);
  const metadata = JSON.parse(await readFile(path.join(project.root, '.mobile-builder.json'), 'utf8')); assert.equal(metadata.project.id, projectId); assert.equal(metadata.studio.board.activeId, viewId);
  assert.deepEqual((await tool('launch_kit_read', { projectId, bundleId })).manifest, kit.manifest);
  media = await tool('media_list', { projectId }); assert.equal(media.capabilities.provider.configured, false); assert.equal(media.jobs.length, 1); assert.equal(media.jobs[0].state, 'cancelled');
  await page.getByRole('button', { name: 'Assistant', exact: true }).click();
  const restoredPanel = page.getByRole('dialog', { name: 'Assistant', exact: true });
  await expect(restoredPanel.getByText('Offline verified studio_control.', { exact: true }).last()).toBeVisible();
  await expect(restoredPanel.getByRole('button', { name: 'Send message' })).toBeDisabled();
  assert.equal(assistant.requests, beforeReconnect, 'Reconnect and restart never resubmit a prompt');
  const historyDir = path.join(root, 'home', 'assistant');
  for (const file of await readdir(historyDir)) {
    const history = await readFile(path.join(historyDir, file), 'utf8');
    assert.ok(!history.includes(fixtureKey)); assert.ok(!history.includes(png.toString('base64')));
  }
  assert.ok(!JSON.stringify(metadata).includes('Offline acceptance'));
  assert.deepEqual(errors, []);
  console.log(`PASS: ${inventory.tools.length} canonical tools discovered with exact policy parity; ${exercised.length} local tools exercised through real Pi/Assistant, resource/prompt/PNG round-trips, exact approvals, Inspector attachment, sandboxed two-phone desktop, shared MCP/CLI Engine, Launch Kit download, reconnect/hide/restart history, cleared credentials and owned shutdown. ${assistant.requests} local fixture requests; no external model/image calls. Native save-dialog interaction and visual quality require human review.`);
} finally {
  await client?.close(); await transport?.close(); await app?.close();
  for (const url of [origin, previewUrl].filter(Boolean)) await expect.poll(() => fetch(url, { signal: AbortSignal.timeout(2000) }).then(() => false, () => true)).toBe(true);
  await assistant.close();
  await rm(root, { recursive: true, force: true });
}
