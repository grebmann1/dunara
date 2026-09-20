import { constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseEnv } from 'node:util';
import { z } from 'zod';
import { BuilderError } from './contracts.js';
import { SecretBox } from '../../platform/src/crypto.js';
import { assertStateAvailable, stageHomeState } from './durable-state.js';

export const credentialKeySchema = z.string().min(16).max(4096).regex(/^[\x21-\x7e]+$/);
const savedSchema = z.object({ version: z.literal(1), key: credentialKeySchema }).strict();
export type StartupCredentials = { imageKey?: string; assistantKey?: string };
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const failure = () => new BuilderError('INVALID_INPUT', 'Credential storage is unavailable or unsafe. Check file ownership, permissions and format; no provider request was made.');
function owned(info: import('node:fs').Stats, privateMode: boolean) {
  if (process.getuid && info.uid !== process.getuid()) throw failure();
  if ((info.mode & (privateMode ? 0o077 : 0o022)) !== 0) throw failure();
}
function read(file: string, limit: number, privateMode: boolean): string | undefined {
  let fd: number;
  try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if (missing(error)) return; throw failure(); }
  try {
    const info = fstatSync(fd); owned(info, privateMode);
    if (!info.isFile() || info.nlink !== 1 || info.size > limit) throw failure();
    const buffer = Buffer.alloc(limit + 1);
    const bytes = readSync(fd, buffer, 0, buffer.length, 0);
    if (bytes > limit || buffer.subarray(0, bytes).includes(0)) throw failure();
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytes));
  } finally { closeSync(fd); }
}

// Parse values without loading arbitrary .env entries into any process environment.
export function startupEnvironmentFile(envFile?: string): NodeJS.ProcessEnv {
  try { const text = envFile ? read(envFile, 64 * 1024, false) : undefined; return text === undefined ? {} : parseEnv(text); }
  catch { throw failure(); }
}
export function startupCredentials(envFile?: string, env: NodeJS.ProcessEnv = process.env): StartupCredentials {
  try {
    const values = startupEnvironmentFile(envFile);
    const image = env.OPENAI_API_KEY ?? values.OPENAI_API_KEY;
    const assistant = env.BUILDER_ASSISTANT_API_KEY ?? values.BUILDER_ASSISTANT_API_KEY ?? image;
    return { imageKey: image ? credentialKeySchema.parse(image) : undefined, assistantKey: assistant ? credentialKeySchema.parse(assistant) : undefined };
  } catch { throw failure(); }
}

// Private, bounded settings files; never exposed through renderer responses.
export class PrivateSettingsStore<T> {
  private directory: string;
  private file: string;
  constructor(private home: string, slot: string, private schema: z.ZodType<T>, private limit = 8192) {
    if (!/^[a-z0-9-]{1,100}$/.test(slot)) throw failure();
    this.directory = path.join(home, 'credentials'); this.file = path.join(this.directory, `${slot}.json`);
  }
  private check(create = false) {
    assertStateAvailable(this.home);
    if (create) mkdirSync(this.home, { recursive: true, mode: 0o700 });
    let home;
    try { home = lstatSync(this.home); } catch (error) { if (missing(error)) return false; throw error; }
    owned(home, false);
    if (!home.isDirectory() || home.isSymbolicLink()) throw failure();
    if (create) { try { mkdirSync(this.directory, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; } }
    let info;
    try { info = lstatSync(this.directory); } catch (error) { if (missing(error)) return false; throw error; }
    owned(info, true);
    if (!info.isDirectory() || info.isSymbolicLink()) throw failure();
    return true;
  }
  load(): T | undefined {
    try {
      if (!this.check()) return;
      const text = read(this.file, this.limit, true);
      return text === undefined ? undefined : this.schema.parse(JSON.parse(text));
    } catch { throw failure(); }
  }
  save(value: T) {
    let temporary: string | undefined;
    try {
      const content = JSON.stringify(this.schema.parse(value));
      if (Buffer.byteLength(content) > this.limit) throw failure();
      this.check(true); this.load();
      temporary = path.join(this.directory, `.credential-${randomUUID()}.tmp`);
      const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { writeFileSync(fd, content); fsyncSync(fd); } finally { closeSync(fd); }
      this.check(); renameSync(temporary, this.file);
      void stageHomeState(this.file, Buffer.from(content));
    } catch {
      if (temporary) { try { unlinkSync(temporary); } catch { /* The storage failure below also covers failed cleanup. */ } }
      throw failure();
    }
  }
  remove() {
    try { if (this.load() !== undefined) { unlinkSync(this.file); void stageHomeState(this.file, null); } }
    catch { throw failure(); }
  }
}

export class CredentialStore {
  private store: EncryptedSettingsStore<z.infer<typeof savedSchema>>;
  private legacy: PrivateSettingsStore<z.infer<typeof savedSchema>>[];
  constructor(home: string, slot: 'openai-images' | 'openai-assistant', readonly protection?: SecretProtection, aliases: string[] = []) {
    this.store = new EncryptedSettingsStore(home, `${slot}-protected`, savedSchema, protection);
    this.legacy = [slot, ...aliases].map(name => new PrivateSettingsStore(home, name, savedSchema));
  }
  load() {
    const current = this.store.load(), old = this.legacy.map(store => store.load());
    const value = current ?? old.find(Boolean);
    if (value && old.some(Boolean)) {
      if (!current) this.store.save(value);
      // Never discard the recoverable plaintext until encrypted read-back succeeds.
      if (this.store.load()?.key !== value.key) throw failure();
      for (const store of this.legacy) store.remove();
    }
    return value?.key;
  }
  save(key: string) { this.load(); this.store.save({ version: 1, key }); }
  remove() { this.store.remove(); for (const store of this.legacy) store.remove(); }
}

export type SecretProtection = { kind: 'os' | 'configured'; key: string };
const envelopeSchema = z.object({ version: z.literal(1), ciphertext: z.string().min(1) }).strict();
/** Only ciphertext is written. Missing/locked protection never falls back to plaintext. */
export class EncryptedSettingsStore<T> {
  private store: PrivateSettingsStore<z.infer<typeof envelopeSchema>>;
  constructor(home: string, private slot: string, private schema: z.ZodType<T>, readonly protection?: SecretProtection) {
    this.store = new PrivateSettingsStore(home, slot, envelopeSchema, 128 * 1024);
  }
  private box() { if (!this.protection) throw failure(); return new SecretBox(this.protection.key); }
  load(): T | undefined {
    try { const envelope = this.store.load(); return envelope ? this.schema.parse(JSON.parse(this.box().open(envelope.ciphertext, `builder:${this.slot}:v1`))) : undefined; }
    catch { throw failure(); }
  }
  save(value: T) {
    try { this.load(); this.store.save({ version: 1, ciphertext: this.box().seal(JSON.stringify(this.schema.parse(value)), `builder:${this.slot}:v1`) }); }
    catch { throw failure(); }
  }
  // An explicit disconnect may forget a locked credential without decrypting it.
  remove() { this.store.remove(); }
}
export function sharedOpenAIStore(home: string, protection?: SecretProtection) {
  return new CredentialStore(home, 'openai-images', protection, ['openai-assistant']);
}
