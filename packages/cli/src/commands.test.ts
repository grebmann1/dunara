import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
  expect((await command('tools')).tools).toHaveLength(65);
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
}, 30_000);
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
