import { readFile } from 'node:fs/promises';
import { configuration, configurationPath, connection, connectionSchema, compatibility } from './configuration.js';

const empty = { type: 'object', properties: {}, additionalProperties: false };
const templates = { 'src/salesforce/client.ts': 'client.ts', 'src/salesforce/SalesforceProvider.tsx': 'SalesforceProvider.tsx', 'salesforce/SETUP.md': 'SETUP.md' };
const json = value => JSON.stringify(value, null, 2) + '\n';
const parse = file => { try { return JSON.parse(file.content); } catch { throw Error(`Fix the JSON syntax in ${file.path} before preparing Salesforce changes.`); } };

async function source(context) {
  const tree = await context.files.list();
  if (tree.truncated) throw Error('The app source list is incomplete. Reduce its size before preparing Salesforce changes.');
  const read = async path => tree.files.includes(path) ? context.files.read(path) : null;
  const saved = await read(configurationPath), manifest = await read('package.json');
  if (!manifest) throw Error('This app needs a package.json before adding Salesforce.');
  return { tree, read, config: saved ? configuration(parse(saved)) : { version: 1, environments: {} }, compatibility: compatibility(parse(manifest)) };
}
async function plannedFiles(context, contents) {
  const { read } = await source(context);
  return Promise.all(Object.entries(contents).map(async ([path, content]) => {
    const before = await read(path);
    return { path, content, expectedRevision: before?.revision ?? null, before: before?.content ?? null };
  }));
}
export default async function salesforce(api) {
  const contents = Object.fromEntries(await Promise.all(Object.entries(templates).map(async ([path, file]) => [path, await readFile(new URL(`template/${file}`, import.meta.url), 'utf8')])));
  api.actions.register({ id: 'inspect', title: 'Inspect Salesforce setup', description: 'Read this app’s public org settings and Mobile SDK compatibility. Does not connect to Salesforce.', effect: 'read', scope: 'project', input: empty, output: { type: 'object' },
    async run(_input, context) {
      const current = await source(context);
      return { configuration: current.config, compatibility: current.compatibility, integrationAdded: Object.keys(templates).every(path => current.tree.files.includes(path)) };
    },
  });
  const apply = async (_input, context) => {
    if (!context.review?.files) throw Error('Prepare and approve a Salesforce review first.');
    context.signal.throwIfAborted();
    await context.files.write(context.review.files.map(({ path, content, expectedRevision }) => ({ path, content, expectedRevision })));
    return { files: context.review.files.map(file => file.path) };
  };
  api.actions.register({ id: 'configure', title: 'Save Salesforce org settings', description: 'Save public OAuth and object settings for one environment in this app. No sign-in, credentials or org mutations.', effect: 'write', scope: 'project', input: connectionSchema, output: { type: 'object' },
    async plan(input, context) {
      const value = connection(input), { config } = await source(context);
      const next = { version: 1, environments: { ...config.environments, [value.environment]: value } };
      return { summary: `Save ${value.label} for ${value.environment}. Native sign-in happens in the built app.`, files: await plannedFiles(context, { [configurationPath]: json(next) }) };
    }, run: apply,
  });
  api.actions.register({ id: 'add-react-integration', title: 'Add Salesforce React integration', description: 'Add a typed Mobile SDK adapter, React provider/hooks and native setup guide. Does not install native dependencies or change the app’s entry point.', effect: 'write', scope: 'project', input: empty, output: { type: 'object' },
    async plan(_input, context) {
      const current = await source(context);
      return { summary: 'Add React source for Mobile SDK 13.2.1. Pass the configured native SDK into createSalesforceClient; web preview stays available.', nativeBuild: current.compatibility.message, files: await plannedFiles(context, contents) };
    }, run: apply,
  });
}
