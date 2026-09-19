import {
  mkdtemp,
  mkdir,
  writeFile,
  symlink,
  rm,
  readdir,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { snapshotSource, sourcePath, saveSnapshot } from "./source.js";
it("checkpoints only bounded source and assets, excludes credentials, and rejects links and traversal", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dunara-source-"));
  try {
    const source = path.join(root, "app");
    await mkdir(source);
    await writeFile(path.join(source, "index.tsx"), "export default 1");
    await writeFile(path.join(source, ".env"), "PRIVATE=value");
    await writeFile(path.join(source, "credentials.json"), "PRIVATE");
    await mkdir(path.join(source, "node_modules"));
    await writeFile(path.join(source, "node_modules", "index.js"), "excluded");
    const snapshot = await snapshotSource(source);
    expect(snapshot.files.map((f) => f.path)).toEqual(["index.tsx"]);
    expect(snapshot.files[0]!.content.buffer.byteLength).toBeLessThan(10_000);
    expect((await snapshotSource(source)).revision).toBe(snapshot.revision);
    for (const name of [
      "../index.tsx",
      "/index.tsx",
      "a/../../index.tsx",
      "a\\index.tsx",
      ".env",
      "credentials.json",
    ])
      expect(sourcePath(name)).toBe(false);
    const checkpoints = path.join(root, "checkpoints");
    for (let i = 0; i < 7; i++) {
      await writeFile(path.join(source, "index.tsx"), String(i));
      await saveSnapshot(checkpoints, await snapshotSource(source));
    }
    expect((await readdir(checkpoints)).length).toBeLessThanOrEqual(5);
    await symlink(path.join(source, ".env"), path.join(source, "linked.ts"));
    await expect(snapshotSource(source)).rejects.toThrow(/symlink/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it("makes curated lockfiles portable without changing versions or integrity", async () => {
  const { portableInstallFiles } = await import("./source.js");
  const lock = {
    packages: {
      "node_modules/example": {
        version: "1.2.3",
        resolved:
          "https://mirror.example/nexus/content/groups/npm-all/example/-/example-1.2.3.tgz",
        integrity: "sha512-pinned",
      },
    },
  };
  const result = portableInstallFiles([
    { path: "package-lock.json", content: Buffer.from(JSON.stringify(lock)) },
  ]);
  expect(
    JSON.parse(Buffer.from(result[0]!.content).toString()).packages[
      "node_modules/example"
    ],
  ).toEqual({
    ...lock.packages["node_modules/example"],
    resolved: "https://registry.npmjs.org/example/-/example-1.2.3.tgz",
  });
  expect(() =>
    portableInstallFiles([
      {
        path: "package-lock.json",
        content: Buffer.from(
          JSON.stringify({
            packages: {
              bad: {
                resolved: "https://evil.example/anything",
                integrity: "sha512-pinned",
              },
            },
          }),
        ),
      },
    ]),
  ).toThrow();
});
