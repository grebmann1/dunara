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
  root = await mkdtemp(path.join(os.tmpdir(), 'salesforce-browser-'));
  engine = new Engine(await Projects.open(path.join(root, 'apps'), path.join(root, 'home')), false);
  await engine.plugins.ready;
  projectId = (await engine.projects.create({ name: 'Salesforce fixture', slug: 'salesforce-fixture' })).id;
  studio = await startStudio(engine, path.resolve('dist/studio'));
});
test.afterEach(async ({ page }) => { await page.close(); await studio?.close(); await engine?.close(); await rm(root, { recursive: true, force: true }); });

test('enables an optional provider, reviews per-app settings and adds the React integration', async ({ page }) => {
  await page.goto(studio.launchUrl);
  await page.getByRole('button', { name: 'Plugins', exact: true }).click();
  await page.getByRole('button', { name: /Salesforce.*Included with Dunara/ }).click();
  await page.getByRole('button', { name: 'Enable', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Salesforce setup', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Backend', exact: true }).click();
  await page.getByRole('group', { name: 'Backend providers' }).getByRole('button', { name: 'Salesforce', exact: true }).click();
  const sections = page.getByRole('tablist', { name: 'Salesforce setup sections' });
  await sections.getByRole('tab', { name: 'Overview', exact: true }).focus(); await page.keyboard.press('ArrowRight');
  await expect(sections.getByRole('tab', { name: 'Org settings', exact: true })).toBeFocused();
  await page.getByLabel('Org label', { exact: true }).fill('Mobile sandbox');
  await page.getByLabel('OAuth consumer key', { exact: true }).fill('public-consumer-key-fixture');
  await page.getByLabel('Native callback URI', { exact: true }).fill('fixture://salesforce/auth');
  await sections.getByRole('tab', { name: 'React SDK', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Native build integration required' })).toBeVisible();
  await sections.getByRole('tab', { name: 'Org settings', exact: true }).click();
  await expect(page.getByLabel('Org label', { exact: true })).toHaveValue('Mobile sandbox');
  await page.getByLabel('Environment', { exact: true }).selectOption('staging');
  await expect(page.getByLabel('Org label', { exact: true })).toHaveValue('');
  await page.getByLabel('Environment', { exact: true }).selectOption('development');
  await expect(page.getByLabel('Org label', { exact: true })).toHaveValue('Mobile sandbox');
  await page.getByRole('button', { name: 'Review org settings', exact: true }).click();
  await expect(engine.files.read(projectId, 'backend/salesforce.json')).rejects.toThrow();
  await page.getByRole('button', { name: 'Review changes', exact: true }).click();
  await expect(page.getByRole('tabpanel', { name: /Reviews/ }).getByText(/^This app · expires/)).toBeVisible();
  await page.getByRole('button', { name: 'Apply reviewed changes', exact: true }).click();
  await expect.poll(() => engine.files.read(projectId, 'backend/salesforce.json').then(file => file.content).catch(() => '')).toContain('Mobile sandbox');
  await page.getByRole('tab', { name: 'Workspace', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Mobile sandbox', exact: true })).toBeVisible();
  await sections.getByRole('tab', { name: 'React SDK', exact: true }).click();
  await page.getByRole('button', { name: 'Add React integration', exact: true }).click();
  await page.getByRole('button', { name: 'Review changes', exact: true }).click();
  await expect(page.getByRole('tabpanel', { name: /Reviews/ }).getByText('Add Salesforce React integration', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Apply reviewed changes', exact: true }).click();
  await expect.poll(() => engine.files.read(projectId, 'src/salesforce/client.ts').then(file => file.content).catch(() => '')).toContain('createSalesforceClient');
});

test('provider tabs share the host appearance and fit desktop and phone widths', async ({ page }) => {
  await engine.plugins.change('salesforce.mobile-sdk', 'enable');
  await mkdir('.builder/salesforce-review', { recursive: true });
  await page.goto(studio.launchUrl);
  await page.getByRole('button', { name: 'Backend', exact: true }).click();
  await page.getByRole('group', { name: 'Backend providers' }).getByRole('button', { name: 'Salesforce', exact: true }).click();
  const sections = page.getByRole('tablist', { name: 'Salesforce setup sections' });
  const outer = page.getByRole('tablist', { name: 'Salesforce sections', exact: true });
  for (const [width, height] of [[1440, 1000], [375, 812], [430, 932]] as const) {
    await page.setViewportSize({ width, height });
    for (const name of ['Overview', 'Org settings', 'React SDK']) {
      await sections.getByRole('tab', { name, exact: true }).click();
      await page.locator('.backend-title').evaluate(node => node.scrollIntoView({ block: 'start' }));
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await expect(page.getByRole('tabpanel', { name, exact: true })).toBeVisible();
      await page.screenshot({ path: `.builder/salesforce-review/${name.replaceAll(' ', '-').toLowerCase()}-${width}.png` });
      if (name !== 'Overview') {
        const action = page.getByRole('button', { name: name === 'Org settings' ? 'Review org settings' : 'Add React integration', exact: true });
        await action.scrollIntoViewIfNeeded();
        await expect(action).toBeInViewport({ ratio: 1 });
        if (width < 500) await page.screenshot({ path: `.builder/salesforce-review/${name.replaceAll(' ', '-').toLowerCase()}-action-${width}.png` });
      }
    }
    const appearance = (node: HTMLElement | SVGElement) => { const css = getComputedStyle(node); return [css.backgroundColor, css.color, css.borderRadius, css.fontSize]; };
    expect(await sections.getByRole('tab', { selected: true }).evaluate(appearance)).toEqual(await outer.getByRole('tab', { selected: true }).evaluate(appearance));
  }
  await sections.getByRole('tab', { name: 'React SDK', exact: true }).focus(); await page.keyboard.press('Home');
  await expect(sections.getByRole('tab', { name: 'Overview', exact: true })).toBeFocused();
  await page.keyboard.press('End'); await expect(sections.getByRole('tab', { name: 'React SDK', exact: true })).toBeFocused();
});
