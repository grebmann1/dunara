import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { dependencyFiles, dependencyProfiles } from '../../packages/core/src/dependency-profiles.js';
import { serviceRecipePaths } from '../../packages/core/src/service-recipe.js';
import { recipeUpgradePaths } from '../../packages/core/src/recipe-upgrades.js';

export async function makeLegacyApp(root: string) {
  const original = await dependencyFiles(root), legacy = await dependencyFiles(dependencyProfiles['expo-legacy']);
  const manifest = JSON.parse(legacy.manifest), lock = JSON.parse(legacy.lock), name = JSON.parse(original.manifest).name;
  manifest.name = name; lock.name = name; lock.packages[''].name = name;
  for (const file of [...recipeUpgradePaths, ...serviceRecipePaths]) if (!file.startsWith('package')) await rm(path.join(root, file), { force: true });
  await rm(path.join(root, 'backend/templates'), { recursive: true, force: true });
  await writeFile(path.join(root, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
  await writeFile(path.join(root, 'package-lock.json'), JSON.stringify(lock, null, 2) + '\n');
  const ui = path.join(root, 'src/ui/index.tsx');
  await writeFile(ui, (await readFile(ui, 'utf8')).replace(", { href: '/account', label: 'Account', icon: '○' }", '').replace(" | '/account'", '') + '\n// Existing app customization: preserve navigation.\n');
}
