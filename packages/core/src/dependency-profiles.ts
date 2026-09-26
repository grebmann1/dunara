import { portableLockfile } from './source.js';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { BuilderError } from './contracts.js';
import { templateRoot } from './projects.js';
import { noSymlinks, readText } from './storage.js';

export const dependencyProfiles = { 'expo-supabase-v1': templateRoot, 'expo-legacy': path.resolve(templateRoot, '../expo-legacy') } as const;
export type DependencyProfile = keyof typeof dependencyProfiles | 'expo-supabase-auth-v1';
// Native Supabase sign-in needs secure PKCE and the system authentication browser.
// Both reviewed artifacts have no additional dependencies; keep their complete lock entries pinned.
const nativeAuthPackages = {
  'expo-crypto': {
    version: '57.0.3',
    resolved: 'https://registry.npmjs.org/expo-crypto/-/expo-crypto-57.0.3.tgz',
    integrity: 'sha512-SAWqEfF37nc8ot7bXsVmu9AFYwQdC2kGvH/eNAHiR3bmlcf1Vv8wu9AnGKT+a90r3T8YfwMpZP4QAYlo4vCn9w==',
    license: 'MIT', peerDependencies: { expo: '*' },
  },
  'expo-web-browser': {
    version: '57.0.3',
    resolved: 'https://registry.npmjs.org/expo-web-browser/-/expo-web-browser-57.0.3.tgz',
    integrity: 'sha512-+ecvhyS/PdWkpv4ai6FF1Trd6Y/4kn/eQ3O86mie2ecU3w+I8bKZh13kppY/jw1uSL7yikt03L5W/iiHojrFwQ==',
    license: 'MIT', peerDependencies: { expo: '*', 'react-native': '*' },
  },
} as const;
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
    if (name === 'expo-supabase-v1') {
      for (const [dependency, entry] of Object.entries(nativeAuthPackages)) {
        manifest.dependencies[dependency] = entry.version;
        templateLock.packages[''].dependencies[dependency] = entry.version;
        templateLock.packages[`node_modules/${dependency}`] = entry;
      }
      if (isDeepStrictEqual(normalized, manifest) && isDeepStrictEqual(normalizedLock, templateLock)) return 'expo-supabase-auth-v1';
    }
  }
  return null;
}
export async function checkDependencies(root: string) {
  const files = await dependencyFiles(root);
  if (!await dependencyProfile(files)) throw new BuilderError('DEPENDENCIES_CHANGED', 'Manifest or lockfile differs from the curated Expo profiles. Review dependency changes independently before using a different stack.');
  return files;
}
