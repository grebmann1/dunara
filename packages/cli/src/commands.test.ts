import sharp from 'sharp';
import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { Engine } from '../../core/src/engine.js';
import { Projects } from '../../core/src/projects.js';
import { startDesktopMcp } from '../../mcp/src/socket.js';
import { startStudio } from './studio-server.js';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const exec = promisify(execFile);
let root: string, engine: Engine, endpoint: Awaited<ReturnType<typeof startDesktopMcp>>, studio: Awaited<ReturnType<typeof startStudio>>;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'builder-command-'));
  engine = new Engine(await Projects.open(path.join(root, 'apps'), path.join(root, 'home')), false);
  endpoint = await startDesktopMcp(engine); studio = await startStudio(engine, path.resolve('dist/studio'));
});
afterEach(async () => { await endpoint.close(); await studio.close(); await engine.close(); await rm(root, { recursive: true, force: true }); });
async function command(...args: string[]) {
  const result = await exec(process.execPath, ['dist/packages/cli/src/index.js', '--desktop-connect', endpoint.socketPath, ...args], { timeout: 15_000 });
  return JSON.parse(result.stdout);
}
it('loads a Dunara-specific env file without Node importing arbitrary dotenv settings', async () => {
  const file = path.join(root, '.env'), sentinel = 'offline-cli-credential-SENTINEL';
  await writeFile(file, `OPENAI_API_KEY=${sentinel}\nNODE_OPTIONS=--require=nonexistent-credential-probe.cjs\nPATH=/hostile\n`, { mode: 0o600 });
  for (const [envFile, configured] of [[file, true], [path.join(root, 'missing.env'), false]] as const) {
    const client = new Client({ name: 'credential-startup-test', version: '1' });
    const transport = new StdioClientTransport({ command: process.execPath, args: [path.resolve('dist/packages/cli/src/index.js'), '--workspace', path.join(root, 'credential-apps'), '--home', path.join(root, 'credential-home'), '--builder-env-file', envFile], env: { PATH: process.env.PATH ?? '' }, stderr: 'pipe' });
    let diagnostics = '';
    transport.stderr?.on('data', chunk => { diagnostics += String(chunk); });
    try {
      await client.connect(transport);
      const created = await client.callTool({ name: 'project_create', arguments: { name: 'Credential startup', slug: configured ? 'configured' : 'unconfigured' } });
      const { project } = z.object({ project: z.object({ id: z.uuid() }) }).parse(created.structuredContent);
      const result = await client.callTool({ name: 'media_list', arguments: { projectId: project.id } });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ capabilities: { provider: { configured, source: configured ? 'environment' : 'none' } } });
      expect(JSON.stringify(result)).not.toContain(sentinel);
    } finally { await client.close(); }
    expect(diagnostics).not.toContain(sentinel);
  }
}, 20_000);
it('runs JSON CLI commands against the same authenticated Studio and Engine', async () => {
  expect((await command('tools')).tools).toHaveLength(93);
  const { project } = (await command('call', 'project_create', '--input', JSON.stringify({ name: 'Command', slug: 'command' }))).structuredContent;
  const initial = (await command('call', 'studio_inspect')).structuredContent;
  const id = randomUUID();
  const opened = (await command('call', 'studio_control', '--input', JSON.stringify({ expectedRevision: initial.revision, action: { type: 'add', id } }))).structuredContent;
  expect(opened.studio.board.views).toHaveLength(2);
  const file = path.join(root, 'input.json'); await writeFile(file, JSON.stringify({ expectedRevision: opened.revision, action: { type: 'update', id, patch: { route: '/habit', viewport: 'large' } } }));
  await command('call', 'studio_control', '--input-file', file);
  const bootstrap = await fetch(`${studio.origin}/api/bootstrap`, { method: 'POST', headers: { Origin: studio.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket: new URL(studio.launchUrl).hash.slice(1) }) });
  const headers = { Authorization: `Bearer ${(await bootstrap.json()).token}`, Origin: studio.origin, 'Content-Type': 'application/json' };
  expect((await fetch(`${studio.origin}/api/studio`)).status).toBe(401);
  const shared = await (await fetch(`${studio.origin}/api/studio`, { headers })).json();
  expect(shared.projectId).toBe(project.id); expect(shared.studio.board.views[1]).toMatchObject({ id, route: '/habit', viewport: 'large' });
  expect((await fetch(`${studio.origin}/api/studio`, { method: 'POST', headers: { ...headers, Origin: 'https://hostile.test' }, body: JSON.stringify({ expectedRevision: shared.revision, action: { type: 'navigate', workspace: 'icons' } }) })).status).toBe(403);
  const response = await fetch(`${studio.origin}/api/studio`, { method: 'POST', headers, body: JSON.stringify({ expectedRevision: shared.revision, action: { type: 'navigate', workspace: 'icons' } }) });
  expect(response.status).toBe(200); expect((await command('call', 'studio_inspect')).structuredContent.studio.workspace).toBe('icons');
  expect((await command('call', 'activity_list', '--input', JSON.stringify({ projectId: project.id }))).structuredContent.captures).toEqual([]);
  expect((await command('resource', 'builder://projects')).contents).toHaveLength(1);
  expect(engine.previews.status(project.id).status).toBe('stopped'); expect(engine.mediaJobs.providerStatus().configured).toBe(false);
// Seven independent CLI processes share this test budget on slower CI runners.
// Each command still has its own 15-second deadline.
}, 60_000);
it('returns nonzero JSON errors for conflicts and prevents competing runtimes or approval bypasses', async () => {
  await engine.projects.create({ name: 'Errors', slug: 'errors' });
  const state = await engine.studio.snapshot(); await engine.studio.control({ expectedRevision: state.revision, action: { type: 'navigate', workspace: 'activity' } });
  for (const args of [
    ['call', 'studio_control', '--input', JSON.stringify({ expectedRevision: state.revision, action: { type: 'navigate', workspace: 'assets' } })],
    ['call', 'studio_control', '--input', '{bad'], ['call', 'media_approve_spending'], ['call', 'project_list', '--workspace', path.join(root, 'forbidden')],
    ['call', 'project_list', '--input', '[]'], ['tools', '--input', '{}'], ['call', 'project_list', '--input', '{}', '--input-file', 'unused'],
  ]) {
    try { await command(...args); expect.fail('Command unexpectedly succeeded'); } catch (error) {
      expect(error).toMatchObject({ code: 1 }); expect(() => JSON.parse((error as { stdout: string }).stdout)).not.toThrow();
    }
  }
  expect(await engine.projects.list()).toHaveLength(1);
}, 30_000);

