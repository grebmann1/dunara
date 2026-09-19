import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { build } from 'vite';
const run = promisify(execFile), root = process.cwd();
const temp = await mkdtemp(path.join(os.tmpdir(), 'dunara-artifact-consumer-'));
const receipt = JSON.parse(await readFile('.builder/packages/release.json', 'utf8'));
try {
  await mkdir(path.join(temp, 'vendor'));
  const dependencies = {}, overrides = [];
  for (const pkg of receipt.packages) {
    const source = path.join(root, '.builder/packages', pkg.file);
    assert.equal(createHash('sha256').update(await readFile(source)).digest('hex'), pkg.sha256);
    await cp(source, path.join(temp, 'vendor', pkg.file));
    dependencies[pkg.name] = `file:vendor/${pkg.file}`;
    overrides.push(`  '${pkg.name}': file:vendor/${pkg.file}`);
  }
  const original = JSON.parse(await readFile('package.json', 'utf8'));
  for (const id of ['react', 'react-dom']) dependencies[id] = original.dependencies[id];
  for (const id of ['@types/react', '@types/react-dom', '@types/node']) dependencies[id] = original.devDependencies[id];
  await writeFile(path.join(temp, 'package.json'), JSON.stringify({ name: 'dunara-consumer-fixture', private: true, type: 'module', dependencies }));
  await writeFile(path.join(temp, '.npmrc'), 'registry=https://registry.npmjs.org/\n');
  await writeFile(path.join(temp, 'pnpm-workspace.yaml'), `minimumReleaseAgeExclude:\n  - zod@4.6.4\noverrides:\n${overrides.join('\n')}\n`);
  await run('pnpm', ['install', '--ignore-scripts', '--package-import-method=hardlink'], { cwd: temp, maxBuffer: 4_000_000, env: { ...process.env, NPM_CONFIG_USERCONFIG: os.devNull } });
  const runtimeRoot = await realpath(path.join(temp, 'node_modules/@mobile-builder/runtime'));
  for (const dependency of ['@earendil-works', 'typebox']) await rm(path.resolve(runtimeRoot, '../../', dependency), { recursive: true, force: true });
  await cp('tests/consumer/runtime.mjs', path.join(temp, 'runtime.mjs'));
  await cp('tests/consumer/browser.tsx', path.join(temp, 'browser.tsx'));
  const runtime = await run(process.execPath, ['runtime.mjs'], { cwd: temp, maxBuffer: 1_000_000 });
  console.log(runtime.stdout.trim());
  await writeFile(path.join(temp, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: 'ES2023', module: 'ESNext', moduleResolution: 'Bundler', jsx: 'react-jsx', lib: ['ES2023', 'DOM'], types: [], skipLibCheck: false }, files: ['browser.tsx'] }));
  await run(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json'], { cwd: temp, maxBuffer: 2_000_000 });
  const result = await build({ configFile: false, root: temp, logLevel: 'silent', build: { write: false, lib: { entry: path.join(temp, 'browser.tsx'), formats: ['es'] } } });
  const chunks = (Array.isArray(result) ? result : [result]).flatMap(item => item.output).filter(item => item.type === 'chunk');
  for (const chunk of chunks) {
    assert(!/from\s*["']node:/.test(chunk.code), 'Browser artifact imports Node');
    assert(!chunk.code.includes('__vite-browser-external'), 'Browser artifact depends on a server shim');
  }
  await run(process.execPath, [path.join(temp, 'node_modules/@mobile-builder/runtime/dist/packages/cli/src/index.js'), '--help'], { cwd: temp });
  console.log('Packed consumers passed without optional Assistant dependencies or source checkout imports; browser declarations and CSS included.');
} catch (error) {
  if (error.stdout) console.error(error.stdout);
  if (error.stderr) console.error(error.stderr);
  throw error;
} finally { await rm(temp, { recursive: true, force: true }); }
