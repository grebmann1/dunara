import { lstat, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Projects } from '../../../core/src/projects.js';
import { BuilderError } from '../../../core/src/contracts.js';
import { revision } from '../../../core/src/files.js';
import { atomicWrite, exists, noSymlinks, readText, SerialQueue } from '../../../core/src/storage.js';
import { nativeBuildConfiguration } from './native-builds.js';
import type { NativeBuildWorkspaces } from './native-build-workspaces.js';
import { deliveryActionInput, deliveryBuildInput, deliveryInstallInput, deliveryLaunchInput, deliveryRemoveInput, deliveryRecord, deliverySelection, type DeliveryPlan, type DeliveryRecord, type DeliveryStatus, type InstallPlan } from '../../../core/src/native-delivery-contracts.js';
import { LocalIOSHost, nativeArtifact, type IOSHost } from './native-ios-host.js';

const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
const ongoing = (value: DeliveryRecord) => ['building', 'installing', 'launching'].includes(value.state);
const publicStatus = ({ epoch: _epoch, directoryIdentity: _identity, ...record }: DeliveryRecord): DeliveryStatus => record;
const guidance: Record<DeliveryRecord['step'], string> = {
  copy: 'The prepared source changed. Prepare and review a new workspace.',
  dependencies: 'Dependency installation failed. Check network access, disk space and Node 24, then review a new build.',
  prebuild: 'Expo could not generate the native project. Check the private build diagnostic and prepare a new workspace.',
  pods: 'CocoaPods setup failed. Check network access and Xcode/CocoaPods installation, then review a new build.',
  compile: 'Xcode could not build or sign this app. Check Xcode → Settings → Accounts, the selected team and device registration. Unlock your iPhone and review a new build.',
  verify: 'The output is not a verified signed app with bundled JavaScript. Review a new build.',
  install: 'Installation was not verified. Connect and unlock the selected iPhone, trust this Mac, and enable Developer Mode. Review installation again; a failed response can still have installed the app.',
  launch: 'The app did not report a successful launch. Unlock your iPhone and check Settings → General → VPN & Device Management if developer trust is required. Then retry Open on iPhone.',
};
function failureMessage(step: DeliveryRecord['step'], error: unknown) {
  const diagnostic = error && typeof error === 'object' && 'diagnostic' in error && typeof error.diagnostic === 'string' ? error.diagnostic : '';
  if (/needs to be unlocked|device is locked|unlock the device/i.test(diagnostic)) return 'Unlock the selected iPhone and keep it connected to this Mac. Xcode needs the unlocked phone to enable development services. Then review this operation again.';
  if (/No Accounts|No signing certificate|No profiles for|requires a provisioning profile/i.test(diagnostic)) return 'Xcode could not find signing authorization for this app. Open Xcode → Settings → Accounts, check the selected team and signing certificate, and register the iPhone. Then review a new build.';
  if (error instanceof BuilderError) return error.message;
  return guidance[step];
}

