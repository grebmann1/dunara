import { access, cp, chmod, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
await mkdir('dist/packages/templates', { recursive: true });
await rm('dist/packages/templates/expo', { recursive: true, force: true });
await cp('packages/templates/expo', 'dist/packages/templates/expo', { recursive: true, filter: file => !['node_modules', '.expo', 'dist'].includes(path.basename(file)) });
await cp('packages/templates/expo-legacy', 'dist/packages/templates/expo-legacy', { recursive: true });
await rm('dist/packages/templates/expo-native', { recursive: true, force: true });
await cp('packages/templates/expo-native', 'dist/packages/templates/expo-native', { recursive: true, filter: file => path.basename(file) !== 'node_modules' });
await access('dist/studio/index.html');
await rm('dist/plugins', { recursive: true, force: true });
await cp('plugins', 'dist/plugins', { recursive: true, filter: file => !['node_modules', '.git'].includes(path.basename(file)) });
for (const file of ['package.json', 'package-lock.json']) {
  assert.deepEqual(await readFile(`dist/packages/templates/expo/${file}`), await readFile(`packages/templates/expo/${file}`), `Built template ${file} differs from pinned source`);
}
await chmod('dist/packages/cli/src/index.js', 0o755);
