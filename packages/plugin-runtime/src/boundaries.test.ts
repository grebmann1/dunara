import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
it('keeps public SDK contracts independent of host and repository implementations', async () => {
  const root = path.resolve('packages/plugin-sdk/src');
  for (const file of await readdir(root)) {
    const content = await readFile(path.join(root, file), 'utf8');
    expect(content, file).not.toMatch(/(?:from\s*|import\s*\()['"](?:\.\.\/|@mobile-builder\/(?:core|builtin-plugins|plugin-runtime))/);
    expect(content, file).not.toContain('process.env');
  }
});
it('keeps feature construction out of the kernel and retains only explicit compatibility exports', async () => {
  const kernel = await readFile('packages/core/src/kernel.ts', 'utf8'); expect(kernel).not.toMatch(/builder\.(supabase|expo|media|icons|assistant)|new (Backends|Previews|MediaJobs)/);
  for (const feature of ['engine', 'backends', 'preview', 'assets', 'app-icons', 'launch-kits', 'native-builds', 'native-build-workspaces']) {
    const facade = await readFile(`packages/core/src/${feature}.ts`, 'utf8');
    expect(facade.trim().split('\n')).toHaveLength(2); expect(facade).toContain('export * from'); expect(facade).not.toContain('new ');
  }
});
