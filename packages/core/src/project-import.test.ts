import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { Projects } from './projects.js';
import { ProjectExports } from './project-export.js';
import { ProjectImports, readProjectZip } from './project-import.js';

let root: string, projects: Projects;
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), 'dunara-import-')); projects = await Projects.open(path.join(root, 'apps'), path.join(root, 'home')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
it('recovers an exported app with fresh identity, exact source and idempotent reviewed import', async () => {
  const original = await projects.create({ name: 'Original', slug: 'original' });
  const archive = await new ProjectExports(projects).download(original.id);
  const importer = new ProjectImports(projects, () => 'account-a');
  const review = await importer.review(archive.bytes);
  expect((await projects.list()).length).toBe(1);
  const input = { id: review.id, revision: review.revision, name: 'Recovered', slug: 'recovered', confirmed: true };
  const recovered = await importer.apply(input);
  expect(recovered.id).not.toBe(original.id);
  expect(await readFile(path.join(recovered.root, 'app/index.tsx'))).toEqual(await readFile(path.join(original.root, 'app/index.tsx')));
  expect((await importer.apply(input)).id).toBe(recovered.id);
  await expect(importer.apply({ ...input, slug: 'another-copy' })).rejects.toThrow('already imported');
  expect(await readFile(path.join(recovered.root, '.mobile-builder.json'), 'utf8')).toContain(recovered.id);
});
it('rejects changed reviews, account switches and occupied folders without replacing source', async () => {
  let context = 'account-a'; const importer = new ProjectImports(projects, () => context);
  const original = await projects.create({ name: 'Original', slug: 'original' });
  const review = await importer.review((await new ProjectExports(projects).download(original.id)).bytes);
  const input = { id: review.id, revision: review.revision, name: 'Recovered', slug: 'original', confirmed: true };
  await expect(importer.apply(input)).rejects.toThrow('already exists');
  await expect(importer.apply({ ...input, revision: 'stale' })).rejects.toThrow('expired');
  context = 'account-b'; await expect(importer.apply({ ...input, slug: 'new-copy' })).rejects.toThrow('account');
  expect((await projects.list()).length).toBe(1);
});
it.each(['../escape.ts', '/absolute.ts', 'a\\escape.ts', 'link'])('rejects unsafe ZIP entry %s before writing files', async name => {
  const file = path.join(root, 'bad.zip');
  await promisify(execFile)('python3', ['-c', 'import zipfile,sys; z=zipfile.ZipFile(sys.argv[1],"w"); i=zipfile.ZipInfo(sys.argv[2]); i.create_system=3; i.external_attr=(0o120777 if sys.argv[2]=="link" else 0o100644)<<16; z.writestr(i,"payload"); z.close()', file, name]);
  await expect(readProjectZip(await readFile(file))).rejects.toThrow();
  expect((await projects.list()).length).toBe(0);
});
