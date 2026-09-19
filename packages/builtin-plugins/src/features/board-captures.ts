import { lstat, mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { BuilderError, revisionSchema, routeSchema } from "../../../core/src/contracts.js";
import type { Captures } from "../../../core/src/capture.js";
import { Files, revision } from "../../../core/src/files.js";
import { atomicWrite, noSymlinks, readText, SerialQueue } from "../../../core/src/storage.js";

const recordSchema = z.object({ id: z.uuid(), projectId: z.uuid(), route: routeSchema, createdAt: z.iso.datetime(), sourceRevision: revisionSchema, configurationRevision: revisionSchema.optional(), environment: z.string().optional(), changedDuringCapture: z.boolean(), png: z.string().max(2_700_000) }).strict();
type Record = z.infer<typeof recordSchema>;
export type BoardCapture = Omit<Record, 'png'> & { stale: boolean; width: 375; height: 812; viewport: 'compact' };
export class BoardCaptures {
  private writes = new SerialQueue();
  private pending = new Set<string>();
  private cache = new Map<string, { stamp: string; record: Record }>();
  constructor(private captures: Captures, private files: Files) {}
  private async directory(id: string) {
    await this.files.projects.get(id);
    const directory = path.join(this.files.projects.home, 'preview-board', id);
    await noSymlinks(this.files.projects.home, directory);
    return directory;
  }
  // Includes local edits made outside Dunara. This is a source fingerprint, not app-state identity.
  async sourceRevision(id: string, tree?: { files: string[]; truncated: boolean }) {
    tree ??= await this.files.list(id);
    const stats = await Promise.all(tree.files.map(async file => {
      const stat = await lstat(await this.files.resolve(id, file));
      return [file, stat.size, stat.mtimeMs, stat.ctimeMs];
    }));
    return revision(JSON.stringify([tree.truncated, stats]));
  }
  private async records(id: string): Promise<Record[]> {
    const directory = await this.directory(id);
    const entries = await readdir(directory).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    const records = await Promise.all(entries.filter(name => /^[a-f0-9]{64}\.json$/.test(name)).slice(0, 24).map(async name => {
      const file = path.join(directory, name); await noSymlinks(this.files.projects.home, file);
      const stat = await lstat(file), stamp = `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
      const cached = this.cache.get(file);
      if (cached?.stamp === stamp) return cached.record;
      const record = recordSchema.parse(JSON.parse(await readText(file, 2_710_000)));
      if (record.projectId !== id || revision(record.route) + '.json' !== name) throw new BuilderError('INVALID_INPUT', 'Screen capture identity mismatch');
      this.cache.delete(file); this.cache.set(file, { stamp, record });
      if (this.cache.size > 24) this.cache.delete(this.cache.keys().next().value!);
      return record;
    }));
    return records;
  }
  private metadata({ png: _png, ...record }: Record, current: string, configuration: string): BoardCapture {
    // Old captures without environment evidence are only current for an unconfigured app.
    const capturedConfiguration = record.configurationRevision ?? revision('{}');
    return { ...record, stale: record.changedDuringCapture || record.sourceRevision !== current || capturedConfiguration !== configuration, width: 375, height: 812, viewport: 'compact' };
  }
  async list(id: string, current?: string) {
    const [records, fingerprint, configuration] = await Promise.all([this.records(id), current ?? this.sourceRevision(id), this.captures.previews.configurationRevision(id)]);
    return records.map(record => this.metadata(record, fingerprint, configuration));
  }
  async get(id: string, captureId: string) {
    const record = (await this.records(id)).find(record => record.id === captureId);
    if (!record) throw new BuilderError('INVALID_INPUT', 'Screen capture was replaced. Refresh the overview.');
    return Buffer.from(record.png, 'base64');
  }
  async capture(id: string, input: string, signal?: AbortSignal) {
    const route = routeSchema.parse(input), key = `${id}:${route}`;
    if (this.pending.has(key)) throw new BuilderError('LIMIT_EXCEEDED', 'This screen is already refreshing');
    this.pending.add(key);
    try {
      const [before, configurationBefore] = await Promise.all([this.sourceRevision(id), this.captures.previews.configurationRevision(id)]);
      const { meta, png } = await this.captures.capture(id, route, 'compact', signal);
      const [after, configurationAfter] = await Promise.all([this.sourceRevision(id), this.captures.previews.configurationRevision(id)]);
      const record: Record = { id: meta.id, projectId: id, route, createdAt: meta.createdAt, sourceRevision: before, configurationRevision: meta.configurationRevision ?? configurationBefore, ...(meta.environment ? { environment: meta.environment } : {}), changedDuringCapture: before !== after || configurationBefore !== configurationAfter, png: png.toString('base64') };
      await this.writes.run(async () => {
        const directory = await this.directory(id); await mkdir(directory, { recursive: true });
        const records = await this.records(id);
        if (!records.some(item => item.route === route) && records.length >= 24) {
          const oldest = records.sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0]!;
          await rm(path.join(directory, `${revision(oldest.route)}.json`));
        }
        const file = path.join(directory, `${revision(route)}.json`); await noSymlinks(this.files.projects.home, file);
        await atomicWrite(file, JSON.stringify(record));
      });
      return this.metadata(record, after, configurationAfter);
    } finally { this.pending.delete(key); }
  }
}
