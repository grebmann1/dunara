import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const licenses = JSON.parse(execFileSync('pnpm', ['licenses', 'list', '--json'], { encoding: 'utf8', maxBuffer: 10_000_000 }));
const builder = Object.values(licenses).flat().map(({ name, versions, license }) => ({ name, versions, license })).sort((a, b) => a.name.localeCompare(b.name));
const lock = JSON.parse(await readFile('packages/templates/expo/package-lock.json', 'utf8'));
const starter = Object.entries(lock.packages).filter(([location]) => location).map(([location, entry]) => ({ name: location.split('node_modules/').at(-1), version: entry.version, license: entry.license ?? 'UNDECLARED' })).sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
const nativeLock = JSON.parse(await readFile('packages/templates/expo-native/package-lock.json', 'utf8'));
const nativeDevelopment = Object.entries(nativeLock.packages).filter(([location, entry]) => location && (!lock.packages[location] || lock.packages[location].version !== entry.version)).map(([location, entry]) => ({ name: location.split('node_modules/').at(-1), version: entry.version, license: entry.license ?? 'UNDECLARED' })).sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
await mkdir('docs', { recursive: true });
await writeFile('docs/licenses.json', JSON.stringify({ description: 'Declared package licenses; preserve upstream texts and notices. Not a compliance certification.', builder, starter, nativeDevelopment }, null, 2) + '\n');
console.log(`Recorded ${builder.length} builder and ${starter.length} starter dependency entries.`);
