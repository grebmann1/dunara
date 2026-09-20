import { lstat, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { BuilderError, revisionSchema } from "../../../core/src/contracts.js";
import { dependencyFiles, dependencyProfile } from "../../../core/src/dependency-profiles.js";
import { revision } from "../../../core/src/files.js";
import type { Projects } from "../../../core/src/projects.js";
import type { PreviewDriver } from "../../../core/src/preview-driver.js";
import { atomicWrite, exists, noSymlinks, readText } from "../../../core/src/storage.js";

const reservedSchemes = new Set(['http', 'https', 'exp', 'exps', 'file', 'intent', 'mailto', 'tel', 'sms', 'data', 'javascript']);
const reservedPackages = new Set('abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for goto if implements import instanceof int interface long native new package private protected public return short static strictfp super switch synchronized this throw throws transient try void volatile while true false null _'.split(' '));
export const nativeBuildConfiguration = z.object({
  iosBundleIdentifier: z.string().min(3).max(155).regex(/^[A-Za-z][A-Za-z0-9-]*(\.[A-Za-z][A-Za-z0-9-]*)+$/),
  androidPackage: z.string().min(3).max(155).regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/).refine(value => !value.split('.').some(part => reservedPackages.has(part)), 'Use non-reserved package segments'),
  scheme: z.string().min(2).max(63).regex(/^[a-z][a-z0-9+.-]*$/).refine(value => !reservedSchemes.has(value), 'Choose an app-specific URL scheme'),
  expoOwner: z.string().min(2).max(64).regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/).optional(),
  easProjectId: z.uuid().optional(),
}).strict().refine(value => !!value.expoOwner === !!value.easProjectId, 'Provide both the Expo owner and existing EAS project ID, or leave both empty');
export const nativeBuildApplyInput = z.object({ configuration: nativeBuildConfiguration.optional(), proposedRevision: revisionSchema, confirmed: z.literal(true) }).strict();
export type NativeBuildConfiguration = z.infer<typeof nativeBuildConfiguration>;
const paths = ['app.json', 'eas.json'] as const;
const identitySchema = z.object({ id: z.uuid(), root: z.string(), device: z.number(), inode: z.number() }).strict();
const changeSchema = z.object({ path: z.enum(paths), before: z.string().max(64_000).nullable(), after: z.string().max(64_000).nullable() }).strict();
const journalSchema = z.object({ version: z.literal(1), identity: identitySchema, files: z.array(changeSchema).min(1).max(2) }).strict();
type Change = z.infer<typeof changeSchema>;
type Identity = z.infer<typeof identitySchema>;
type Json = Record<string, unknown>;
const object = (value: unknown, label: string): Json => {
  const result = z.record(z.string(), z.unknown()).safeParse(value);
  if (!result.success) throw new BuilderError('INVALID_INPUT', `${label} must be a JSON object. Review its configuration manually.`);
  return result.data;
};
const child = (parent: Json, key: string) => parent[key] === undefined ? {} : object(parent[key], key);
const string = (value: unknown) => typeof value === 'string' ? value : '';
const serialize = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
export const nativeBuildProfiles = {
  development: { developmentClient: true, distribution: 'internal', environment: 'development' },
  preview: { developmentClient: false, distribution: 'internal', environment: 'preview', android: { buildType: 'apk' } },
} as const;
export const nativeBuildGuide = {
  user: [
    'Open Preview tools → Build setup. Enter iOS and Android identifiers in a namespace you control and a unique app URL scheme.',
    'Optionally enter the owner and project ID of this app’s existing Expo project. Dunara records this link locally; ownership must still be verified with Expo.',
    'Review the exact local file changes and save the setup. The preview stops when configuration changes; restart it when ready.',
    'In Build setup, choose the build profile, platforms and backend under Prepare a build workspace. Review the copied files and public backend target, then prepare the workspace. Development requires a qualified Expo development-client profile.',
    'Follow the preparation checks through dependency installation, TypeScript and web/native JavaScript export. Failed or interrupted work stays available to inspect or remove; a new preparation requires a fresh review. The original app and preview stay unchanged.',
    'For a local iPhone build, prepare Preview → iOS → No backend. Under Install on iPhone, check the phone and signing team, review automatic Apple provisioning, then build the signed app with Xcode. No Expo account is required for this path.',
    'After the signed app is ready, review installation on the selected iPhone. Existing apps with the same bundle identifier are replaced. Unlock the phone, enable Developer Mode and trust this Mac when iOS asks. Open on iPhone after installation is verified.',
    'Check the installed app’s screens and main interactions with the preview server stopped. A launch receipt proves the OS started the app, not that its screen is correct.',
    'Cloud/EAS builds remain separate: verify Expo ownership, signing and public environment configuration before uploading. Never put management tokens, service-role keys or function secrets in a mobile app.',
  ],
  agent: [
    'Use native_build_inspect to read the app identity, dependency revision, and prerequisites. Obtain intended identifiers and Expo ownership from the user; do not guess ownership or reuse another app’s IDs.',
    'Call native_build_plan with configuration. Resolve conflicts; show the reviewed identifiers, profiles, file changes and consequences.',
    'After review call native_build_apply with the same configuration, proposedRevision and confirmed:true. The built-in Assistant requires human approval. Source, dependency and registered-identity changes invalidate approval.',
    'If recoveryRequired is true, call native_build_plan without configuration and review restoration before applying without configuration. Preserve concurrent edits and resolve conflicts manually.',
    'Call native_workspace_plan with an explicit profile, platform and backend environment. Review its manifest, overlays, target and consequences; native_workspace_prepare requires that proposedRevision, a stable requestId and confirmed:true. Human approval is required in the built-in Assistant. Reuse the same requestId after a lost response; never automatically replay interrupted work.',
    'Read native_workspace_list for durable checks and export receipts. Cancel or remove with the selected workspace ID and its current revision; removal also requires confirmed:true. Source or backend changes invalidate unexecuted plans.',
    'Preparation installs pinned dependencies and checks JavaScript exports in a separate local directory. It does not authenticate Expo, generate native projects, upload source, sign, build or distribute an app. Never report a binary or physical-device test from a setup or preparation result.',
    'For local iOS delivery, use native_delivery_preflight and native_delivery_plan with an exact ready Preview/No backend workspace, device and Apple signing team. Review automatic provisioning effects; native_delivery_build requires the proposal revision, stable requestId and confirmed:true. Poll native_delivery_list for signed artifact receipts. Built-in Assistant mutations require human approval.',
    'After build success, call native_delivery_install_plan with the delivery ID and current revision. Review device, artifact and existing-app replacement before native_delivery_install. Inspect again, then native_delivery_launch opens only that app. Never retry uncertain installation automatically; never claim visual or interaction success from a launch process ID.',
  ],
};
export type NativeBuildPlan = {
  project: { id: string; name: string }; version: 1; proposedRevision: string;
  state: 'ready' | 'current' | 'conflict' | 'recovery'; configuration: NativeBuildConfiguration | null;
  files: Change[]; conflicts: string[]; consequences: string[];
};

