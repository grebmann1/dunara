import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const { CANDIDATE_RUN, RELEASE_VERSION, SOURCE_SHA } = process.env;
assert(/^\d+$/.test(CANDIDATE_RUN ?? ''), 'Provide a successful Check run ID.');
assert(/^\d+\.\d+\.\d+$/.test(RELEASE_VERSION ?? ''), 'Use a stable semantic version.');
assert(/^[a-f0-9]{40}$/.test(SOURCE_SHA ?? ''), 'Provide the exact qualified source SHA.');
const gh = args => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const run = JSON.parse(gh(['run', 'view', CANDIDATE_RUN, '--json', 'headSha,conclusion,event,workflowName,headBranch']));
assert(run.headSha === SOURCE_SHA && run.conclusion === 'success' && run.event === 'push' && run.workflowName === 'Check' && run.headBranch === 'main', 'Only a successful main push qualification can be released.');
const directory = await mkdtemp(path.join(os.tmpdir(), 'dunara-release-'));
try {
  gh(['run', 'download', CANDIDATE_RUN, '--name', `packages-${SOURCE_SHA}`, '--dir', directory]);
  const receipt = JSON.parse(await readFile(path.join(directory, 'release.json'), 'utf8'));
  assert.equal(receipt.source, SOURCE_SHA); assert.equal(receipt.version, RELEASE_VERSION);
  assert.equal(receipt.sourceDirty, false, 'Release candidates must be built from clean source.');
  assert.equal(receipt.sdkApi, 1); assert.equal(receipt.studioProtocol, 1);
  assert.deepEqual(receipt.packages.map(pkg => pkg.name).sort(), ['catalog', 'execution', 'plugin-sdk', 'runtime', 'studio'].map(name => `@mobile-builder/${name}`).sort());
  const assets = [];
  for (const pkg of receipt.packages) {
    assert.equal(pkg.version, RELEASE_VERSION);
    assert(/^mobile-builder-[a-z-]+-\d+\.\d+\.\d+\.tgz$/.test(pkg.file));
    const file = path.join(directory, pkg.file), bytes = await readFile(file);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), pkg.sha256);
    assert.equal(`sha512-${createHash('sha512').update(bytes).digest('base64')}`, pkg.integrity);
    assets.push(file);
  }
  const notes = path.join(directory, 'release-notes.md');
  await writeFile(notes, `Dunara ${RELEASE_VERSION}\n\nQualified source: ${SOURCE_SHA}\n\nFive coordinated package archives; SDK API 1 and Studio protocol 1. See release.json for exact versions and integrity hashes. Local building requires no hosted account. This release does not announce a live cloud deployment.\n\nBuilt once by Check run ${CANDIDATE_RUN}; these are the exact qualified artifacts.\n`);
  gh(['release', 'create', `v${RELEASE_VERSION}`, '--draft', '--target', SOURCE_SHA, '--title', `Dunara ${RELEASE_VERSION}`, '--notes-file', notes, ...assets, path.join(directory, 'release.json')]);
  console.log('Draft release created from qualified artifacts. Enable immutable releases and publish the reviewed draft without rebuilding.');
} finally { await rm(directory, { recursive: true, force: true }); }
