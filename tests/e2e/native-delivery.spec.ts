import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Engine } from '../../packages/core/src/engine.js';
import { Projects } from '../../packages/core/src/projects.js';
import { startStudio } from '../../packages/cli/src/studio-server.js';
import { NativeBuildWorkspaces } from '../../packages/core/src/native-build-workspaces.js';
import { NativeDeliveries } from '../../packages/builtin-plugins/src/features/native-deliveries.js';
import type { IOSHost } from '../../packages/builtin-plugins/src/features/native-ios-host.js';

let root: string, engine: Engine, studio: Awaited<ReturnType<typeof startStudio>>, releaseBuild: (() => void) | undefined;
let installations: number, launches: number, prerequisitesAvailable: boolean;
test.beforeEach(async ({ page }) => {
  root = await mkdtemp(path.join(os.tmpdir(), 'dunara-phone-ui-')); installations = 0; launches = 0; prerequisitesAvailable = true;
  engine = new Engine(await Projects.open(path.join(root, 'apps'), path.join(root, 'home')), true);
  const project = await engine.projects.create({ name: 'Phone test', slug: 'phone-test' }), id = project.id;
  const setup = await engine.nativeBuilds.plan(id, { iosBundleIdentifier: 'com.fixture.phone', androidPackage: 'com.fixture.phone', scheme: 'phone-test' });
  await engine.nativeBuilds.apply(id, { configuration: setup.configuration, proposedRevision: setup.proposedRevision, confirmed: true });
  await engine.nativeWorkspaces.close(); await engine.nativeDeliveries.close();
  const workspaces = new NativeBuildWorkspaces(engine.projects, true, async () => ({ app: {}, revision: 'none' }), async () => {}, () => {}, async (step, directory) => {
    if (step.startsWith('export-')) { const target = path.join(directory, '../exports', step.slice(7)); await mkdir(target, { recursive: true }); await writeFile(path.join(target, 'bundle.js'), 'fixture'); }
  });
  Object.defineProperty(engine, 'nativeWorkspaces', { value: workspaces });
  const plan = await workspaces.plan(id, { profile: 'preview', platform: 'ios', environment: 'none' });
  const workspace = await workspaces.prepare(id, { selection: plan.selection, proposedRevision: plan.proposedRevision, requestId: randomUUID(), confirmed: true });
  await expect.poll(async () => (await workspaces.get(id, workspace.id)).state).toBe('ready');
  const device = { id: '00008130-001918DC2E520010', name: 'My iPhone', model: 'iPhone 15 Pro Max', developerMode: true }, team = { id: 'ABCDE12345', name: 'Apple Development: Example Developer' };
  const host: IOSHost = {
    inspect: async () => prerequisitesAvailable ? { supported: true, devices: [device], teams: [team], issues: [], xcode: 'Xcode fixture', cocoaPods: 'fixture' } : { supported: true, devices: [], teams: [], issues: ['Connect and unlock your iPhone.', 'Add your Apple account in Xcode.'] },
    device: async () => device, installed: async () => installations > 0, install: async () => { installations++; }, launch: async () => { launches++; return 1234; },
    run: async (spec, signal) => {
      if (spec.args.includes('-extract')) return { stdout: spec.args.includes('ExpirationDate') ? '2099-01-01T00:00:00Z' : JSON.stringify([spec.args.includes('ProvisionedDevices') ? device.id : team.id]), stderr: '' };
      if (spec.args.includes('prebuild')) await mkdir(path.join(spec.cwd, 'ios/Fixture.xcodeproj'), { recursive: true });
      if (spec.command === 'pod') await mkdir(path.join(spec.cwd, 'Fixture.xcworkspace'));
      if (spec.args.includes('build')) {
        await new Promise<void>((resolve, reject) => { releaseBuild = resolve; signal.addEventListener('abort', () => reject(signal.reason), { once: true }); });
        const derived = spec.args[spec.args.indexOf('-derivedDataPath') + 1]!, output = path.join(derived, 'Build/Products/Release-iphoneos/Fixture.app');
        await mkdir(output, { recursive: true }); for (const name of ['main.jsbundle', 'embedded.mobileprovision', 'Info.plist']) await writeFile(path.join(output, name), 'fixture');
      }
      return { stdout: spec.command === '/usr/bin/plutil' ? JSON.stringify({ CFBundleIdentifier: 'com.fixture.phone' }) : '', stderr: spec.args.includes('-dvv') ? `TeamIdentifier=${team.id}\n` : '' };
    },
  };
  Object.defineProperty(engine, 'nativeDeliveries', { value: new NativeDeliveries(engine.projects, workspaces, true, true, () => {}, host) });
  studio = await startStudio(engine, path.resolve('dist/studio')); await page.goto(studio.launchUrl);
  await page.getByLabel('Preview tools', { exact: true }).click(); await page.getByRole('button', { name: 'Build setup', exact: true }).click();
});
test.afterEach(async ({ page }) => { await page.close(); await studio?.close(); await engine?.close(); await rm(root, { recursive: true, force: true }); });
async function capture(page: Page, info: TestInfo, state: string, target: string) {
  const dialog = page.getByRole('dialog', { name: 'Build setup', exact: true });
  for (const [width, height] of [[1280, 900], [375, 812], [430, 932]]) {
    await page.setViewportSize({ width: width!, height: height! }); await dialog.locator(target).scrollIntoViewIfNeeded();
    expect(await dialog.evaluate(node => node.scrollWidth - node.clientWidth)).toBe(0);
    await page.screenshot({ path: info.outputPath(`${state}-${width}.png`) });
  }
}
test('reviews a local build, persists progress across drawer navigation, and installs and opens only on explicit actions', async ({ page }, info) => {
  const panel = page.getByRole('region', { name: 'Install on iPhone', exact: true });
  await panel.getByRole('button', { name: 'Check phone and signing', exact: true }).click();
  await expect(panel.getByLabel('iPhone', { exact: true })).toContainText('My iPhone');
  await capture(page, info, 'phone-selection', '.native-delivery');
  await panel.getByRole('button', { name: 'Review iPhone build', exact: true }).click();
  await expect(page.getByLabel('iPhone build review')).toContainText('automatic signing');
  expect(installations).toBe(0); await capture(page, info, 'build-review', '.native-delivery .native-build-review');
  await panel.getByRole('button', { name: 'Build signed iPhone app', exact: true }).click();
  await expect(panel.getByRole('status')).toHaveText('Building and signing with Xcode');
  await page.getByRole('dialog', { name: 'Build setup', exact: true }).press('Escape');
  await page.getByLabel('Preview tools', { exact: true }).click(); await page.getByRole('button', { name: 'Build setup', exact: true }).click();
  await expect(panel.getByRole('status')).toHaveText('Building and signing with Xcode');
  releaseBuild!(); await expect(panel.getByRole('status')).toHaveText('Signed app ready'); expect(installations).toBe(0);
  await panel.getByRole('button', { name: 'Review installation', exact: true }).click();
  await expect(page.getByLabel('iPhone installation review')).toContainText('Install this signed app');
  await capture(page, info, 'install-review', '.native-delivery .native-build-review');
  await panel.getByRole('button', { name: 'Install on iPhone', exact: true }).click();
  await expect(panel.getByRole('status')).toHaveText('Installation verified'); expect(installations).toBe(1); expect(launches).toBe(0);
  await panel.getByRole('button', { name: 'Open on iPhone', exact: true }).click();
  await expect(panel.getByRole('status')).toHaveText('Opened on iPhone'); expect(launches).toBe(1);
  await capture(page, info, 'phone-opened', '.native-delivery article');
  await panel.getByRole('button', { name: 'Remove build files', exact: true }).click();
  await expect(panel).toContainText('installed phone app stay unchanged');
  await panel.getByRole('button', { name: 'Confirm removal', exact: true }).click();
  await expect(panel.getByRole('article')).toHaveCount(0); expect(installations).toBe(1);
});
test('explains missing prerequisites and prevents an incomplete build review', async ({ page }, info) => {
  prerequisitesAvailable = false;
  const panel = page.getByRole('region', { name: 'Install on iPhone', exact: true });
  await panel.getByRole('button', { name: 'Check phone and signing', exact: true }).click();
  await expect(panel).toContainText('Connect and unlock your iPhone.');
  await expect(panel.getByRole('button', { name: 'Review iPhone build', exact: true })).toBeDisabled();
  await capture(page, info, 'prerequisites', '.native-delivery');
});