/** Local, revision-checked managed-app configuration. Provider ownership remains unverified. */
export class NativeBuilds {
  constructor(private projects: Projects, private previews: PreviewDriver) {}
  private async identity(id: string): Promise<Identity> {
    const project = await this.projects.get(id), stat = await lstat(project.root);
    return { id, root: project.root, device: stat.dev, inode: stat.ino };
  }
  private async journalPath(id: string) {
    z.uuid().parse(id);
    const file = path.join(this.projects.home, 'native-builds', `${id}.json`);
    await noSymlinks(this.projects.home, file); return file;
  }
  async assertReady(id: string) {
    if (await exists(await this.journalPath(id))) throw new BuilderError('REVISION_CONFLICT', 'An interrupted build setup needs recovery in Preview tools → Build setup before previewing.');
  }
  private async content(root: string, relative: string) {
    const file = path.join(root, relative); await noSymlinks(root, file);
    return await exists(file) ? readText(file, 64_000) : null;
  }
  private async documents(id: string) {
    const identity = await this.identity(id), appText = await this.content(identity.root, 'app.json'), easText = await this.content(identity.root, 'eas.json');
    if (appText === null) throw new BuilderError('INVALID_INPUT', 'Build setup requires a static app.json.');
    const app = object(JSON.parse(appText), 'app.json'), expo = object(app.expo, 'expo'), eas = easText === null ? {} : object(JSON.parse(easText), 'eas.json');
    return { identity, appText, easText, app, expo, eas };
  }
  async inspect(id: string) {
    return this.projects.mutations.run(async () => {
      const recoveryRequired = !!await exists(await this.journalPath(id));
      const project = await this.projects.get(id), { identity, expo, eas } = await this.documents(id).catch(async error => {
        if (!recoveryRequired) throw error;
        // Keep recovery accessible even if a concurrent editor left invalid JSON.
        return { identity: await this.identity(id), expo: {} as Json, eas: {} as Json };
      });
      const dependencies = await dependencyFiles(identity.root), manifest = object(JSON.parse(dependencies.manifest), 'package.json');
      const deps = child(manifest, 'dependencies'), extra = child(expo, 'extra'), easIdentity = child(extra, 'eas');
      return {
        project: { id, name: project.name }, recoveryRequired,
        configuration: { iosBundleIdentifier: string(child(expo, 'ios').bundleIdentifier), androidPackage: string(child(expo, 'android').package), scheme: string(expo.scheme), expoOwner: string(expo.owner), easProjectId: string(easIdentity.projectId) },
        profiles: child(eas, 'build'),
        dependencies: { profile: await dependencyProfile(dependencies), revision: revision(dependencies.manifest + '\0' + dependencies.lock), expo: string(deps.expo), reactNative: string(deps['react-native']), developmentClient: string(deps['expo-dev-client']) || null },
        providerOwnership: 'unverified' as const,
        prerequisites: [
          ...(recoveryRequired ? ['Recover the interrupted local setup before continuing.'] : []),
          ...(!deps['expo-dev-client'] ? ['The development profile needs expo-dev-client installed and pinned in a separate build checkout.'] : ['Verify expo-dev-client compatibility and the pinned lockfile in the build checkout.']),
          'Verify the Expo account and EAS project ownership before uploading source.',
          'Review signing and register devices for internal iOS distribution; Android preview uses an APK.',
          'Set the intended public backend connection in each EAS environment; local preview settings are not exported by this setup.',
        ], guide: nativeBuildGuide,
      };
    });
  }
  plan(id: string, input?: unknown) { return this.projects.mutations.run(() => this.proposal(id, input)); }
  private async proposal(id: string, input?: unknown): Promise<NativeBuildPlan> {
    const identity = await this.identity(id), project = await this.projects.get(id), journalPath = await this.journalPath(id);
    const files: Change[] = [], conflicts: string[] = [], guards: Json = { identity };
    let configuration: NativeBuildConfiguration | null = null, state: NativeBuildPlan['state'] = 'ready';
    let consequences = ['Update local app.json and eas.json only. Stop the current preview before writing; start it again when ready.', 'Development uses Metro and requires expo-dev-client. Preview bundles JavaScript for testing with the laptop off.', 'Development and preview use the same app identifiers and replace each other on a device. Separate variants require a separately reviewed configuration.', 'Expo ownership, signing, dependency installation, backend variables and actual builds remain separate steps.'];
    if (await exists(journalPath)) {
      const journalText = await readText(journalPath, 300_000), journal = journalSchema.parse(JSON.parse(journalText));
      if (!isDeepStrictEqual(identity, journal.identity) || new Set(journal.files.map(file => file.path)).size !== journal.files.length) throw new BuilderError('REVISION_CONFLICT', 'Build recovery belongs to a different project root or is invalid. Preserve the record and restore the original project.');
      if (input !== undefined) throw new BuilderError('INVALID_INPUT', 'Review recovery without a new configuration first.');
      guards.journal = revision(journalText); state = 'recovery'; consequences = ['Restore the local configuration from before the interrupted setup. Concurrent edits are preserved; resolve conflicts before restoring.'];
      for (const file of journal.files) {
        const current = await this.content(identity.root, file.path); guards[file.path] = current === null ? null : revision(current);
        if (current !== file.before && current !== file.after) conflicts.push(`${file.path} changed after interruption. Restore its original or proposed content manually before recovery.`);
        else if (current !== file.before) files.push({ path: file.path, before: current, after: file.before });
      }
    } else {
      configuration = nativeBuildConfiguration.parse(input);
      const documents = await this.documents(id), { app, expo, eas } = documents;
      guards.app = revision(documents.appText); guards.eas = documents.easText === null ? null : revision(documents.easText);
      const dependencies = await dependencyFiles(identity.root);
      guards.dependencies = revision(dependencies.manifest + '\0' + dependencies.lock);
      for (const relative of ['app.config.ts', 'app.config.js', 'app.config.mjs', 'app.config.cjs', 'ios', 'android']) {
        const target = path.join(identity.root, relative); await noSymlinks(identity.root, target);
        if (await exists(target)) conflicts.push(`${relative} requires manual native configuration. Automatic setup supports static, managed Expo apps.`);
      }
      const ios = child(expo, 'ios'), android = child(expo, 'android'), extra = child(expo, 'extra'), easIdentity = child(extra, 'eas');
      for (const [label, current, requested] of [['iOS identifier', ios.bundleIdentifier, configuration.iosBundleIdentifier], ['Android package', android.package, configuration.androidPackage], ['Expo owner', expo.owner, configuration.expoOwner], ['EAS project', easIdentity.projectId, configuration.easProjectId]] as const) {
        if (current !== undefined && current !== requested) conflicts.push(`${label} is already configured. Keep it unchanged; ownership or identity migration requires a separate manual review.`);
      }
      if (expo.scheme !== undefined && typeof expo.scheme !== 'string') conflicts.push('Multiple app URL schemes require a manual review.');
      const others = [];
      for (const other of await this.projects.list()) {
        if (other.id === id) continue;
        const text = await this.content(other.root, 'app.json');
        if (text === null) { conflicts.push(`Cannot check registered app ${other.name}: app.json is missing.`); continue; }
        const otherExpo = object(object(JSON.parse(text), 'registered app.json').expo, 'registered expo');
        const otherEas = child(child(otherExpo, 'extra'), 'eas');
        const values = { id: other.id, ios: child(otherExpo, 'ios').bundleIdentifier, android: child(otherExpo, 'android').package, scheme: otherExpo.scheme, eas: otherEas.projectId };
        others.push(values);
        const equal = (a: unknown, b: string | undefined) => typeof a === 'string' && b !== undefined && a.toLowerCase() === b.toLowerCase();
        if (equal(values.ios, configuration.iosBundleIdentifier) || equal(values.android, configuration.androidPackage) || equal(values.eas, configuration.easProjectId) || (Array.isArray(values.scheme) ? values.scheme : [values.scheme]).some(value => equal(value, configuration!.scheme))) conflicts.push(`The requested identity or URL scheme is already used by registered app ${other.name}. Choose a distinct app identity.`);
      }
      guards.otherIdentities = others;
      expo.ios = { ...ios, bundleIdentifier: configuration.iosBundleIdentifier }; expo.android = { ...android, package: configuration.androidPackage }; expo.scheme = configuration.scheme;
      if (configuration.expoOwner && configuration.easProjectId) { expo.owner = configuration.expoOwner; expo.extra = { ...extra, eas: { ...easIdentity, projectId: configuration.easProjectId } }; }
      app.expo = expo;
      const build = child(eas, 'build');
      for (const [name, profile] of Object.entries(nativeBuildProfiles)) {
        if (build[name] !== undefined && !isDeepStrictEqual(build[name], profile)) conflicts.push(`eas.json already has a custom ${name} profile. Preserve it and integrate build profiles manually.`);
        else build[name] = profile;
      }
      eas.build = build;
      for (const [relative, before, value] of [['app.json', documents.appText, app], ['eas.json', documents.easText, eas]] as const) {
        const after = serialize(value);
        if (Buffer.byteLength(after) > 64_000) throw new BuilderError('LIMIT_EXCEEDED', 'Build configuration exceeds 64 KiB.');
        if (before === null || !isDeepStrictEqual(JSON.parse(before), value)) files.push({ path: relative, before, after });
      }
      if (!files.length) state = 'current';
    }
    if (conflicts.length) state = 'conflict';
    const result = { project: { id, name: project.name }, version: 1 as const, state, configuration, files, conflicts, consequences };
    return { ...result, proposedRevision: revision(JSON.stringify({ ...result, guards })) };
  }
  async apply(id: string, input: unknown) {
    const value = nativeBuildApplyInput.parse(input);
    return this.projects.mutations.run(async () => {
      const checked = await this.proposal(id, value.configuration);
      const verify = (plan: NativeBuildPlan) => {
        if (plan.proposedRevision !== value.proposedRevision) throw new BuilderError('REVISION_CONFLICT', 'Build setup changed. Review a new plan before applying.');
        if (plan.conflicts.length) throw new BuilderError('REVISION_CONFLICT', 'Resolve build setup conflicts before applying.');
      };
      verify(checked);
      if (checked.state === 'current') return { applied: [], recovered: false };
      return this.previews.withStopped(id, async () => {
        const plan = await this.proposal(id, value.configuration); verify(plan);
        const identity = await this.identity(id), journalPath = await this.journalPath(id);
        if (plan.state !== 'recovery') {
          await mkdir(path.dirname(journalPath), { recursive: true }); await this.journalPath(id);
          await atomicWrite(journalPath, serialize(journalSchema.parse({ version: 1, identity, files: plan.files })));
        }
        try {
          for (const file of plan.files) await this.replace(identity, file);
          await rm(journalPath);
        } catch (error) {
          let restored = plan.state !== 'recovery';
          if (restored) for (const file of [...plan.files].reverse()) {
            try {
              const current = await this.content(identity.root, file.path);
              if (current === file.before) continue;
              if (current !== file.after) { restored = false; continue; }
              await this.replace(identity, { ...file, before: current, after: file.before });
            } catch { restored = false; }
          }
          if (restored) await rm(journalPath);
          throw new BuilderError('WRITE_FAILED', restored ? 'Build setup failed; original configuration restored. Review again before retrying.' : 'Build setup interrupted. Review recovery before previewing.', { recoveryRequired: !restored, cause: error instanceof Error ? error.message : 'Write failed' });
        }
        this.previews.diagnostics.emit('change', id);
        return { applied: plan.files.map(file => file.path), recovered: plan.state === 'recovery' };
      });
    });
  }
  private async replace(identity: Identity, file: Change) {
    if (!isDeepStrictEqual(identity, await this.identity(identity.id))) throw new BuilderError('REVISION_CONFLICT', 'Project root changed.');
    if (await this.content(identity.root, file.path) !== file.before) throw new BuilderError('REVISION_CONFLICT', `${file.path} changed during setup.`);
    const target = path.join(identity.root, file.path); await noSymlinks(identity.root, target);
    if (file.after === null) await rm(target); else await atomicWrite(target, file.after);
  }
}
