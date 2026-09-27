import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, readdir, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { readText } from '../../core/src/storage.js';

export const runtimeRecordSchema = z.object({ version: z.literal(1), pid: z.number().int().positive(), home: z.string().max(4096), workspace: z.string().max(4096), socketPath: z.string().max(4096), startedAt: z.iso.datetime() }).strict();
export type RuntimeRecord = z.infer<typeof runtimeRecordSchema>;
/** Discover only private, current-user endpoints; no launch URLs or bearer tokens. */
export async function discoverRuntimes() {
  if (process.platform === 'win32') return [];
  // MCP clients commonly omit TMPDIR from their stdio child environment on macOS.
  const roots = new Set([os.tmpdir()]);
  if (process.platform === 'darwin') {
    try { roots.add((await promisify(execFile)('/usr/bin/getconf', ['DARWIN_USER_TEMP_DIR'], { timeout: 2000 })).stdout.trim()); } catch { /* Explicit sockets still work if OS discovery is unavailable. */ }
  }
  const found = new Map<string, RuntimeRecord>();
  for (const root of roots) for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || !/^mb-mcp-[a-zA-Z0-9]+$/.test(entry.name)) continue;
    try {
      const directory = path.join(root, entry.name), recordPath = path.join(directory, 'runtime.json');
      const [parent, file] = await Promise.all([lstat(directory), lstat(recordPath)]);
      if (!parent.isDirectory() || !file.isFile() || parent.uid !== process.getuid?.() || file.uid !== parent.uid || (parent.mode & 0o077) || (file.mode & 0o077)) continue;
      const record = runtimeRecordSchema.parse(JSON.parse(await readText(recordPath, 16_384)));
      if (!path.isAbsolute(record.home) || !path.isAbsolute(record.workspace) || !path.isAbsolute(record.socketPath) || path.basename(record.socketPath) !== 'mcp.sock' || await realpath(path.dirname(record.socketPath)) !== await realpath(directory)) continue;
      const socket = await lstat(record.socketPath);
      if (!socket.isSocket() || socket.uid !== parent.uid || (socket.mode & 0o077)) continue;
      process.kill(record.pid, 0);
      found.set(await realpath(record.socketPath), record);
    } catch { /* Stopped, inaccessible or malformed entries are not usable connections. */ }
  }
  return [...found.values()].sort((a, b) => a.home.localeCompare(b.home) || a.startedAt.localeCompare(b.startedAt));
}
export async function resolveRuntimeHome(home: string) {
  const canonical = await realpath(path.resolve(home));
  const matches = (await discoverRuntimes()).filter(runtime => runtime.home === canonical);
  if (matches.length !== 1) throw new Error(matches.length ? 'Multiple runtimes use this home. Choose an explicit --desktop-connect socket from runtimes.' : 'No running Dunara runtime for this home. Start the editor, then run runtimes.');
  return matches[0]!.socketPath;
}
