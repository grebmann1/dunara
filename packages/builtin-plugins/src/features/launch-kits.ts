import { lstatSync } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import sharp from 'sharp';
import { BuilderError } from "../../../core/src/contracts.js";
import { Assets, readBinary } from "../../../core/src/assets.js";
import { Captures } from "../../../core/src/capture.js";
import { Projects } from "../../../core/src/projects.js";
import { stageHomeStateBatch, assertStateAvailable } from '../../../core/src/durable-state.js';
import { exists, noSymlinks, SerialQueue } from "../../../core/src/storage.js";
import { KIT_BYTES, KIT_PROJECT_LIMIT, KIT_STORAGE_BYTES, kitFileIdSchema, kitLimitations, legacyKitLimitations, launchKitCreateSchema, launchKitManifestSchema, launchKitRemoveSchema, type LaunchKit, type LaunchKitFile, type LaunchKitManifest } from "../../../core/src/launch-kit-contracts.js";

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const json = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const queues = new Map<string, SerialQueue>();
const uuid = (value: string) => z.uuid().parse(value);
function invalid(message: string): never { throw new BuilderError('INVALID_INPUT', message); }
function full(): never { throw new BuilderError('LIMIT_EXCEEDED', 'Launch Kit storage limit reached; explicitly delete an existing kit and retry. Nothing was evicted.'); }
function fileName(id: string) {
  kitFileIdSchema.parse(id);
  if (id.startsWith('screenshot-')) return `screenshots/${uuid(id.slice(11))}.png`;
  switch (id) {
    case 'manifest': return 'manifest.json';
    case 'listing-json': return 'listing.json';
    case 'listing': return 'listing.md';
    case 'credits': return 'credits.md';
    case 'readiness': return 'readiness.md';
    case 'icon': return 'icon.png';
    default: return invalid('Unknown kit file');
  }
}
function descriptor(id: string, bytes: Buffer): LaunchKitFile {
  const name = fileName(id);
  return { id, name, bytes: bytes.length, sha256: hash(bytes), mediaType: name.endsWith('.png') ? 'image/png' : name.endsWith('.json') ? 'application/json' : 'text/markdown' };
}
// Quote drafts as inert Markdown text instead of interpreting authored HTML or links.
const quote = (value: string) => value.replace(/[&<>]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[char]!).replace(/([\\`*_{}[\]()#+.!|~-])/g, '\\$1').split('\n').map(line => `> ${line}`).join('\n');
function textFiles(manifest: Pick<LaunchKitManifest, 'listing' | 'attribution' | 'icon'> & { schemaVersion?: 1 | 2 }) {
  const { listing, attribution, icon } = manifest;
  const limitations = manifest.schemaVersion === 1 ? legacyKitLimitations : kitLimitations;
  const destinations = manifest.schemaVersion === 1 ? '' : '\n\n## iPhone / App Store\n\n- [ ] Signed release and TestFlight installation checked on the intended iPhone.\n- [ ] Native screenshots, app privacy disclosures, age rating and review access prepared.\n- [ ] Support/privacy pages and each requested listing locale reviewed.\n\n## Android / Google Play\n\n- [ ] Store-signed AAB prepared; a preview APK is not a Play release.\n- [ ] Internal testing, data safety, content rating and review access completed.\n- [ ] Native screenshots, feature artwork and localized listing reviewed.\n\n## Web preview\n\n- [ ] Intended routes, primary actions and data persistence tested.\n- [ ] Access control, backend environment and shared URL tested by the intended audience.';
  return new Map<string, Buffer>([
    ['listing-json', json(listing)],
    ['listing', Buffer.from(`# Listing draft — not reviewed for publication\n\n${Object.entries(listing).map(([field, value]) => `## ${field}\n\n${quote(value)}`).join('\n\n')}\n`)],
    ['credits', Buffer.from(`# Attribution draft — rights not verified\n\n## Screenshot/app imagery\n\n${quote(attribution || 'No attribution supplied. Review all app imagery and license obligations before sharing.')}\n\n## Optional icon\n\n${quote(icon?.rightsNote || (icon ? 'No icon rights note supplied.' : 'No icon included.'))}\n`)],
    ['readiness', Buffer.from(`# Factual readiness checklist\n\n- [x] Selected original web PNGs copied locally and hashed.\n- [x] User confirmed the selected local export contents.\n- [ ] Human visual and gesture review.\n- [ ] Rights and attribution review, including derivative-license obligations.\n- [ ] Listing claims and support/privacy content review.\n- [ ] Native interaction, keyboard, safe areas, accessibility and launcher review.\n- [ ] Store-specific screenshot and submission requirements.\n\n## Known limitations\n\n${limitations.map(item => `- ${item}`).join('\n')}${destinations}\n`)],
  ]);
}

