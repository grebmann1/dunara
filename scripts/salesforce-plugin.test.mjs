import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { Engine } from '../packages/core/src/engine.ts';
import { Projects } from '../packages/core/src/projects.ts';
import { snapshotSource } from '../packages/core/src/source.ts';
import { inspectPackage } from '../packages/plugin-runtime/src/packages.ts';
import { connection, compatibility, SDK } from '../plugins/salesforce/configuration.js';
import { createSalesforceClient } from '../plugins/salesforce/template/client.ts';

const id = 'salesforce.mobile-sdk';
const settings = { environment: 'development', label: 'Test sandbox', loginUrl: 'https://example--dev.sandbox.my.salesforce.com', clientId: 'public-consumer-key-fixture', redirectUri: 'fixture://salesforce/auth', object: 'Account', fields: ['Id', 'Name'] };
let root, engine, project;
describe('Salesforce plugin through the real host', () => {
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'salesforce-plugin-'));
    engine = new Engine(await Projects.open(path.join(root, 'apps'), path.join(root, 'home')), false);
    await engine.plugins.ready;
    project = await engine.projects.create({ name: 'Salesforce fixture', slug: 'salesforce-fixture' });
    await engine.projects.setBackendPlugin(project.id, id, true);
    await engine.plugins.change(id, 'enable');
  });
  afterEach(async () => { await engine?.close(); if (root) await rm(root, { recursive: true, force: true }); });
  it('ships as a valid independent API 1 plugin and reports the actual compatibility gap', async () => {
    const pkg = await inspectPackage(path.resolve('plugins/salesforce'));
    expect(pkg.package.builder).toMatchObject({ workspaceGroup: 'backend', workspacePanel: 'backend', capabilities: ['project.read', 'project.write'] });
    expect(Object.keys(pkg.files).length).toBeLessThan(200);
    const state = await engine.plugins.invoke(id, 'inspect', {}, project.id);
    expect(state).toMatchObject({ configuration: { environments: {} }, integrationAdded: false, compatibility: { state: 'incompatible', reactNative: '0.86.3', sdk: { version: '13.2.1' } } });
    await expect(engine.plugins.invoke(id, 'inspect', {}, null)).rejects.toThrow('Select');
  });
  it('reviews public org settings, preserves other environments and isolates projects', async () => {
    const install = await engine.plugins.invoke(id, 'install-in-app', {}, project.id);
    await engine.plugins.answerReview(install.reviewId, true);
    const proposed = await engine.plugins.invoke(id, 'configure', settings, project.id);
    await expect(engine.files.read(project.id, 'backend/salesforce.json')).rejects.toThrow();
    expect(engine.plugins.reviewsFor(id)[0].plan.files[0]).toMatchObject({ path: 'backend/salesforce.json', before: null });
    await engine.plugins.answerReview(proposed.reviewId, true);
    const next = await engine.plugins.invoke(id, 'configure', { ...settings, environment: 'production', label: 'Production', loginUrl: 'https://login.salesforce.com' }, project.id);
    await engine.plugins.answerReview(next.reviewId, true);
    expect(JSON.parse((await engine.files.read(project.id, 'backend/salesforce.json')).content).environments).toMatchObject({ development: settings, production: { label: 'Production' } });
    const other = await engine.projects.create({ name: 'Other fixture', slug: 'other-fixture' });
    const untouched = await snapshotSource(other.root);
    expect(untouched.files.some(file => /salesforce/i.test(file.path))).toBe(false);
    expect(await readFile(path.join(other.root, 'package.json'), 'utf8')).not.toContain('react-native-force');
    expect((await engine.plugins.invoke(id, 'inspect', {}, other.id)).configuration.environments).toEqual({});
    const integration = await engine.plugins.invoke(id, 'add-react-integration', {}, project.id);
    await engine.plugins.answerReview(integration.reviewId, true);
    expect((await engine.plugins.invoke(id, 'inspect', {}, project.id)).integrationAdded).toBe(true);
    await engine.plugins.change(id, 'disable');
    await expect(engine.plugins.invoke(id, 'inspect', {}, project.id)).rejects.toThrow();
    expect((await engine.files.read(project.id, 'backend/salesforce.json')).content).toContain('Test sandbox');
    await engine.plugins.change(id, 'enable');
    await engine.plugins.invoke(id, 'inspect', {}, other.id);
    expect((await snapshotSource(other.root)).revision).toBe(untouched.revision);
  });
  it('adds portable React source with reviewed overwrites and leaves manifests and Supabase intact', async () => {
    const manifest = await readFile(path.join(project.root, 'package.json'), 'utf8'), lock = await readFile(path.join(project.root, 'package-lock.json'), 'utf8');
    const supabase = (await engine.files.read(project.id, 'src/backend/client.ts')).content;
    const review = await engine.plugins.invoke(id, 'add-react-integration', {}, project.id);
    const plan = engine.plugins.reviewsFor(id)[0].plan;
    expect(plan.files).toHaveLength(4);
    expect(plan.nativeBuild).toContain('separately qualified');
    await engine.plugins.answerReview(review.reviewId, true);
    expect((await engine.files.read(project.id, 'src/salesforce/client.ts')).content).toContain('createSalesforceClient');
    expect((await engine.plugins.invoke(id, 'inspect', {}, project.id)).integrationAdded).toBe(true);
    const old = await engine.plugins.invoke(id, 'add-react-integration', {}, project.id);
    const source = await engine.files.read(project.id, 'src/salesforce/client.ts');
    await engine.files.write(project.id, [{ path: source.path, expectedRevision: source.revision, content: source.content + '\n// App edit\n' }]);
    await expect(engine.plugins.answerReview(old.reviewId, true)).rejects.toThrow('changed');
    expect(await readFile(path.join(project.root, 'package.json'), 'utf8')).toBe(manifest);
    expect(await readFile(path.join(project.root, 'package-lock.json'), 'utf8')).toBe(lock);
    expect((await engine.files.read(project.id, 'src/backend/client.ts')).content).toBe(supabase);
  });
  it('exposes reviewed app installation to agents without opting other apps in', async () => {
    const other = await engine.projects.create({ name: 'No Salesforce', slug: 'no-salesforce' });
    const untouched = await snapshotSource(other.root);
    const status = async app => (await engine.inspect(app)).backendPlugins.find(plugin => plugin.pluginId === id);
    expect(await status(project.id)).toMatchObject({ context: { installation: { state: 'not-installed', enabled: false } }, pendingReviews: [] });
    await expect(engine.plugins.invoke(id, 'configure', settings, project.id)).rejects.toThrow('Install in app');
    const dismissed = await engine.plugins.invoke(id, 'install-in-app', {}, project.id);
    expect(await status(project.id)).toMatchObject({ context: { installation: { state: 'not-installed' } }, pendingReviews: [{ id: dismissed.reviewId, action: 'install-in-app', state: 'awaiting-approval' }] });
    expect(await status(other.id)).toMatchObject({ context: { installation: { state: 'not-installed' } }, pendingReviews: [], operations: [] });
    await engine.plugins.answerReview(dismissed.reviewId, false);
    await expect(engine.files.read(project.id, 'backend/salesforce-installation.json')).rejects.toThrow();
    const approved = await engine.plugins.invoke(id, 'install-in-app', {}, project.id);
    await engine.plugins.answerReview(approved.reviewId, true);
    expect(await status(project.id)).toMatchObject({ context: { installation: { state: 'installed', enabled: true }, nativeBuild: { verified: false } }, pendingReviews: [], operations: [{ id: approved.reviewId, state: 'succeeded' }] });
    await engine.close();
    engine = new Engine(await Projects.open(path.join(root, 'apps'), path.join(root, 'home')), false);
    expect(await status(project.id)).toMatchObject({ context: { installation: { state: 'installed' } } });
    await rm(path.join(project.root, 'src/salesforce/client.ts'));
    expect(await status(project.id)).toMatchObject({ context: { installation: { state: 'needs-repair', missingFiles: ['src/salesforce/client.ts'] } } });
    await expect(engine.plugins.invoke(id, 'configure', settings, project.id)).rejects.toThrow('Install in app');
    expect((await snapshotSource(other.root)).revision).toBe(untouched.revision);
  });
  it('rejects secrets, SOQL expressions, unsafe endpoints and malformed saved settings', async () => {
    for (const patch of [{ clientSecret: 'private' }, { loginUrl: 'http://localhost:9999' }, { loginUrl: 'https://example.my.salesforce.com.evil.example' }, { loginUrl: 'https://user:pass@login.salesforce.com' }, { redirectUri: 'javascript://alert' }, { object: 'Account WHERE Name != null' }, { fields: ['Id', 'Name FROM User'] }]) {
      await expect(engine.plugins.invoke(id, 'configure', { ...settings, ...patch }, project.id)).rejects.toThrow();
    }
    await engine.files.write(project.id, [{ path: 'backend/salesforce.json', expectedRevision: null, content: '{"version":999}' }]);
    await expect(engine.plugins.invoke(id, 'configure', settings, project.id)).rejects.toThrow('Unsupported');
  });
});

