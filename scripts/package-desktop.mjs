import { build, Platform } from 'electron-builder';
import { execFile } from 'node:child_process';
import { promisify, parseArgs } from 'node:util';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const { values } = parseArgs({ options: { release: { type: 'boolean', default: false }, help: { type: 'boolean', default: false } } });
if (values.help) { console.log('pnpm desktop:package [--release]\nBuild a macOS DMG + ZIP with Node 24, npm, Chromium and the ChatGPT image runtime. Never publishes. Default: ad-hoc local candidate. --release requires clean source, Developer ID signing and configured Apple notarization credentials.'); process.exit(0); }
if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(process.arch) || !process.version.startsWith('v24.')) throw Error('Package on the target Mac architecture using Node 24.');
const exec = promisify(execFile), root = process.cwd();
const command = async (file, args, options = {}) => (await exec(file, args, { cwd: root, maxBuffer: 8_000_000, ...options })).stdout;
const dirty = !!(await command('git', ['status', '--porcelain'])).trim();
const source = (await command('git', ['rev-parse', 'HEAD'])).trim();
const notarizationConfigured = process.env.APPLE_API_KEY && process.env.APPLE_API_KEY_ID && process.env.APPLE_API_ISSUER || process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID || process.env.APPLE_KEYCHAIN_PROFILE && process.env.APPLE_KEYCHAIN;
if (values.release && (dirty || !notarizationConfigured)) throw Error('Release packaging requires clean source and explicit Apple notarization configuration. No files were published.');
const manifest = JSON.parse(await readFile('package.json', 'utf8'));
await mkdir('.builder/desktop-packages', { recursive: true });
const stage = await mkdtemp(path.resolve('.builder/desktop-packages/candidate-')), app = path.join(stage, 'app'), output = path.join(stage, 'output');
console.log(`Preparing ${stage}`);
// Install the pinned production graph in an independent workspace. Never prune
// the source checkout's node_modules while tests or a desktop may be using it.
await mkdir(app);
await writeFile(path.join(app, 'package.json'), JSON.stringify(manifest));
await cp('pnpm-lock.yaml', path.join(app, 'pnpm-lock.yaml'));
await writeFile(path.join(app, 'pnpm-workspace.yaml'), 'packages: []\nallowBuilds: {}\nminimumReleaseAgeExclude:\n  - zod@4.6.4\n  - electron@44.4.0\n');
await command('pnpm', ['--dir', app, 'install', '--prod', '--frozen-lockfile', '--ignore-scripts'], { env: { ...process.env, CI: 'true' } });
await rm(path.join(app, 'pnpm-lock.yaml')); await rm(path.join(app, 'pnpm-workspace.yaml'));
await cp('dist', path.join(app, 'dist'), { recursive: true, filter: file => !/\.(?:map|test\.js)$/.test(file) });
for (const file of ['LICENSE', 'README.md']) await cp(file, path.join(app, file));
await writeFile(path.join(app, 'package.json'), JSON.stringify({ name: 'mobile-builder-desktop', productName: 'Dunara', version: manifest.version, description: 'Dunara mobile app studio', author: 'Dunara contributors', license: manifest.license, type: 'module', main: 'dist/packages/desktop/src/main.js', dependencies: manifest.dependencies, optionalDependencies: manifest.optionalDependencies }));
const nodeName = `node-${process.version}-darwin-${process.arch}`, tarball = `${nodeName}.tar.gz`, base = `https://nodejs.org/dist/${process.version}/`;
const response = await fetch(`${base}SHASUMS256.txt`); if (!response.ok) throw Error('Node checksums unavailable.');
const checksum = (await response.text()).split('\n').find(line => line.endsWith(`  ${tarball}`))?.split(' ')[0];
if (!checksum || !/^[a-f0-9]{64}$/.test(checksum)) throw Error('Node checksum missing.');
const archiveResponse = await fetch(`${base}${tarball}`); if (!archiveResponse.ok) throw Error('Node runtime download failed.');
const bytes = Buffer.from(await archiveResponse.arrayBuffer());
if (createHash('sha256').update(bytes).digest('hex') !== checksum) throw Error('Node runtime checksum did not match.');
await writeFile(path.join(stage, tarball), bytes);
await command('/usr/bin/tar', ['-xzf', path.join(stage, tarball), '-C', stage]);
const browsers = path.join(stage, 'browsers');
await command(process.execPath, ['node_modules/playwright/cli.js', 'install', 'chromium', '--only-shell'], { env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browsers } });
const entitlements = path.join(root, 'packages/desktop/entitlements.plist');
const codexLauncher = path.join(stage, 'codex');
await writeFile(codexLauncher, '#!/bin/sh\nruntime_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec "$runtime_dir/node" "$runtime_dir/../../app/node_modules/@openai/codex/bin/codex.js" "$@"\n', { mode: 0o755 });
await build({ targets: Platform.MAC.createTarget(['dmg', 'zip']), publish: 'never', config: {
  appId: 'com.mobilebuilder.desktop', productName: 'Dunara', electronVersion: manifest.devDependencies.electron,
  directories: { app, output }, asar: false, npmRebuild: false, nodeGypRebuild: false,
  files: ['dist/**/*', 'package.json', 'LICENSE', 'README.md'],
  extraResources: [
    { from: path.join(stage, nodeName), to: 'runtime', filter: ['bin/node', 'bin/npm', 'bin/npx', 'LICENSE'] },
    { from: codexLauncher, to: 'runtime/bin/codex' },
    { from: browsers, to: 'browsers' },
  ],
  // Resource globbing excludes nested node_modules. npm's own vendored modules
  // are required at runtime, so copy the verified distribution before signing.
  afterPack: async context => {
    const resources = path.join(context.appOutDir, 'Dunara.app/Contents/Resources');
    // Template lockfiles and dotfiles are application data, but the packager's
    // default app filters omit them. Restore the curated compiled tree intact.
    await cp(path.join(app, 'dist'), path.join(resources, 'app/dist'), { recursive: true });
    const destination = path.join(resources, 'runtime/lib/node_modules/npm');
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(path.join(stage, nodeName, 'lib/node_modules/npm'), destination, { recursive: true });
    const env = { PATH: `${path.join(resources, 'runtime/bin')}:/usr/bin:/bin`, HOME: stage };
    for (const executable of ['node', 'npm', 'codex']) await command(path.join(resources, 'runtime/bin', executable), ['--version'], { env, timeout: 15_000 });
  },
  artifactName: 'Dunara-${version}-${arch}.${ext}',
  publish: { provider: 'github', owner: 'grebmann1', repo: 'dunara', releaseType: 'release' },
  forceCodeSigning: values.release,
  mac: { icon: path.join(root, 'dist/packages/desktop/assets/app-icon.png'), category: 'public.app-category.developer-tools', hardenedRuntime: values.release, notarize: values.release, ...(values.release ? {} : { identity: '-' }), entitlements, entitlementsInherit: entitlements, binaries: ['Contents/Resources/runtime/bin/node'] },
} });
const artifacts = [];
for (const name of await readdir(output)) if (/\.(dmg|zip|yml|blockmap)$/.test(name)) { const content = await readFile(path.join(output, name)); artifacts.push({ name, bytes: content.length, sha256: createHash('sha256').update(content).digest('hex') }); }
await writeFile(path.join(output, 'desktop-receipt.json'), JSON.stringify({ version: manifest.version, source, sourceDirty: dirty, platform: process.platform, arch: process.arch, node: process.version, nodeSha256: checksum, signedAndNotarized: values.release, artifacts }, null, 2));
console.log(`Desktop artifacts: ${output}\n${values.release ? 'Signed and notarized candidate; qualify before publication.' : 'Local ad-hoc candidate only; not a distributable notarized release.'}`);
