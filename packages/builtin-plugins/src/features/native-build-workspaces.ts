import { cp, lstat, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { BuilderError } from "../../../core/src/contracts.js";
import { revision } from "../../../core/src/files.js";
import { dependencyFiles, dependencyProfile } from "../../../core/src/dependency-profiles.js";
import { Projects, templateRoot } from "../../../core/src/projects.js";
import { Processes } from "../../../core/src/processes.js";
import { atomicWrite, exists, noSymlinks, readText, SerialQueue } from "../../../core/src/storage.js";
import { nativeBuildConfiguration, nativeBuildProfiles } from "../../../core/src/native-builds.js";
import { boundedFile, exportManifest, manifest, sourceSnapshot, type Snapshot } from "../../../core/src/native-workspace-source.js";
import { workspaceActionInput, workspacePrepareInput, workspaceRecord, workspaceRemoveInput, workspaceSelection, type WorkspacePlan, type WorkspaceRecord, type WorkspaceSelection, type WorkspaceStatus } from "../../../core/src/native-workspace-contracts.js";
import type { AppEnvironment } from "../../../core/src/runtime-environment.js";
import { desiredConfiguration } from "../../../platform/src/configuration.js";

const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
type Environment = { app: AppEnvironment; revision: string };
type Runner = (step: WorkspaceRecord['step'], directory: string, env: AppEnvironment, signal: AbortSignal) => Promise<void>;
const status = ({ epoch: _epoch, directoryIdentity: _identity, ...value }: WorkspaceRecord): WorkspaceStatus => value;
export class NativeBuildWorkspaces {
  private readonly epoch = randomUUID();
  private readonly writes = new SerialQueue();
  private readonly active = new Map<string, { controller: AbortController; task: Promise<void> }>();
  private readonly processes = new Processes();
  private closed = false;
  constructor(private projects: Projects, private trusted: boolean, private environment: (id: string, selection: WorkspaceSelection) => Promise<Environment>, private assertReady: (id: string) => Promise<void>, private changed: (id: string) => void, private runner?: Runner) {}
  private async directory(projectId: string, id?: string) {
    z.uuid().parse(projectId); if (id) z.uuid().parse(id);
    const root = path.join(this.projects.home, 'native-workspaces', projectId, ...(id ? [id] : []));
    await noSymlinks(this.projects.home, root); return root;
  }
  private async read(projectId: string, id: string) {
    await this.projects.get(projectId);
    const root = await this.directory(projectId, id), record = workspaceRecord.parse(JSON.parse(await readText(path.join(root, 'record.json'), 512_000)));
    const info = await lstat(root);
    if (record.projectId !== projectId || record.id !== id || record.directoryIdentity.device !== info.dev || record.directoryIdentity.inode !== info.ino) throw new BuilderError('REVISION_CONFLICT', 'Prepared workspace identity changed.');
    return record;
  }
  private async save(record: WorkspaceRecord) {
    const value = workspaceRecord.parse({ ...record, revision: randomUUID(), updatedAt: new Date().toISOString() });
    const root = await this.directory(value.projectId, value.id);
    await noSymlinks(root, path.join(root, 'record.json'));
    await atomicWrite(path.join(root, 'record.json'), json(value)); this.changed(value.projectId); return value;
  }
  private update(projectId: string, id: string, patch: Partial<WorkspaceRecord>) {
    return this.writes.run(async () => this.save({ ...await this.read(projectId, id), ...patch }));
  }
  async get(projectId: string, id: string) {
    return this.writes.run(async () => {
      let record = await this.read(projectId, id);
      if (['preparing', 'cancelling'].includes(record.state) && record.epoch !== this.epoch) record = await this.save({ ...record, state: 'interrupted', error: 'Dunara stopped during preparation. Review a new preparation; this workspace is retained for inspection or removal.' });
      return status(record);
    });
  }
  /** Consume the reviewed immutable inputs, never the mutable npm/tooling directory. */
  async deliverySource(projectId: string, id: string, platform: 'ios' | 'android' = 'ios') {
    return this.writes.run(async () => {
      const record = await this.read(projectId, id);
      if (record.state !== 'ready' || record.selection.profile !== 'preview' || record.selection.platform !== 'all' && record.selection.platform !== platform) throw new BuilderError('INVALID_INPUT', `Prepare a successful ${platform === 'ios' ? 'iOS' : 'Android'} Preview workspace first.`);
      const root = path.join(await this.directory(projectId, id), 'input');
      const snapshot = await sourceSnapshot(root);
      if (!isDeepStrictEqual(snapshot.files, record.files)) throw new BuilderError('REVISION_CONFLICT', 'Prepared inputs changed. Review a new preparation.');
      return { record: status(record), snapshot };
    });
  }
  async list(projectId: string) {
    await this.projects.get(projectId); const root = await this.directory(projectId);
    if (!await exists(root)) return [];
    const ids = await readdir(root);
    if (ids.length > 10) throw new BuilderError('LIMIT_EXCEEDED', 'Remove old build workspaces before continuing.');
    const records = await Promise.all(ids.map(id => this.get(projectId, id)));
    return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  private async dependencies(root: string, selection: WorkspaceSelection, name: string) {
    const original = await dependencyFiles(root);
    if (await dependencyProfile(original) !== 'expo-supabase-v1') throw new BuilderError('DEPENDENCIES_CHANGED', 'Build preparation currently supports the curated Supabase Expo profile. Review a recipe upgrade or custom dependency integration first.');
    if (selection.profile === 'preview') return { ...original, profile: 'expo-supabase-v1' };
    const nativeRoot = path.resolve(templateRoot, '../expo-native');
    if (!await exists(path.join(nativeRoot, 'package.json')) || !await exists(path.join(nativeRoot, 'package-lock.json'))) throw new BuilderError('DEPENDENCIES_CHANGED', 'The native development dependency profile is not qualified yet. Preview preparation is available.');
    const native = await dependencyFiles(nativeRoot);
    const packageJson = JSON.parse(native.manifest), lock = JSON.parse(native.lock);
    if (!isDeepStrictEqual(packageJson.dependencies, lock.packages?.['']?.dependencies) || packageJson.dependencies['expo-dev-client'] !== lock.packages?.['node_modules/expo-dev-client']?.version || !lock.packages?.['node_modules/expo-dev-client']?.integrity) throw new BuilderError('DEPENDENCIES_CHANGED', 'The native development dependency profile is not qualified yet. Preview preparation is available.');
    packageJson.name = name; lock.name = name; lock.packages[''].name = name;
    return { manifest: json(packageJson), lock: json(lock), profile: 'expo-native-v1' };
  }
  private async snapshot(projectId: string, input: unknown): Promise<{ plan: WorkspacePlan; source: Snapshot; prepared: Snapshot; app: AppEnvironment }> {
    const selection = workspaceSelection.parse(input), project = await this.projects.get(projectId), identity = await lstat(project.root);
    await this.assertReady(projectId);
    const dependencies = await this.dependencies(project.root, selection, project.slug), source = await sourceSnapshot(project.root);
    const text = (name: string) => { const data = source.contents.get(name); if (!data) throw new BuilderError('INVALID_INPUT', `Missing build input: ${name}`); return new TextDecoder('utf-8', { fatal: true }).decode(data); };
    const config = JSON.parse(text('app.json')), expo = config.expo;
    const parsed = nativeBuildConfiguration.safeParse({ iosBundleIdentifier: expo?.ios?.bundleIdentifier, androidPackage: expo?.android?.package, scheme: expo?.scheme, ...(expo?.owner || expo?.extra?.eas?.projectId ? { expoOwner: expo.owner, easProjectId: expo.extra?.eas?.projectId } : {}) });
    if (!parsed.success) throw new BuilderError('INVALID_INPUT', 'Save valid app identifiers in Build setup before preparing a workspace.');
    const eas = JSON.parse(text('eas.json'));
    if (!desiredConfiguration.safeParse(JSON.parse(text('backend/configuration.json'))).success) throw new BuilderError('INVALID_INPUT', 'Backend configuration must contain only supported public settings and private-input references.');
    if (!isDeepStrictEqual(eas.build?.[selection.profile], nativeBuildProfiles[selection.profile])) throw new BuilderError('INVALID_INPUT', 'This build profile differs from the reviewed Dunara profile. Integrate custom build profiles manually.');
    // The checked client gives defined env-over-file precedence. Custom clients need their own integration.
    const client = await boundedFile(templateRoot, 'src/backend/client.ts');
    if (!source.contents.get('src/backend/client.ts')?.equals(client)) throw new BuilderError('INVALID_INPUT', 'Custom backend clients need a reviewed environment integration before build preparation.');
    const environment = await this.environment(projectId, selection), app = environment.app;
    const connection = { environment: selection.environment, url: app.EXPO_PUBLIC_SUPABASE_URL ?? '', publishableKey: app.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? '' };
    if (selection.environment !== 'none' && (!/^https:\/\/[a-z0-9]{20}\.supabase\.co$/.test(connection.url) || !connection.publishableKey.startsWith('sb_publishable_'))) throw new BuilderError('INVALID_INPUT', 'Link the intended backend environment before preparing its build.');
    const contents = new Map(source.contents), overlays: WorkspacePlan['overlays'] = [];
    for (const [name, after] of [['package.json', dependencies.manifest], ['package-lock.json', dependencies.lock], ['backend/connection.json', json(connection)]] as const) {
      const before = contents.get(name);
      contents.set(name, Buffer.from(after));
      if (!before?.equals(Buffer.from(after))) overlays.push({ path: name, before: before ? revision(before.toString('utf8')) : null, after: revision(after) });
    }
    const prepared = manifest(contents);
    const backend = { environment: selection.environment, url: connection.url, publishableKeyFingerprint: connection.publishableKey ? revision(connection.publishableKey) : null };
    const dependencyFingerprint = revision(dependencies.manifest + '\0' + dependencies.lock);
    const proposedRevision = revision(JSON.stringify({ version: 1, projectId, root: project.root, device: identity.dev, inode: identity.ino, source: source.fingerprint, prepared: prepared.fingerprint, dependencyFingerprint, environment: environment.revision, selection }));
    return { source, prepared, app, plan: {
      project: { id: projectId, name: project.name }, selection, proposedRevision, sourceFingerprint: source.fingerprint, dependencyFingerprint,
      backend, files: prepared.files, bytes: prepared.bytes, dependencyProfile: dependencies.profile, overlays,
      consequences: ['Copy reviewed source and assets into a private workspace. Keep your app and running preview unchanged.', 'Install pinned dependencies, check TypeScript and export web/native JavaScript. Runs trusted app tooling on this computer, in a separate directory rather than a security sandbox.', 'Use the selected public backend in this copy. Choosing No backend clears its saved connection.', 'No source upload, signing or cloud build. Exported JavaScript is not an installable app.'],
    } };
  }
  plan(projectId: string, input: unknown) { return this.projects.mutations.run(async () => (await this.snapshot(projectId, input)).plan); }
  async prepare(projectId: string, input: unknown) {
    const value = workspacePrepareInput.parse(input);
    return this.projects.mutations.run(async () => {
      if (this.closed) throw new BuilderError('INVALID_INPUT', 'Dunara is shutting down.');
      const existing = await this.directory(projectId, value.requestId);
      if (await exists(existing)) {
        const record = await this.get(projectId, value.requestId);
        if (record.inputFingerprint !== value.proposedRevision || !isDeepStrictEqual(record.selection, value.selection)) throw new BuilderError('REVISION_CONFLICT', 'Preparation request ID belongs to different inputs.');
        return record;
      }
      if (!this.trusted) throw new BuilderError('TRUST_REQUIRED', 'Authorize app execution in Dunara before preparing build workspaces.');
      if (this.active.size) throw new BuilderError('LIMIT_EXCEEDED', 'One build preparation can run at a time. Wait or cancel it first.');
      if ((await this.list(projectId)).length >= 5) throw new BuilderError('LIMIT_EXCEEDED', 'Remove an old build workspace before preparing another (limit: 5 per app).');
      const snapshot = await this.snapshot(projectId, value.selection);
      if (snapshot.plan.proposedRevision !== value.proposedRevision) throw new BuilderError('REVISION_CONFLICT', 'Build inputs changed. Review a new preparation before executing.');
      await mkdir(existing, { recursive: true, mode: 0o700 }); await this.directory(projectId, value.requestId);
      const info = await lstat(existing), now = new Date().toISOString();
      let record: WorkspaceRecord = { version: 1, id: value.requestId, projectId, revision: randomUUID(), inputFingerprint: value.proposedRevision, sourceFingerprint: snapshot.source.fingerprint, dependencyFingerprint: snapshot.plan.dependencyFingerprint, selection: value.selection, backend: snapshot.plan.backend, files: snapshot.prepared.files, state: 'preparing', step: 'copy', createdAt: now, updatedAt: now, epoch: this.epoch, directoryIdentity: { device: info.dev, inode: info.ino }, receipts: [], exports: [] };
      try { record = await this.save(record); }
      catch (error) { await rm(existing, { recursive: true, force: true }); throw error; }
      const controller = new AbortController();
      const task = Promise.resolve().then(() => this.execute(record, snapshot.prepared, snapshot.app, controller)).finally(() => { this.active.delete(record.id); this.changed(projectId); });
      this.active.set(record.id, { controller, task });
      // Observe terminal persistence failures without creating an unhandled rejection.
      void task.catch(() => {});
      return status(record);
    });
  }
  private async execute(record: WorkspaceRecord, prepared: Snapshot, app: AppEnvironment, controller: AbortController) {
    const root = await this.directory(record.projectId, record.id), work = path.join(root, 'app'), source = path.join(root, 'input');
    const signal = controller.signal, timer = setTimeout(() => controller.abort('deadline'), 12 * 60_000);
    let step: WorkspaceRecord['step'] = 'copy';
    const receipts: WorkspaceRecord['receipts'] = [], exports: WorkspaceRecord['exports'] = [];
    try {
      for (const [relative, content] of prepared.contents) {
        signal.throwIfAborted(); const target = path.join(source, relative);
        await mkdir(path.dirname(target), { recursive: true, mode: 0o700 }); await noSymlinks(root, target);
        await writeFile(target, content, { flag: 'wx', mode: 0o600 });
      }
      await cp(source, work, { recursive: true, errorOnExist: true, force: false });
      const steps: WorkspaceRecord['step'][] = ['install', 'typecheck', 'export-web', ...(record.selection.platform === 'all' ? ['export-ios', 'export-android'] as const : [`export-${record.selection.platform}` as const]), 'verify'];
      for (step of steps) {
        signal.throwIfAborted(); await this.update(record.projectId, record.id, { step }); signal.throwIfAborted();
        if (step === 'verify') {
          const input = await sourceSnapshot(source);
          if (input.fingerprint !== prepared.fingerprint) throw new Error('Immutable build inputs changed during validation.');
          for (const file of prepared.files) if (!(await boundedFile(work, file.path)).equals(prepared.contents.get(file.path)!)) throw new Error('App tooling changed a reviewed build input.');
        } else {
          await (this.runner ? this.runner(step, work, app, signal) : this.run(step, work, app, signal));
          if (step.startsWith('export-')) {
            const platform = step.slice(7) as 'web' | 'ios' | 'android', exported = await exportManifest(path.join(root, 'exports', platform));
            if (!exported.files.length) throw new Error('No export artifacts were produced.');
            exports.push({ platform, files: exported.files.length, bytes: exported.bytes, fingerprint: exported.fingerprint });
          }
        }
        receipts.push({ step, completedAt: new Date().toISOString() });
        await this.update(record.projectId, record.id, { receipts: [...receipts], exports: [...exports] });
      }
      await this.writes.run(async () => {
        signal.throwIfAborted();
        await this.save({ ...await this.read(record.projectId, record.id), state: 'ready' });
      });
    } catch {
      const state = signal.aborted ? signal.reason === 'runtime_stopped' ? 'interrupted' : signal.reason === 'deadline' ? 'failed' : 'cancelled' : 'failed';
      await this.update(record.projectId, record.id, { state, error: state === 'cancelled' ? 'Preparation cancelled. The original app is unchanged.' : state === 'interrupted' ? 'Dunara stopped during preparation. Review a new preparation to continue.' : `Preparation failed during ${step}. Check the selected source/dependency profile and trusted tooling before reviewing a new preparation.` });
    } finally { clearTimeout(timer); }
  }
  private async run(step: WorkspaceRecord['step'], cwd: string, env: AppEnvironment, signal: AbortSignal) {
    const log = () => {}; // Compiler output can contain arbitrary app data; receipts expose only bounded stage outcomes.
    if (step === 'install') return this.processes.run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], cwd, log, signal, env);
    if (step === 'typecheck') return this.processes.run(process.execPath, [path.join(cwd, 'node_modules/typescript/bin/tsc'), '--noEmit'], cwd, log, signal, env);
    const platform = step.slice(7);
    return this.processes.run(process.execPath, [path.join(cwd, 'node_modules/expo/bin/cli'), 'export', '--platform', platform, '--output-dir', path.join(cwd, '../exports', platform)], cwd, log, signal, env);
  }
  async cancel(projectId: string, input: unknown) {
    const value = workspaceActionInput.parse(input);
    return this.writes.run(async () => {
      const record = await this.read(projectId, value.workspaceId);
      if (record.revision !== value.expectedRevision) throw new BuilderError('REVISION_CONFLICT', 'Preparation changed. Refresh its status first.');
      const active = this.active.get(record.id);
      if (!active || !['preparing', 'cancelling'].includes(record.state)) throw new BuilderError('INVALID_INPUT', 'This preparation is not running in this runtime.');
      const next = await this.save({ ...record, state: 'cancelling' }); active.controller.abort('user_cancelled'); return status(next);
    });
  }
  async remove(projectId: string, input: unknown) {
    const value = workspaceRemoveInput.parse(input);
    return this.writes.run(async () => {
      const record = await this.read(projectId, value.workspaceId);
      if (record.revision !== value.expectedRevision || this.active.has(record.id) || ['preparing', 'cancelling'].includes(record.state)) throw new BuilderError('REVISION_CONFLICT', 'Preparation changed or is still running. Refresh before removing it.');
      await rm(await this.directory(projectId, record.id), { recursive: true }); this.changed(projectId); return { removed: record.id };
    });
  }
  async close() {
    this.closed = true;
    for (const active of this.active.values()) active.controller.abort('runtime_stopped');
    await Promise.allSettled([...this.active.values()].map(value => value.task)); await this.processes.close();
  }
}
