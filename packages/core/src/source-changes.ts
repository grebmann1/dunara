import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { BuilderError } from './contracts.js';
import { type Files, revision, validFile } from './files.js';
import { atomicWrite, exists, noSymlinks, readText } from './storage.js';

const scopeSchema = z.object({ projectId: z.uuid(), conversationId: z.uuid(), runId: z.uuid() }).strict();
export type ChangeScope = z.infer<typeof scopeSchema>;
const sourceText = z.string().refine(text => Buffer.byteLength(text) <= 256_000 && !text.includes('\0'));
const fileSchema = z.object({ path: z.string().refine(validFile), before: sourceText.nullable(), after: sourceText.nullable(), pending: sourceText.optional() }).strict();
const recordSchema = scopeSchema.extend({ version: z.literal(1), root: z.string(), device: z.number(), inode: z.number(), state: z.enum(['recording', 'ready', 'restoring', 'restored']), createdAt: z.iso.datetime(), files: z.array(fileSchema).max(100) }).strict()
  .refine(record => new Set(record.files.map(file => file.path)).size === record.files.length);
type Record = z.infer<typeof recordSchema>;
type Lease = { scope: Omit<ChangeScope, 'projectId'> & { projectId: string | null }; signal: AbortSignal; closing: boolean; requests: Set<Promise<unknown>> };
const limits = { turnBytes: 8 * 1024 * 1024, totalBytes: 100 * 1024 * 1024, records: 1000 };
const fileRevision = (text: string | null) => text === null ? null : revision(text);

