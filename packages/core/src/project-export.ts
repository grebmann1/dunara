import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import path from 'node:path';
import { crc32, deflateRaw } from 'node:zlib';
import { promisify } from 'node:util';
import { BuilderError } from './contracts.js';
import type { Projects } from './projects.js';
import { noSymlinks } from './storage.js';
import { portableLockfile } from './source.js';

const compress = promisify(deflateRaw);
const limits = { fileBytes: 32 * 1024 * 1024, totalBytes: 128 * 1024 * 1024, files: 4000, visited: 10_000, depth: 24 };
const generated = new Set(['node_modules', 'dist', 'build', 'coverage', 'exports', 'web-build', 'Pods', 'DerivedData', '__pycache__']);
const safeDotFiles = new Set(['.gitignore', '.gitattributes', '.editorconfig', '.prettierrc', '.prettierrc.json', '.prettierrc.js', '.eslintrc', '.eslintrc.json', '.eslintrc.js', '.babelrc', '.babelrc.json', '.watchmanconfig', '.browserslistrc', '.nvmrc', '.node-version']);
const safeDotDirectories = new Set(['.github', '.vscode']);
type ExportFile = { path: string; content: Buffer; executable: boolean };
type Exclusion = { path: string; reason: string };
type Stamp = { path: string; identity: string };
const identity = (info: Awaited<ReturnType<typeof lstat>>) => `${info.dev}:${info.ino}:${info.mode}:${info.size}:${info.mtimeMs}:${info.ctimeMs}:${info.nlink}`;

