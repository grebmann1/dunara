import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { readdir, open, mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { noSymlinks, atomicWrite } from "./storage.js";
import type { ExecutionFile } from "../../plugin-sdk/src/execution.js";
const excluded = new Set(["node_modules", "dist", "build", "coverage"]);
const extensions = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".css",
  ".md",
  ".txt",
  ".svg",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".ttf",
  ".otf",
  ".sql",
  ".toml",
  ".html",
]);
export function sourcePath(name: string) {
  return (
    name.length <= 240 &&
    !name.includes("\\") &&
    name
      .split("/")
      .every(
        (part) =>
          /^[a-zA-Z0-9_()[\]. -]+$/.test(part) &&
          !part.startsWith(".") &&
          !excluded.has(part) &&
          !/(secret|credential|private.key)/i.test(part),
      ) &&
    extensions.has(path.posix.extname(name))
  );
}
export type SourceSnapshot = {
  revision: string;
  bytes: number;
  files: ExecutionFile[];
};
/** Reads bytes only. Never imports configuration or runs an archive/package script. */
export async function snapshotSource(root: string): Promise<SourceSnapshot> {
  const files: ExecutionFile[] = [];
  let bytes = 0,
    visited = 0;
  const walk = async (directory: string, depth: number) => {
    if (depth > 12) throw Error("Cloud source nesting limit exceeded");
    await noSymlinks(root, directory);
    for (const item of await readdir(directory, { withFileTypes: true })) {
      if (++visited > 4000) throw Error("Cloud source file limit exceeded");
      if (item.name.startsWith(".") || excluded.has(item.name)) continue;
      const filename = path.join(directory, item.name),
        relative = path.relative(root, filename).split(path.sep).join("/");
      if (item.isSymbolicLink())
        throw Error("Cloud source cannot contain symlinks");
      if (item.isDirectory()) await walk(filename, depth + 1);
      else if (item.isFile() && sourcePath(relative)) {
        await noSymlinks(root, filename);
        const handle = await open(
          filename,
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
        let content: Buffer;
        try {
          const info = await handle.stat();
          if (!info.isFile() || info.size > 8_000_000)
            throw Error("Oversized source file");
          const buffer = Buffer.alloc(info.size + 1);
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
          if (bytesRead > info.size)
            throw Error("Source changed during upload; retry the preview");
          content = buffer.subarray(0, bytesRead);
        } finally {
          await handle.close();
        }
        bytes += content.byteLength;
        if (
          content.byteLength > 8_000_000 ||
          bytes > 32_000_000 ||
          files.length >= 500
        )
          throw Error("Cloud source exceeds upload limits");
        files.push({ path: relative, content });
      }
    }
  };
  await walk(root, 0);
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const hash = createHash("sha256");
  for (const file of files)
    hash
      .update(file.path)
      .update("\0")
      .update(String(file.content.byteLength))
      .update("\0")
      .update(file.content);
  return { revision: hash.digest("hex"), bytes, files };
}
/** Immutable, provider-independent source checkpoint. Secrets and node_modules are excluded. */
export async function saveSnapshot(
  directory: string,
  snapshot: SourceSnapshot,
) {
  if (!/^[a-f0-9]{64}$/.test(snapshot.revision))
    throw Error("Invalid checkpoint revision");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const previous = await Promise.all(
    (await readdir(directory))
      .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
      .map(async (name) => ({
        name,
        time: (await stat(path.join(directory, name))).mtimeMs,
      })),
  );
  for (const item of previous.sort((a, b) => b.time - a.time).slice(4))
    await rm(path.join(directory, item.name));
  await atomicWrite(
    path.join(directory, `${snapshot.revision}.json`),
    JSON.stringify({
      version: 1,
      revision: snapshot.revision,
      files: snapshot.files.map((file) => ({
        path: file.path,
        base64: Buffer.from(file.content).toString("base64"),
      })),
    }),
  );
}

/** Preserve the curated package versions and SRI hashes while removing a developer's registry mirror. */
export function portableInstallFiles(files: ExecutionFile[]): ExecutionFile[] {
  return files.map(file => file.path === 'package-lock.json'
    ? { ...file, content: Buffer.from(portableLockfile(Buffer.from(file.content).toString('utf8'))) }
    : file);
}

/** Normalize registry locations without changing package versions or integrity constraints. */
export function portableLockfile(text: string): string {
  const lock = JSON.parse(text);
  for (const entry of Object.values(lock.packages ?? {}) as { resolved?: string; integrity?: string }[]) {
    if (!entry.resolved) continue;
    const url = new URL(entry.resolved);
    const pathname = url.pathname.replace(/^\/nexus\/content\/groups\/npm-all\//, '/');
    if (!/^\/(?:@[^/]+\/)?[^/]+\/-\/[^/]+\.tgz$/.test(pathname) || !entry.integrity?.startsWith('sha512-')) {
      throw Error('Unsupported pinned package artifact');
    }
    entry.resolved = `https://registry.npmjs.org${pathname}`;
  }
  return JSON.stringify(lock);
}
