import { randomUUID } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { fromBuffer, type ZipFile } from 'yauzl';
import { z } from 'zod';
import { BuilderError, createSchema, designSchema } from './contracts.js';
import { revision } from './files.js';
import type { Projects } from './projects.js';
import { projectFileExclusion } from './project-export.js';
import { sourcePath } from './source.js';

const MAX_ARCHIVE = 32 * 1024 * 1024, MAX_FILE = 32 * 1024 * 1024, MAX_TOTAL = 128 * 1024 * 1024;
const fail = (message: string): never => { throw new BuilderError('INVALID_INPUT', message); };
const safe = (name: string) => name.length <= 500 && name.split('/').every(part => part && !['.', '..'].includes(part) && [...part].every(char => char.charCodeAt(0) > 31 && char.charCodeAt(0) !== 127) && !/[\\<>:"|?*]/.test(part) && !/[. ]$/.test(part) && !/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part));
const excluded = (name: string) => name.split('/').some((part, index, parts) => projectFileExclusion(part, index < parts.length - 1, false));
export async function readProjectZip(bytes: Buffer) {
  if (!bytes.length || bytes.length > MAX_ARCHIVE) fail('Choose a project ZIP up to 32 MiB.');
  const zip = await new Promise<ZipFile>((resolve, reject) => fromBuffer(bytes, { lazyEntries: true, strictFileNames: true, validateEntrySizes: true }, (error, value) => error ? reject(error) : resolve(value)));
  const files = new Map<string, Buffer>(), names = new Set<string>(); let total = 0, count = 0;
  await new Promise<void>((resolve, reject) => {
    let ended = false;
    const stop = (cause: unknown) => { if (!ended) { ended = true; zip.close(); reject(cause); } };
    zip.on('error', stop); zip.on('end', () => { ended = true; resolve(); });
    zip.on('entry', entry => { void (async () => {
      const name = entry.fileName.replace(/\/$/, ''), type = (entry.externalFileAttributes >>> 16) & 0o170000;
      if (++count > 4000 || !safe(name) || type && type !== 0o100000 && type !== 0o040000 || entry.isEncrypted()) fail('ZIP contains unsupported paths, links, encrypted entries or too many files.');
      const key = name.normalize('NFC').toLowerCase(); if (names.has(key)) fail('ZIP contains duplicate or conflicting paths.'); names.add(key);
      if (entry.fileName.endsWith('/')) { zip.readEntry(); return; }
      if (entry.uncompressedSize > MAX_FILE || total + entry.uncompressedSize > MAX_TOTAL) fail('Expanded project exceeds 32 MiB per file or 128 MiB total.');
      const stream = await new Promise<import('node:stream').Readable>((resolve, reject) => zip.openReadStream(entry, (error, value) => error ? reject(error) : resolve(value)));
      const chunks: Buffer[] = []; let length = 0;
      for await (const chunk of stream) { length += chunk.length; if (length > MAX_FILE || total + length > MAX_TOTAL) { stream.destroy(); fail('Expanded project exceeds the import limit.'); } chunks.push(chunk); }
      const content = Buffer.concat(chunks);
      if (length !== entry.uncompressedSize || crc32(content) !== entry.crc32) fail('ZIP checksum or file size does not match.');
      total += length; files.set(name, content); if (!ended) zip.readEntry();
    })().catch(stop); });
    zip.readEntry();
  });
  let prefix = '';
  if (!files.has('package.json')) {
    const roots = [...files.keys()].filter(name => /^[^/]+\/package\.json$/.test(name));
    if (roots.length !== 1) fail('Choose a ZIP with one Expo app at its root or inside one folder.');
    prefix = roots[0]!.slice(0, -'package.json'.length);
  }
  const source = new Map<string, Buffer>(), skipped: string[] = [];
  for (const [name, bytes] of files) {
    if (!name.startsWith(prefix)) { skipped.push(name); continue; }
    const relative = name.slice(prefix.length);
    if (excluded(relative)) { skipped.push(name); continue; }
    source.set(relative, bytes);
  }
  const read = (name: string) => { const content = source.get(name); if (!content) fail(`Project is missing ${name}. Import an exported Dunara Expo app.`); return JSON.parse(content!.toString('utf8')); };
  const manifest = z.object({ dependencies: z.record(z.string(), z.unknown()), scripts: z.record(z.string(), z.string()).optional() }).parse(read('package.json'));
  if (!manifest.dependencies.expo || !manifest.dependencies['expo-router']) fail('This import requires an Expo Router app.');
  designSchema.parse(read('src/theme/design.json')); read('app.json');
  return { source, skipped, scripts: manifest.scripts ?? {} };
}
export type ImportReview = { id: string; revision: string; files: { path: string; bytes: number }[]; skipped: string[]; scripts: Record<string, string>; expiresAt: string };
export class ProjectImports {
  private reviews = new Map<string, { review: ImportReview; source: Map<string, Buffer>; context: string; result?: { id: string; name: string; slug: string } }>();
  constructor(private projects: Projects, private context: () => string) {}
  async review(bytes: Buffer): Promise<ImportReview> {
    const context = this.context(), { source, skipped, scripts } = await readProjectZip(bytes);
    if (this.projects.durable) {
      for (const name of source.keys()) if (!sourcePath(name)) { source.delete(name); skipped.push(name); }
      if (source.size > 500 || [...source.values()].some(bytes => bytes.length > 8_000_000) || [...source.values()].reduce((sum, bytes) => sum + bytes.length, 0) > 32_000_000 || [...source.keys()].some(name => name.split('/').length > 13)) fail('Hosted imports support 500 source files, 8 MB per file and 32 MB total. Reduce this project before importing.');
    }
    if (context !== this.context()) fail('Account changed. Review this import again.');
    for (const [id, item] of this.reviews) if (Date.parse(item.review.expiresAt) <= Date.now() || item.context !== context) this.reviews.delete(id);
    if (this.reviews.size >= 2) this.reviews.delete(this.reviews.keys().next().value!);
    const review = { id: randomUUID(), revision: revision(bytes.toString('base64')), files: [...source].map(([path, content]) => ({ path, bytes: content.length })), skipped, scripts, expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() };
    this.reviews.set(review.id, { review, source, context }); return review;
  }
  async apply(input: unknown) {
    const value = z.object({ id: z.uuid(), revision: z.string(), name: createSchema.shape.name, slug: createSchema.shape.slug, confirmed: z.literal(true) }).strict().parse(input);
    const entry = this.reviews.get(value.id);
    if (!entry || entry.context !== this.context() || entry.review.revision !== value.revision || Date.parse(entry.review.expiresAt) <= Date.now()) fail('Import review expired or account changed. Review the ZIP again.');
    return this.projects.mutations.run(async () => {
      if (entry!.context !== this.context()) fail('Account changed. Review this import again.');
      if (entry!.result) {
        if (entry!.result.name !== value.name || entry!.result.slug !== value.slug) fail('This review was already imported with another name or folder. Review the ZIP again for a new copy.');
        return this.projects.get(entry!.result.id);
      }
      const project = await this.projects.importSource({ name: value.name, slug: value.slug }, entry!.source);
      entry!.result = { id: project.id, name: value.name, slug: value.slug }; return project;
    });
  }
}
