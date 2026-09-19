import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Engine } from '../dist/packages/core/src/engine.js';
import { Projects } from '../dist/packages/core/src/projects.js';
import { NativeBuildWorkspaces } from '../dist/packages/core/src/native-build-workspaces.js';
import { sourceSnapshot } from '../dist/packages/core/src/native-workspace-source.js';

// Disposable fixture only: actual pinned npm installation and Expo exports, no provider calls.
const root = await mkdtemp(path.join(os.tmpdir(), 'builder-native-smoke-'));
const engine = new Engine(await Projects.open(path.join(root, 'apps'), path.join(root, 'home')), true);
const publicEnv = { EXPO_PUBLIC_SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co', EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_NATIVE_EXPORT_CANARY', EXPO_PUBLIC_BUILDER_ENVIRONMENT: 'staging' };
const service = new NativeBuildWorkspaces(engine.projects, true, async (_id, selection) => ({ app: selection.environment === 'none' ? {} : publicEnv, revision: selection.environment }), async () => {}, () => {});
process.env.OPENAI_API_KEY = 'PRIVATE_NATIVE_BUILD_CANARY'; process.env.EXPO_TOKEN = 'PRIVATE_EXPO_BUILD_CANARY'; process.env.SUPABASE_ACCESS_TOKEN = 'PRIVATE_SUPABASE_BUILD_CANARY';
const profile = process.argv[2] ?? 'preview';
assert.ok(['preview', 'development'].includes(profile));
const results = [];
try {
  const project = await engine.projects.create({ name: 'Native Qualification', slug: 'native-qualification' });
  const setup = await engine.nativeBuilds.plan(project.id, { iosBundleIdentifier: 'com.builder.qualification', androidPackage: 'com.builder.qualification', scheme: 'builder-qualification' });
  await engine.nativeBuilds.apply(project.id, { configuration: setup.configuration, proposedRevision: setup.proposedRevision, confirmed: true });
  await writeFile(path.join(project.root, '.env'), 'EXPO_PUBLIC_SUPABASE_URL=https://forbidden-dotenv.example\nPRIVATE_KEY=PRIVATE_DOTENV_BUILD_CANARY');
  await writeFile(path.join(project.root, 'backend/connection.json'), JSON.stringify({ url: 'https://forbidden-fallback.example', publishableKey: 'forbidden-fallback-key', environment: 'development' }));
  const source = await sourceSnapshot(project.root);
  for (const environment of ['staging', 'none']) {
    const plan = await service.plan(project.id, { profile, platform: 'all', environment });
    let result = await service.prepare(project.id, { selection: plan.selection, proposedRevision: plan.proposedRevision, requestId: randomUUID(), confirmed: true }), last = '';
    while (['preparing', 'cancelling'].includes(result.state)) {
      if (last !== result.step) { console.log(`${environment}: ${result.step}`); last = result.step; }
      await new Promise(resolve => setTimeout(resolve, 500)); result = await service.get(project.id, result.id);
    }
    assert.equal(result.state, 'ready', result.error);
    assert.equal((await sourceSnapshot(project.root)).fingerprint, source.fingerprint);
    for (const platform of ['web', 'ios', 'android']) {
      const contents = [];
      async function walk(directory) { for (const entry of await readdir(directory, { withFileTypes: true })) { const file = path.join(directory, entry.name); if (entry.isDirectory()) await walk(file); else contents.push(await readFile(file)); } }
      await walk(path.join(engine.projects.home, 'native-workspaces', project.id, result.id, 'exports', platform));
      const data = Buffer.concat(contents);
      assert.equal(data.includes(publicEnv.EXPO_PUBLIC_SUPABASE_URL), environment === 'staging', `${platform}: selected public target`);
      assert.equal(data.includes(publicEnv.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY), environment === 'staging', `${platform}: selected public key`);
      for (const denied of ['PRIVATE_NATIVE_BUILD_CANARY', 'PRIVATE_EXPO_BUILD_CANARY', 'PRIVATE_SUPABASE_BUILD_CANARY', 'PRIVATE_DOTENV_BUILD_CANARY', 'forbidden-dotenv.example', 'forbidden-fallback.example']) assert.ok(!data.includes(denied), `${platform}: excluded ${denied}`);
    }
    results.push({ selection: result.selection, state: result.state, receipts: result.receipts, exports: result.exports, publicEnvironmentVerified: true, privateCanariesExcluded: true, sourceUnchanged: true });
  }
  await mkdir('.builder/qualification', { recursive: true }); await writeFile(`.builder/qualification/native-${profile}-result.json`, JSON.stringify(results, null, 2) + '\n');
  console.log('PASS: isolated pinned installation, TypeScript, and web/iOS/Android exports for a public backend and no backend. Private/fallback canaries excluded; original source unchanged. No signed binaries or hardware claims.');
} finally { await service.close(); await engine.close(); await rm(root, { recursive: true, force: true }); }