describe('Mobile SDK callback adapter', () => {
  const account = { userId: 'user-1', orgId: 'org-1', accessToken: 'private-token-canary', refreshToken: 'private-refresh-canary' };
  function native() {
    return { oauth: { getAuthCredentials: vi.fn(yes => yes(account)), authenticate: vi.fn(yes => yes(account)), logout: vi.fn(yes => yes(null)) }, net: { query: vi.fn((_query, yes) => yes({ records: [{ Id: 'record-1', Name: 'Account fixture' }] })) } };
  }
  it('uses the stable callback API, exposes only identity and creates bounded validated SOQL', async () => {
    const sdk = native(), client = createSalesforceClient(sdk, settings);
    await client.signIn(); await client.loadRecords();
    expect(client.getSnapshot()).toMatchObject({ status: 'ready', identity: { userId: 'user-1', orgId: 'org-1' }, records: [{ Id: 'record-1' }] });
    expect(JSON.stringify(client.getSnapshot())).not.toContain('private-');
    expect(sdk.net.query.mock.calls[0][0]).toBe('SELECT Id, Name FROM Account LIMIT 100');
    await client.signOut(); expect(client.getSnapshot()).toMatchObject({ status: 'signed-out', records: [], identity: null });
    expect(() => createSalesforceClient(sdk, { object: 'Account LIMIT 1', fields: ['Id'] })).toThrow();
  });
  it('coalesces login, uses authenticate when needed, and sanitizes SDK failures', async () => {
    const sdk = native(); let complete;
    sdk.oauth.getAuthCredentials.mockImplementation((_yes, no) => no({ accessToken: 'private-canary' }));
    sdk.oauth.authenticate.mockImplementation(yes => { complete = yes; });
    const client = createSalesforceClient(sdk, settings), first = client.signIn(), second = client.signIn();
    await Promise.resolve();
    expect(first).toBe(second); expect(sdk.oauth.authenticate).toHaveBeenCalledTimes(1);
    complete(account); await first;
    sdk.net.query.mockImplementation((_query, _yes, no) => no({ message: 'private-canary' }));
    await expect(client.loadRecords()).rejects.toThrow('object and field access');
    expect(JSON.stringify(client.getSnapshot())).not.toContain('private-canary');
  });
  it('discards a late read after logout and clears cached records before native logout completes', async () => {
    const sdk = native(), client = createSalesforceClient(sdk, settings);
    await client.signIn(); await client.loadRecords();
    let readDone, logoutDone;
    sdk.net.query.mockImplementation((_query, yes) => { readDone = yes; });
    sdk.oauth.logout.mockImplementation(yes => { logoutDone = yes; });
    const reading = client.loadRecords(), logout = client.signOut();
    expect(client.getSnapshot()).toMatchObject({ status: 'signing-out', identity: null, records: [] });
    readDone({ records: [{ Id: 'late-sensitive-record' }] }); await reading;
    expect(client.getSnapshot().records).toEqual([]);
    logoutDone(null); await logout; expect(client.getSnapshot().status).toBe('signed-out');
  });
  it('never fakes native authentication in a web preview', async () => {
    const client = createSalesforceClient(null, settings);
    expect(client.getSnapshot().status).toBe('native-setup-required');
    await expect(client.signIn()).rejects.toThrow('native Mobile SDK build');
    await expect(client.loadRecords()).rejects.toThrow('native Mobile SDK build');
  });
  it('compiles the generated client and React provider with strict TypeScript', () => {
    const program = ts.createProgram(['plugins/salesforce/template/client.ts', 'plugins/salesforce/template/SalesforceProvider.tsx'], { noEmit: true, strict: true, skipLibCheck: true, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, target: ts.ScriptTarget.ES2023, jsx: ts.JsxEmit.ReactJSX });
    const diagnostics = ts.getPreEmitDiagnostics(program);
    expect(diagnostics.map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))).toEqual([]);
  });
});

it('normalizes public configuration without creating an unreadable field selection', () => {
  expect(connection({ ...settings, fields: ['Name', 'Name'] }).fields).toEqual(['Id', 'Name']);
  expect(() => connection({ ...settings, fields: Array.from({ length: 20 }, (_, i) => `Field${i}`) })).toThrow('including Id');
  expect(compatibility({ dependencies: { react: SDK.react, 'react-native': SDK.reactNative } })).toMatchObject({ compatible: true, state: 'native-setup-required' });
});
