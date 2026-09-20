import { test, expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, mkdir, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Engine } from '../../packages/core/src/engine.js';
import { Projects } from '../../packages/core/src/projects.js';
import { runtimeEnvironment } from '../../packages/core/src/runtime-environment.js';
import { startStudio } from '../../packages/cli/src/studio-server.js';
import type { Project } from '../../packages/core/src/contracts.js';

const run = promisify(execFile);
let root: string, engine: Engine, studio: Awaited<ReturnType<typeof startStudio>>, project: Project;
test.use({ trace: 'off', actionTimeout: 15_000 });
test.beforeEach(async ({ page }) => {
  test.skip(!!process.env.VISUAL, 'Workflow verification suite');
  root = await mkdtemp(path.join(os.tmpdir(), 'dunara-project-download-'));
  engine = new Engine(await Projects.open(path.join(root, 'apps'), path.join(root, 'home')), false);
  project = await engine.projects.create({ name: 'Garden Ideas', slug: 'garden-ideas' });
  await mkdir(path.join(project.root, 'assets'), { recursive: true });
  await writeFile(path.join(project.root, 'assets/example.bin'), Buffer.from([0, 255, 32, 64]));
  await writeFile(path.join(project.root, '.env'), 'PRIVATE_EXPORT_SENTINEL=excluded\n');
  studio = await startStudio(engine, path.resolve('dist/studio'));
  await page.goto(studio.launchUrl);
});
test.afterEach(async ({ page }) => { if (process.env.VISUAL) return; await page.close(); await studio.close(); await engine.close(); await rm(root, { recursive: true, force: true }); });

test('downloads the complete source ZIP from Studio at phone and desktop sizes and runs the extracted app independently', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const modal = page.getByRole('dialog', { name: 'Take your app with you' });
  for (const [width, height] of [[375, 812], [430, 932], [1440, 1100]]) {
    await page.setViewportSize({ width: width!, height: height! });
    await page.getByRole('button', { name: 'Download project', exact: true }).click();
    await expect(modal).toContainText('Garden Ideas'); await expect(modal.getByRole('button', { name: 'Download ZIP' })).toBeInViewport({ ratio: 1 });
    const bounds = await modal.boundingBox(); expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width! + 1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`project-download-${width}.png`) });
    await modal.getByRole('button', { name: 'Close project download' }).click();
  }
  await page.getByRole('button', { name: 'Download project', exact: true }).click();
  const downloaded = page.waitForEvent('download'); await modal.getByRole('button', { name: 'Download ZIP', exact: true }).click();
  const download = await downloaded; expect(download.suggestedFilename()).toBe('garden-ideas.zip');
  const zip = path.join(root, 'garden-ideas.zip'); await download.saveAs(zip); expect(await download.failure()).toBeNull();
  await expect(modal.getByRole('status')).toContainText('garden-ideas.zip is ready');
  const extracted = path.join(root, 'extracted');
  const inspected = await run('python3', ['-c', 'import zipfile,sys,json; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; z.extractall(sys.argv[2]); print(json.dumps(z.namelist()))', zip, extracted]);
  const names = JSON.parse(inspected.stdout) as string[];
  for (const name of ['package.json', 'package-lock.json', 'app/index.tsx', 'assets/example.bin', 'backend/connection.json', 'supabase/functions/owner-note/index.ts', 'README.md', 'LICENSE', 'DUNARA-EXPORT.md']) expect(names).toContain(`garden-ideas/${name}`);
  expect(names).not.toContain('garden-ideas/.env'); expect(names).not.toContain('garden-ideas/.mobile-builder.json');
  const app = path.join(extracted, 'garden-ideas');
  expect(await readFile(path.join(app, 'assets/example.bin'))).toEqual(Buffer.from([0, 255, 32, 64]));
  expect(await readFile(path.join(app, 'app/index.tsx'))).toEqual(await readFile(path.join(project.root, 'app/index.tsx')));
  expect(await readFile(path.join(project.root, '.env'), 'utf8')).toContain('PRIVATE_EXPORT_SENTINEL');
  // Use the downloaded copy, with Dunara stopped and no inherited provider credentials.
  await page.goto('about:blank'); await studio.close(); await engine.close();
  const npmConfig = path.join(root, 'empty-npmrc'); await writeFile(npmConfig, '');
  const env = { ...runtimeEnvironment(process.env), CI: '1', npm_config_userconfig: npmConfig, npm_config_registry: 'https://registry.npmjs.org' };
  const options = { cwd: app, env, timeout: 180_000, maxBuffer: 8 * 1024 * 1024 };
  await run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], options);
  await run('npm', ['run', 'typecheck'], options);
  await run(process.execPath, ['node_modules/expo/bin/cli', 'export', '--platform', 'web', '--output-dir', 'dist-verified'], options);
  expect(await readFile(path.join(app, 'dist-verified/index.html'), 'utf8')).toContain('<html');
  expect(errors).toEqual([]);
});

test('shows export failures without downloading a partial ZIP and supports a repaired retry', async ({ page }) => {
  const external = path.join(root, 'outside.txt'); await writeFile(external, 'not-exported');
  const linked = path.join(project.root, 'src/linked.ts'); await symlink(external, linked);
  let downloads = 0; page.on('download', () => downloads++);
  await page.getByRole('button', { name: 'Download project', exact: true }).click();
  const modal = page.getByRole('dialog', { name: 'Take your app with you' });
  await modal.getByRole('button', { name: 'Download ZIP', exact: true }).click();
  await expect(modal.getByRole('alert')).toContainText('src/linked.ts'); expect(downloads).toBe(0);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.screenshot({ path: test.info().outputPath('project-download-error-375.png') });
  await rm(linked);
  const download = page.waitForEvent('download'); await modal.getByRole('button', { name: 'Download ZIP', exact: true }).click();
  expect((await download).suggestedFilename()).toBe('garden-ideas.zip');
  await expect(modal.getByRole('alert')).toHaveCount(0);
});

test('discards a pending download when the user switches projects', async ({ page }) => {
  const other = await engine.projects.create({ name: 'Other project', slug: 'other-project' });
  let release!: () => void, received!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { received = resolve; });
  await page.route('**/api/projects/*/download', async route => { received(); await pending; await route.abort().catch(() => {}); });
  let downloads = 0; page.on('download', () => downloads++);
  await page.getByRole('button', { name: 'Download project', exact: true }).click();
  await page.getByRole('button', { name: 'Download ZIP', exact: true }).click(); await started;
  await expect(page.getByRole('button', { name: 'Preparing ZIP…' })).toBeDisabled();
  await engine.studio.control({ expectedRevision: (await engine.studio.snapshot()).revision, action: { type: 'select-project', projectId: other.id } });
  await expect(page.getByRole('dialog', { name: 'Take your app with you' })).toHaveCount(0);
  release(); await page.unrouteAll({ behavior: 'wait' });
  await page.getByRole('button', { name: 'Download project', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Take your app with you' })).toContainText('Other project'); expect(downloads).toBe(0);
});
