import { expect, it } from 'vitest';
import { dependencyFiles, dependencyProfile, dependencyProfiles } from './dependency-profiles.js';
import { nativeAuthDependencies } from '../../../tests/fixtures/native-auth-app.js';

it('recognizes the pinned native sign-in profile without changing its files', async () => {
  const files = nativeAuthDependencies(await dependencyFiles(dependencyProfiles['expo-supabase-v1']));
  const manifest = JSON.parse(files.manifest), lock = JSON.parse(files.lock);
  manifest.name = lock.name = lock.packages[''].name = 'custom-app-name';
  const renamed = { manifest: JSON.stringify(manifest), lock: JSON.stringify(lock).replaceAll('https://registry.npmjs.org/', 'https://mirror.example.test/nexus/content/groups/npm-all/') };
  const before = structuredClone(renamed);
  expect(await dependencyProfile(renamed)).toBe('expo-supabase-auth-v1');
  expect(renamed).toEqual(before);
});

it.each(['manifest-version', 'lock-version', 'integrity', 'artifact', 'script', 'extra-package', 'missing-package', 'root-version', 'base-integrity', 'override'])('rejects native sign-in dependencies with changed %s', async change => {
  const files = nativeAuthDependencies(await dependencyFiles(dependencyProfiles['expo-supabase-v1']));
  const manifest = JSON.parse(files.manifest), lock = JSON.parse(files.lock);
  const crypto = lock.packages['node_modules/expo-crypto'];
  if (change === 'manifest-version') manifest.dependencies['expo-crypto'] = '^57.0.3';
  if (change === 'lock-version') crypto.version = '57.0.4';
  if (change === 'integrity') crypto.integrity = 'sha512-tampered';
  if (change === 'artifact') crypto.resolved = 'https://registry.npmjs.org/other/-/other-57.0.3.tgz';
  if (change === 'script') manifest.scripts.postinstall = 'touch owned';
  if (change === 'extra-package') lock.packages['node_modules/extra'] = crypto;
  if (change === 'missing-package') delete lock.packages['node_modules/expo-web-browser'];
  if (change === 'root-version') lock.packages[''].dependencies['expo-crypto'] = '57.0.4';
  if (change === 'base-integrity') lock.packages['node_modules/expo'].integrity = 'sha512-tampered';
  if (change === 'override') manifest.overrides = { expo: '57.0.1' };
  expect(await dependencyProfile({ manifest: JSON.stringify(manifest), lock: JSON.stringify(lock) })).toBeNull();
});

it('does not classify a legacy app with native sign-in additions as the Supabase profile', async () => {
  const files = nativeAuthDependencies(await dependencyFiles(dependencyProfiles['expo-legacy']));
  expect(await dependencyProfile(files)).toBeNull();
});

it('preserves generated app compatibility across the portable registry migration', async () => {
  for (const [profile, root] of Object.entries(dependencyProfiles)) {
    const current = await dependencyFiles(root);
    expect(current.lock).not.toContain('/nexus/');
    const older = { ...current, lock: current.lock.replaceAll('https://registry.npmjs.org/', 'https://mirror.example.test/nexus/content/groups/npm-all/') };
    expect(await dependencyProfile(older)).toBe(profile);
    const changed = JSON.parse(older.lock);
    const artifact = Object.values(changed.packages).find((entry): entry is { integrity: string } => !!(entry as { integrity?: string }).integrity)!;
    artifact.integrity = 'sha512-tampered';
    expect(await dependencyProfile({ ...older, lock: JSON.stringify(changed) })).toBeNull();
  }
});
