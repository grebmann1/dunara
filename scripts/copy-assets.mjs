import { access, cp, chmod, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import sharp from 'sharp';

// Electron needs a raster icon; derive it from the same mark used by Studio.
const desktopAssets = 'dist/packages/desktop/assets';
await mkdir(desktopAssets, { recursive: true });
const mark = await sharp('packages/catalog/assets/brand-mark.svg', { density: 1152 }).resize(824, 824).png().toBuffer();
await sharp({ create: { width: 1024, height: 1024, channels: 4, background: '#00000000' } })
  .composite([{ input: mark, left: 100, top: 100 }]).png().toFile(`${desktopAssets}/app-icon.png`);

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
