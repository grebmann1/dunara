import { test, expect } from '@playwright/test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Engine } from '../../packages/core/src/engine.js';
import { Projects } from '../../packages/core/src/projects.js';
import { startStudio } from '../../packages/cli/src/studio-server.js';
import { inspectPackage } from '../../packages/plugin-runtime/src/packages.js';

let root: string, engine: Engine, studio: Awaited<ReturnType<typeof startStudio>>, projectId: string;
const ref = 'abcdefghijklmnopqrst';
test.use({ trace: 'off', actionTimeout: 15_000 });
test.beforeEach(async ({ page }) => {
  root = await mkdtemp(path.join(os.tmpdir(), 'backend-navigation-'));
  engine = new Engine(await Projects.open(path.join(root, 'apps'), path.join(root, 'home')), false, false, undefined, {}, { fetch: async input => {
    const url = String(input), project = { id: ref, organization_slug: 'studio-test', name: 'Development', region: 'eu-central-1', status: 'ACTIVE_HEALTHY' };
    if (url.endsWith('/organizations')) return Response.json([{ slug: 'studio-test', name: 'Studio test' }]);
    if (url.endsWith('/projects')) return Response.json([project]);
    if (url.endsWith(`/projects/${ref}`)) return Response.json(project);
    if (url.includes('/health?')) return Response.json([{ name: 'db', status: 'ACTIVE_HEALTHY' }]);
    if (url.includes('/api-keys?')) return Response.json([{ type: 'publishable', api_key: 'sb_publishable_fixture' }]);
    if (url.endsWith('/database/migrations')) return Response.json([]);
    if (url.endsWith('/config/auth')) return Response.json({ site_url: 'https://fixture.example', external_email_enabled: true });
    throw Error('Unexpected fixture request');
  } });
  await engine.plugins.ready;
  projectId = (await engine.projects.create({ name: 'Backend navigation', slug: 'backend-navigation' })).id;
  engine.backends.configure({ token: 'fixture-management-token' });
  const plan = await engine.backends.plan(projectId, { action: 'link', environment: 'development', projectRef: ref, organization: 'studio-test' });
  const operation = await engine.backends.submit(projectId, { plan, requestId: randomUUID() });
  await engine.backends.approve(projectId, { operationId: operation.id, planHash: operation.planHash });
  await expect.poll(async () => (await engine.backends.operation(projectId, operation.id)).state).toBe('succeeded');
  studio = await startStudio(engine, path.resolve('dist/studio'));
  await page.goto(studio.launchUrl);
  await page.getByRole('button', { name: 'Backend', exact: true }).click();
});
test.afterEach(async ({ page }) => { await page.close(); await studio?.close(); await engine?.close(); await rm(root, { recursive: true, force: true }); });

