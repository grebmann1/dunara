import { mkdtemp, rm, writeFile, mkdir, rename, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Engine } from './engine.js';
import { Projects } from './projects.js';
import { applyInspectorSetup, previewInspectorSetup } from './preview-inspector.js';
let dir: string, engine: Engine, id: string, root: string;
const layout = '"use client";\nexport default function Layout() { return null; }\n';
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'builder-inspector-'));
  engine = new Engine(await Projects.open(path.join(dir, 'apps'), path.join(dir, 'home')), false);
  const project = await engine.projects.create({ name: 'Inspect', slug: 'inspect' }); id = project.id; root = project.root;
});
afterEach(async () => { vi.restoreAllMocks(); await engine.close(); await rm(dir, { recursive: true, force: true }); });
async function legacy() { await writeFile(path.join(root, 'app/_layout.tsx'), layout); for (const file of ['src/builder-inspector.tsx', 'src/builder-inspector.web.tsx']) await rm(path.join(root, file)); }
const confirm = (hash: string) => ({ projectId: id, proposedRevision: hash, confirmed: true });
it('leaves new starters unchanged and is idempotent', async () => {
  const p = await previewInspectorSetup(engine, id); expect(p.installed).toBe(true);
  expect(await applyInspectorSetup(engine, id, confirm(p.proposedRevision))).toEqual({ applied: [] });
});
it('previews full exact changes without writes, preserves directives and installs helpers first', async () => {
  await legacy(); const p = await previewInspectorSetup(engine, id);
  expect((await engine.files.read(id, 'app/_layout.tsx')).content).toBe(layout);
  expect(p.files.slice(0, 2).every(file => file.expectedRevision === null)).toBe(true);
  expect(p.files[2]!.after.startsWith(layout)).toBe(true);
  expect((await applyInspectorSetup(engine, id, confirm(p.proposedRevision))).applied.map(file => file.path)).toEqual(p.files.map(file => file.path));
  expect((await previewInspectorSetup(engine, id)).installed).toBe(true);
});
it('supports src/app layouts with the right relative import', async () => {
  await legacy(); await mkdir(path.join(root, 'src/app')); await rename(path.join(root, 'app/_layout.tsx'), path.join(root, 'src/app/_layout.tsx'));
  const p = await previewInspectorSetup(engine, id); expect(p.files[2]!.after).toContain("import '../builder-inspector';");
  await applyInspectorSetup(engine, id, confirm(p.proposedRevision));
});
it('rejects stale, unconfirmed, cross-project, replaced-root and arbitrary write proposals', async () => {
  await legacy(); const p = await previewInspectorSetup(engine, id);
  await expect(applyInspectorSetup(engine, id, { ...confirm(p.proposedRevision), confirmed: false })).rejects.toThrow();
  await expect(applyInspectorSetup(engine, id, { ...confirm(p.proposedRevision), files: [{ path: '../outside', content: 'bad' }] })).rejects.toThrow();
  const other = await engine.projects.create({ name: 'Other', slug: 'other' });
  await expect(applyInspectorSetup(engine, other.id, confirm(p.proposedRevision))).rejects.toThrow('another project');
  await writeFile(path.join(root, 'app/_layout.tsx'), layout + '// change\n');
  await expect(applyInspectorSetup(engine, id, confirm(p.proposedRevision))).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  const fresh = await previewInspectorSetup(engine, id);
  await rename(root, root + '-old'); await mkdir(root); await symlink(root + '-old/app', path.join(root, 'app'));
  await expect(applyInspectorSetup(engine, id, confirm(fresh.proposedRevision))).rejects.toThrow();
});
it('refuses ambiguous, invalid, edited and symlinked files without overwriting', async () => {
  await mkdir(path.join(root, 'src/app')); await writeFile(path.join(root, 'src/app/_layout.tsx'), layout);
  await expect(previewInspectorSetup(engine, id)).rejects.toThrow('exactly one');
  await rm(path.join(root, 'src/app/_layout.tsx'));
  await writeFile(path.join(root, 'app/_layout.tsx'), 'export default function ( {');
  await expect(previewInspectorSetup(engine, id)).rejects.toThrow('syntax');
  await writeFile(path.join(root, 'app/_layout.tsx'), layout);
  await writeFile(path.join(root, 'src/builder-inspector.tsx'), '// customized');
  await expect(previewInspectorSetup(engine, id)).rejects.toThrow('Conflicting');
  await rm(path.join(root, 'src/builder-inspector.tsx')); await symlink(path.join(root, 'app/_layout.tsx'), path.join(root, 'src/builder-inspector.tsx'));
  await expect(previewInspectorSetup(engine, id)).rejects.toThrow('Symlinks');
});
it('reports partial writes and permits a freshly reviewed safe retry', async () => {
  await legacy(); const p = await previewInspectorSetup(engine, id);
  const original = engine.files.resolve.bind(engine.files); let calls = 0;
  vi.spyOn(engine.files, 'resolve').mockImplementation(async (project, file) => {
    // Proposal reads the path once; prevalidation once; each write twice.
    if (file === 'src/builder-inspector.web.tsx' && ++calls === 3) throw new Error('Interrupted test write');
    return original(project, file);
  });
  await expect(applyInspectorSetup(engine, id, confirm(p.proposedRevision))).rejects.toMatchObject({ code: 'WRITE_FAILED', details: { applied: [{ path: 'src/builder-inspector.tsx' }] } });
  vi.restoreAllMocks(); expect((await engine.files.read(id, 'app/_layout.tsx')).content).toBe(layout);
  const next = await previewInspectorSetup(engine, id); expect(next.proposedRevision).not.toBe(p.proposedRevision);
  await applyInspectorSetup(engine, id, confirm(next.proposedRevision)); expect((await previewInspectorSetup(engine, id)).installed).toBe(true);
});
