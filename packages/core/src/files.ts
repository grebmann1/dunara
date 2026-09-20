import { mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { BuilderError, writeSchema, type FileWrite } from './contracts.js';
import { Projects } from './projects.js';
import { atomicWrite, exists, noSymlinks, readText } from './storage.js';
export const revision = (content: string) => createHash('sha256').update(content).digest('hex');
const allowed = new Set(['.ts', '.tsx', '.js', '.jsx', '.json', '.css', '.md', '.txt']);
const denied = new Set(['node_modules', 'dist', 'build', 'coverage', 'package-lock.json', 'pnpm-lock.yaml', 'credentials.json']);
export function validFile(relative: string) {
  const parts = relative.split('/');
  const backendArtifact = /^supabase\/(migrations|tests)\/[a-zA-Z0-9_-]+\.sql$/.test(relative) || /^backend\/templates\/[a-z0-9_-]+\.html$/.test(relative) || relative === 'supabase/config.toml' || relative === 'supabase/seed.sql';
  return relative.length <= 240 && !relative.includes('\\') && parts.every(p => /^[a-zA-Z0-9_()[\]. -]+$/.test(p) && !p.startsWith('.') && !denied.has(p) && !/(secret|credential|private.key)/i.test(p)) && (allowed.has(path.extname(relative)) || backendArtifact);
}
export class Files {
  journal?: { prepare(projectId: string, changes: { path: string; before: string | null; after: string }[]): Promise<{ check(): void; applied(path: string): Promise<void> } | undefined> };
  constructor(readonly projects: Projects) {}
  async resolve(id: string, relative: string) {
    if (!validFile(relative)) throw new BuilderError('INVALID_PATH', 'Only scoped source and configuration text files are accessible');
    const project = await this.projects.get(id);
    const target = path.join(project.root, relative);
    await noSymlinks(project.root, target);
    return target;
  }
  async read(id: string, relative: string) {
    const target = await this.resolve(id, relative);
    const content = await readText(target);
    return { path: relative, content, revision: revision(content) };
  }
  async list(id: string) {
    const { root } = await this.projects.get(id);
    const files: string[] = []; let truncated = false; let visited = 0;
    const walk = async (directory: string, depth: number) => {
      if (depth > 8) { truncated = true; return; }
      await noSymlinks(root, directory);
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (++visited > 2000 || files.length >= 300) { truncated = true; return; }
        if (entry.name.startsWith('.') || denied.has(entry.name) || entry.isSymbolicLink()) continue;
        const full = path.join(directory, entry.name), relative = path.relative(root, full).split(path.sep).join('/');
        if (entry.isDirectory()) await walk(full, depth + 1);
        else if (validFile(relative)) files.push(relative);
      }
    };
    await walk(root, 0);
    return { files: files.sort(), truncated };
  }
  async write(id: string, input: FileWrite[]) {
    const writes = z.array(writeSchema).min(1).max(20).parse(input);
    return this.projects.mutations.run(() => this.writeUnlocked(id, writes));
  }
  async writeUnlocked(id: string, writes: FileWrite[]) {
    if (new Set(writes.map(w => w.path)).size !== writes.length) throw new BuilderError('INVALID_INPUT', 'Duplicate paths in batch');
    if (writes.reduce((n, w) => n + Buffer.byteLength(w.content), 0) > 1_000_000) throw new BuilderError('LIMIT_EXCEEDED', 'Batch exceeds 1 MB');
    const prepared = [];
    for (const write of writes) {
      if (Buffer.byteLength(write.content) > 256_000 || write.content.includes('\0')) throw new BuilderError('LIMIT_EXCEEDED', 'File exceeds text limits');
      const target = await this.resolve(id, write.path);
      const before = await exists(target) ? await readText(target) : null;
      const current = before === null ? null : revision(before);
      if (current !== write.expectedRevision) throw new BuilderError('REVISION_CONFLICT', `File changed: ${write.path}`, { path: write.path, currentRevision: current });
      prepared.push({ write, target, before });
    }
    const journal = await this.journal?.prepare(id, prepared.map(({ write, before }) => ({ path: write.path, before, after: write.content })));
    const applied: { path: string; revision: string }[] = [];
    try {
      for (const { write, target } of prepared) {
        await this.resolve(id, write.path);
        const current = await exists(target) ? revision(await readText(target)) : null;
        if (current !== write.expectedRevision) throw new BuilderError('REVISION_CONFLICT', `File changed during batch: ${write.path}`);
        await mkdir(path.dirname(target), { recursive: true });
        await this.resolve(id, write.path);
        journal?.check();
        await atomicWrite(target, write.content);
        applied.push({ path: write.path, revision: revision(write.content) });
        await journal?.applied(write.path);
      }
    } catch (error) {
      throw new BuilderError('WRITE_FAILED', 'Batch interrupted; some files may have been written', { applied, cause: error instanceof Error ? error.message : String(error) });
    }
    return { applied };
  }
}