it('discovers an existing runtime and reconnects by home over JSON CLI and stdio MCP', async () => {
  const discovered = JSON.parse((await exec(process.execPath, ['dist/packages/cli/src/index.js', 'runtimes'])).stdout);
  expect(discovered.runtimes).toContainEqual(expect.objectContaining({ home: engine.projects.home, socketPath: endpoint.socketPath }));
  const args = ['dist/packages/cli/src/index.js', '--connect-home', engine.projects.home];
  expect(JSON.parse((await exec(process.execPath, [...args, 'tools'])).stdout).tools).toHaveLength(93);
  const client = new Client({ name: 'home-bridge', version: '1' });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args, stderr: 'pipe' }));
    expect((await client.callTool({ name: 'project_list', arguments: {} })).isError).not.toBe(true);
  } finally { await client.close(); }
  await endpoint.close(); endpoint = await startDesktopMcp(engine);
  expect(JSON.parse((await exec(process.execPath, [...args, 'tools'])).stdout).tools).toHaveLength(93);
  expect(await engine.projects.list()).toEqual([]);
}, 30_000);
it('discovers resources and prompts and writes real image bytes for an agent image viewer', async () => {
  expect((await command('resources')).resources.map((item: { uri: string }) => item.uri)).toContain('builder://capabilities');
  expect((await command('resource-templates')).resourceTemplates.some((item: { uriTemplate: string }) => item.uriTemplate.includes('/downloads/'))).toBe(true);
  expect((await command('prompts')).prompts[0].name).toBe('build-mobile-app');
  expect((await command('prompt', 'build-mobile-app', '--input', JSON.stringify({ brief: 'A reading app' }))).messages[0].content.text).toContain('A reading app');
  const project = await engine.projects.create({ name: 'Picture', slug: 'picture' });
  const png = await sharp({ create: { width: 20, height: 20, channels: 4, background: '#467855' } }).png().toBuffer();
  const state = await engine.assets.import(project.id, { label: 'Fixture', role: 'other', mediaType: 'image/png', expectedRevision: null }, png);
  const asset = state.assets[0]!, expected = (await engine.assets.read(project.id, asset.id)).bytes;
  const destination = path.join(root, 'reference.png');
  const saved = await command('call', 'media_read', '--input', JSON.stringify({ projectId: project.id, assetId: asset.id }), '--output', destination);
  expect(saved.output).toMatchObject({ bytes: expected.length, sha256: createHash('sha256').update(expected).digest('hex'), mimeType: 'image/png' });
  expect(await readFile(destination)).toEqual(expected); expect((await stat(destination)).mode & 0o777).toBe(0o600);
  const resourceFile = path.join(root, 'resource.png');
  await command('resource', `builder://projects/${project.id}/media/${asset.id}`, '--output', resourceFile);
  expect(await readFile(resourceFile)).toEqual(expected);
  await expect(command('resource', `builder://projects/${project.id}/media/${asset.id}`, '--output', destination)).rejects.toMatchObject({ code: 1 });
  expect(await readFile(destination)).toEqual(expected);
  await expect(command('call', 'project_create', '--input', JSON.stringify({ name: 'Not created', slug: 'not-created' }), '--output', destination)).rejects.toMatchObject({ code: 1 });
  expect(await engine.projects.list()).toHaveLength(1);
}, 60_000);
it('exports and imports a project entirely through CLI with shared expiring review and no backend opt-in', async () => {
  const project = await engine.projects.create({ name: 'Portable', slug: 'portable' });
  await mkdir(path.join(project.root, 'assets'));
  await writeFile(path.join(project.root, 'assets', 'fixture.bin'), randomBytes(5 * 1024 * 1024));
  const zip = path.join(root, 'project.zip');
  const exported = await command('call', 'project_export', '--input', JSON.stringify({ projectId: project.id }), '--output', zip);
  const bytes = await readFile(zip); expect(bytes.length).toBeGreaterThan(4 * 1024 * 1024); expect(bytes.readUInt32LE()).toBe(0x04034b50);
  expect(exported.output.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
  const file = path.join(root, 'archive.json'); await writeFile(file, JSON.stringify({ zip: bytes.toString('base64') }));
  const review = (await command('call', 'project_import_review', '--input-file', file)).structuredContent;
  expect(engine.projectImports.inspect(review.id).revision).toBe(review.revision);
  expect(await engine.projects.list()).toHaveLength(1);
  const input = { id: review.id, revision: review.revision, name: 'Imported', slug: 'imported', confirmed: true };
  const imported = (await command('call', 'project_import_apply', '--input', JSON.stringify(input))).structuredContent.project;
  expect(await engine.projects.list()).toHaveLength(2);
  const backends = (await command('call', 'project_backend_list', '--input', JSON.stringify({ projectId: imported.id }))).structuredContent.backends;
  expect(backends.every((backend: { enabled: boolean }) => !backend.enabled)).toBe(true);
  expect((await command('call', 'project_import_apply', '--input', JSON.stringify(input))).structuredContent.project.id).toBe(imported.id);
  await expect(command('call', 'project_import_apply', '--input', JSON.stringify({ ...input, slug: 'changed' }))).rejects.toMatchObject({ code: 1 });
}, 60_000);
