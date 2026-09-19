import { mkdtemp, writeFile, readFile, mkdir, rm, symlink, link, chmod } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, expect, it } from 'vitest';
import { Projects } from './projects.js';
import { ProjectExports } from './project-export.js';

const run = promisify(execFile);
let root: string, projects: Projects, exporter: ProjectExports, id: string, app: string;
async function put(name: string, content: string | Buffer) { await mkdir(path.dirname(path.join(app, name)), { recursive: true }); await writeFile(path.join(app, name), content); }
async function inspect(bytes: Buffer) {
  const zip = path.join(root, 'download.zip'); await writeFile(zip, bytes);
  const result = await run('python3', ['-c', 'import zipfile,json,sys; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print(json.dumps({i.filename:{"data":z.read(i).hex(),"mode":i.external_attr >> 16} for i in z.infolist()}))', zip], { maxBuffer: 8 * 1024 * 1024 });
  const files = JSON.parse(result.stdout) as Record<string, { data: string; mode: number }>;
  return { files, names: Object.keys(files), text: (name: string) => Buffer.from(files[`export-app/${name}`]!.data, 'hex').toString('utf8'), bytes: (name: string) => Buffer.from(files[`export-app/${name}`]!.data, 'hex') };
}
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'dunara-project-export-'));
  projects = await Projects.open(path.join(root, 'apps'), path.join(root, 'home'));
  const project = await projects.create({ name: 'Export app', slug: 'export-app' }); id = project.id; app = project.root;
  exporter = new ProjectExports(projects);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

it('downloads an independently readable ZIP with complete source, binary assets, backend files, config, licenses and portable pinned dependencies', async () => {
  const binary = Buffer.from([0, 255, 127, 64, 32, 10]);
  await put('assets/音楽.woff2', binary); await put('assets/sample.zip', binary);
  await put('.gitignore', 'node_modules\n.env*\n'); await put('.github/workflows/test.yml', 'name: App checks\n');
  await put('scripts/check.sh', '#!/bin/sh\nexit 0\n'); await chmod(path.join(app, 'scripts/check.sh'), 0o755);
  await put('scripts/build', '#!/bin/sh\necho building\n');
  await put('DUNARA-EXPORT.md', 'User documentation stays intact');
  const source = await readFile(path.join(app, 'app/index.tsx')), originalLock = await readFile(path.join(app, 'package-lock.json'), 'utf8');
  const archive = await exporter.download(id), zip = await inspect(archive.bytes);
  expect(archive.filename).toBe('export-app.zip'); expect(archive.guide).toBe('DUNARA-EXPORT-2.md'); expect(zip.names).toHaveLength(archive.fileCount);
  expect(zip.bytes('app/index.tsx')).toEqual(source); expect(zip.bytes('assets/音楽.woff2')).toEqual(binary); expect(zip.bytes('assets/sample.zip')).toEqual(binary);
  for (const name of ['README.md', 'LICENSE', 'package.json', 'tsconfig.json', 'metro.config.js', 'supabase/functions/owner-note/index.ts', 'supabase/migrations/20260917000100_notes.sql', 'backend/configuration.json', 'backend/connection.json', '.gitignore', '.github/workflows/test.yml']) expect(zip.names).toContain(`export-app/${name}`);
  expect(zip.files['export-app/scripts/check.sh']!.mode & 0o777).toBe(0o755);
  expect(zip.text('scripts/build')).toContain('echo building');
  expect(zip.text('DUNARA-EXPORT.md')).toBe('User documentation stays intact'); expect(zip.text(archive.guide)).toContain('npm ci --ignore-scripts');
  const sourceLock = JSON.parse(originalLock), exportedLock = JSON.parse(zip.text('package-lock.json'));
  for (const [name, value] of Object.entries(sourceLock.packages) as [string, { version?: string; integrity?: string }][]) expect(exportedLock.packages[name]).toMatchObject(value.integrity ? { version: value.version, integrity: value.integrity } : {});
  expect(zip.text('package-lock.json')).not.toContain('/nexus/');
  expect(await readFile(path.join(app, 'package-lock.json'), 'utf8')).toBe(originalLock);
});

it('omits credentials, hidden builder state, history and generated files and reports omissions without their contents', async () => {
  const privatePaths = ['.env', '.env.local', '.npmrc', 'credentials.json', 'secrets/token.txt', 'signing/key.p12', '.git/config', '.expo/settings.json', '.builder/history.json', 'node_modules/example/index.js', 'dist/index.html', 'dist-web/index.html', 'ios/Pods/generated.m', 'android/local.properties'];
  for (const name of privatePaths) await put(name, 'private-export-sentinel');
  const zip = await inspect((await exporter.download(id)).bytes);
  for (const name of [...privatePaths, '.mobile-builder.json']) expect(zip.names).not.toContain(`export-app/${name}`);
  expect(Object.values(zip.files).some(file => Buffer.from(file.data, 'hex').toString('utf8').includes('private-export-sentinel'))).toBe(false);
  expect(zip.text('DUNARA-EXPORT.md')).toContain('".env"'); expect(zip.text('DUNARA-EXPORT.md')).toContain('"node_modules/"');
  expect(await readFile(path.join(app, '.env'), 'utf8')).toBe('private-export-sentinel');
});

it('refuses source symlinks and hardlinks while ignoring excluded symlinked environment files', async () => {
  const outside = path.join(root, 'private.txt'); await writeFile(outside, 'outside-export-sentinel');
  await symlink(outside, path.join(app, '.env')); await exporter.download(id);
  await symlink(outside, path.join(app, 'src/linked.ts'));
  await expect(exporter.download(id)).rejects.toMatchObject({ code: 'INVALID_PATH' });
  await rm(path.join(app, 'src/linked.ts')); await link(outside, path.join(app, 'src/linked.ts'));
  await expect(exporter.download(id)).rejects.toMatchObject({ code: 'INVALID_PATH' });
});

it('rejects oversized projects and unsafe paths without returning a partial archive', async () => {
  const bounded = new ProjectExports(projects, { fileBytes: 10, totalBytes: 20, files: 3, visited: 100, depth: 24 });
  await expect(bounded.download(id)).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
  await put('src/bad:name.ts', 'export const value = 1;');
  await expect(exporter.download(id)).rejects.toMatchObject({ code: 'INVALID_PATH' });
});

it('preserves custom dependency files, isolates projects and allows retry after cancellation', async () => {
  const custom = '{"name":"local","packages":{"":{"name":"local"},"node_modules/local":{"resolved":"file:./vendor/local"}}}\n';
  await put('package-lock.json', custom); await put('vendor/local/index.js', 'module.exports = 1');
  const other = await projects.create({ name: 'Other', slug: 'other' });
  const controller = new AbortController(); controller.abort(); await expect(exporter.download(id, controller.signal)).rejects.toThrow();
  const first = exporter.download(id);
  await expect(exporter.download(other.id)).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
  const zip = await inspect((await first).bytes); expect(zip.text('package-lock.json')).toBe(custom);
  expect(zip.names.every(name => name.startsWith('export-app/'))).toBe(true);
  await expect(exporter.download('00000000-0000-4000-8000-000000000000')).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });
});
