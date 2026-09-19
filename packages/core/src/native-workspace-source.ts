import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import path from 'node:path';
import { BuilderError } from './contracts.js';
import { noSymlinks } from './storage.js';
import { revision } from './files.js';
import { createHash } from 'node:crypto';
import type { WorkspaceFile } from './native-workspace-contracts.js';

const directories = new Set(['app', 'src', 'assets', 'components', 'hooks', 'constants']);
const rootFiles = new Set(['app.json', 'eas.json', 'package.json', 'package-lock.json', 'tsconfig.json', 'expo-env.d.ts']);
const ignored = new Set(['node_modules', 'dist', 'build', 'coverage', 'exports', 'web-build', '.git', '.expo', '.builder', '.mobile-builder.json', 'README.md', 'LICENSE', 'NOTICE', 'supabase', 'docs']);
const extensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.json', '.css', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif', '.svg', '.ttf', '.otf', '.woff', '.woff2', '.mp3', '.wav', '.mp4', '.txt']);
const privateFile = (name: string) => /^\.env(?:\.|$)|^(?:credentials|openai-images|openai-assistant)(?:\.|$)|\.(?:key|pem|p8|p12|pfx|keystore|jks|log)$|^\.credential-/i.test(name);
const digest = (data: Buffer) => createHash('sha256').update(data).digest('hex');
export type Snapshot = { files: WorkspaceFile[]; contents: Map<string, Buffer>; bytes: number; fingerprint: string };
export function manifest(contents: Map<string, Buffer>): Snapshot {
  const files = [...contents].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([name, data]) => ({ path: name, bytes: data.length, sha256: digest(data) }));
  return { files, contents, bytes: files.reduce((n, file) => n + file.bytes, 0), fingerprint: revision(JSON.stringify(files)) };
}
export async function boundedFile(root: string, relative: string, limit = 8_000_000) {
  const target = path.join(root, relative); await noSymlinks(root, target);
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > limit) throw new BuilderError('INVALID_PATH', `Unsupported or oversized build input: ${relative}`);
    const buffer = Buffer.alloc(stat.size + 1), { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== stat.size || bytesRead > limit) throw new BuilderError('REVISION_CONFLICT', `Build input changed while reading: ${relative}`);
    return buffer.subarray(0, bytesRead);
  } finally { await handle.close(); }
}
/** Explicit managed-app surface. Unknown code/config requires an intentional integration. */
export async function sourceSnapshot(root: string): Promise<Snapshot> {
  const contents = new Map<string, Buffer>(); let bytes = 0, visited = 0;
  const walk = async (relative: string, depth: number) => {
    if (++visited > 1200 || depth > 12) throw new BuilderError('LIMIT_EXCEEDED', 'Build source exceeds the bounded file tree.');
    const target = path.join(root, relative), name = path.basename(relative);
    if (ignored.has(name) || privateFile(name) || name.startsWith('.')) return;
    await noSymlinks(root, target); const stat = await lstat(target);
    if (stat.isDirectory()) {
      if (depth === 0 && !directories.has(name) && name !== 'backend') throw new BuilderError('INVALID_PATH', `Review unsupported build directory: ${relative}`);
      for (const child of (await readdir(target)).sort()) {
        if (relative === 'backend' && !['connection.json', 'configuration.json'].includes(child)) continue;
        await walk(`${relative}/${child}`, depth + 1);
      }
      return;
    }
    if (depth === 0 && !rootFiles.has(name) || !extensions.has(path.extname(name)) || relative.length > 240 || !/^[a-zA-Z0-9_()[\]. /@+-]+$/.test(relative)) throw new BuilderError('INVALID_PATH', `Review unsupported build file: ${relative}`);
    const data = await boundedFile(root, relative);
    bytes += data.length;
    if (contents.size >= 600 || bytes > 64_000_000) throw new BuilderError('LIMIT_EXCEEDED', 'Build source exceeds 600 files or 64 MB.');
    contents.set(relative, data);
  };
  for (const name of (await readdir(root)).sort()) await walk(name, 0);
  return manifest(contents);
}
export async function exportManifest(root: string) {
  const contents = new Map<string, Buffer>(); let bytes = 0, visited = 0;
  const walk = async (relative: string, depth: number) => {
    if (++visited > 4000 || depth > 12 || contents.size >= 2000) throw new BuilderError('LIMIT_EXCEEDED', 'Export exceeds file limits.');
    const target = path.join(root, relative); await noSymlinks(root, target);
    const stat = await lstat(target);
    if (stat.isDirectory()) { for (const child of (await readdir(target)).sort()) await walk(relative ? `${relative}/${child}` : child, depth + 1); }
    else { const data = await boundedFile(root, relative, 32_000_000); bytes += data.length; if (bytes > 128_000_000) throw new BuilderError('LIMIT_EXCEEDED', 'Export exceeds 128 MB.'); contents.set(relative, data); }
  };
  await walk('', 0); return manifest(contents);
}
