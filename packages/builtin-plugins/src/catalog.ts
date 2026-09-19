import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { inspectBundledPackage } from '../../plugin-runtime/src/packages.js';
import { packageSchema } from '../../plugin-runtime/src/contracts.js';
import type { BuiltinPlugin } from '../../plugin-runtime/src/runtime.js';
import type { PluginFactory } from '../../plugin-sdk/src/server.js';

/** Concrete first-party identities and compatibility mappings live only in the distribution layer. */
import { featureCatalog } from './contributions.js';
export { featureCatalog, workspaceOwner } from './contributions.js';
const agentGuide = `# Authoring for Dunara\n\nUse @mobile-builder/plugin-sdk/server, /app, /recipes and /testing. API version 1.\n\n1. Scaffold: mobile-builder plugin new /absolute/plugin-directory.\n2. Register actions with JSON input/output schemas and read/write effects. Project file access requires declared capabilities and a selected app.\n3. Export a browser entry with apiVersion: 1 and panels. Each panel mounts in an owned element and returns cleanup.\n4. Validate and pack with mobile-builder plugin validate <directory> and plugin pack <directory>.\n5. Install using Plugins in a running Dunara profile, or use plugin dev <directory> for the reviewed development installation steps.\n6. Test disable/restart/reinstall and error states. Do not import Dunara repository internals.\n\nWrite actions and recipes require human review in Plugins. Guides are context, not authorization. Never put credentials in actions, generated source or logs. Private credential fields belong in Plugins.\n`;
const featurePanels: Record<string, { action: string; collection: string; title: string; empty: string }> = {
  'builder.launch-kit': { action: 'launch-kit-list', collection: 'kits', title: 'Saved Launch Kits', empty: 'No exports yet. Create one in Assets → Launch Kit using reviewed captures.' },
  'builder.expo': { action: 'native-workspace-list', collection: 'workspaces', title: 'Native preparation', empty: 'No prepared workspaces yet. Open Preview → Build setup to review one.' },
  'builder.media': { action: 'media-list', collection: 'assets', title: 'App assets', empty: 'Your asset library is empty. Open Assets to import or create images.' },
};
function featureApp(config: { action: string; collection: string; title: string; empty: string }) {
  return `const config = ${JSON.stringify(config)}; export default { apiVersion: 1, panels: [{ id: 'overview', title: config.title, scope: 'project', mount(root, context) {
    const title = document.createElement('h2'); title.textContent = config.title; const output = document.createElement('p'); output.setAttribute('role','status'); const list = document.createElement('ul'); const button = document.createElement('button'); button.textContent = 'Refresh';
    async function refresh() { button.disabled = true; try { const value = await context.invoke(config.action, {}); if (context.signal.aborted) return; const entries = value[config.collection] || []; output.textContent = entries.length ? entries.length + ' saved items for this app' : config.empty; list.replaceChildren(); for (const entry of entries.slice(0,10)) { const item = document.createElement('li'); item.textContent = entry.manifest?.listing?.name || entry.label || entry.state || 'Saved item'; list.append(item); } } catch { if (!context.signal.aborted) output.textContent = 'This app’s items are unavailable. Check its source and plugin status, then refresh.'; } finally { button.disabled = false; } }
    button.onclick = refresh; root.append(title, output, list, button); void refresh(); return () => { button.onclick = null; root.replaceChildren(); };
  } }] };\n`;
}
export async function bundledPlugins(activate?: PluginFactory): Promise<BuiltinPlugin[]> {
  const migrated = featureCatalog.map(feature => {
    const panel = featurePanels[feature.id];
    const app = panel ? featureApp(panel) : undefined;
    const pkg = packageSchema.parse({ name: `@mobile-builder/plugin-${feature.id.slice(8)}`, version: '0.1.0', type: 'module', builder: { id: feature.id, name: feature.name, description: feature.description, apiVersion: 1, capabilities: [], requires: Object.fromEntries(feature.requires.map(id => [id, '0.1.0'])), guides: ['user.md', 'agent.md'], ...(app ? { app: 'app.js' } : {}) } });
    const files: Record<string, string> = { 'package.json': JSON.stringify(pkg, null, 2), 'user.md': `# ${feature.name}\n\n${feature.description}\n\nThis is a bundled Dunara feature. Its current project workflows and reviews remain available in its normal workspace.\n`, 'agent.md': agentGuide, ...(app ? { 'app.js': app } : {}) };
    const digest = createHash('sha256').update(JSON.stringify(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)))).digest('hex');
    return { contents: { package: pkg, files, digest }, activate };
  });
  const root = fileURLToPath(new URL('../../../plugins/', import.meta.url));
  const catalogue = z.object({ version: z.literal(1), plugins: z.array(z.object({ directory: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/), autoInstall: z.boolean(), defaultEnabled: z.boolean() }).strict()).max(40) }).strict().parse(JSON.parse(await readFile(path.join(root, 'catalog.json'), 'utf8')));
  const packaged = await Promise.all(catalogue.plugins.map(async entry => ({ contents: await inspectBundledPackage(path.join(root, entry.directory)), autoInstall: entry.autoInstall, defaultEnabled: entry.defaultEnabled })));
  return [...migrated, ...packaged];
}
export function actionOwner(name: string): string | null {
  if (name.startsWith('backend_')) return 'builder.supabase';
  if (/^(native_|recipe_upgrade_|preview_|board_capture)/.test(name) || name === 'project_create') return 'builder.expo';
  if (name.startsWith('media_')) return 'builder.media';
  if (name.startsWith('icon_')) return 'builder.icons';
  if (name.startsWith('launch_kit_')) return 'builder.launch-kit';
  if (name.startsWith('inspector_') || name === 'design_apply') return 'builder.design';
  return null;
}
export function routeOwner(route: string): string | null {
  if (/\/launch-kits(?:\/|$)/.test(route)) return 'builder.launch-kit';
  if (/\/account(?:\/|$)/.test(route)) return 'builder.account';
  if (/\/backend(?:\/|$)/.test(route)) return 'builder.supabase';
  if (/\/native-|\/recipe-upgrade|\/(?:preview|start|stop|transport|phone-test|capture|artifacts|board-captures)(?:\/|$)/.test(route)) return 'builder.expo';
  if (/\/icons(?:\/|$)|\/media\/icon-/.test(route)) return 'builder.icons';
  if (/\/media(?:\/|$)/.test(route)) return 'builder.media';
  if (/\/design(?:\/|$)|\/inspector/.test(route)) return 'builder.design';
  if (/\/assistant\//.test(route)) return 'builder.assistant';
  return null;
}