test('separates backend sections, keeps drafts and supports keyboard navigation', async ({ page }) => {
  const sections = page.getByRole('tablist', { name: 'Supabase sections' });
  await expect(page.getByRole('group', { name: 'Backend providers' }).getByRole('button', { name: 'Supabase', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(sections.getByRole('tab')).toHaveCount(6);
  await expect(page.getByRole('region', { name: 'Configure backend' })).toHaveCount(0);
  await sections.getByRole('tab', { name: 'Overview', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(sections.getByRole('tab', { name: 'Projects', exact: true })).toBeFocused();
  await page.getByRole('combobox', { name: 'Change', exact: true }).selectOption('create');
  await page.getByLabel('Project name', { exact: true }).fill('Draft project');
  await sections.getByRole('tab', { name: 'Services', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Database migrations' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Supabase environment variables' })).toHaveCount(0);
  await sections.getByRole('tab', { name: 'Projects', exact: true }).click();
  await expect(page.getByLabel('Project name', { exact: true })).toHaveValue('Draft project');
  await page.keyboard.press('End');
  await expect(sections.getByRole('tab', { name: 'Settings', exact: true })).toBeFocused();
  await page.keyboard.press('Home');
  await expect(sections.getByRole('tab', { name: 'Overview', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('combobox', { name: 'Environment', exact: true }).selectOption('staging');
  await sections.getByRole('tab', { name: 'Variables', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Connect a project first' })).toBeVisible();
  expect((await engine.backends.inspect(projectId)).activeEnvironment).toBe('development');
});

test('all Supabase tabs fit compact, large and desktop viewports', async ({ page }, info) => {
  for (const [width, height] of [[1440, 1000], [375, 812], [430, 932]] as const) {
    await page.setViewportSize({ width, height });
    for (const name of ['Overview', 'Projects', 'Services', 'Variables', 'Reviews', 'Settings']) {
      await page.getByRole('tab', { name, exact: true }).click();
      await page.getByRole('tabpanel', { name, exact: true }).waitFor();
      await page.locator('.backend-title').evaluate(node => node.scrollIntoView({ block: 'start' }));
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: info.outputPath(`supabase-${name.toLowerCase()}-${width}.png`) });
    }
  }
});

test('an installed provider joins Backend and keeps its app reviews isolated', async ({ page }, info) => {
  const source = path.join(root, 'crm-plugin'); await mkdir(source);
  await writeFile(path.join(source, 'package.json'), JSON.stringify({ name: 'backend-fixture', version: '1.0.0', type: 'module', builder: { id: 'example.crm', name: 'Salesforce', description: 'Disposable provider fixture — no Salesforce connection.', apiVersion: 1, server: 'server.js', app: 'app.js', workspacePanel: 'backend', workspaceGroup: 'backend', capabilities: ['project.write'] } }));
  await writeFile(path.join(source, 'server.js'), `export default api => { api.actions.register({ id: 'save-note', title: 'Save backend note', description: 'Fixture write', effect: 'write', scope: 'project', input: {type:'object',additionalProperties:false}, output: {type:'object'}, plan: () => ({file:'BACKEND-NOTE.md'}), run: async (_input, context) => { await context.files.write([{path:'BACKEND-NOTE.md',content:'Reviewed fixture',expectedRevision:null}]); return {}; } }); };`);
  await writeFile(path.join(source, 'app.js'), `export default { apiVersion:1, panels:[{id:'backend',title:'CRM workspace',scope:'project',mount(root, context) {const title=document.createElement('h2');title.textContent='Salesforce backend';const p=document.createElement('p');p.textContent='App: '+context.projectId;const button=document.createElement('button');button.textContent='Prepare backend note';button.onclick=()=>context.invoke('save-note',{});root.append(title,p,button);return ()=>root.replaceChildren();}},{id:'other',title:'Unrelated panel',scope:'global',mount(root){root.textContent='Should stay in Plugins';}}]};`);
  const pkg = await inspectPackage(source); await engine.plugins.install(source, pkg.digest, true);
  const providers = page.getByRole('group', { name: 'Backend providers' });
  await providers.getByRole('button', { name: 'Salesforce', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Salesforce backend', exact: true })).toBeVisible();
  await expect(page.getByText('Should stay in Plugins', { exact: true })).toHaveCount(0);
  await expect(page.getByText(`App: ${projectId}`, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Prepare backend note' }).click();
  await page.getByRole('button', { name: 'Review changes', exact: true }).click();
  await expect(engine.files.read(projectId, 'BACKEND-NOTE.md')).rejects.toThrow();
  for (const [width, height] of [[1440, 1000], [375, 812], [430, 932]] as const) {
    await page.setViewportSize({ width, height });
    await page.locator('.backend-title').evaluate(node => node.scrollIntoView({ block: 'start' }));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`backend-providers-${width}.png`) });
  }
  await page.getByRole('button', { name: 'Apply reviewed changes' }).click();
  await expect.poll(() => engine.files.read(projectId, 'BACKEND-NOTE.md').then(file => file.content).catch(() => '')).toBe('Reviewed fixture');
  const other = await engine.projects.create({ name: 'Other app', slug: 'other-app' });
  await engine.plugins.invoke('example.crm', 'save-note', {}, other.id);
  await page.goto(studio.issueLaunchUrl());
  await providers.getByRole('button', { name: 'Salesforce', exact: true }).click();
  await page.getByRole('tab', { name: 'Reviews', exact: true }).click();
  await expect(page.getByText('No changes to review.', { exact: true })).toBeVisible();
  await engine.plugins.change('builder.supabase', 'disable');
  await expect(providers.getByRole('button', { name: 'Supabase', exact: true })).toHaveCount(0);
  await expect(providers.getByRole('button', { name: 'Salesforce', exact: true })).toHaveAttribute('aria-current', 'page');
  await engine.plugins.change('example.crm', 'disable');
  await expect(page.getByRole('button', { name: 'Open Plugins', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Salesforce backend', exact: true })).toHaveCount(0);
});
