import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import { BuilderError } from '../../../core/src/contracts.js';
import { androidAction, androidBuildInput, androidDeviceId, androidInstallInput, androidRecord, androidSelection, type AndroidDelivery, type AndroidInstallPlan, type AndroidPlan } from '../../../core/src/android-delivery-contracts.js';
import type { Projects } from '../../../core/src/projects.js';
import { revision } from '../../../core/src/files.js';
import { atomicWrite, exists, noSymlinks, readText, SerialQueue } from '../../../core/src/storage.js';
import { readBinary } from './assets.js';
import type { NativeBuildWorkspaces } from './native-build-workspaces.js';
import { LocalAndroidHost, type AndroidHost } from './native-android-host.js';

const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex');
export class AndroidDeliveries {
  private epoch = randomUUID();
  private queue = new SerialQueue();
  private active?: { id: string; controller: AbortController; task: Promise<void> };
  private closed = false;
  constructor(private projects: Projects, private workspaces: NativeBuildWorkspaces, private trusted: boolean, private local: boolean, private changed: (projectId: string) => void, private host: AndroidHost = new LocalAndroidHost()) {}
  private enabled() { if (!this.local || !this.trusted || this.closed) throw new BuilderError('TRUST_REQUIRED', 'Android builds require trusted local execution in Dunara Desktop.'); }
  private async directory(projectId: string, id?: string) { await this.projects.get(projectId); if (id) z.uuid().parse(id); const root = path.join(this.projects.home, 'android-deliveries', projectId, ...(id ? [id] : [])); await noSymlinks(this.projects.home, root); return root; }
  private async read(projectId: string, id: string) {
    const record = androidRecord.parse(JSON.parse(await readText(path.join(await this.directory(projectId, id), 'record.json'), 16_384)));
    if (record.id !== id || record.projectId !== projectId) throw new BuilderError('REVISION_CONFLICT', 'Android build identity changed.');
    return record;
  }
  private async save(record: AndroidDelivery) {
    const value = androidRecord.parse({ ...record, revision: randomUUID() });
    await atomicWrite(path.join(await this.directory(record.projectId, record.id), 'record.json'), JSON.stringify(value)); this.changed(record.projectId); return value;
  }
  private update(projectId: string, id: string, patch: Partial<AndroidDelivery>) { return this.queue.run(async () => this.save({ ...await this.read(projectId, id), ...patch })); }
  preflight() { this.enabled(); return this.host.inspect(); }
  async list(projectId: string) {
    this.enabled(); const directory = await this.directory(projectId); if (!await exists(directory)) return [];
    return this.queue.run(async () => {
      const records = [];
      for (const id of (await readdir(directory)).filter(id => z.uuid().safeParse(id).success).slice(0, 20)) {
        let record = await this.read(projectId, id);
        if (['building', 'installing'].includes(record.state) && record.epoch !== this.epoch) record = await this.save({ ...record, state: 'interrupted', error: 'Dunara stopped during this operation. Check the device before retrying; no automatic retry was made.' });
        records.push(record);
      }
      return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    });
  }
  async plan(projectId: string, input: unknown): Promise<AndroidPlan> {
    this.enabled(); const selection = androidSelection.parse(input), source = await this.workspaces.deliverySource(projectId, selection.workspaceId, 'android'), host = await this.preflight();
    if (!host.available) throw new BuilderError('INVALID_INPUT', host.issues.join(' '));
    const app = JSON.parse(source.snapshot.contents.get('app.json')!.toString());
    const packageName = androidRecord.shape.packageName.parse(app.expo?.android?.package);
    return { selection, packageName, backend: source.record.backend.environment, proposedRevision: revision(JSON.stringify({ selection, packageName, source: source.snapshot.fingerprint, workspace: source.record.revision })), consequences: ['Build a separate copy with Expo and Gradle. Dependencies and Android tools may be downloaded.', 'Create a signed APK with bundled JavaScript for device testing. It uses the generated project’s preview signing configuration; it is not a Play Store release.', `Use the reviewed ${source.record.backend.environment} backend from this preparation.`, 'Installation is a separate reviewed action. Your source app is unchanged.'] };
  }
  async build(projectId: string, raw: unknown) {
    this.enabled(); const input = androidBuildInput.parse(raw);
    return this.queue.run(async () => {
      this.enabled();
      const root = await this.directory(projectId, input.requestId);
      const tombstone = path.join(await this.directory(projectId), 'removed', `${input.requestId}.json`); await noSymlinks(this.projects.home, tombstone);
      if (await exists(tombstone)) throw new BuilderError('REVISION_CONFLICT', 'This build was removed. Review a new build with a new request ID.');
      if (await exists(root)) { const record = await this.read(projectId, input.requestId); if (record.inputFingerprint !== input.proposedRevision || record.workspaceId !== input.selection.workspaceId) throw new BuilderError('REVISION_CONFLICT', 'Request ID belongs to another build.'); return record; }
      if (this.active) throw new BuilderError('LIMIT_EXCEEDED', 'Wait for the current Android operation.');
      const parent = await this.directory(projectId); if (await exists(parent) && (await readdir(parent)).filter(id => z.uuid().safeParse(id).success).length >= 10) throw new BuilderError('LIMIT_EXCEEDED', 'Ten Android builds are retained. Remove a completed local build before creating another.');
      const plan = await this.plan(projectId, input.selection);
      if (plan.proposedRevision !== input.proposedRevision) throw new BuilderError('REVISION_CONFLICT', 'Preparation changed. Review the Android build again.');
      const source = await this.workspaces.deliverySource(projectId, input.selection.workspaceId, 'android');
      if (revision(JSON.stringify({ selection: plan.selection, packageName: plan.packageName, source: source.snapshot.fingerprint, workspace: source.record.revision })) !== input.proposedRevision) throw new BuilderError('REVISION_CONFLICT', 'Preparation changed. Review the Android build again.');
      await mkdir(root, { recursive: true, mode: 0o700 });
      const record = await this.save({ version: 1, id: input.requestId, projectId, revision: randomUUID(), epoch: this.epoch, workspaceId: input.selection.workspaceId, inputFingerprint: input.proposedRevision, packageName: plan.packageName, sourceFingerprint: source.record.sourceFingerprint, state: 'building', step: 'copy', createdAt: new Date().toISOString() });
      this.start(record, signal => this.compile(record, source.snapshot.contents, signal)); return record;
    });
  }
  private start(record: AndroidDelivery, work: (signal: AbortSignal) => Promise<void>) {
    const controller = new AbortController();
    const task = Promise.resolve().then(() => work(controller.signal)).catch(async () => {
      await this.update(record.projectId, record.id, { state: controller.signal.aborted ? 'interrupted' : 'failed', error: controller.signal.aborted ? 'Operation stopped. Check the phone before retrying an installation.' : 'Android operation could not finish. Check SDK/JDK setup, accepted SDK licenses, network access and device authorization. Review again before retrying.' });
    }).finally(() => { this.active = undefined; });
    this.active = { id: record.id, controller, task }; void task.catch(() => {});
  }
  private async compile(record: AndroidDelivery, source: Map<string, Buffer>, signal: AbortSignal) {
    const root = await this.directory(record.projectId, record.id), app = path.join(root, 'app');
    for (const [name, bytes] of source) { signal.throwIfAborted(); const file = path.join(app, name); await mkdir(path.dirname(file), { recursive: true }); await noSymlinks(root, file); await writeFile(file, bytes, { flag: 'wx', mode: 0o600 }); }
    const command = async (step: AndroidDelivery['step'], command: string, args: string[], cwd = app, timeout = 300_000) => { signal.throwIfAborted(); await this.update(record.projectId, record.id, { step }); await this.host.run({ command, args, cwd, timeout }, signal); };
    await command('dependencies', 'npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund']);
    await command('prebuild', process.execPath, ['node_modules/expo/bin/cli', 'prebuild', '--platform', 'android', '--no-install', '--skip-dependency-update', 'react,react-native']);
    const android = path.join(app, 'android'); await noSymlinks(root, android);
    await command('compile', '/bin/sh', ['./gradlew', ':app:assembleRelease', '--no-daemon'], android, 2_700_000);
    await this.update(record.projectId, record.id, { step: 'verify' });
    const built = path.join(android, 'app/build/outputs/apk/release/app-release.apk'); await noSymlinks(root, built);
    await this.host.verify(built, record.packageName, signal);
    const bytes = await readBinary(built, 256 * 1024 * 1024), target = path.join(root, 'preview.apk');
    signal.throwIfAborted(); await writeFile(target, bytes, { flag: 'wx', mode: 0o600 });
    await this.update(record.projectId, record.id, { state: 'ready', artifact: { fingerprint: hash(bytes), bytes: bytes.length } });
  }
  async artifact(projectId: string, id: string) {
    this.enabled(); const record = await this.read(projectId, id);
    if (!record.artifact || !['ready', 'installed', 'failed', 'interrupted'].includes(record.state)) throw new BuilderError('INVALID_INPUT', 'Build a verified APK first.');
    const file = path.join(await this.directory(projectId, id), 'preview.apk'); await noSymlinks(this.projects.home, file);
    const bytes = await readBinary(file, 256 * 1024 * 1024);
    if (hash(bytes) !== record.artifact.fingerprint || bytes.length !== record.artifact.bytes) throw new BuilderError('REVISION_CONFLICT', 'APK changed. Build and review it again.');
    return { file, bytes, record };
  }
  async installPlan(projectId: string, raw: unknown): Promise<AndroidInstallPlan> {
    this.enabled(); const input = androidAction.extend({ deviceId: androidDeviceId }).strict().parse(raw), { record } = await this.artifact(projectId, input.id);
    if (record.revision !== input.expectedRevision) throw new BuilderError('REVISION_CONFLICT', 'Android build changed. Review again.');
    const device = (await this.preflight()).devices.find(device => device.id === input.deviceId);
    if (!device) throw new BuilderError('INVALID_INPUT', 'Connect and authorize the selected Android device.');
    const replacesExistingApp = await this.host.installed(input.deviceId, record.packageName, AbortSignal.timeout(30_000));
    return { ...input, packageName: record.packageName, replacesExistingApp, proposedRevision: revision(JSON.stringify({ input, artifact: record.artifact, device, replacesExistingApp })) };
  }
  async install(projectId: string, raw: unknown) {
    this.enabled(); const input = androidInstallInput.parse(raw);
    return this.queue.run(async () => {
      this.enabled();
      if (this.active) throw new BuilderError('LIMIT_EXCEEDED', 'Wait for the current Android operation.');
      const plan = await this.installPlan(projectId, { id: input.id, expectedRevision: input.expectedRevision, deviceId: input.deviceId });
      if (plan.proposedRevision !== input.proposedRevision) throw new BuilderError('REVISION_CONFLICT', 'Device or app replacement status changed. Review installation again.');
      const { file, record } = await this.artifact(projectId, input.id);
      const next = await this.save({ ...record, state: 'installing', step: 'install', deviceId: input.deviceId });
      this.start(next, async signal => { await this.host.install(input.deviceId, file, signal); if (!await this.host.installed(input.deviceId, record.packageName, signal)) throw new Error('Installation not verified'); await this.update(projectId, input.id, { state: 'installed', error: undefined }); });
      return next;
    });
  }
  async cancel(projectId: string, raw: unknown) {
    this.enabled(); const input = androidAction.parse(raw), record = await this.read(projectId, input.id);
    if (record.revision !== input.expectedRevision || this.active?.id !== record.id) throw new BuilderError('REVISION_CONFLICT', 'Operation changed. Refresh its status.');
    this.active.controller.abort(); return { stopping: true };
  }
  async remove(projectId: string, raw: unknown) {
    this.enabled(); const input = androidAction.extend({ confirmed: z.literal(true) }).strict().parse(raw);
    return this.queue.run(async () => {
      const record = await this.read(projectId, input.id);
      if (record.revision !== input.expectedRevision || this.active?.id === input.id || ['building', 'installing'].includes(record.state)) throw new BuilderError('REVISION_CONFLICT', 'Build changed or is still running. Refresh its status.');
      const root = await this.directory(projectId, input.id), tombstones = path.join(await this.directory(projectId), 'removed');
      await noSymlinks(this.projects.home, tombstones); await mkdir(tombstones, { recursive: true, mode: 0o700 });
      await atomicWrite(path.join(tombstones, `${input.id}.json`), JSON.stringify({ id: input.id, removedAt: new Date().toISOString() }));
      await rm(root, { recursive: true }); this.changed(projectId); return { removed: true };
    });
  }
  async close() { this.closed = true; await this.queue.run(async () => { this.active?.controller.abort(); }); await this.active?.task.catch(() => {}); }
}
