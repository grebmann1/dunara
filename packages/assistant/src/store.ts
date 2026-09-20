import { lstat, mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { BuilderError } from '../../core/src/contracts.js';
import { atomicWrite, exists, noSymlinks, readText, removeStateFile, SerialQueue } from '../../core/src/storage.js';
import { ASSISTANT_LIMITS, conversationSchema, type AssistantLimits, type Conversation } from './contracts.js';

export class AssistantStore {
  private queue = new SerialQueue();
  private constructor(readonly directory: string, private limits: { conversationBytes: number; totalBytes: number; conversationsPerProject: number }) {}
  static async open(home: string, limits: AssistantLimits = ASSISTANT_LIMITS) {
    const directory = path.join(home, 'assistant');
    await noSymlinks(home, directory);
    await mkdir(directory, { mode: 0o700, recursive: true });
    return AssistantStore.checked(directory, limits);
  }
  private static async checked(directory: string, limits: { conversationBytes: number; totalBytes: number; conversationsPerProject: number }) {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) || info.uid !== process.getuid?.()) throw new BuilderError('INVALID_PATH', 'Assistant history must be a private directory owned by the current user');
    const store = new AssistantStore(directory, limits);
    await store.queue.run(async () => {
      const names = await readdir(directory);
      if (names.length > 10_000) throw new BuilderError('LIMIT_EXCEEDED', 'Too many assistant history files');
      for (const name of names) if (/^\.builder-[a-f0-9-]{36}\.tmp$/.test(name)) {
        const temporary = path.join(directory, name);
        const info = await lstat(temporary);
        if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (info.mode & 0o077) || info.uid !== process.getuid?.() || info.size > limits.conversationBytes) throw new BuilderError('INVALID_PATH', 'Unsafe interrupted assistant history write');
        await rm(temporary);
      }
      for (const item of await store.inventory()) {
        const record = await store.readUnchecked(item.id);
        let changed = false;
        for (const turn of record.turns) if (turn.state === 'starting' || turn.state === 'running') {
          turn.state = 'interrupted'; turn.endedAt = new Date().toISOString(); turn.notice = 'The backend restarted. Send a new message to continue; no prompt was resubmitted.'; changed = true;
        }
        if (changed) await store.saveUnchecked(record);
      }
    });
    return store;
  }
  private filename(id: string) { return path.join(this.directory, `${z.uuid().parse(id)}.json`); }
  private async inventory() {
    const names = await readdir(this.directory);
    if (names.length > 10_000) throw new BuilderError('LIMIT_EXCEEDED', 'Too many assistant history files');
    const files = [];
    for (const name of names) {
      if (!/^[a-f0-9-]{36}\.json$/.test(name)) throw new BuilderError('INVALID_PATH', 'Unrecognized file in assistant history directory');
      const id = z.uuid().parse(name.slice(0, -5));
      const info = await lstat(this.filename(id));
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (info.mode & 0o077) || info.uid !== process.getuid?.()) throw new BuilderError('INVALID_PATH', 'Assistant history must contain private regular files');
      if (info.size > this.limits.conversationBytes) throw new BuilderError('LIMIT_EXCEEDED', 'Assistant conversation exceeds its history quota');
      files.push({ id, bytes: info.size });
    }
    if (files.reduce((sum, file) => sum + file.bytes, 0) > this.limits.totalBytes) throw new BuilderError('LIMIT_EXCEEDED', 'Assistant history exceeds its total quota');
    return files;
  }
  private async readUnchecked(id: string) {
    const filename = this.filename(id);
    await noSymlinks(this.directory, filename);
    const record = conversationSchema.parse(JSON.parse(await readText(filename, this.limits.conversationBytes)));
    if (record.id !== id) throw new BuilderError('INVALID_INPUT', 'Assistant conversation identity does not match its file');
    return record;
  }
  private async saveUnchecked(input: Conversation, reserveBytes = 0) {
    const record = conversationSchema.parse(input);
    const encoded = JSON.stringify(record) + '\n';
    const bytes = Buffer.byteLength(encoded) + reserveBytes;
    const files = await this.inventory();
    if (bytes > this.limits.conversationBytes || files.filter(file => file.id !== record.id).reduce((sum, file) => sum + file.bytes, bytes) > this.limits.totalBytes) throw new BuilderError('LIMIT_EXCEEDED', 'Assistant history is full. Delete a conversation before continuing.');
    let projectCount = 0;
    for (const file of files) if (file.id !== record.id && (await this.readUnchecked(file.id)).projectId === record.projectId) projectCount++;
    if (projectCount >= this.limits.conversationsPerProject) throw new BuilderError('LIMIT_EXCEEDED', 'Too many conversations for this project. Delete a conversation before continuing.');
    await noSymlinks(this.directory, this.filename(record.id));
    await atomicWrite(this.filename(record.id), encoded);
  }
  list(projectId: string | null) {
    if (projectId !== null) z.uuid().parse(projectId);
    return this.queue.run(async () => {
      const records = await Promise.all((await this.inventory()).map(file => this.readUnchecked(file.id)));
      return records.filter(record => record.projectId === projectId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    });
  }
  read(id: string) { return this.queue.run(async () => { await this.inventory(); return this.readUnchecked(id); }); }
  create(record: Conversation) { return this.queue.run(async () => { if (await exists(this.filename(record.id))) throw new BuilderError('REVISION_CONFLICT', 'Conversation already exists'); await this.saveUnchecked(record); }); }
  save(record: Conversation, reserveBytes = 0) { return this.queue.run(async () => { if (!await exists(this.filename(record.id))) throw new BuilderError('INVALID_INPUT', 'Conversation is unavailable'); await this.saveUnchecked(record, reserveBytes); }); }
  hasRun(id: string) {
    z.uuid().parse(id);
    return this.queue.run(async () => {
      for (const file of await this.inventory()) if ((await this.readUnchecked(file.id)).turns.some(turn => turn.id === id)) return true;
      return false;
    });
  }
  remove(id: string) { return this.queue.run(async () => { await this.inventory(); await this.readUnchecked(id); await removeStateFile(this.filename(id)); }); }
}
