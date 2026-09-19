import { cp, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Engine } from './engine.js';
import { Projects } from './projects.js';
import { serviceRecipePaths } from './service-recipe.js';

let root: string, engine: Engine, id: string, appRoot: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'service-recipe-'));
  engine = new Engine(await Projects.open(path.join(root, 'apps'), path.join(root, 'home')), true);
  const project = await engine.projects.create({ name: 'Services', slug: 'services' }); id = project.id; appRoot = project.root;
  for (const file of serviceRecipePaths) await rm(path.join(appRoot, file));
});
afterEach(async () => { vi.restoreAllMocks(); await engine.close(); await rm(root, { recursive: true, force: true }); });
it('adds only reviewed service sources and leaves the existing app and dependencies intact', async () => {
  const preserved = await Promise.all(['package.json', 'package-lock.json', 'app/account.tsx', 'app/_layout.tsx'].map(async file => [file, await readFile(path.join(appRoot, file), 'utf8')] as const));
  const plan = await engine.serviceRecipe.preview(id);
  expect(plan.conflicts).toEqual([]); expect(plan.files.map(f => f.path)).toEqual(serviceRecipePaths);
  const result = await engine.serviceRecipe.apply(id, { proposedRevision: plan.proposedRevision, confirmed: true });
  expect(result.written).toEqual(serviceRecipePaths); expect((await engine.serviceRecipe.preview(id)).files).toEqual([]);
  for (const [file, content] of preserved) expect(await readFile(path.join(appRoot, file), 'utf8')).toBe(content);
});
it.each(['app/(auth)/oauth-callback.tsx', 'app/private-files/index.tsx', 'src/backend/social.web.ts', 'supabase/migrations/20260917000300_custom.sql'])('preserves a conflicting source at %s', async relative => {
  await mkdir(path.dirname(path.join(appRoot, relative)), { recursive: true }); await writeFile(path.join(appRoot, relative), '// Existing application');
  const plan = await engine.serviceRecipe.preview(id); expect(plan.conflicts.length).toBeGreaterThan(0);
  await expect(engine.serviceRecipe.apply(id, { proposedRevision: plan.proposedRevision, confirmed: true })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  expect(await readFile(path.join(appRoot, relative), 'utf8')).toBe('// Existing application');
});
it('fences changed source, custom routing, replaced project roots and symlinks before writes', async () => {
  const plan = await engine.serviceRecipe.preview(id);
  await writeFile(path.join(appRoot, 'src/backend/client.ts'), '// Edited client');
  await expect(engine.serviceRecipe.apply(id, { proposedRevision: plan.proposedRevision, confirmed: true })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  const fresh = await engine.serviceRecipe.preview(id);
  await rename(appRoot, appRoot + '-old'); await cp(appRoot + '-old', appRoot, { recursive: true });
  await expect(engine.serviceRecipe.apply(id, { proposedRevision: fresh.proposedRevision, confirmed: true })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  await symlink(path.join(root, 'outside'), path.join(appRoot, 'app/linked'));
  await expect(engine.serviceRecipe.preview(id)).rejects.toThrow('Symlinks');
  await rm(path.join(appRoot, 'app/linked')); await mkdir(path.join(appRoot, 'src/app'));
  expect((await engine.serviceRecipe.preview(id)).conflicts.length).toBeGreaterThan(0);
});
