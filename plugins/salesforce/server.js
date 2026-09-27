import { readFile } from 'node:fs/promises';
import { configuration, configurationPath, connection, connectionSchema, compatibility } from './configuration.js';

const empty = { type: 'object', properties: {}, additionalProperties: false };
const installationPath = 'backend/salesforce-installation.json';
const installation = { version: 1, provider: 'salesforce.mobile-sdk', integrationVersion: '0.1.0', enabled: true };
const templates = { 'src/salesforce/client.ts': 'client.ts', 'src/salesforce/SalesforceProvider.tsx': 'SalesforceProvider.tsx', 'salesforce/SETUP.md': 'SETUP.md' };
const json = value => JSON.stringify(value, null, 2) + '\n';
const parse = file => { try { return JSON.parse(file.content); } catch { throw Error(`Fix the JSON syntax in ${file.path} before preparing Salesforce changes.`); } };

async function source(context) {
  const tree = await context.files.list();
  if (tree.truncated) throw Error('The app source list is incomplete. Reduce its size before preparing Salesforce changes.');
  const read = async path => tree.files.includes(path) ? context.files.read(path) : null;
  const saved = await read(configurationPath), manifest = await read('package.json');
  if (!manifest) throw Error('This app needs a package.json before adding Salesforce.');
  const marker = await read(installationPath), record = marker ? parse(marker) : null;
  if (marker && (!record || record.version !== 1 || record.provider !== installation.provider || record.enabled !== true || record.integrationVersion !== installation.integrationVersion)) throw Error('Unsupported Salesforce installation record. Review this app’s installation file.');
  const missingFiles = Object.keys(templates).filter(path => !tree.files.includes(path));
  const appInstallation = { state: !record ? 'not-installed' : missingFiles.length ? 'needs-repair' : 'installed', enabled: !!record, integrationVersion: record?.integrationVersion ?? null, missingFiles };
  return { tree, read, installation: appInstallation, config: saved ? configuration(parse(saved)) : { version: 1, environments: {} }, compatibility: compatibility(parse(manifest)) };
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
      return { installation: current.installation, configuration: current.config, compatibility: current.compatibility, integrationAdded: Object.keys(templates).every(path => current.tree.files.includes(path)) };
    },
  });
  api.actions.register({ id: 'project-context', title: 'Salesforce app installation status', description: 'Public per-app installation state for agents. Installing native dependencies or configuring an org is separate from enabling this integration.', effect: 'read', scope: 'project', input: empty, output: { type: 'object' },
    async run(_input, context) {
      const current = await source(context);
      return { installation: current.installation, configuredEnvironments: Object.keys(current.config.environments), nativeBuild: { state: current.compatibility.state, sdkVersion: current.compatibility.sdk.version, verified: false }, nextStep: current.installation.state === 'not-installed' ? 'The user must choose Install in app in Backend → Salesforce and approve its review. Do not add Salesforce to this app automatically.' : current.installation.state === 'needs-repair' ? 'Installation files are missing. Ask the user to review a repair before using the integration.' : 'Integration source is installed for this app. Configure the selected org and complete native setup; installation is not proof of a live connection.' };
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
      const value = connection(input), { config, installation: installed } = await source(context);
      if (installed.state !== 'installed') throw Error('Choose Install in app in Backend → Salesforce and apply its review before saving org settings.');
      const next = { version: 1, environments: { ...config.environments, [value.environment]: value } };
      return { summary: `Save ${value.label} for ${value.environment}. Native sign-in happens in the built app.`, files: await plannedFiles(context, { [configurationPath]: json(next) }) };
    }, run: apply,
  });
  const install = { title: 'Install Salesforce in app', description: 'Opt this app into Salesforce with a reviewed installation record, typed adapter, React hooks and setup guide. Native SDK dependencies and device setup are separate.', effect: 'write', scope: 'project', input: empty, output: { type: 'object' },
    async plan(_input, context) {
      const current = await source(context);
      return { summary: 'Enable Salesforce integration for this app. Agents will see it as installed only after this review is applied. Native SDK installation remains a separate step.', nativeBuild: current.compatibility.message, files: await plannedFiles(context, { ...contents, [installationPath]: json(installation) }) };
    }, run: apply,
  };
  api.actions.register({ id: 'install-in-app', ...install });
  // Preserve the first plugin archive's action name; both paths require the same human review.
  api.actions.register({ id: 'add-react-integration', ...install });
}
