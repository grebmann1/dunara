import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { z } from 'zod';
import { Engine } from '../../core/src/engine.js';
import { Projects } from '../../core/src/projects.js';
import { scaffoldPlugin } from '../../cli/src/plugin-commands.js';
import { archivePackage, inspectPackage } from './packages.js';
import { manifestSchema } from './contracts.js';

let root: string, source: string, engine: Engine, projectId: string;
async function start() { engine = new Engine(await Projects.open(path.join(root, 'apps'), path.join(root, 'home')), false, false, undefined, {}, {}, undefined, { encryptionKey: 'a'.repeat(64) }); await engine.plugins.ready; }
async function install() { const pkg = await inspectPackage(source); await engine.plugins.install(source, pkg.digest, true); return pkg; }
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), 'builder-plugins-')); source = path.join(root, 'sample'); await scaffoldPlugin(source); await start(); projectId = (await engine.projects.create({ name: 'Plugin app', slug: 'plugin-app' })).id; });
afterEach(async () => { await engine.close(); await rm(root, { recursive: true, force: true }); });
it('discovers backend workspaces only from a validated, enabled plugin package', async () => {
  const manifest = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8'));
  manifest.builder.workspacePanel = 'backend'; manifest.builder.workspaceGroup = 'backend';
  expect(manifestSchema.safeParse({ ...manifest.builder, app: undefined }).success).toBe(false);
  expect(manifestSchema.safeParse({ ...manifest.builder, workspacePanel: undefined }).success).toBe(false);
  expect(manifestSchema.safeParse({ ...manifest.builder, workspaceGroup: 'unknown' }).success).toBe(false);
  await writeFile(path.join(source, 'package.json'), JSON.stringify(manifest));
  await install();
  expect(engine.plugins.snapshot().find(plugin => plugin.id === manifest.builder.id)).toMatchObject({ workspacePanel: 'backend', workspaceGroup: 'backend', status: 'active', appUrl: expect.any(String) });
  await engine.plugins.change(manifest.builder.id, 'disable');
  const disabled = engine.plugins.snapshot().find(plugin => plugin.id === manifest.builder.id)!;
  expect(disabled.status).toBe('disabled'); expect(disabled.appUrl).toBeUndefined();
  await engine.close(); await start();
  expect(engine.plugins.snapshot().find(plugin => plugin.id === manifest.builder.id)).toMatchObject({ workspaceGroup: 'backend', status: 'disabled' });
});
it('installs defaults offline and preserves disabled and removed defaults across restart', async () => {
  expect(engine.plugins.snapshot()).toHaveLength(9); expect(engine.plugins.snapshot().every(p => p.status === 'active')).toBe(true);
  await engine.plugins.change('builder.plugin-guide', 'uninstall'); await engine.plugins.change('builder.icons', 'disable');
  await engine.close(); await start();
  expect(engine.plugins.snapshot().some(p => p.id === 'builder.plugin-guide')).toBe(false);
  expect(engine.plugins.snapshot().find(p => p.id === 'builder.icons')?.status).toBe('disabled');
  await engine.plugins.restoreDefaults(); expect(engine.plugins.isEnabled('builder.plugin-guide')).toBe(true); expect(engine.plugins.isEnabled('builder.icons')).toBe(false);
});
it('requires trust and an unchanged package digest, reserves builtin identities, and rejects traversal/symlinks', async () => {
  const pkg = await inspectPackage(source);
  await expect(engine.plugins.install(source, pkg.digest, false)).rejects.toThrow('trust');
  await writeFile(path.join(source, 'user.md'), 'Changed'); await expect(engine.plugins.install(source, pkg.digest, true)).rejects.toThrow('changed');
  await symlink(path.join(source, 'user.md'), path.join(source, 'linked.md')); await expect(inspectPackage(source)).rejects.toThrow('symlink'); await rm(path.join(source, 'linked.md'));
  const bad = path.join(root, 'bad.builder-plugin.json'); await writeFile(bad, JSON.stringify({ format: 'builder-plugin-1', files: { '../escape.js': 'x' } })); await expect(inspectPackage(bad)).rejects.toThrow();
  const manifest = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8')); manifest.builder.id = 'builder.imposter'; await writeFile(path.join(source, 'package.json'), JSON.stringify(manifest));
  await expect(install()).rejects.toThrow('reserved');
});
it('supports an external archive, scoped action execution, schema validation and private namespaced settings', async () => {
  await writeFile(path.join(source, 'LICENSE'), 'License fixture');
  const longSetting = 'a'.repeat(48);
  await writeFile(path.join(source, 'server.js'), (await readFile(path.join(source, 'server.js'), 'utf8')).replace("id: 'label'", `id: '${longSetting}'`));
  const pkg = await inspectPackage(source), archive = path.join(root, 'sample.builder-plugin.json'); await writeFile(archive, archivePackage(pkg));
  expect((await inspectPackage(archive)).digest).toBe(pkg.digest); await engine.plugins.install(archive, pkg.digest, true);
  const result = await engine.plugins.invoke(pkg.package.builder.id, 'source-summary', {}, projectId);
  expect(result).toMatchObject({ files: expect.arrayContaining(['app/index.tsx']), truncated: false });
  await expect(engine.plugins.invoke(pkg.package.builder.id, 'source-summary', { extra: true }, projectId)).rejects.toThrow();
  await expect(engine.plugins.invoke(pkg.package.builder.id, 'source-summary', {}, null)).rejects.toThrow('Select');
  await engine.plugins.setSetting(pkg.package.builder.id, longSetting, 'My private app label');
  expect(await engine.plugins.settings(pkg.package.builder.id)).toEqual({ [longSetting]: 'My private app label' });
  expect(JSON.stringify(engine.plugins.snapshot())).not.toContain('My private app label');
  await engine.close(); await start(); expect(await engine.plugins.settings(pkg.package.builder.id)).toEqual({ [longSetting]: 'My private app label' });
});
it('requires a fresh human review before applying a recipe and retains source after uninstall', async () => {
  await install(); const runtime = engine.plugins;
  const proposed = z.object({ reviewId: z.string() }).parse(await runtime.invoke('example.project-notes', 'recipe:notes', {}, projectId));
  await expect(engine.files.read(projectId, 'APP-NOTES.md')).rejects.toThrow();
  await engine.files.write(projectId, [{ path: 'NEW.md', content: 'Changed after review', expectedRevision: null }]);
  await expect(runtime.answerReview(proposed.reviewId, true)).rejects.toThrow('changed');
  const next = z.object({ reviewId: z.string() }).parse(await runtime.invoke('example.project-notes', 'recipe:notes', {}, projectId));
  await runtime.answerReview(next.reviewId, true);
  expect((await engine.files.read(projectId, 'APP-NOTES.md')).content).toContain('My app');
  await expect(runtime.answerReview(next.reviewId, true)).rejects.toThrow('unavailable');
  await runtime.change('example.project-notes', 'uninstall'); expect((await engine.files.read(projectId, 'APP-NOTES.md')).content).toContain('My app');
  expect(await engine.projects.metadata(await engine.projects.get(projectId))).toMatchObject({ recipeApplications: [{ pluginId: 'example.project-notes', recipeId: 'notes', version: '1.0.0' }] });
  await engine.close(); await start(); expect(engine.plugins.snapshot().some(p => p.id === 'example.project-notes')).toBe(false);
});
it('invalidates pending reviews on disable, and blocks a provider with enabled dependents', async () => {
  await install(); const proposed = z.object({ reviewId: z.string() }).parse(await engine.plugins.invoke('example.project-notes', 'recipe:notes', {}, projectId));
  await engine.plugins.change('example.project-notes', 'disable'); await expect(engine.plugins.answerReview(proposed.reviewId, true)).rejects.toThrow('unavailable');
  await expect(engine.plugins.change('builder.media', 'disable')).rejects.toThrow('dependent');
});
it('fails activation atomically and detects changed installed package contents on restart', async () => {
  await writeFile(path.join(source, 'server.js'), "export default api => { api.actions.register({ id:'half', title:'Half', description:'', effect:'read', scope:'global', input:{}, output:{}, run(){return null} }); throw Error('secret-canary'); };\n");
  const pkg = await install(); const view = engine.plugins.snapshot().find(p => p.id === pkg.package.builder.id)!;
  expect(view.status).toBe('failed'); expect(view.actions).toEqual([]); expect(JSON.stringify(view)).not.toContain('secret-canary');
  await writeFile(path.join(engine.plugins.root, 'packages', pkg.digest, 'server.js'), 'export default () => {};');
  await engine.close(); await start(); expect(engine.plugins.snapshot().find(p => p.id === pkg.package.builder.id)?.status).toBe('failed');
});
it('keeps credential values encrypted and unavailable through plugin discovery', async () => {
  const manifest = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8')); manifest.builder.capabilities.push('credentials'); await writeFile(path.join(source, 'package.json'), JSON.stringify(manifest)); await install();
  await engine.plugins.setCredential('example.project-notes', 'token', 'private-plugin-canary');
  const files = await import('node:fs/promises').then(fs => fs.readdir(path.join(root, 'home/credentials')));
  for (const file of files) expect(await readFile(path.join(root, 'home/credentials', file), 'utf8')).not.toContain('private-plugin-canary');
  expect(JSON.stringify(engine.plugins.snapshot())).not.toContain('private-plugin-canary');
});
it('enforces host capabilities and read-only file access independent of input schemas', async () => {
  await writeFile(path.join(source, 'server.js'), "export default api => api.actions.register({ id:'bad-read', title:'Bad read', description:'', effect:'read', scope:'project', input:{}, output:{}, async run(_, ctx){ return ctx.files.write([{path:'BAD.md',content:'bad',expectedRevision:null}]); } });");
  await install(); await expect(engine.plugins.invoke('example.project-notes', 'bad-read', {}, projectId)).rejects.toThrow('capability');
  await expect(engine.files.read(projectId, 'BAD.md')).rejects.toThrow();
});
it('publishes builtin actions through the SDK and preserves canonical project scoping', async () => {
  expect(engine.plugins.snapshot().find(p => p.id === 'builder.supabase')?.actions.some(action => action.id === 'backend-inspect')).toBe(true);
  expect(await engine.plugins.invoke('builder.supabase', 'backend-inspect', {}, projectId)).toMatchObject({});
  await expect(engine.plugins.invoke('builder.supabase', 'backend-inspect', { projectId: '00000000-0000-4000-8000-000000000000' }, projectId)).rejects.toThrow('different project');
});
it('reloads a trusted development folder, fences capability changes and permits only data-compatible rollback', async () => {
  const first = await inspectPackage(source); await engine.plugins.install(source, first.digest, true, true);
  await writeFile(path.join(source, 'app.js'), (await readFile(path.join(source, 'app.js'), 'utf8')) + '\n// Development edit\n');
  await engine.plugins.change('example.project-notes', 'reload'); const next = engine.plugins.snapshot().find(p => p.id === 'example.project-notes')!; expect(next.digest).not.toBe(first.digest);
  await engine.plugins.change('example.project-notes', 'rollback'); expect(engine.plugins.snapshot().find(p => p.id === next.id)?.digest).toBe(first.digest);
  await engine.plugins.change('example.project-notes', 'reload'); await engine.plugins.setSetting(next.id, 'label', 'Changed after update');
  await expect(engine.plugins.change(next.id, 'rollback')).rejects.toThrow('data changed');
  const manifest = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8')); manifest.builder.capabilities.push('credentials'); await writeFile(path.join(source, 'package.json'), JSON.stringify(manifest));
  await expect(engine.plugins.change(next.id, 'reload')).rejects.toThrow('capabilities');
});
it('records approved operations durably without replay on restart', async () => {
  await install();
  const proposed = z.object({ reviewId: z.string() }).parse(await engine.plugins.invoke('example.project-notes', 'recipe:notes', {}, projectId)); await engine.plugins.answerReview(proposed.reviewId, true);
  expect(engine.plugins.operationList()).toMatchObject([{ id: proposed.reviewId, state: 'succeeded' }]);
  await engine.close(); await start(); expect(engine.plugins.operationList()).toMatchObject([{ id: proposed.reviewId, state: 'succeeded' }]);
  await expect(engine.plugins.answerReview(proposed.reviewId, true)).rejects.toThrow('unavailable');
});
it('confines builtin provider services to the action’s project', async () => {
  const other = await engine.projects.create({ name: 'Other', slug: 'other' });
  const manifest = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8')); manifest.builder.requires = { 'builder.supabase': '0.1.0' }; await writeFile(path.join(source, 'package.json'), JSON.stringify(manifest));
  await writeFile(path.join(source, 'server.js'), `export default api => { const backend = api.services.use('builder.supabase','backend-environment','1.0.0'); api.actions.register({ id:'inspect', title:'Inspect', description:'Provider scope test', effect:'read', scope:'project', input:{type:'object',properties:{other:{type:'boolean'}}}, output:{}, async run(input,ctx){ return backend.inspect(input.other ? ${JSON.stringify(other.id)} : ctx.projectId); } }); };`);
  await install(); await expect(engine.plugins.invoke('example.project-notes', 'inspect', {}, projectId)).resolves.toBeDefined();
  await expect(engine.plugins.invoke('example.project-notes', 'inspect', { other: true }, projectId)).rejects.toThrow('different project');
});