/** Receipts for attributed managed text writes. This never infers authorship from a whole-app snapshot. */
export class SourceChanges {
  private context = new AsyncLocalStorage<Lease>();
  private leases = new Map<string, Lease>();
  constructor(private files: Files, private quotas = limits) {}
  begin(scope: Lease['scope'], signal: AbortSignal) {
    const token = randomUUID();
    this.leases.set(token, { scope: { projectId: scope.projectId, conversationId: scope.conversationId, runId: scope.runId }, signal, closing: false, requests: new Set() });
    return token;
  }
  async bind(token: string, projectId: string) {
    const lease = this.leases.get(token);
    if (!lease || lease.closing) throw new BuilderError('REVISION_CONFLICT', 'Source checkpoint session ended');
    z.uuid().parse(projectId);
    if (lease.scope.projectId && lease.scope.projectId !== projectId && await this.read(scopeSchema.parse(lease.scope))) throw new BuilderError('REVISION_CONFLICT', 'This turn has source changes in its original app. Start a new conversation for another app.');
    lease.scope.projectId = projectId;
  }
  async withToken<T>(token: unknown, work: () => Promise<T>): Promise<T> {
    if (token === undefined) return work();
    const lease = typeof token === 'string' ? this.leases.get(token) : undefined;
    if (!lease || lease.closing) throw new BuilderError('REVISION_CONFLICT', 'Source checkpoint session ended');
    lease.signal.throwIfAborted();
    const request = this.context.run(lease, work); lease.requests.add(request);
    try { return await request; } finally { lease.requests.delete(request); }
  }
  async finish(token: string) {
    const lease = this.leases.get(token); if (!lease) return;
    lease.closing = true;
    await Promise.allSettled([...lease.requests]);
    this.leases.delete(token);
    if (lease.scope.projectId) await this.inspect(scopeSchema.parse(lease.scope));
  }
  private active(scope: ChangeScope) { return [...this.leases.values()].some(lease => lease.scope.runId === scope.runId && lease.scope.conversationId === scope.conversationId); }
  private async directory() {
    const home = this.files.projects.home, directory = path.join(home, 'source-changes');
    await noSymlinks(home, directory); await mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await lstat(directory);
    if (!info.isDirectory() || (info.mode & 0o077) || info.uid !== process.getuid?.()) throw new BuilderError('INVALID_PATH', 'Source checkpoints need a private owned directory');
    return directory;
  }
  private async filename(runId: string) { return path.join(await this.directory(), `${z.uuid().parse(runId)}.json`); }
  private async read(scope: ChangeScope) {
    scopeSchema.parse(scope);
    const filename = await this.filename(scope.runId), info = await exists(filename);
    if (!info) return null;
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (info.mode & 0o077) || info.uid !== process.getuid?.()) throw new BuilderError('INVALID_PATH', 'Unsafe source checkpoint file');
    const record = recordSchema.parse(JSON.parse(await readText(filename, this.quotas.turnBytes)));
    if (record.projectId !== scope.projectId || record.conversationId !== scope.conversationId || record.runId !== scope.runId) throw new BuilderError('INVALID_INPUT', 'Source checkpoint belongs to another turn or project');
    return record;
  }
  private async save(record: Record) {
    const content = JSON.stringify(recordSchema.parse(record));
    const bytes = Buffer.byteLength(content), directory = await this.directory(), filename = await this.filename(record.runId);
    if (bytes > this.quotas.turnBytes) throw new BuilderError('LIMIT_EXCEEDED', 'This turn exceeds its source checkpoint limit. Start a smaller turn.');
    const names = (await readdir(directory)).filter(name => /^[a-f0-9-]{36}\.json$/.test(name));
    if (names.length >= this.quotas.records && !names.includes(path.basename(filename))) throw new BuilderError('LIMIT_EXCEEDED', 'Source checkpoint storage is full. Delete old conversations before editing.');
    let total = bytes;
    for (const name of names) if (name !== path.basename(filename)) total += (await lstat(path.join(directory, name))).size;
    if (total > this.quotas.totalBytes) throw new BuilderError('LIMIT_EXCEEDED', 'Source checkpoint storage is full. Delete old conversations before editing.');
    await noSymlinks(directory, filename); await atomicWrite(filename, content);
  }
  private async identity(record: Record) {
    const project = await this.files.projects.get(record.projectId), info = await lstat(project.root);
    if (project.root !== record.root || info.dev !== record.device || info.ino !== record.inode) throw new BuilderError('REVISION_CONFLICT', 'The app folder was replaced. Its old checkpoint cannot change this folder.');
  }
  private async current(projectId: string, name: string) {
    const target = await this.files.resolve(projectId, name);
    return await exists(target) ? readText(target) : null;
  }
  /** Called under the same project mutation lock as the actual file write. Intents reach disk first. */
  async prepare(projectId: string, changes: { path: string; before: string | null; after: string }[]) {
    const lease = this.context.getStore(); if (!lease) return undefined;
    const check = () => {
      lease.signal.throwIfAborted();
      if (lease.closing || lease.scope.projectId !== projectId) throw new BuilderError('REVISION_CONFLICT', 'This source write no longer belongs to the active Assistant turn');
    };
    check(); const scope = scopeSchema.parse(lease.scope);
    let record = await this.read(scope);
    if (!record) {
      const project = await this.files.projects.get(projectId), info = await lstat(project.root);
      record = { version: 1, ...scope, root: project.root, device: info.dev, inode: info.ino, state: 'recording', createdAt: new Date().toISOString(), files: [] };
    }
    await this.identity(record);
    if (record.state !== 'recording') throw new BuilderError('REVISION_CONFLICT', 'This source checkpoint is already closed');
    for (const change of changes) {
      let file = record.files.find(file => file.path === change.path);
      if (file && (file.pending !== undefined || file.after !== change.before)) throw new BuilderError('REVISION_CONFLICT', `Another edit changed ${change.path} during this turn. Start a new turn after reviewing it.`);
      if (!file) { file = { path: change.path, before: change.before, after: change.before }; record.files.push(file); }
      file.pending = change.after;
    }
    check(); await this.save(record);
    return { check, applied: async (name: string) => {
      const file = record.files.find(file => file.path === name)!;
      file.after = file.pending!; delete file.pending;
      await this.save(record);
    } };
  }
  private async reconcile(record: Record) {
    if (this.active(record)) return;
    let changed = false;
    if (record.state === 'recording') { record.state = 'ready'; changed = true; }
    for (const file of record.files) if (file.pending !== undefined) {
      try {
        const current = await this.current(record.projectId, file.path);
        if (current === file.pending) { file.after = file.pending; delete file.pending; changed = true; }
        else if (current === file.after) { delete file.pending; changed = true; }
      } catch { /* Unknown filesystem state remains a visible conflict, never permission to overwrite. */ }
    }
    if (changed) await this.save(record);
  }
  private async review(record: Record | null, scope: ChangeScope) {
    const changes = [], conflicts: string[] = [];
    if (record) {
      await this.identity(record);
      for (const file of record.files) {
        if (file.before === file.after && file.pending === undefined) continue;
        let conflict = file.pending !== undefined;
        try {
          const current = await this.current(scope.projectId, file.path);
          if (record.state !== 'restored' && current !== file.after && !(record.state === 'restoring' && current === file.before)) conflict = true;
        } catch { conflict = true; }
        if (conflict) conflicts.push(file.path);
        changes.push({ path: file.path, kind: file.before === null ? 'added' as const : 'modified' as const, beforeRevision: fileRevision(file.before), afterRevision: fileRevision(file.after), conflict });
      }
    }
    return { ...scope, state: record?.state ?? 'none' as const, revision: revision(JSON.stringify(record)), changes, conflicts, canRestore: !!record && !this.active(scope) && ['ready', 'restoring'].includes(record.state) && changes.length > 0 && conflicts.length === 0 };
  }
  async inspect(scope: ChangeScope) {
    return this.files.projects.mutations.run(async () => {
      const record = await this.read(scope);
      if (record) { await this.identity(record); await this.reconcile(record); }
      return this.review(record, scope);
    });
  }
  async diff(scope: ChangeScope, name: string) {
    const record = await this.read(scope); if (!record) throw new BuilderError('INVALID_INPUT', 'No source checkpoint for this turn');
    await this.identity(record);
    const file = record.files.find(file => file.path === name);
    if (!file) throw new BuilderError('INVALID_PATH', 'File is not part of this source checkpoint');
    return { path: file.path, before: file.before, after: file.pending ?? file.after, ...(file.pending !== undefined ? { uncertain: true } : {}) };
  }
  async restore(scope: ChangeScope, expectedRevision: string, guard: () => Promise<void>) {
    return this.files.projects.mutations.run(async () => {
      await guard();
      const record = await this.read(scope);
      if (!record || revision(JSON.stringify(record)) !== expectedRevision) throw new BuilderError('REVISION_CONFLICT', 'The checkpoint changed. Review it again before restoring.');
      const review = await this.review(record, scope);
      if (!review.canRestore) throw new BuilderError('REVISION_CONFLICT', 'Restore is blocked. Finish the turn and resolve newer file edits before reviewing again.', { conflicts: review.conflicts });
      record.state = 'restoring'; await this.save(record);
      try {
        for (const file of record.files) {
          if (file.before === file.after) continue;
          await guard(); await this.identity(record);
          const current = await this.current(scope.projectId, file.path);
          if (current === file.before) continue;
          if (current !== file.after) throw new BuilderError('REVISION_CONFLICT', `A newer edit changed ${file.path}. It was preserved.`);
          const target = await this.files.resolve(scope.projectId, file.path);
          await guard();
          if (await this.current(scope.projectId, file.path) !== file.after) throw new BuilderError('REVISION_CONFLICT', `A newer edit changed ${file.path}. It was preserved.`);
          if (file.before === null) await rm(target); else await atomicWrite(target, file.before);
        }
        record.state = 'restored'; await this.save(record);
      } catch {
        throw new BuilderError('WRITE_FAILED', 'Restore was interrupted. Some files may already be restored. Review the checkpoint again to safely finish; newer edits are preserved.');
      }
      return this.review(record, scope);
    });
  }
  async removeConversation(conversationId: string) {
    z.uuid().parse(conversationId);
    return this.files.projects.mutations.run(async () => {
      if ([...this.leases.values()].some(lease => lease.scope.conversationId === conversationId)) throw new BuilderError('REVISION_CONFLICT', 'Finish the active turn before deleting its checkpoints');
      const directory = await this.directory();
      for (const name of await readdir(directory)) if (/^[a-f0-9-]{36}\.json$/.test(name)) {
        const filename = path.join(directory, name); await noSymlinks(directory, filename);
        const record = recordSchema.parse(JSON.parse(await readText(filename, this.quotas.turnBytes)));
        if (record.conversationId === conversationId) await rm(filename);
      }
    });
  }
}
export type SourceChangeReview = Awaited<ReturnType<SourceChanges['inspect']>>;