/** Local Xcode delivery consumes an immutable preparation. It never changes the source app. */
export class NativeDeliveries {
  private readonly epoch = randomUUID();
  private readonly writes = new SerialQueue();
  private readonly active = new Map<string, { controller: AbortController; task: Promise<void> }>();
  private closed = false;
  constructor(private projects: Projects, private workspaces: NativeBuildWorkspaces, private trusted: boolean, private local: boolean, private changed: (id: string) => void, private host: IOSHost = new LocalIOSHost()) {}
  private enabled() { if (!this.local) throw new BuilderError('TRUST_REQUIRED', 'Phone installation is available in local Dunara Studio only.'); }
  private execution() { this.enabled(); if (!this.trusted || this.closed) throw new BuilderError('TRUST_REQUIRED', 'Local execution trust is required to build and install an app.'); }
  preflight() { this.enabled(); return this.host.inspect(); }
  private async directory(projectId: string, id?: string) {
    z.uuid().parse(projectId); if (id) z.uuid().parse(id);
    const root = path.join(this.projects.home, 'native-deliveries', projectId, ...(id ? [id] : [])); await noSymlinks(this.projects.home, root); return root;
  }
  private async read(projectId: string, id: string) {
    await this.projects.get(projectId); const root = await this.directory(projectId, id);
    const record = deliveryRecord.parse(JSON.parse(await readText(path.join(root, 'record.json'), 64_000))), identity = await lstat(root);
    if (record.id !== id || record.projectId !== projectId || record.directoryIdentity.device !== identity.dev || record.directoryIdentity.inode !== identity.ino) throw new BuilderError('REVISION_CONFLICT', 'Native build directory changed.');
    return record;
  }
  private async save(record: DeliveryRecord) {
    const value = deliveryRecord.parse({ ...record, revision: randomUUID(), updatedAt: new Date().toISOString() }), root = await this.directory(value.projectId, value.id);
    await noSymlinks(root, path.join(root, 'record.json')); await atomicWrite(path.join(root, 'record.json'), json(value)); this.changed(value.projectId); return value;
  }
  private update(projectId: string, id: string, patch: Partial<DeliveryRecord>) { return this.writes.run(async () => this.save({ ...await this.read(projectId, id), ...patch })); }
  async list(projectId: string) {
    this.enabled(); await this.projects.get(projectId); const root = await this.directory(projectId);
    if (!await exists(root)) return [];
    return this.writes.run(async () => {
      const records: DeliveryStatus[] = [];
      for (const id of (await readdir(root)).filter(id => z.uuid().safeParse(id).success).slice(0, 20)) {
        let record = await this.read(projectId, id);
        if (ongoing(record) && record.epoch !== this.epoch) record = await this.save({ ...record, state: 'interrupted', error: 'Dunara stopped during this operation. Nothing was automatically retried. Check the phone before reviewing installation again.' });
        records.push(publicStatus(record));
      }
      return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    });
  }
  async plan(projectId: string, input: unknown): Promise<DeliveryPlan> {
    this.enabled(); const selection = deliverySelection.parse(input), source = await this.workspaces.deliverySource(projectId, selection.workspaceId), host = await this.preflight();
    const device = host.devices.find(value => value.id === selection.deviceId), team = host.teams.find(value => value.id === selection.teamId);
    if (!host.supported || !host.xcode || !host.cocoaPods || !device || !team) throw new BuilderError('INVALID_INPUT', host.issues.join(' ') || 'Refresh devices and signing teams before building.');
    if (!device.developerMode) throw new BuilderError('INVALID_INPUT', 'Enable Developer Mode on the selected iPhone before building.');
    const app = JSON.parse(source.snapshot.contents.get('app.json')!.toString('utf8'));
    const bundleIdentifier = nativeBuildConfiguration.shape.iosBundleIdentifier.parse(app.expo?.ios?.bundleIdentifier);
    const proposedRevision = revision(json({ selection, workspace: source.record.revision, prepared: source.snapshot.fingerprint, device, team, bundleIdentifier, xcode: host.xcode, cocoaPods: host.cocoaPods }));
    return { selection, device, team, bundleIdentifier, sourceFingerprint: source.record.sourceFingerprint, proposedRevision, consequences: [
      'Build a separate copy with Expo, CocoaPods and Xcode on this Mac. Dependencies and native templates may be downloaded; app source is not uploaded to a build service.',
      `Sign ${bundleIdentifier} with ${team.name} (${team.id}). Xcode automatic signing may contact Apple to create or update the app identifier, device registration and provisioning profile.`,
      'Create an iOS Release app with bundled JavaScript. No Expo account or running preview server is required to open it.',
      source.record.backend.environment === 'none' ? 'This preparation has no backend connection.' : `Use the reviewed ${source.record.backend.environment} backend at ${source.record.backend.url}. Its public app key is bundled; sign-in and shared data require network access and that backend to remain available.`,
      `Review installation separately before changing ${device.name}. This build is for device testing, not App Store publication.`,
    ] };
  }
  async build(projectId: string, raw: unknown) {
    this.execution(); const input = deliveryBuildInput.parse(raw);
    return this.writes.run(async () => {
      const root = await this.directory(projectId, input.requestId);
      const removed = path.join(await this.directory(projectId), 'removed', `${input.requestId}.json`); await noSymlinks(this.projects.home, removed);
      if (await exists(removed)) throw new BuilderError('REVISION_CONFLICT', 'This request ID was already removed. Review a new build with a new request ID.');
      if (await exists(root)) {
        const record = await this.read(projectId, input.requestId);
        if (record.inputFingerprint !== input.proposedRevision || json(record.selection) !== json(input.selection)) throw new BuilderError('REVISION_CONFLICT', 'This request ID belongs to another native build.');
        return publicStatus(record);
      }
      if (this.active.size) throw new BuilderError('LIMIT_EXCEEDED', 'Wait for the current native operation to finish.');
      const parent = await this.directory(projectId);
      if (await exists(parent) && (await readdir(parent)).filter(value => z.uuid().safeParse(value).success).length >= 10) throw new BuilderError('LIMIT_EXCEEDED', 'Ten local builds are retained. Remove a completed build before starting another.');
      const plan = await this.plan(projectId, input.selection);
      if (plan.proposedRevision !== input.proposedRevision) throw new BuilderError('REVISION_CONFLICT', 'Native build inputs changed. Review again.');
      const source = await this.workspaces.deliverySource(projectId, input.selection.workspaceId);
      this.execution();
      await mkdir(root, { recursive: true, mode: 0o700 }); const identity = await lstat(root), now = new Date().toISOString();
      const record = await this.save({ version: 1, id: input.requestId, projectId, revision: randomUUID(), epoch: this.epoch, directoryIdentity: { device: identity.dev, inode: identity.ino }, selection: plan.selection, device: plan.device, team: plan.team, bundleIdentifier: plan.bundleIdentifier, inputFingerprint: plan.proposedRevision, sourceFingerprint: plan.sourceFingerprint, state: 'building', step: 'copy', createdAt: now, updatedAt: now, receipts: [] });
      this.start(record, signal => this.compile(record, source.snapshot.contents, signal)); return publicStatus(record);
    });
  }
  private start(record: DeliveryRecord, operation: (signal: AbortSignal) => Promise<void>) {
    const controller = new AbortController();
    if (this.closed) controller.abort();
    const task = Promise.resolve().then(() => operation(controller.signal)).catch(async error => {
      const latest = await this.read(record.projectId, record.id);
      if (error && typeof error === 'object' && 'diagnostic' in error && typeof error.diagnostic === 'string') {
        try {
          const diagnostic = path.join(await this.directory(record.projectId, record.id), 'diagnostic.txt'); await noSymlinks(this.projects.home, diagnostic);
          await writeFile(diagnostic, error.diagnostic.slice(-1_000_000), { mode: 0o600 });
        } catch { /* Failure to retain diagnostics must not hide the operation outcome. */ }
      }
      await this.update(record.projectId, record.id, { state: controller.signal.aborted ? (latest.state === 'building' && !this.closed ? 'cancelled' : 'interrupted') : 'failed', error: controller.signal.aborted ? 'Operation stopped. No automatic retry; source is unchanged.' : failureMessage(latest.step, error) });
    }).finally(() => this.active.delete(record.id));
    this.active.set(record.id, { controller, task });
    // Persist failures, including aborted work, without an unhandled background rejection.
    void task.catch(() => {});
  }
  private async step(record: DeliveryRecord, step: DeliveryRecord['step'], action: () => Promise<void>) {
    await this.update(record.projectId, record.id, { step }); await action();
    await this.writes.run(async () => { const latest = await this.read(record.projectId, record.id); await this.save({ ...latest, receipts: [...latest.receipts, { step, completedAt: new Date().toISOString() }].slice(-30) }); });
  }
  private async compile(record: DeliveryRecord, contents: Map<string, Buffer>, signal: AbortSignal) {
    const root = await this.directory(record.projectId, record.id), app = path.join(root, 'app');
    const command = async (command: string, args: string[], timeout: number, cwd = app) => { signal.throwIfAborted(); await this.host.run({ command, args, cwd, timeout }, signal); };
    await this.step(record, 'copy', async () => {
      for (const [name, data] of contents) { signal.throwIfAborted(); const target = path.join(app, name); await mkdir(path.dirname(target), { recursive: true, mode: 0o700 }); await noSymlinks(root, target); await writeFile(target, data, { flag: 'wx', mode: 0o600 }); }
    });
    await this.step(record, 'dependencies', () => command('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], 300_000));
    await this.step(record, 'prebuild', () => command(process.execPath, ['node_modules/expo/bin/cli', 'prebuild', '--platform', 'ios', '--no-install', '--skip-dependency-update', 'react,react-native'], 300_000));
    const ios = path.join(app, 'ios'); await noSymlinks(root, ios);
    // Xcode script phases must use the same Node as this runtime, including desktop launches.
    const node = process.execPath.replaceAll("'", "'\\''");
    await noSymlinks(root, path.join(ios, '.xcode.env.local'));
    await writeFile(path.join(ios, '.xcode.env.local'), `export NODE_BINARY='${node}'\n`, { mode: 0o600 });
    await this.step(record, 'pods', () => command('pod', ['install'], 900_000, ios));
    await this.step(record, 'compile', async () => {
      const entries = await readdir(ios), projects = entries.filter(name => /^[A-Za-z0-9 _-]+\.xcodeproj$/.test(name)), workspaces = entries.filter(name => /^[A-Za-z0-9 _-]+\.xcworkspace$/.test(name));
      if (projects.length !== 1 || workspaces.length !== 1) throw new Error('Expected one generated Xcode app');
      await command('/usr/bin/xcrun', ['xcodebuild', '-workspace', path.join(ios, workspaces[0]!), '-scheme', projects[0]!.slice(0, -10), '-configuration', 'Release', '-sdk', 'iphoneos', '-destination', 'generic/platform=iOS', '-derivedDataPath', path.join(root, 'build'), '-allowProvisioningUpdates', `DEVELOPMENT_TEAM=${record.team.id}`, 'CODE_SIGN_STYLE=Automatic', 'build'], 2_700_000);
    });
    await this.step(record, 'verify', async () => {
      const products = path.join(root, 'build/Build/Products/Release-iphoneos'); await noSymlinks(root, products);
      const apps = (await readdir(products)).filter(name => /^[A-Za-z0-9 _-]+\.app$/.test(name)); if (apps.length !== 1) throw new Error('Expected one signed iOS app');
      const name = apps[0]!, artifactPath = path.join(products, name);
      await this.verify(record, artifactPath, signal);
      const artifact = { name, ...await nativeArtifact(artifactPath) }; await this.update(record.projectId, record.id, { artifact });
    });
    signal.throwIfAborted(); await this.update(record.projectId, record.id, { state: 'ready' });
  }
  private artifactPath(root: string, record: DeliveryRecord) { if (!record.artifact) throw new BuilderError('INVALID_INPUT', 'Build and verify the signed app first.'); return path.join(root, 'build/Build/Products/Release-iphoneos', record.artifact.name); }
  private async verify(record: DeliveryRecord, app: string, signal: AbortSignal) {
    await noSymlinks(this.projects.home, app);
    const run = (command: string, args: string[]) => this.host.run({ command, args, cwd: app }, signal);
    const info = JSON.parse((await run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path.join(app, 'Info.plist')])).stdout);
    if (info.CFBundleIdentifier !== record.bundleIdentifier) throw new Error('Built app identity changed');
    await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
    const signature = await run('/usr/bin/codesign', ['-dvv', app]);
    if (!signature.stderr.split('\n').includes(`TeamIdentifier=${record.team.id}`)) throw new Error('Signing team does not match the review');
    const temp = await mkdtemp(path.join(os.tmpdir(), 'dunara-provision-'));
    try {
      const profile = path.join(temp, 'profile.plist');
      await run('/usr/bin/security', ['cms', '-D', '-i', path.join(app, 'embedded.mobileprovision'), '-o', profile]);
      const devices = z.array(z.string()).parse(JSON.parse((await run('/usr/bin/plutil', ['-extract', 'ProvisionedDevices', 'json', '-o', '-', profile])).stdout));
      const teams = z.array(z.string()).parse(JSON.parse((await run('/usr/bin/plutil', ['-extract', 'TeamIdentifier', 'json', '-o', '-', profile])).stdout));
      const expiry = Date.parse((await run('/usr/bin/plutil', ['-extract', 'ExpirationDate', 'raw', '-o', '-', profile])).stdout.trim());
      if (!devices.includes(record.device.id) || !teams.includes(record.team.id)) throw new BuilderError('INVALID_INPUT', 'The signing profile does not include this iPhone and team. Register the selected device in Xcode or your Apple Developer account, then review a new build.');
      if (!Number.isFinite(expiry) || expiry <= Date.now()) throw new BuilderError('INVALID_INPUT', 'The signing profile has expired. Refresh signing in Xcode and review a new build.');
    } finally { await rm(temp, { recursive: true, force: true }); }
  }
  private async installReview(record: DeliveryRecord): Promise<InstallPlan> {
    if (ongoing(record) || !record.artifact) throw new BuilderError('INVALID_INPUT', 'Wait for a verified signed app before installing.');
    const root = await this.directory(record.projectId, record.id), signal = AbortSignal.timeout(60_000), app = this.artifactPath(root, record);
    const fingerprint = await nativeArtifact(app); if (fingerprint.fingerprint !== record.artifact.fingerprint) throw new BuilderError('REVISION_CONFLICT', 'Signed app changed. Build and review again.');
    await this.verify(record, app, signal);
    let device, replacesExistingApp: boolean;
    try { device = await this.host.device(record.device.id, signal); replacesExistingApp = await this.host.installed(device.id, record.bundleIdentifier, signal); }
    catch (error) { throw new BuilderError('INVALID_INPUT', failureMessage('install', error)); }
    const proposedRevision = revision(json({ id: record.id, revision: record.revision, artifact: record.artifact, device, replacesExistingApp }));
    return { deliveryId: record.id, expectedRevision: record.revision, device, bundleIdentifier: record.bundleIdentifier, artifact: record.artifact, replacesExistingApp, proposedRevision, consequences: [
      `${replacesExistingApp ? 'Replace the existing app' : 'Install this signed app'} on ${device.name}. Bundle identifier: ${record.bundleIdentifier}.`,
      'This is a local testing build. Its provisioning profile can expire; rebuild if iOS later refuses to open it.',
      'Installation and launching are recorded separately. A successful launch still needs an on-phone visual and interaction check.',
    ] };
  }
  async installPlan(projectId: string, raw: unknown) {
    this.enabled(); const input = deliveryActionInput.parse(raw), record = await this.read(projectId, input.deliveryId);
    if (record.revision !== input.expectedRevision) throw new BuilderError('REVISION_CONFLICT', 'Native build status changed. Refresh it first.');
    return this.installReview(record);
  }
  async install(projectId: string, raw: unknown) {
    this.execution(); const input = deliveryInstallInput.parse(raw);
    return this.writes.run(async () => {
      if (this.active.size) throw new BuilderError('LIMIT_EXCEEDED', 'Wait for the current native operation to finish.');
      const record = await this.read(projectId, input.deliveryId);
      if (record.revision !== input.expectedRevision || (await this.installReview(record)).proposedRevision !== input.proposedRevision) throw new BuilderError('REVISION_CONFLICT', 'Installation review changed. Review again.');
      this.execution();
      const current = await this.save({ ...record, state: 'installing', step: 'install', epoch: this.epoch, error: undefined });
      this.start(current, async signal => {
        await this.step(current, 'install', async () => {
          const app = this.artifactPath(await this.directory(projectId, current.id), current);
          if ((await nativeArtifact(app)).fingerprint !== current.artifact!.fingerprint) throw new Error('Signed app changed');
          await this.host.install(current.device.id, app, signal);
          if (!await this.host.installed(current.device.id, current.bundleIdentifier, signal)) throw new Error('Installed app was not found');
        });
        await this.update(projectId, current.id, { state: 'installed' });
      }); return publicStatus(current);
    });
  }
  async launch(projectId: string, raw: unknown) {
    this.execution(); const input = deliveryLaunchInput.parse(raw);
    return this.writes.run(async () => {
      if (this.active.size) throw new BuilderError('LIMIT_EXCEEDED', 'Wait for the current native operation to finish.');
      const record = await this.read(projectId, input.deliveryId);
      if (record.revision !== input.expectedRevision) throw new BuilderError('REVISION_CONFLICT', 'Native build status changed. Refresh it first.');
      if (!record.receipts.some(receipt => receipt.step === 'install')) throw new BuilderError('INVALID_INPUT', 'Verify installation before opening this app.');
      const current = await this.save({ ...record, state: 'launching', step: 'launch', epoch: this.epoch, error: undefined });
      this.start(current, async signal => {
        let processId: number | undefined;
        await this.step(current, 'launch', async () => { await this.host.device(current.device.id, signal); processId = await this.host.launch(current.device.id, current.bundleIdentifier, signal); });
        await this.update(projectId, current.id, { state: 'launched', processId });
      }); return publicStatus(current);
    });
  }
  async cancel(projectId: string, raw: unknown) {
    this.execution(); const input = deliveryActionInput.parse(raw), record = await this.read(projectId, input.deliveryId);
    if (record.revision !== input.expectedRevision) throw new BuilderError('REVISION_CONFLICT', 'Native build status changed. Refresh it first.');
    if (record.state !== 'building') throw new BuilderError('INVALID_INPUT', 'Only an active local build can be cancelled. Installation cannot be rolled back by cancelling.');
    const active = this.active.get(record.id); if (!active) throw new BuilderError('INVALID_INPUT', 'This runtime does not own the active build.');
    active.controller.abort(); await active.task; return publicStatus(await this.read(projectId, record.id));
  }
  busy() { return this.active.size > 0; }
  async remove(projectId: string, raw: unknown) {
    this.execution(); const input = deliveryRemoveInput.parse(raw);
    return this.writes.run(async () => {
      const root = await this.directory(projectId, input.deliveryId), tombstone = path.join(await this.directory(projectId), 'removed', `${input.deliveryId}.json`);
      await noSymlinks(this.projects.home, tombstone);
      if (!await exists(root) && await exists(tombstone)) {
        const removed = z.object({ expectedRevision: z.uuid() }).parse(JSON.parse(await readText(tombstone, 2048)));
        if (removed.expectedRevision !== input.expectedRevision) throw new BuilderError('REVISION_CONFLICT', 'Removal belongs to another revision.');
        return { removed: input.deliveryId, phoneAppUnchanged: true };
      }
      const record = await this.read(projectId, input.deliveryId);
      if (record.revision !== input.expectedRevision) throw new BuilderError('REVISION_CONFLICT', 'Native build status changed. Review removal again.');
      if (ongoing(record) || this.active.has(record.id)) throw new BuilderError('INVALID_INPUT', 'Wait for this operation to finish before removing its build files.');
      await mkdir(path.dirname(tombstone), { recursive: true, mode: 0o700 }); await noSymlinks(this.projects.home, tombstone);
      await atomicWrite(tombstone, json({ expectedRevision: input.expectedRevision, removedAt: new Date().toISOString() }));
      await rm(root, { recursive: true }); this.changed(projectId);
      return { removed: record.id, phoneAppUnchanged: true };
    });
  }
  async close() { this.closed = true; for (const active of this.active.values()) active.controller.abort(); await Promise.allSettled([...this.active.values()].map(active => active.task)); }
}
