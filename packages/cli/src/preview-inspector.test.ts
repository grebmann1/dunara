import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { Engine } from '../../core/src/engine.js';
import { Projects } from '../../core/src/projects.js';
import { startStudio } from './studio-server.js';
it('keeps setup authenticated, origin-checked, project-scoped and non-generic', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'builder-inspector-api-'));
  const engine = new Engine(await Projects.open(path.join(dir, 'apps'), path.join(dir, 'home')), false);
  const project = await engine.projects.create({ name: 'Inspect', slug: 'inspect' });
  const studio = await startStudio(engine, path.resolve('dist/studio'));
  try {
    const bootstrap = await fetch(studio.origin + '/api/bootstrap', { method: 'POST', headers: { Origin: studio.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket: new URL(studio.launchUrl).hash.slice(1) }) });
    const headers = { Origin: studio.origin, 'Content-Type': 'application/json', Authorization: `Bearer ${(await bootstrap.json()).token}` };
    const url = `${studio.origin}/api/projects/${project.id}/inspector/`;
    const post = (action: string, input: unknown, extra = {}) => fetch(url + action, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(input) });
    expect((await post('setup-preview', {}, { Authorization: '' })).status).toBe(401);
    expect((await post('setup-preview', {}, { Origin: 'http://localhost:1' })).status).toBe(403);
    expect((await post('setup-preview', { path: '../outside.ts' })).status).toBe(400);
    const proposal = await (await post('setup-preview', {})).json(); expect(proposal.installed).toBe(true);
    expect((await post('setup-apply', { projectId: project.id, proposedRevision: proposal.proposedRevision, confirmed: false })).status).toBe(400);
    const applied = await post('setup-apply', { projectId: project.id, proposedRevision: proposal.proposedRevision, confirmed: true });
    expect(applied.status).toBe(200); expect(await applied.json()).toEqual({ applied: [] });
    expect((await fetch(url + 'setup-preview', { headers })).status).toBe(405);
  } finally { await studio.close(); await engine.close(); await rm(dir, { recursive: true, force: true }); }
});
