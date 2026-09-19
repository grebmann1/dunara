import { portableLockfile } from './source.js';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { BuilderError } from './contracts.js';
import { templateRoot } from './projects.js';
import { noSymlinks, readText } from './storage.js';

export const dependencyProfiles = { 'expo-supabase-v1': templateRoot, 'expo-legacy': path.resolve(templateRoot, '../expo-legacy') } as const;
export type DependencyProfile = keyof typeof dependencyProfiles;
export async function dependencyFiles(root: string) {
  await noSymlinks(root, path.join(root, 'package.json'));
  await noSymlinks(root, path.join(root, 'package-lock.json'));
  return { manifest: await readText(path.join(root, 'package.json')), lock: await readText(path.join(root, 'package-lock.json'), 2_000_000) };
}
const portableLock = (text: string) => JSON.parse(portableLockfile(text));

export async function dependencyProfile(files: Awaited<ReturnType<typeof dependencyFiles>>): Promise<DependencyProfile | null> {
  const actual = JSON.parse(files.manifest), lock = portableLock(files.lock);
  for (const [name, root] of Object.entries(dependencyProfiles)) {
    const expected = await dependencyFiles(root), manifest = JSON.parse(expected.manifest), templateLock = portableLock(expected.lock);
    // Only the app's name may differ. Scripts, resolutions and integrity data stay pinned.
    if (!lock.packages?.['']) return null;
    const normalized = { ...actual, name: manifest.name };
    const normalizedLock = { ...lock, name: templateLock.name, packages: { ...lock.packages, '': { ...lock.packages[''], name: templateLock.packages[''].name } } };
    if (isDeepStrictEqual(normalized, manifest) && isDeepStrictEqual(normalizedLock, templateLock)) return name as DependencyProfile;
  }
  return null;
}
export async function checkDependencies(root: string) {
  const files = await dependencyFiles(root);
  if (!await dependencyProfile(files)) throw new BuilderError('DEPENDENCIES_CHANGED', 'Manifest or lockfile differs from the curated Expo profiles. Review dependency changes independently before using a different stack.');
  return files;
}
