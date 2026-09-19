import { constants } from 'node:fs';
import { link, lstat, mkdir, open, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { BuilderError } from "../../../core/src/contracts.js";
import { revision } from "../../../core/src/files.js";
import { Projects } from "../../../core/src/projects.js";
import { atomicWrite, exists, noSymlinks, readText } from "../../../core/src/storage.js";
import { assetSchema, briefSchema, importSchema, manifestSchema, MEDIA_BYTES, MEDIA_PIXELS, transformSchema, type Asset, type ImportInput, type Manifest, type MediaLibrary, type TransformInput } from "../../../core/src/media-contracts.js";

const manifestPath = 'assets/builder/manifest.json';
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function invalid(message: string): never { throw new BuilderError('INVALID_INPUT', message); }
export async function readBinary(file: string, limit = MEDIA_BYTES) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) throw new BuilderError('LIMIT_EXCEEDED', 'Image exceeds the file limit');
    const buffer = Buffer.alloc(limit + 1); let length = 0;
    while (length < buffer.length) { const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null); if (!bytesRead) break; length += bytesRead; }
    if (length > limit) throw new BuilderError('LIMIT_EXCEEDED', 'Image exceeds the file limit');
    return buffer.subarray(0, length);
  } finally { await handle.close(); }
}
export async function normalizeImage(bytes: Buffer, mime: string) {
  if (!bytes.length || bytes.length > MEDIA_BYTES) throw new BuilderError('LIMIT_EXCEEDED', 'Images must be at most 10 MiB');
  const format = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'png'
    : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'jpeg'
      : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' ? 'webp' : null;
  if (!format || mime !== `image/${format}`) invalid('Only matching PNG, JPEG, or WebP images are supported');
  try {
    const image = sharp(bytes, { limitInputPixels: MEDIA_PIXELS, failOn: 'warning' });
    const meta = await image.metadata();
    if (meta.format !== format || (meta.pages ?? 1) !== 1 || !meta.width || !meta.height || meta.width * meta.height > MEDIA_PIXELS) invalid('Only bounded single-frame images are supported');
    const output = await image.rotate().png().toBuffer({ resolveWithObject: true });
    if (output.data.length > MEDIA_BYTES) throw new BuilderError('LIMIT_EXCEEDED', 'Normalized image exceeds 10 MiB');
    return output;
  } catch (error) { if (error instanceof BuilderError) throw error; invalid('Image could not be decoded safely'); }
}
export class Assets {
  private closed = false;
  constructor(readonly projects: Projects) {}
  close() { this.closed = true; return this.projects.mutations.run(async () => {}); }
  private active(signal?: AbortSignal) { if (this.closed || signal?.aborted) invalid('Asset operation cancelled or Engine closed'); }
  private async target(id: string, relative = manifestPath) {
    const { root } = await this.projects.get(id); const file = path.join(root, relative);
    await noSymlinks(root, file); return { root, file };
  }
  async list(id: string): Promise<MediaLibrary> {
    const { file } = await this.target(id);
    if (!(await exists(file))) return { version: 1, brief: briefSchema.parse({}), assets: [], revision: null };
    const text = await readText(file, 512_000);
    const parsed = manifestSchema.safeParse(JSON.parse(text));
    if (!parsed.success) invalid('Invalid media manifest; restore valid metadata before continuing');
    const manifest = parsed.data;
    const ids = new Set(manifest.assets.map(a => a.id));
    if (ids.size !== manifest.assets.length || manifest.assets.reduce((n, a) => n + a.bytes, 0) > 100 * 1024 * 1024) invalid('Invalid asset identities or quota');
    for (const asset of manifest.assets) {
      await this.target(id, asset.path);
      if (asset.parentId && (!ids.has(asset.parentId) || asset.parentId === asset.id)) invalid('Invalid asset parent');
    }
    if (manifest.brief.referenceIds.some(ref => !manifest.assets.some(a => a.id === ref && a.status === 'approved'))) invalid('Brief references must be approved project assets');
    return { ...manifest, revision: revision(text) };
  }
  private async check(id: string, expected: string | null) {
    this.active(); const current = await this.list(id);
    if (current.revision !== expected) throw new BuilderError('REVISION_CONFLICT', 'Media library changed; review and retry');
    return current;
  }
  private async save(id: string, current: MediaLibrary, next: Manifest, signal?: AbortSignal) {
    manifestSchema.parse(next); await this.check(id, current.revision);
    const { root, file } = await this.target(id);
    await mkdir(path.dirname(file), { recursive: true }); await noSymlinks(root, file); this.active(signal);
    await atomicWrite(file, JSON.stringify(next, null, 2) + '\n');
    return this.list(id);
  }
  async brief(id: string, expectedRevision: string | null, input: unknown) {
    const brief = briefSchema.parse(input);
    return this.projects.mutations.run(async () => {
      const current = await this.check(id, expectedRevision);
      if (brief.referenceIds.some(ref => !current.assets.some(a => a.id === ref && a.status === 'approved'))) invalid('Select approved reference images');
      return this.save(id, current, { version: 1, assets: current.assets, brief });
    });
  }
  async approve(id: string, assetId: string, expectedRevision: string | null) {
    return this.projects.mutations.run(async () => {
      const current = await this.check(id, expectedRevision); await this.read(id, assetId);
      return this.save(id, current, { version: 1, brief: current.brief, assets: current.assets.map(a => a.id === assetId ? { ...a, status: 'approved' } : a) });
    });
  }
  async read(id: string, assetId: string) {
    const asset = (await this.list(id)).assets.find(a => a.id === assetId);
    if (!asset) invalid('Asset not found in this project');
    const { file } = await this.target(id, asset.path); const bytes = await readBinary(file);
    if (hash(bytes) !== asset.hash || bytes.length !== asset.bytes) invalid('Immutable asset changed on disk');
    const meta = await sharp(bytes, { limitInputPixels: MEDIA_PIXELS }).metadata();
    if (meta.format !== 'png' || meta.width !== asset.width || meta.height !== asset.height || (meta.pages ?? 1) !== 1 || meta.exif) invalid('Asset metadata does not match its image');
    return { asset, bytes };
  }
  async import(id: string, input: ImportInput, bytes: Buffer) {
    const value = importSchema.parse(input);
    return this.add(id, value, [{ bytes, provenance: 'imported' }]);
  }
  async add(id: string, input: ImportInput, outputs: { bytes: Buffer; provenance: Asset['provenance']; parentId?: string; provider?: 'openai'; model?: string }[], signal?: AbortSignal) {
    const value = importSchema.parse(input);
    if (!outputs.length || outputs.length > 2) invalid('One or two images are required');
    return this.projects.mutations.run(async () => {
      const current = await this.check(id, value.expectedRevision); this.active(signal);
      const normalized = [];
      for (const output of outputs) {
        if (output.parentId && !current.assets.some(a => a.id === output.parentId)) invalid('Parent image is not in this project');
        const image = await normalizeImage(output.bytes, value.mediaType); const assetId = randomUUID();
        const asset = assetSchema.parse({ id: assetId, path: `assets/builder/${assetId}.png`, hash: hash(image.data), width: image.info.width, height: image.info.height, bytes: image.data.length, mediaType: 'image/png', transparent: image.info.channels === 4 && !(await sharp(image.data).stats()).isOpaque, label: value.label, role: value.role, status: 'candidate', parentId: output.parentId, provenance: output.provenance, provider: output.provider, model: output.model, rightsNote: value.rightsNote, createdAt: new Date().toISOString() });
        normalized.push({ asset, bytes: image.data });
      }
      const { root, file } = await this.target(id); const directory = path.dirname(file);
      await mkdir(directory, { recursive: true }); await noSymlinks(root, directory);
      let count = 0, size = 0;
      for (const entry of await readdir(directory)) {
        if (entry === 'manifest.json') continue;
        const info = await lstat(path.join(directory, entry));
        if (!info.isFile() || info.isSymbolicLink()) invalid('Unexpected entry in the media directory');
        count++; size += info.size;
      }
      if (count + normalized.length > 100 || current.assets.length + normalized.length > 100 || size + normalized.reduce((n, a) => n + a.bytes.length, 0) > 100 * 1024 * 1024) throw new BuilderError('LIMIT_EXCEEDED', 'Project media quota reached (100 versions / 100 MiB)');
      const written: string[] = [];
      try {
        for (const image of normalized) {
          const target = path.join(root, image.asset.path), tmp = path.join(directory, `.builder-${randomUUID()}.tmp`);
          await noSymlinks(root, target); this.active(signal);
          try {
            const handle = await open(tmp, 'wx', 0o600);
            try { await handle.writeFile(image.bytes); await handle.sync(); } finally { await handle.close(); }
            await noSymlinks(root, target); this.active(signal); await link(tmp, target); written.push(target);
          } finally { await noSymlinks(root, tmp); await rm(tmp, { force: true }); }
        }
        return await this.save(id, current, { version: 1, brief: current.brief, assets: [...current.assets, ...normalized.map(a => a.asset)] }, signal);
      } catch (error) {
        for (const target of written) { await noSymlinks(root, target); await rm(target, { force: true }); }
        throw error;
      }
    });
  }
  async transform(id: string, input: TransformInput) {
    const value = transformSchema.parse(input); await this.check(id, value.expectedRevision);
    const { asset, bytes } = await this.read(id, value.assetId); let image = sharp(bytes, { limitInputPixels: MEDIA_PIXELS });
    if (value.fit === 'cover') {
      const ratio = value.width / value.height;
      const width = Math.min(asset.width, Math.round(asset.height * ratio)); const height = Math.min(asset.height, Math.round(asset.width / ratio));
      image = image.extract({ width, height, left: Math.round((asset.width - width) * value.focalX), top: Math.round((asset.height - height) * value.focalY) });
    }
    const output = await image.resize(value.width, value.height, { fit: 'contain', background: value.background }).png().toBuffer();
    return this.add(id, { expectedRevision: value.expectedRevision, label: `${asset.label.slice(0, 85)} · resized`, role: asset.role, rightsNote: asset.rightsNote, mediaType: 'image/png' }, [{ bytes: output, provenance: 'transformed', parentId: asset.id }]);
  }
}
