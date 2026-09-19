import { createHash } from 'node:crypto';
import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

/** Include the actual upstream notices for modules redistributed inside our browser bundle. */
export async function bundleNotices(output, extraDependencies = ['react', 'react-dom', 'scheduler', 'tailwindcss']) {
  const roots = new Map();
  async function add(file) {
    let directory = path.dirname(file);
    while (directory !== path.dirname(directory)) {
      try {
        await access(path.join(directory, 'package.json'));
        const pkg = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
        if (pkg.name && !pkg.name.startsWith('@mobile-builder/') && pkg.name !== 'mobile-app-builder') roots.set(`${pkg.name}@${pkg.version}`, directory);
        return;
      } catch { directory = path.dirname(directory); }
    }
  }
  for (const chunk of output.flatMap(item => item.output).filter(item => item.type === 'chunk')) {
    for (const id of chunk.moduleIds) if (id.includes('/node_modules/')) await add(id.replace(/^\0/, '').split('?')[0]);
  }
  // Full local Studio also bundles these peers; Tailwind's CSS is processed before module emission.
  for (const id of extraDependencies) {
    const manifest = id === 'scheduler' ? new URL('scheduler/package.json', new URL('../', import.meta.resolve('react-dom/package.json'))).pathname : new URL(import.meta.resolve(`${id}/package.json`)).pathname;
    if (id === 'scheduler') {
      // pnpm installs scheduler alongside react-dom, not necessarily at the workspace root.
      const reactManifest = new URL(import.meta.resolve('react-dom/package.json')).pathname;
      await add(path.resolve(path.dirname(reactManifest), '../scheduler/package.json'));
    } else await add(manifest);
  }
  const sections = [], missing = [];
  for (const [name, directory] of [...roots].sort(([a], [b]) => a.localeCompare(b))) {
    const notices = (await readdir(directory)).filter(file => /^(?:licen[cs]e|copying|notice)(?:[.-]|$)/i.test(file));
    if (!notices.length) {
      const sources = JSON.parse(await readFile('docs/bundled-licenses/sources.json', 'utf8').catch(() => '{}'));
      const record = sources[name];
      if (!record) { missing.push(name); continue; }
      const text = await readFile(path.join('docs/bundled-licenses', record.file), 'utf8');
      if (createHash('sha256').update(text).digest('hex') !== record.sha256) throw new Error(`Bundled license hash mismatch: ${name}`);
      sections.push(`## ${name}\n\nSource: ${record.source}\n\n${text}`);
      continue;
    }
    sections.push(`## ${name}\n\n` + (await Promise.all(notices.map(file => readFile(path.join(directory, file), 'utf8')))).join('\n\n'));
  }
  if (missing.length) throw new Error(`Review missing bundled license text: ${missing.join(', ')}`);
  return '# Bundled third-party notices\n\nThese upstream notices apply to redistributed browser code and CSS. External dependencies retain their own package notices.\n\n' + sections.join('\n\n');
}
