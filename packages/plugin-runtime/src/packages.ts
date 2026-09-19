import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { noSymlinks, readText } from '../../core/src/storage.js';
import { entryPath, packageSchema, type PluginPackage } from './contracts.js';

export type PackageContents = { package: PluginPackage; digest: string; files: Record<string, string> };
const MAX_BYTES = 8 * 1024 * 1024;
const fileMap = z.record(entryPath, z.string().max(2 * 1024 * 1024));
const archiveSchema = z.object({ format: z.literal('builder-plugin-1'), files: fileMap }).strict();
const supportedTextFile = (name: string) => /\.(?:m?js|cjs|json|md|css|ts|tsx|txt|html|svg)$/.test(name) || ['LICENSE', 'NOTICE'].includes(path.posix.basename(name));
function contents(files: Record<string, string>): PackageContents {
  const entries = Object.entries(files).sort(([a], [b]) => a.localeCompare(b));
  if (entries.some(([name]) => !supportedTextFile(name))) throw Error('Plugin packages support regular text source, UI, license and guide files only');
  if (entries.some(([, text]) => Buffer.byteLength(text) > 2 * 1024 * 1024)) throw Error('A plugin file exceeds 2 MiB');
  if (entries.length > 200 || entries.reduce((sum, [, text]) => sum + Buffer.byteLength(text), 0) > MAX_BYTES) throw Error('Plugin package exceeds 200 files or 8 MiB');
  const pkg = packageSchema.parse(JSON.parse(files['package.json'] ?? '{}'));
  for (const entry of [pkg.builder.server, pkg.builder.app, ...pkg.builder.guides].filter((p): p is string => !!p)) if (!Object.hasOwn(files, entry)) throw Error(`Missing plugin entry: ${entry}`);
  const digest = createHash('sha256').update(JSON.stringify(entries)).digest('hex');
  return { package: pkg, digest, files };
}
/** A bounded, text-only archive avoids install scripts, native addons and tar traversal. */
export async function inspectPackage(source: string): Promise<PackageContents> {
  const input = path.resolve(source), stat = await lstat(input);
  if (stat.isSymbolicLink()) throw Error('Plugin source cannot be a symlink');
  if (stat.isFile()) return contents(archiveSchema.parse(JSON.parse(await readText(input, MAX_BYTES + 128_000))).files);
  if (!stat.isDirectory()) throw Error('Choose a plugin directory or .builder-plugin.json archive');
  const root = await realpath(input), files: Record<string, string> = Object.create(null); let bytes = 0;
  async function walk(directory: string, depth: number) {
    if (depth > 8) throw Error('Plugin directory is too deeply nested');
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (['node_modules', '.git', '.DS_Store'].includes(entry.name)) continue;
      const file = path.join(directory, entry.name), relative = path.relative(root, file).split(path.sep).join('/');
      entryPath.parse(relative);
      if (entry.isSymbolicLink()) throw Error('Plugin packages cannot contain symlinks');
      if (entry.isDirectory()) await walk(file, depth + 1);
      else if (entry.isFile()) {
        if (!supportedTextFile(relative)) throw Error(`Unsupported package file: ${relative}`);
        await noSymlinks(root, file);
        const stat = await lstat(file); if (stat.nlink !== 1) throw Error('Plugin files cannot be hard links');
        const value = await readText(file, 2 * 1024 * 1024); bytes += Buffer.byteLength(value);
        if (Object.keys(files).length >= 200 || bytes > MAX_BYTES) throw Error('Plugin package exceeds 200 files or 8 MiB');
        files[relative] = value;
      } else throw Error('Plugin packages require regular files');
    }
  }
  await walk(root, 0); return contents(files);
}
export function archivePackage(pkg: PackageContents) { return JSON.stringify({ format: 'builder-plugin-1', files: pkg.files }, null, 2) + '\n'; }
export async function materializePackage(root: string, pkg: PackageContents) {
  const destination = path.join(root, pkg.digest);
  await noSymlinks(root, destination);
  try {
    const installed = await inspectPackage(destination);
    if (installed.digest !== pkg.digest) throw Error('Installed plugin package was modified');
    return destination;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const staging = path.join(root, `stage-${randomUUID()}`);
  await mkdir(staging, { mode: 0o700 });
  try {
    for (const [name, content] of Object.entries(pkg.files)) {
      entryPath.parse(name); const file = path.join(staging, name);
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 }); await writeFile(file, content, { flag: 'wx', mode: 0o600 });
    }
    if ((await inspectPackage(staging)).digest !== pkg.digest) throw Error('Plugin staging verification failed');
    await rename(staging, destination); return destination;
  } finally { await rm(staging, { recursive: true, force: true }); }
}