export class LaunchKits {
  private readonly identities = new Map<string, string>();
  private readonly queue: SerialQueue;
  private readonly root: string;
  private closed = false;
  constructor(readonly projects: Projects, readonly captures: Captures, readonly assets: Assets) {
    this.root = path.join(projects.home, 'launch-kits');
    const stat = lstatSync(projects.home);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new BuilderError('INVALID_PATH', 'Dunara home is not a directory');
    this.identities.set(projects.home, `${stat.dev}:${stat.ino}`);
    this.queue = queues.get(projects.home) ?? new SerialQueue(); queues.set(projects.home, this.queue);
  }
  private async operation<T>(run: () => Promise<T>): Promise<T> {
    return this.queue.run(async () => {
      if (this.closed) invalid('Launch Kit service is closed');
      try { await this.directory(this.projects.home); return await run(); }
      catch (error) {
        if (error instanceof BuilderError) throw error;
        if (error instanceof z.ZodError) invalid('Invalid Launch Kit input or stored metadata');
        throw new BuilderError('WRITE_FAILED', 'Launch Kit storage operation failed; check owned storage and retry. App source was not changed.');
      }
    });
  }
  private async directory(target: string) {
    await noSymlinks(this.projects.home, target);
    const stat = await lstat(target);
    const identity = `${stat.dev}:${stat.ino}`;
    if (!stat.isDirectory() || await realpath(target) !== target || (this.identities.has(target) && this.identities.get(target) !== identity)) throw new BuilderError('INVALID_PATH', 'Launch Kit storage root or directory changed');
    this.identities.set(target, identity);
  }
  private async rootDirectory(create = false) {
    assertStateAvailable(this.root);
    await this.directory(this.projects.home);
    if (!(await exists(this.root))) {
      if (this.identities.has(this.root)) throw new BuilderError('INVALID_PATH', 'Launch Kit storage root disappeared');
      if (!create) return false;
      await mkdir(this.root, { mode: 0o700 });
    }
    await this.directory(this.root); return true;
  }
  private async projectDirectory(id: string, create = false) {
    uuid(id); await this.projects.get(id);
    const target = path.join(this.root, id);
    if (!await this.rootDirectory(create)) return null;
    if (!await exists(target)) {
      if (this.identities.has(target)) throw new BuilderError('INVALID_PATH', 'Launch Kit project directory disappeared');
      if (!create) return null;
      await mkdir(target, { mode: 0o700 });
    }
    await this.directory(target); return target;
  }
  private async safeFile(directory: string, name: string, limit: number) {
    await this.rootDirectory(); await this.directory(path.dirname(directory)); await this.directory(directory);
    const file = path.join(directory, name);
    await noSymlinks(directory, file);
    if (name.startsWith('screenshots/')) await this.directory(path.join(directory, 'screenshots'));
    const stat = await lstat(file);
    if (!stat.isFile() || stat.nlink !== 1) throw new BuilderError('INVALID_PATH', 'Kit files must be owned regular files, not links');
    const bytes = await readBinary(file, limit);
    await this.directory(directory); return bytes;
  }
  private async usage() {
    let bytes = 0, entries = 0;
    const counts = new Map<string, number>();
    const walk = async (directory: string, depth: number) => {
      await this.directory(directory);
      for (const name of await readdir(directory)) {
        if (++entries > 20_000) full();
        const file = path.join(directory, name), stat = await lstat(file);
        if (stat.isSymbolicLink() || (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1))) throw new BuilderError('INVALID_PATH', 'Unsafe entry in Launch Kit storage');
        if (stat.isDirectory()) {
          if (depth === 0) uuid(name);
          else if (depth === 1) {
            if (name.startsWith('.staging-')) uuid(name.slice(9));
            else { uuid(name); counts.set(path.basename(directory), (counts.get(path.basename(directory)) ?? 0) + 1); }
          } else if (depth !== 2 || name !== 'screenshots') invalid('Unexpected Launch Kit directory');
          await walk(file, depth + 1);
        } else {
          if (depth < 2) invalid('Unexpected file in Launch Kit root');
          bytes += stat.size;
        }
      }
    };
    await walk(this.root, 0); return { bytes, counts };
  }
  private async load(projectId: string, bundleId: string): Promise<{ kit: LaunchKit; contents: Map<string, Buffer>; directory: string }> {
    uuid(bundleId);
    const parent = await this.projectDirectory(projectId);
    if (!parent) invalid('Launch Kit not found in this project');
    const directory = path.join(parent, bundleId);
    if (!await exists(directory)) invalid('Launch Kit not found in this project');
    await this.directory(directory);
    const raw = await this.safeFile(directory, 'manifest.json', 128 * 1024);
    const manifest = launchKitManifestSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)));
    if (manifest.id !== bundleId || manifest.project.id !== projectId || JSON.stringify(manifest.limitations) !== JSON.stringify(manifest.schemaVersion === 1 ? legacyKitLimitations : kitLimitations)) invalid('Kit identity or limitations changed');
    if (new Set(manifest.captures.map(c => c.id)).size !== manifest.captures.length || manifest.captures.some(c => c.projectId !== projectId)) invalid('Invalid capture identities');
    const expected = textFiles(manifest);
    const expectedIds = [...expected.keys(), ...manifest.captures.map(c => `screenshot-${c.id}`), ...(manifest.icon ? ['icon'] : [])];
    if (manifest.files.length !== expectedIds.length || new Set(manifest.files.map(f => f.id)).size !== expectedIds.length || expectedIds.some(id => !manifest.files.some(f => f.id === id))) invalid('Kit file inventory changed');
    const expectedNames = ['manifest.json', ...manifest.files.map(f => f.name)];
    const actualNames: string[] = [];
    for (const name of await readdir(directory)) {
      if (name === 'screenshots') {
        await this.directory(path.join(directory, name));
        actualNames.push(...(await readdir(path.join(directory, name))).map(file => `screenshots/${file}`));
      } else actualNames.push(name);
    }
    if (JSON.stringify(actualNames.sort()) !== JSON.stringify(expectedNames.sort())) invalid('Kit contains unexpected or missing files');
    const contents = new Map<string, Buffer>([['manifest', raw]]); let total = raw.length;
    for (const file of manifest.files) {
      if (file.name !== fileName(file.id)) invalid('Invalid kit file name');
      total += file.bytes; if (total > KIT_BYTES) full();
      const bytes = await this.safeFile(directory, file.name, file.bytes);
      const actual = descriptor(file.id, bytes);
      if (actual.bytes !== file.bytes || actual.sha256 !== file.sha256 || actual.mediaType !== file.mediaType) invalid('Immutable kit file changed');
      if (expected.has(file.id) && !bytes.equals(expected.get(file.id)!)) invalid('Kit draft metadata changed');
      const capture = manifest.captures.find(c => file.id === `screenshot-${c.id}`);
      if (capture && capture.bytes !== file.bytes) invalid('Capture size metadata changed');
      if (file.id === 'icon' && file.sha256 !== manifest.icon?.sha256) invalid('Icon hash metadata changed');
      contents.set(file.id, bytes);
    }
    return { directory, contents, kit: { manifest, files: [descriptor('manifest', raw), ...manifest.files], location: `launch-kits/${projectId}/${bundleId}` } };
  }
  list(projectId: string) {
    return this.operation(async () => {
      const directory = await this.projectDirectory(projectId); if (!directory) return [];
      const names = (await readdir(directory)).filter(name => !name.startsWith('.staging-'));
      if (names.length > KIT_PROJECT_LIMIT) full();
      const kits: LaunchKit[] = [];
      for (const name of names) kits.push((await this.load(projectId, name)).kit);
      return kits.sort((a, b) => b.manifest.createdAt.localeCompare(a.manifest.createdAt));
    });
  }
  read(projectId: string, bundleId: string) { return this.operation(async () => (await this.load(projectId, bundleId)).kit); }
  readFile(projectId: string, bundleId: string, fileId: string) {
    return this.operation(async () => {
      kitFileIdSchema.parse(fileId);
      const { kit, contents } = await this.load(projectId, bundleId);
      const file = kit.files.find(f => f.id === fileId), bytes = contents.get(fileId);
      if (!file || !bytes) invalid('File not included in this kit');
      return { file, bytes };
    });
  }
  create(projectId: string, input: unknown) {
    return this.operation(() => this.projects.mutations.run(async () => {
      const value = launchKitCreateSchema.parse(input);
      const parent = await this.projectDirectory(projectId, true);
      if (!parent) invalid('Kit project directory unavailable');
      const project = await this.projects.get(projectId);
      // Resolve all retained captures before any await can prune them. Never silently recapture.
      const captured = value.captureIds.map(id => { const c = this.captures.get(projectId, id); return { meta: { ...c.meta }, png: Buffer.from(c.png) }; });
      const selectedIcon = async () => {
        if (!value.icon) return undefined;
        const library = await this.assets.list(projectId);
        if (library.revision !== value.icon.expectedRevision) throw new BuilderError('REVISION_CONFLICT', 'Icon media revision changed; review the icon again');
        const { asset, bytes } = await this.assets.read(projectId, value.icon.assetId);
        if (asset.status !== 'approved' || asset.width !== 1024 || asset.height !== 1024 || !(await sharp(bytes).stats()).isOpaque) invalid('Select an approved opaque 1024×1024 icon master');
        return { meta: { assetId: asset.id, mediaRevision: value.icon.expectedRevision, sha256: asset.hash, width: 1024 as const, height: 1024 as const, status: 'approved' as const, rightsNote: asset.rightsNote }, bytes };
      };
      const icon = await selectedIcon();
      const id = randomUUID();
      const draft = { listing: value.listing, attribution: value.attribution, ...(icon ? { icon: icon.meta } : {}) };
      const contents = textFiles(draft);
      for (const capture of captured) {
        const metadata = await sharp(capture.png, { limitInputPixels: 430 * 932, failOn: 'warning' }).metadata();
        if (metadata.format !== 'png' || (metadata.pages ?? 1) !== 1 || metadata.width !== capture.meta.width || metadata.height !== capture.meta.height || capture.png.length !== capture.meta.bytes) invalid('Capture bytes or dimensions changed');
        contents.set(`screenshot-${capture.meta.id}`, capture.png);
      }
      if (icon) contents.set('icon', icon.bytes);
      const manifest = launchKitManifestSchema.parse({ schemaVersion: 2, id, createdAt: new Date().toISOString(), project: { id: project.id, name: project.name, slug: project.slug }, captures: captured.map(c => c.meta), ...draft, files: [...contents].map(([id, bytes]) => descriptor(id, bytes)), limitations: [...kitLimitations] });
      contents.set('manifest', json(manifest));
      const size = [...contents.values()].reduce((sum, bytes) => sum + bytes.length, 0);
      const checkQuota = async (extra: number) => { const usage = await this.usage(); if (size > KIT_BYTES || usage.bytes + extra > KIT_STORAGE_BYTES || (usage.counts.get(projectId) ?? 0) >= KIT_PROJECT_LIMIT) full(); };
      await checkQuota(size);
      const staging = path.join(parent, `.staging-${id}`), target = path.join(parent, id);
      let staged = false;
      try {
        await mkdir(staging, { mode: 0o700 }); staged = true; await this.directory(staging);
        await mkdir(path.join(staging, 'screenshots'), { mode: 0o700 });
        await this.directory(path.join(staging, 'screenshots'));
        for (const [fileId, bytes] of contents) {
          await this.rootDirectory(); await this.directory(parent); await this.directory(staging); await this.directory(path.join(staging, 'screenshots'));
          const file = path.join(staging, fileName(fileId)); await noSymlinks(staging, file);
          const handle = await open(file, 'wx', 0o600);
          try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
        }
        await selectedIcon(); await this.projects.get(projectId); await checkQuota(0);
        await this.rootDirectory(); await this.directory(parent); await this.directory(staging);
        if (this.closed) invalid('Launch Kit service is closed');
        if (await exists(target)) invalid('Bundle identity already exists; no files overwritten');
        await rename(staging, target); staged = false;
        await stageHomeStateBatch([...contents].map(([id, content]) => ({ file: path.join(target, fileName(id)), content })));
        return { manifest, files: [descriptor('manifest', contents.get('manifest')!), ...manifest.files], location: `launch-kits/${projectId}/${id}` } satisfies LaunchKit;
      } finally {
        if (staged) {
          // Refuse cleanup if storage moved. Never follow a substituted staging directory.
          await this.rootDirectory(); await this.directory(parent); await this.directory(staging);
          await rm(staging, { recursive: true, force: true });
        }
        this.identities.delete(staging); this.identities.delete(path.join(staging, 'screenshots'));
      }
    }));
  }
  remove(projectId: string, input: unknown) {
    return this.operation(async () => {
      const { bundleId } = launchKitRemoveSchema.parse(input);
      const { directory, kit } = await this.load(projectId, bundleId);
      await this.rootDirectory(); await this.directory(path.dirname(directory)); await this.directory(directory);
      await stageHomeStateBatch(['manifest', ...kit.manifest.files.map(file => file.id)].map(id => ({ file: path.join(directory, fileName(id)), content: null })));
      await rm(directory, { recursive: true });
      this.identities.delete(directory); this.identities.delete(path.join(directory, 'screenshots'));
      return { removed: bundleId };
    });
  }
  close() { this.closed = true; return this.queue.run(async () => {}); }
}
