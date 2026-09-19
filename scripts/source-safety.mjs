import { execFileSync } from 'node:child_process';
import { readFile, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const policy = JSON.parse(await readFile('source-policy.json', 'utf8'));
const root = await realpath('.');
for (const file of files) {
  if (!policy.files.includes(file) && !policy.directories.some(directory => file.startsWith(directory + '/'))) throw Error(`Unreviewed source ownership: ${file}`);
  if (/^(?:packages\/cloud|apps\/(?:cloud|website)|supabase\/platform|infra\/cloud)\//.test(file) || /^packages\/platform\/src\/(?:api|main|oauth)(?:\.test)?\.ts$/.test(file)) throw Error(`Private implementation in OSS: ${file}`);
  if (file.split('/').some(part => ['node_modules', 'dist', '.builder', '.zcc', '.git'].includes(part)) || /(?:^|\/)(?:\.env(?:\..*)?|credentials(?:\.json)?|.*\.(?:pem|key|p12|pfx|log))$/i.test(file)) throw Error(`Runtime/private artifact: ${file}`);
  const full = path.join(root, file), info = await lstat(full);
  if (!info.isFile() || info.isSymbolicLink()) throw Error(`Non-regular source file: ${file}`);
  if (/\.(?:png|webp|jpe?g)$/.test(file)) continue;
  const text = await readFile(full, 'utf8');
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text) || /\bsk-(?:proj-)?[A-Za-z0-9_-]{40,}\b/.test(text) || /\/(?:Users|home)\/(?!example(?:\/|\b)|user(?:\/|\b)|you(?:\/|\b))[A-Za-z0-9._-]+\//.test(text)) throw Error(`Private content requires review: ${file}`);
  if (/nexus-proxy\.repo\.|local\.sfdc\.net/.test(text)) throw Error(`Private registry location: ${file}`);
}
console.log(`Source ownership and private-content checks passed for ${files.length} tracked files.`);
