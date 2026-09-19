import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { inspectPackage, archivePackage } from '../../plugin-runtime/src/packages.js';
import { readText } from '../../core/src/storage.js';

export const starterServer = `export default function plugin(api) {
  api.actions.register({
    id: 'source-summary', title: 'Source summary', description: 'List the selected app’s editable source files.',
    effect: 'read', scope: 'project', input: { type: 'object', properties: {}, additionalProperties: false },
    output: { type: 'object', properties: { files: { type: 'array', items: { type: 'string' } }, truncated: { type: 'boolean' } }, required: ['files', 'truncated'] },
    async run(_input, context) { return context.files.list(); }
  });
  api.settings.define([{ id: 'label', label: 'Panel label', type: 'string', default: 'My app notes' }]);
  api.recipes.register({ id: 'notes', title: 'Add app notes', version: '1.0.0', description: 'Create a README for your app. Review the exact file before applying.', files: [{ path: 'APP-NOTES.md', content: '# My app\\n\\nKeep your testing notes here.\\n' }] });
}
`;
export const starterApp = `export default { apiVersion: 1, panels: [{ id: 'notes', title: 'App notes', scope: 'project', async mount(root, api) {
  const settings = await api.settings(); if (api.signal.aborted) return;
  const heading = document.createElement('h2'); heading.textContent = settings.label || 'My app notes';
  const description = document.createElement('p'); description.textContent = 'This panel is supplied by a plugin outside Dunara. Inspect your app’s source or review the notes recipe below.';
  const button = document.createElement('button'); button.textContent = 'Inspect app source'; const output = document.createElement('pre');
  button.onclick = async () => { button.disabled = true; try { const result = await api.invoke('source-summary', {}); if (!api.signal.aborted) output.textContent = JSON.stringify(result, null, 2); } catch { output.textContent = 'Source is unavailable. Check the selected app and plugin status.'; } finally { button.disabled = false; } };
  root.append(heading, description, button, output); return () => { button.onclick = null; root.replaceChildren(); };
} }] };
`;
export async function scaffoldPlugin(directory: string) {
  const root = path.resolve(directory); await mkdir(root, { recursive: false });
  const files = {
    'package.json': JSON.stringify({ name: '@example/project-notes', version: '1.0.0', type: 'module', builder: { id: 'example.project-notes', name: 'Project Notes', description: 'An independent panel, source action and reviewed app recipe.', apiVersion: 1, server: 'server.js', app: 'app.js', capabilities: ['project.read', 'project.write', 'storage'], guides: ['user.md', 'agent.md'] } }, null, 2) + '\n',
    'server.js': starterServer, 'app.js': starterApp,
    'user.md': '# Project Notes\n\n1. Select an app.\n2. Open this plugin’s panel and inspect its source.\n3. Choose Review recipe to add app notes.\n4. Read the exact change and apply it in Plugins.\n',
    'agent.md': '# Project Notes for agents\n\nUse plugin_list to discover source-summary and recipe:notes. The former reads scoped files; the latter prepares a human review. No operation accepts credentials.\n\nThis package implements the public @mobile-builder/plugin-sdk API. TypeScript authors can import definePlugin, definePluginApp, defineRecipe and testPlugin from its documented exports. Bundle imports before packaging a plugin for installation.\n',
  };
  for (const [name, text] of Object.entries(files)) await writeFile(path.join(root, name), text, { flag: 'wx' });
  return { directory: root, next: ['mobile-builder plugin validate <directory>', 'mobile-builder plugin pack <directory>', 'Open Dunara → Plugins → Install plugin'] };
}
export async function runPluginCommand(args: string[], input?: string, inputFile?: string) {
  const [command, source, ...extra] = args;
  if (extra.length || !source || !['new', 'validate', 'pack', 'dev'].includes(command ?? '')) throw Error('Use plugin new|validate|pack|dev <directory-or-package>');
  if (input !== undefined || inputFile !== undefined) throw Error('Plugin installation is reviewed in Dunara’s Plugins screen; command inputs are not accepted here');
  if (command === 'new') return scaffoldPlugin(source);
  const pkg = await inspectPackage(source);
  if (command === 'pack') {
    const output = path.resolve(`${source.replace(/\/$/, '')}.builder-plugin.json`); await writeFile(output, archivePackage(pkg), { flag: 'wx', mode: 0o600 }); return { output, id: pkg.package.builder.id, digest: pkg.digest };
  }
  if (command === 'dev') return { id: pkg.package.builder.id, digest: pkg.digest, directory: path.resolve(source), instruction: 'Open Dunara → Plugins → Install plugin, enter this path, inspect it and select Development package. Use Reload after edits. Changes to identity or declared capabilities require a new installation review.' };
  // Reading the manifest through the same bounded path also rejects accidental empty packages.
  if (!pkg.files['package.json']) throw Error('Missing package.json');
  return { valid: true, id: pkg.package.builder.id, version: pkg.package.version, digest: pkg.digest, files: Object.keys(pkg.files), guides: await Promise.all(pkg.package.builder.guides.map(async file => source.endsWith('.builder-plugin.json') ? pkg.files[file]!.length : (await readText(path.join(source, file), 128000)).length)) };
}