function exclusion(relative: string, directory: boolean, symlink: boolean) {
  const name = path.posix.basename(relative);
  if ((directory || symlink) && (generated.has(name) || /^(?:dist|build)[-_]/i.test(name)) || /\.(?:log|tsbuildinfo|apk|aab|ipa)$/i.test(name)) return 'Dependencies or generated output';
  if (/^\.env(?:\.|$)|^\.npmrc$|^\.yarnrc(?:\.yml)?$|^\.netrc$|^\.credential-/i.test(name) || /(?:^|[-_.])(?:credentials?|secrets?|private[-_.]?key)(?:[-_.]|$)/i.test(name) || /\.(?:pem|key|p8|p12|pfx|keystore|jks|mobileprovision)$/i.test(name) || /^(?:id_rsa|id_ed25519|local\.properties)$/i.test(name)) return 'Private or machine-specific configuration';
  if (name.startsWith('.') && !(directory ? safeDotDirectories : safeDotFiles).has(name)) return 'Local history, metadata or hidden configuration';
  return undefined;
}
function safeName(name: string) {
  return name.length <= 500 && name.split('/').every(part => !!part && part !== '.' && part !== '..' && [...part].every(char => char.charCodeAt(0) > 31 && char.charCodeAt(0) !== 127) && !/[\\<>:"|?*]/.test(part) && !/[. ]$/.test(part) && !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part));
}

/** Read a complete portable project tree without executing project code or archive scripts. */
async function capture(root: string, maximum: typeof limits, signal?: AbortSignal) {
  const files: ExportFile[] = [], excluded: Exclusion[] = [], stamps: Stamp[] = [];
  const names = new Set<string>();
  let bytes = 0, visited = 0;
  const walk = async (relative: string, depth: number) => {
    signal?.throwIfAborted();
    if (++visited > maximum.visited || depth > maximum.depth) throw new BuilderError('LIMIT_EXCEEDED', 'Project export exceeds the file tree limit. Move generated output outside the project and retry.');
    const filename = path.join(root, relative);
    const info = await lstat(filename);
    if (relative) {
      const reason = exclusion(relative, info.isDirectory(), info.isSymbolicLink());
      if (reason) { excluded.push({ path: relative + (info.isDirectory() ? '/' : ''), reason }); return; }
      if (!safeName(relative)) throw new BuilderError('INVALID_PATH', `Rename this file to a portable project path before downloading: ${relative}`);
      const portableName = relative.normalize('NFC').toLowerCase();
      if (names.has(portableName)) throw new BuilderError('INVALID_PATH', `Project paths collide on another filesystem: ${relative}`);
      names.add(portableName);
    }
    if (info.isSymbolicLink()) throw new BuilderError('INVALID_PATH', `Replace this source link with a regular file before downloading: ${relative}`);
    await noSymlinks(root, filename);
    stamps.push({ path: relative, identity: identity(info) });
    if (info.isDirectory()) {
      for (const name of (await readdir(filename)).sort()) await walk(relative ? `${relative}/${name}` : name, depth + 1);
      return;
    }
    if (!info.isFile() || info.nlink !== 1) throw new BuilderError('INVALID_PATH', `Project download requires regular files, without links: ${relative}`);
    if (info.size > maximum.fileBytes || bytes + info.size > maximum.totalBytes || files.length >= maximum.files) throw new BuilderError('LIMIT_EXCEEDED', 'Project download supports up to 4,000 files, 32 MiB per file and 128 MiB total. No partial ZIP was created.');
    const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let content: Buffer;
    try {
      if (identity(await handle.stat()) !== identity(info)) throw new BuilderError('REVISION_CONFLICT', 'Project changed while preparing the download. Try again once edits finish.');
      const buffer = Buffer.alloc(info.size + 1); let offset = 0;
      while (offset < buffer.length) {
        signal?.throwIfAborted();
        const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      if (offset !== info.size || identity(await handle.stat()) !== identity(info)) throw new BuilderError('REVISION_CONFLICT', 'Project changed while preparing the download. Try again once edits finish.');
      content = buffer.subarray(0, offset);
    } finally { await handle.close(); }
    bytes += content.length; files.push({ path: relative, content, executable: !!(info.mode & 0o111) });
  };
  await walk('', 0);
  // A second metadata pass catches external edits, added files and replaced directories.
  for (const stamp of stamps) {
    signal?.throwIfAborted(); const filename = path.join(root, stamp.path);
    await noSymlinks(root, filename);
    if (identity(await lstat(filename)) !== stamp.identity) throw new BuilderError('REVISION_CONFLICT', 'Project changed while preparing the download. Try again once edits finish.');
  }
  return { files, excluded, bytes };
}

/** Bounded ZIP32: UTF-8 names, DEFLATE, CRC32 and ordinary Unix file permissions. */
async function zip(folder: string, files: ExportFile[], signal?: AbortSignal) {
  const entries: Buffer[] = [], central: Buffer[] = []; let offset = 0, centralBytes = 0;
  for (const file of files) {
    signal?.throwIfAborted();
    const name = Buffer.from(`${folder}/${file.path}`), content = await compress(file.content, { level: 1 }), checksum = crc32(file.content);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6); header.writeUInt16LE(8, 8); header.writeUInt16LE(33, 12);
    header.writeUInt32LE(checksum, 14); header.writeUInt32LE(content.length, 18); header.writeUInt32LE(file.content.length, 22); header.writeUInt16LE(name.length, 26);
    entries.push(header, name, content);
    const index = Buffer.alloc(46);
    index.writeUInt32LE(0x02014b50); index.writeUInt16LE(0x0314, 4); header.copy(index, 6, 4, 30);
    index.writeUInt32LE(((file.executable ? 0o100755 : 0o100644) << 16) >>> 0, 38); index.writeUInt32LE(offset, 42);
    central.push(index, name); centralBytes += index.length + name.length; offset += header.length + name.length + content.length;
  }
  signal?.throwIfAborted();
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(centralBytes, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...entries, ...central, end]);
}

export class ProjectExports {
  private running = false;
  constructor(private projects: Projects, private maximum = limits) {}
  async download(projectId: string, signal?: AbortSignal) {
    if (this.running) throw new BuilderError('LIMIT_EXCEEDED', 'Another project download is being prepared. Wait for it to finish and try again.');
    this.running = true;
    try {
      const { project, snapshot } = await this.projects.mutations.run(async () => {
        const project = await this.projects.get(projectId);
        return { project, snapshot: await capture(project.root, this.maximum, signal) };
      });
      let portableLock = false;
      const lock = snapshot.files.find(file => file.path === 'package-lock.json');
      if (lock) {
        try { lock.content = Buffer.from(portableLockfile(lock.content.toString('utf8')) + '\n'); portableLock = true; }
        catch { /* Preserve custom or incomplete lockfiles exactly so their source can still be recovered. */ }
      }
      let guide = 'DUNARA-EXPORT.md', index = 2;
      while (snapshot.files.some(file => file.path.toLowerCase() === guide.toLowerCase())) guide = `DUNARA-EXPORT-${index++}.md`;
      const instructions = `# Your downloaded project\n\nThis ZIP contains the app's source, assets, configuration, backend files and documentation. Dunara is not required to edit or run the generated Expo app.\n\n## Run locally\n\nInstall Node.js 24, open a terminal in this folder, then run:\n\n\`\`\`sh\n${lock ? 'npm ci --ignore-scripts --no-audit --no-fund' : 'npm install'}\nnpm run typecheck\nnpm run web\n# Or start the development server for a compatible Expo Go app:\nnpm run start\n\`\`\`\n\nThe package.json scripts and project README describe this app's own setup. A source download is not a signed or installable native build.\n\n## Configuration\n\nDependencies, generated output, Git history, Dunara metadata, private environment files and known credential files are excluded. Recreate local environment variables and signing configuration on your computer. Public backend/connection.json, when present, is included; a backend used only through Dunara's runtime settings needs its public connection configured separately. See backend/README.md when present. No provider or signing credentials are injected from Dunara.\n\n${portableLock ? 'The npm lockfile retains its pinned versions and integrity hashes, with registry tarballs using registry.npmjs.org.' : 'Custom dependency files are preserved as written. Follow their package manager and registry setup.'}\n\n## Files omitted from this download\n\n${snapshot.excluded.length ? snapshot.excluded.map(file => '- ' + JSON.stringify(file.path) + ' — ' + file.reason).join('\n') : 'No excluded files were present.'}\n\nThis exclusion list uses known file names and directories; secrets written directly into source code are still source content.\n`;
      snapshot.files.push({ path: guide, content: Buffer.from(instructions), executable: false });
      const bytes = await zip(project.slug, snapshot.files, signal);
      return { filename: `${project.slug}.zip`, bytes, fileCount: snapshot.files.length, excludedCount: snapshot.excluded.length, guide };
    } finally { this.running = false; }
  }
}
