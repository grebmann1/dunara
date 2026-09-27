import { test, expect } from '@playwright/test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Engine } from '../../packages/core/src/engine.js';
import { Projects } from '../../packages/core/src/projects.js';
import { startStudio } from '../../packages/cli/src/studio-server.js';

let root: string, engine: Engine, studio: Awaited<ReturnType<typeof startStudio>>, projectId: string;
test.use({ trace: 'off', actionTimeout: 15_000 });
test.beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'backend-project-ui-'));
  engine = new Engine(await Projects.open(path.join(root, 'apps'), path.join(root, 'home')), false);
  await engine.plugins.ready;
  projectId = (await engine.projects.create({ name: 'My project', slug: 'my-project' })).id;
  studio = await startStudio(engine, path.resolve('dist/studio'));
  await mkdir('.builder/project-backends-review', { recursive: true });
});
test.afterEach(async ({ page }) => { await page.close(); await studio?.close(); await engine?.close(); await rm(root, { recursive: true, force: true }); });
for (const [width, height] of [[375, 812], [430, 932], [1440, 1000]] as const) test(`both backends use the same project enablement at ${width}`, async ({ page }) => {
  await page.setViewportSize({ width, height }); await page.goto(studio.launchUrl);
  await page.getByRole('button', { name: 'Backend', exact: true }).click();
  for (const [name, id] of [['Supabase', 'builder.supabase'], ['Salesforce', 'salesforce.mobile-sdk']] as const) {
    await page.getByRole('group', { name: 'Backend providers' }).getByRole('button', { name, exact: true }).click();
    await expect(page.getByRole('button', { name: 'Enable for this app', exact: true })).toBeEnabled();
    await page.screenshot({ path: `.builder/project-backends-review/${name}-disabled-${width}.png` });
    await page.getByRole('button', { name: 'Enable for this app', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Disable for this app', exact: true })).toBeEnabled();
    await expect(page.getByRole('tablist', { name: `${name} sections`, exact: true })).toBeVisible();
    await page.screenshot({ path: `.builder/project-backends-review/${name}-enabled-${width}.png` });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect((await engine.backendPluginState(projectId, id)).enabled).toBe(true);
    await expect(engine.files.read(projectId, 'backend/salesforce-installation.json')).rejects.toThrow();
  }
  const other = await engine.projects.create({ name: 'Another project', slug: 'another-project' });
  const session = await engine.studio.snapshot();
  await engine.studio.control({ expectedRevision: session.revision, action: { type: 'select-project', projectId: other.id } });
  const selected = await engine.studio.snapshot();
  await engine.studio.control({ expectedRevision: selected.revision, action: { type: 'navigate', workspace: 'backend' } });
  await page.goto(studio.issueLaunchUrl());
  await expect(page.getByRole('heading', { name: 'Supabase', exact: true })).toBeVisible();
  for (const name of ['Supabase', 'Salesforce']) {
    await page.getByRole('group', { name: 'Backend providers' }).getByRole('button', { name, exact: true }).click();
    await expect(page.getByRole('button', { name: 'Enable for this app', exact: true })).toBeEnabled();
  }
});
