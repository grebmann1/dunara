import { expect, it } from 'vitest';
import { dependencyFiles, dependencyProfile, dependencyProfiles } from './dependency-profiles.js';

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
