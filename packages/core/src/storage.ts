import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BuilderError } from './contracts.js';

export async function exists(file: string) { try { return await lstat(file); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; } }
export function inside(root: string, target: string) { const rel = path.relative(root, target); return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel); }
export async function noSymlinks(root: string, target: string) {
  if (target !== root && !inside(root, target)) throw new BuilderError('INVALID_PATH', 'Path escapes the registered root');
  let current = root;
  for (const part of ['', ...path.relative(root, target).split(path.sep).filter(Boolean)]) {
    current = path.join(current, part);
    const info = await exists(current);
    if (info?.isSymbolicLink()) throw new BuilderError('INVALID_PATH', 'Symlinks are not supported');
  }
}
export async function canonicalDirectory(directory: string) { await mkdir(directory, { recursive: true }); return realpath(directory); }
export async function readText(file: string, limit = 256_000) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) throw new BuilderError('LIMIT_EXCEEDED', 'File is not a bounded text file');
    const buffer = Buffer.alloc(limit + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > limit || buffer.subarray(0, bytesRead).includes(0)) throw new BuilderError('LIMIT_EXCEEDED', 'Binary or oversized file');
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead));
  } finally { await handle.close(); }
}
export async function atomicWrite(file: string, content: string) {
  const tmp = path.join(path.dirname(file), `.builder-${randomUUID()}.tmp`);
  try {
    const handle = await open(tmp, 'wx', 0o600);
    try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
    await rename(tmp, file);
  } finally { await rm(tmp, { force: true }); }
}
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn);
    this.tail = result.catch(() => {});
    return result;
  }
}
