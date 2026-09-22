import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Engine } from '../../packages/core/src/engine.js';
import { Projects } from '../../packages/core/src/projects.js';
import { startStudio } from '../../packages/cli/src/studio-server.js';
import { NativeBuildWorkspaces } from '../../packages/core/src/native-build-workspaces.js';

let root: string, engine: Engine, studio: Awaited<ReturnType<typeof startStudio>>, projectId: string, appRoot: string;
test.beforeEach(async ({ page }) => {
  root = await mkdtemp(path.join(os.tmpdir(), 'builder-native-ui-'));
  engine = new Engine(await Projects.open(path.join(root, 'apps'), path.join(root, 'home')), false);
  const project = await engine.projects.create({ name: 'Still Native', slug: 'still-native' }); projectId = project.id; appRoot = project.root;
  studio = await startStudio(engine, path.resolve('dist/studio'));
  await page.goto(studio.launchUrl);
  await page.getByLabel('Preview tools', { exact: true }).click();
  await page.getByRole('button', { name: 'Build setup', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Build setup', exact: true })).toBeVisible();
  await expect(page.getByLabel('App URL scheme', { exact: true })).toHaveValue('still-native');
});
test.afterEach(async ({ page }) => { await page.close(); await studio?.close(); await engine?.close(); await rm(root, { recursive: true, force: true }); });
async function capture(page: Page, info: TestInfo, state: string, target: string) {
  const dialog = page.getByRole('dialog', { name: 'Build setup', exact: true });
  for (const [width, height] of [[375, 812], [430, 932]] as const) {
    await page.setViewportSize({ width, height });
    await dialog.locator(target).evaluate(node => node.scrollIntoView({ block: 'start' }));
    expect(await dialog.evaluate(node => node.scrollWidth - node.clientWidth)).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`${state}-${width}.png`) });
  }
}
async function fill(page: Page) {
  await page.getByLabel('iOS bundle identifier', { exact: true }).fill('com.acme.still');
  await page.getByLabel('Android package', { exact: true }).fill('com.acme.still');
  await page.getByLabel('App URL scheme', { exact: true }).fill('acme-still');
}
test('both build entry points keep the header and close control visible while only the form scrolls', async ({ page }, info) => {
  const dialog = page.getByRole('dialog', { name: 'Build setup', exact: true });
  const title = dialog.getByRole('heading', { name: 'Build setup', exact: true });
  const close = dialog.getByRole('button', { name: 'Close dialog', exact: true });
  for (const entry of ['toolbar', 'journey']) {
    if (entry === 'journey') {
      await dialog.press('Escape');
      await page.locator('.creation-guide-trigger').click();
      const guide = page.getByRole('dialog', { name: 'Your app journey', exact: true });
      await guide.getByRole('button', { name: /Build To do/ }).click();
      await guide.getByRole('button', { name: 'Open build setup', exact: true }).click();
    }
    await expect(title).toBeFocused();
    for (const [width, height] of [[1440, 1000], [375, 812], [430, 932], [375, 460], [360, 250]]) {
      await page.setViewportSize({ width: width!, height: height! });
      const top = (await title.boundingBox())!.y;
      await dialog.locator('.preview-tool-body').evaluate(element => { element.scrollTop = element.scrollHeight; });
      await expect(title).toBeInViewport({ ratio: 1 });
      await expect(close).toBeInViewport({ ratio: 1 });
      await close.click({ trial: true });
      expect((await title.boundingBox())!.y).toBeCloseTo(top, 0);
      expect(await dialog.evaluate(element => element.scrollWidth - element.clientWidth)).toBe(0);
      await page.screenshot({ path: info.outputPath(`build-modal-${entry}-${width}-${height}.png`) });
      await close.focus();
      await page.keyboard.press('Tab');
      expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBe(true);
      await title.focus();
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
  }
  await close.click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('.creation-guide-trigger')).toBeFocused();
});
test('reviews and saves build setup, preserves dependencies, and explains remaining build prerequisites', async ({ page }, info) => {
  const manifest = await readFile(path.join(appRoot, 'package.json'), 'utf8');
  await fill(page); await capture(page, info, 'identity', '.native-build-setup');
  await page.getByRole('button', { name: 'Review build setup', exact: true }).click();
  const review = page.getByLabel('Build setup review');
  await expect(review).toContainText('Update app.json'); await expect(review).toContainText('Add eas.json');
  expect((await engine.nativeBuilds.inspect(projectId)).configuration.iosBundleIdentifier).toBe('');
  await capture(page, info, 'review', '.native-build-review');
  await page.getByRole('button', { name: 'Save build setup', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Build setup saved' })).toBeVisible();
  expect((await engine.nativeBuilds.inspect(projectId)).configuration.iosBundleIdentifier).toBe('com.acme.still');
  expect(await readFile(path.join(appRoot, 'package.json'), 'utf8')).toBe(manifest);
  await capture(page, info, 'prerequisites', '.native-build-guide');
  await expect(page.getByText('Expo project ownership: unverified.', { exact: false })).toBeVisible();
  await page.getByRole('dialog', { name: 'Build setup', exact: true }).press('Escape');
  await expect(page.getByLabel('Preview tools', { exact: true })).toBeFocused();
});
test('rejects a stale review and preserves another editor’s EAS profiles', async ({ page }, info) => {
  await fill(page); await page.getByRole('button', { name: 'Review build setup', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save build setup', exact: true })).toBeVisible();
  const edited = '{"build":{"preview":{"extends":"existing-profile"}}}';
  await writeFile(path.join(appRoot, 'eas.json'), edited);
  await page.getByRole('button', { name: 'Save build setup', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Build setup changed' })).toBeVisible();
  expect(await readFile(path.join(appRoot, 'eas.json'), 'utf8')).toBe(edited);
  await page.getByRole('button', { name: 'Review build setup', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save build setup', exact: true })).toBeDisabled();
  await capture(page, info, 'conflict', '.native-build-review');
});

test('reviews isolated preparation, tracks checks and cancels or removes only the prepared copy', async ({ page }, info) => {
  let releaseInstall: (() => void) | undefined;
  await engine.nativeWorkspaces.close();
  const workspaces = new NativeBuildWorkspaces(engine.projects, true, async () => ({ app: {}, revision: 'fixture' }), async () => {}, () => {}, async (step, directory, _env, signal) => {
    if (step === 'install') await new Promise<void>(resolve => { releaseInstall = resolve; if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true }); });
    if (step.startsWith('export-')) { const target = path.join(directory, '../exports', step.slice(7)); await mkdir(target, { recursive: true }); await writeFile(path.join(target, 'bundle.js'), 'fixture'); }
  });
  Object.defineProperty(engine, 'nativeWorkspaces', { value: workspaces });
  await fill(page); await page.getByRole('button', { name: 'Review build setup', exact: true }).click(); await page.getByRole('button', { name: 'Save build setup', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Build setup saved' })).toBeVisible();
  const panel = page.getByRole('region', { name: 'Prepare a build workspace', exact: true });
  await panel.getByRole('button', { name: 'Review preparation', exact: true }).click();
  await expect(page.getByLabel('Preparation review', { exact: true })).toContainText('No backend');
  await capture(page, info, 'preparation-review', '.native-workspace-review');
  await panel.getByRole('button', { name: 'Prepare reviewed workspace', exact: true }).click();
  await expect(panel.getByRole('status').filter({ hasText: 'Installing pinned dependencies' })).toBeVisible();
  await capture(page, info, 'preparation-running', '.native-workspace-jobs');
  await page.getByRole('dialog', { name: 'Build setup', exact: true }).press('Escape');
  await page.getByLabel('Preview tools', { exact: true }).click(); await page.getByRole('button', { name: 'Build setup', exact: true }).click();
  await expect(panel.getByRole('status').filter({ hasText: 'Installing pinned dependencies' })).toBeVisible();
  releaseInstall!();
  await expect(panel.getByText('Ready for the next build step', { exact: true })).toBeVisible();
  await capture(page, info, 'preparation-ready', '.native-workspace-jobs');
  await panel.getByRole('button', { name: 'Remove workspace', exact: true }).click();
  await panel.getByRole('button', { name: 'Confirm removal', exact: true }).click();
  await expect(panel.getByText('Ready for the next build step', { exact: true })).toHaveCount(0);
  await panel.getByRole('button', { name: 'Review preparation', exact: true }).click();
  await panel.getByRole('button', { name: 'Prepare reviewed workspace', exact: true }).click();
  await expect(panel.getByRole('status').filter({ hasText: 'Installing pinned dependencies' })).toBeVisible();
  await panel.getByRole('button', { name: 'Cancel preparation', exact: true }).click();
  await expect(panel.getByText('Preparation cancelled', { exact: true })).toBeVisible();
  expect((await workspaces.list(projectId))[0]!.state).toBe('cancelled');
  expect(await readFile(path.join(appRoot, 'app.json'), 'utf8')).toContain('com.acme.still');
});

test('reports execution trust without creating a prepared workspace', async ({ page }, info) => {
  const setup = await engine.nativeBuilds.plan(projectId, { iosBundleIdentifier: 'com.acme.still', androidPackage: 'com.acme.still', scheme: 'acme-still' });
  await engine.nativeBuilds.apply(projectId, { configuration: setup.configuration, proposedRevision: setup.proposedRevision, confirmed: true });
  const panel = page.getByRole('region', { name: 'Prepare a build workspace', exact: true });
  await panel.getByRole('button', { name: 'Review preparation', exact: true }).click();
  await panel.getByRole('button', { name: 'Prepare reviewed workspace', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('Authorize app execution');
  await capture(page, info, 'preparation-blocked', '.native-workspaces');
  expect(await engine.nativeWorkspaces.list(projectId)).toEqual([]);
});
