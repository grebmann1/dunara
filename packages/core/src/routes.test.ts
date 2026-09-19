import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { discoverRoutes } from './routes.js';
import { Projects } from './projects.js';
import { Engine } from './engine.js';
const discover = (files: string[], truncated = false) => discoverRoutes({ files, truncated });
it('discovers static, index, grouped and dynamic routes in either conventional root without interpreting code', () => {
  for (const root of ['app/', 'src/app/']) {
    const result = discover(['index.tsx', '(tabs)/wiki.tsx', '(tabs)/care/index.js', 'species/[id].tsx', '[...rest].tsx', '_layout.tsx', '+not-found.tsx', 'hook+api.ts', 'other.web.tsx'].map(file => root + file));
    expect(result.candidates.map(c => [c.path, c.kind])).toEqual([['/', 'static'], ['/[...rest]', 'dynamic'], ['/care', 'static'], ['/species/[id]', 'dynamic'], ['/wiki', 'static']]);
    expect(result.warnings.join(' ')).toContain('platform');
  }
});
it('deduplicates deterministically and marks competing roots/group routes ambiguous', () => {
  const files = ['app/(second)/wiki.tsx', 'app/(first)/wiki.tsx', 'src/app/wiki.tsx'];
  const result = discover(files); expect(result).toEqual(discover([...files].reverse()));
  expect(result.candidates).toEqual([{ path: '/wiki', kind: 'static', files: [...files].sort(), ambiguous: true }]);
  expect(result.roots).toEqual(['app/', 'src/app/']);
});
it('does not invent URLs for unsupported, special, API, declaration or platform files; reports truncation', () => {
  const result = discover(['app/_layout.tsx', 'app/+html.tsx', 'app/item+api.ts', 'app/file.d.ts', 'app/(one,two)/index.tsx', 'app/[[id]].tsx', 'app/item.ios.tsx', 'app/item.android.tsx', 'app/item.native.tsx', 'app/item.web.tsx', 'app/bad space.tsx', 'src/screens/elsewhere.tsx'], true);
  expect(result.candidates).toEqual([]); expect(result.truncated).toBe(true); expect(result.warnings.join(' ')).toContain('truncated');
  expect(discover([]).candidates).toEqual([]);
});
it('reconciles safe source additions/removals, skips symlinks, preserves legacy routes and reports bounded traversal', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'route-candidates-'));
  const engine = new Engine(await Projects.open(path.join(dir, 'apps'), path.join(dir, 'home')), false);
  try {
    const project = await engine.projects.create({ name: 'Routes', slug: 'routes' });
    const before = await engine.inspect(project.id);
    await engine.files.write(project.id, [{ path: 'app/wiki.tsx', content: 'throw new Error("MUST NEVER EXECUTE")', expectedRevision: null }, { path: 'app/species/[id].tsx', content: '// dynamic', expectedRevision: null }]);
    const after = await engine.inspect(project.id); expect(after.routes).toEqual(before.routes);
    expect(after.routeCandidates.candidates).toEqual(expect.arrayContaining([expect.objectContaining({ path: '/wiki' }), expect.objectContaining({ path: '/species/[id]', kind: 'dynamic' })]));
    await rm(path.join(project.root, 'app/wiki.tsx'));
    await writeFile(path.join(dir, 'outside.tsx'), 'private'); await symlink(path.join(dir, 'outside.tsx'), path.join(project.root, 'app/linked.tsx'));
    expect((await engine.inspect(project.id)).routeCandidates.candidates.map(c => c.path)).not.toContain('/linked');
    expect((await engine.inspect(project.id)).routeCandidates.candidates.map(c => c.path)).not.toContain('/wiki');
    const deep = path.join(project.root, 'app/a/b/c/d/e/f/g/h/i'); await mkdir(deep, { recursive: true }); await writeFile(path.join(deep, 'index.tsx'), '');
    expect((await engine.inspect(project.id)).routeCandidates.truncated).toBe(true);
  } finally { await engine.close(); await rm(dir, { recursive: true, force: true }); }
});

it('names and orders safe screens from literal navigator titles, excluding dynamic and ambiguous routes', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'named-screens-'));
  const engine = new Engine(await Projects.open(path.join(dir, 'apps'), path.join(dir, 'home')), false);
  try {
    const project = await engine.projects.create({ name: 'Names', slug: 'names' });
    const layout = await engine.files.read(project.id, 'app/_layout.tsx');
    await engine.files.write(project.id, [{ path: layout.path, expectedRevision: layout.revision, content: `throw new Error('Never execute'); <Tabs><Tabs.Screen name="habit" options={{title: 'Ritual'}}/><Tabs.Screen name="index" options={{title:'Tonight'}}/><Tabs.Screen name="progress" options={{title: computedName()}}/></Tabs>` }, { path: 'app/person/[id].tsx', expectedRevision: null, content: '// requires concrete values' }]);
    expect((await engine.inspect(project.id)).screens).toEqual([{ route: '/habit', name: 'Ritual' }, { route: '/', name: 'Tonight' }, { route: '/account', name: 'Account' }, { route: '/oauth-callback', name: 'Oauth Callback' }, { route: '/private-files', name: 'Private Files' }, { route: '/progress', name: 'Progress' }]);
  } finally { await engine.close(); await rm(dir, { recursive: true, force: true }); }
});
