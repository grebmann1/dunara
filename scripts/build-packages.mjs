import { bundleNotices } from './bundle-notices.mjs';
import { cp, mkdir, readFile, readdir, rm, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { build } from 'vite';
import tailwindcss from '@tailwindcss/vite';

const version = JSON.parse(await readFile('package.json', 'utf8')).version;
const output = path.resolve('.builder/packages');
await mkdir(output, { recursive: true });
const publicUrl = name => `https://github.com/grebmann1/dunara/releases/download/v${version}/mobile-builder-${name}-${version}.tgz`;
// One archive contains the legacy composition. These folders are not independent public packages.
const runtimeModules = ['runtime', 'core', 'builtin-plugins', 'plugin-runtime', 'templates', 'mcp', 'cli', 'assistant', 'platform'];
const platformModules = new Set(['accounts', 'configuration', 'supabase', 'storage-api', 'crypto', 'contracts', 'store', 'oauth-contracts']);
async function files(root) {
  const result = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) result.push(...await files(file)); else result.push(file);
  }
  return result;
}
function run(args, cwd) { return execFileSync(process.execPath, args, { cwd, stdio: 'pipe' }); }
run(['node_modules/typescript/bin/tsc', '-p', 'packages/plugin-sdk/tsconfig.json']);
run(['node_modules/typescript/bin/tsc', '-p', 'packages/catalog/tsconfig.json']);
const studioBuild = await build({ configFile: false, plugins: [tailwindcss()], build: {
  outDir: 'packages/studio/dist', emptyOutDir: true, sourcemap: false,
  lib: { entry: 'packages/studio/src/index.ts', formats: ['es'], fileName: 'studio', cssFileName: 'studio' },
  rollupOptions: { external: id => /^react(?:-dom)?(?:\/|$)/.test(id) },
} });
const notices = await bundleNotices(Array.isArray(studioBuild) ? studioBuild : [studioBuild]);
await writeFile('packages/studio/dist/THIRD_PARTY_NOTICES.txt', notices);
await writeFile('dist/studio/THIRD_PARTY_NOTICES.txt', notices);
await cp('packages/studio/src/public.d.ts', 'packages/studio/dist/index.d.ts');
await cp('packages/studio/src/styles.d.ts', 'packages/studio/dist/styles.d.ts');
const receipt = { version, sdkApi: 1, studioProtocol: 1, source: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), sourceDirty: !!execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim(), packages: [] };
for (const name of ['plugin-sdk', 'catalog', 'runtime', 'studio', 'execution']) {
  const source = `packages/${name}`, stage = path.join(output, name);
  await rm(stage, { recursive: true, force: true }); await mkdir(stage, { recursive: true });
  const manifest = JSON.parse(await readFile(`${source}/package.json`, 'utf8'));
  // Public archives use exact, versioned release assets. Candidate consumers override the entire set with verified local archives.
  for (const dependencies of [manifest.dependencies, manifest.optionalDependencies]) for (const [id, value] of Object.entries(dependencies ?? {})) {
    if (value.startsWith('workspace:')) dependencies[id] = publicUrl(id.replace('@mobile-builder/', ''));
  }
  delete manifest.scripts;
  await writeFile(path.join(stage, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
  for (const file of ['README.md', 'LICENSE']) await cp(`${source}/${file}`, path.join(stage, file));
  if (name === 'runtime') {
    for (const module of runtimeModules) {
      await cp(`dist/packages/${module}`, path.join(stage, 'dist/packages', module), { recursive: true, filter: file => {
        if (/\.(?:map|test\.[cm]?js)$/.test(file)) return false;
        if (module === 'platform' && /\.(?:js|ts)$/.test(file)) return platformModules.has(path.basename(file).replace(/\.d\.ts$|\.js$/, ''));
        return true;
      } });
    }
    await cp('dist/plugins', path.join(stage, 'dist/plugins'), { recursive: true });
    await cp('dist/studio', path.join(stage, 'dist/studio'), { recursive: true });
    await chmod(path.join(stage, 'dist/packages/cli/src/index.js'), 0o755);
  } else if (name === 'execution') {
    await cp('dist/packages/execution/src', path.join(stage, 'dist'), { recursive: true, filter: file => !/(?:source\.(?:js|d\.ts)|\.map)$/.test(file) });
  } else {
    await cp(`${source}/dist`, path.join(stage, 'dist'), { recursive: true });
    if (name === 'catalog') await cp(`${source}/assets`, path.join(stage, 'assets'), { recursive: true });
  }
  for (const file of await files(path.join(stage, 'dist'))) {
    if (!/\.(?:js|ts)$/.test(file)) continue;
    let text = await readFile(file, 'utf8');
    text = text.replace(/(?:\.\.\/)+plugin-sdk\/src\/([a-z-]+)\.js/g, '@mobile-builder/plugin-sdk/$1');
    text = text.replace(/(?:\.\.\/)+catalog\/src\/index\.js/g, '@mobile-builder/catalog');
    text = text.replace(/^\/\/# sourceMappingURL=.*$/gm, '');
    await writeFile(file, text);
  }
  const packed = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', output], { cwd: stage, encoding: 'utf8' }))[0];
  const bytes = await readFile(path.join(output, packed.filename));
  receipt.packages.push({ name: manifest.name, version: manifest.version, file: packed.filename, sha256: createHash('sha256').update(bytes).digest('hex'), integrity: packed.integrity, url: publicUrl(name) });
}
await writeFile(path.join(output, 'release.json'), JSON.stringify(receipt, null, 2) + '\n');
console.log(`Packed ${receipt.packages.length} artifacts into ${output}`);
