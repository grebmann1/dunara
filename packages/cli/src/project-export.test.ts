import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { beforeEach, afterEach, expect, it } from 'vitest';
import { Engine } from '../../core/src/engine.js';
import { Projects } from '../../core/src/projects.js';
import { startStudio } from './studio-server.js';

let root: string, engine: Engine, studio: Awaited<ReturnType<typeof startStudio>>, headers: Record<string, string>, id: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'project-export-http-'));
  engine = new Engine(await Projects.open(path.join(root, 'apps'), path.join(root, 'home')), false);
  const project = await engine.projects.create({ name: 'Download', slug: 'download' }); id = project.id;
  await writeFile(path.join(project.root, '.env'), 'PRIVATE_DOWNLOAD_SENTINEL=secret');
  studio = await startStudio(engine, path.resolve('dist/studio'));
  const response = await fetch(`${studio.origin}/api/bootstrap`, { method: 'POST', headers: { Origin: studio.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket: new URL(studio.launchUrl).hash.slice(1) }) });
  headers = { Origin: studio.origin, Authorization: `Bearer ${(await response.json()).token}` };
});
afterEach(async () => { await studio.close(); await engine.close(); await rm(root, { recursive: true, force: true }); });
it('requires authentication and same-origin access and returns a named no-store ZIP', async () => {
  const url = `${studio.origin}/api/projects/${id}/download`;
  expect((await fetch(url)).status).toBe(401);
  expect((await fetch(url, { headers: { ...headers, Origin: 'https://untrusted.invalid' } })).status).toBe(403);
  expect((await fetch(url, { method: 'POST', headers })).status).toBe(405);
  const response = await fetch(url, { headers });
  expect(response.status).toBe(200); expect(response.headers.get('Content-Type')).toBe('application/zip');
  expect(response.headers.get('Content-Disposition')).toBe('attachment; filename="download.zip"'); expect(response.headers.get('Cache-Control')).toBe('no-store');
  const archive = Buffer.from(await response.arrayBuffer()); expect(archive.readUInt32LE(0)).toBe(0x04034b50);
  expect(archive.length).toBe(Number(response.headers.get('Content-Length')));
});
it('does not allow arbitrary paths or an unregistered project to be exported', async () => {
  // Fetch normalizes the encoded parent segment before it reaches the server.
  for (const [endpoint, status] of [[`/api/projects/00000000-0000-4000-8000-000000000000/download`, 400], [`/api/projects/${id}/download?path=/`, 400], [`/api/projects/${id}/download/%2e%2e`, 404]] as const) {
    const response = await fetch(studio.origin + endpoint, { headers });
    expect(response.status).toBe(status); expect(response.headers.get('Content-Type')).toBe('application/json');
    expect(await response.text()).not.toContain('PRIVATE_DOWNLOAD_SENTINEL');
  }
});
