import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { atomicWrite, exists, noSymlinks, readText, SerialQueue } from '../../core/src/storage.js';
import type { ActionContext, Json, PluginAction, PluginFactory, PluginServer, PluginSetting } from '../../plugin-sdk/src/server.js';
import type { PluginRecipe } from '../../plugin-sdk/src/recipes.js';
import { localId, pluginId, storeSchema, version, type InstalledPlugin, type PluginStore, type PluginView } from './contracts.js';
import { inspectPackage, materializePackage, type PackageContents } from './packages.js';

export type RuntimeHost = {
  files(projectId: string): ActionContext['files'];
  binding(projectId: string | null): Promise<unknown>;
  getCredential(plugin: string, name: string): Promise<string | undefined>;
  setCredential(plugin: string, name: string, value: string | null): Promise<void>;
  beforeChange?(plugin: string): Promise<void>;
  recordRecipe?(projectId: string, record: { pluginId: string; recipeId: string; version: string; digest: string; appliedAt: string }): Promise<void>;
};
export type BuiltinPlugin = { contents: PackageContents; activate?: PluginFactory; autoInstall?: boolean; defaultEnabled?: boolean };
type Live = { generation: string; actions: Map<string, PluginAction>; recipes: Map<string, PluginRecipe>; settings: PluginSetting[]; disposers: Array<() => void | Promise<void>>; services: Map<string, unknown>; running: Set<AbortController>; accepting: boolean };
type Review = { id: string; pluginId: string; action: string; projectId: string | null; generation: string; input: Json; fingerprint: string; plan: Json; expiresAt: string; approved: boolean };
const operationSchema = z.object({ id: z.uuid(), pluginId, action: z.string().max(64), projectId: z.uuid().nullable(), digest: z.string(), state: z.enum(['running', 'succeeded', 'unknown']), updatedAt: z.string(), message: z.string().max(500) });
type Operation = z.infer<typeof operationSchema>;
const valueSchema = z.json();
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value, (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item) ?? '').digest('hex');
function bounded<T>(value: T, max = 1_000_000): T { if (Buffer.byteLength(JSON.stringify(value) ?? '') > max) throw Error('Plugin value exceeds its size limit'); return value; }
function json(value: unknown): Json { return bounded(valueSchema.parse(value)); }
function schema(value: unknown) { return z.fromJSONSchema(z.record(z.string(), z.unknown()).parse(bounded(value, 32_000))); }
export class PluginRuntime extends EventEmitter {
  private store: PluginStore = { version: 1, installed: [], uninstalled: [] };
  private readonly queue = new SerialQueue();
  private readonly dataQueue = new SerialQueue();
  private readonly live = new Map<string, Live>();
  private readonly errors = new Map<string, string>();
  private readonly reviews = new Map<string, Review>();
  private readonly builtins = new Map<string, BuiltinPlugin>();
  private readonly operations = new Map<string, Operation[]>();
  private readonly operationQueue = new SerialQueue();
  private readonly actionScope = new AsyncLocalStorage<{ projectId: string | null; signal: AbortSignal }>();
  private closed = false;
  readonly root: string;
  readonly ready: Promise<void>;
  constructor(readonly home: string, private host: RuntimeHost, bundled: BuiltinPlugin[] | Promise<BuiltinPlugin[]>, readonly recovery = process.env.BUILDER_DISABLE_USER_PLUGINS === '1') {
    super(); this.root = path.join(home, 'plugins');
    this.ready = this.initialize(bundled);
    // Consumers await ready; avoid an unhandled rejection while the app is still starting.
    void this.ready.catch(() => {});
  }
  private async initialize(bundled: BuiltinPlugin[] | Promise<BuiltinPlugin[]>) {
    for (const builtin of await bundled) { const id = builtin.contents.package.builder.id; if (this.builtins.has(id)) throw Error('Duplicate bundled plugin identity'); this.builtins.set(id, builtin); }
    await noSymlinks(this.home, this.root); await mkdir(this.root, { recursive: true, mode: 0o700 });
    for (const directory of ['packages', 'data']) { await noSymlinks(this.root, path.join(this.root, directory)); await mkdir(path.join(this.root, directory), { recursive: true, mode: 0o700 }); }
    const file = path.join(this.root, 'installed.json'); await noSymlinks(this.root, file);
    if (await exists(file)) this.store = storeSchema.parse(JSON.parse(await readText(file, 512_000)));
    if (new Set(this.store.installed.map(row => row.package.builder.id)).size !== this.store.installed.length) throw Error('Duplicate installed plugin IDs');
    for (const [id, builtin] of this.builtins) {
      if (builtin.autoInstall === false) continue;
      if (this.store.uninstalled.includes(id)) continue;
      const current = this.row(id, false);
      if (current && current.source !== 'builtin') continue;
      await materializePackage(path.join(this.root, 'packages'), builtin.contents);
      if (!current) this.store.installed.push({ package: builtin.contents.package, digest: builtin.contents.digest, source: 'builtin', enabled: builtin.defaultEnabled !== false, installedAt: new Date().toISOString() });
      else if (current.digest !== builtin.contents.digest) { current.previous = { package: current.package, digest: current.digest, source: 'builtin', dataRevision: fingerprint(await this.allData(id)) }; current.package = builtin.contents.package; current.digest = builtin.contents.digest; }
    }
    await this.save(); await this.activateAll(); this.emit('change');
  }
  private row(id: string, required = true) { pluginId.parse(id); const row = this.store.installed.find(row => row.package.builder.id === id); if (!row && required) throw Error('Plugin is not installed'); return row; }
  private async save() { await noSymlinks(this.root, path.join(this.root, 'installed.json')); await atomicWrite(path.join(this.root, 'installed.json'), JSON.stringify(storeSchema.parse(this.store), null, 2)); }
  private directory(row: InstalledPlugin) { return path.join(this.root, 'packages', row.digest); }
  isEnabled(id: string) { return this.live.has(id) && this.live.get(id)!.accepting; }
  assertEnabled(id: string) { if (!this.isEnabled(id)) throw Error('This feature is unavailable. Enable its plugin in Plugins.'); }
  assertProjectAccess(id: string) { const scope = this.actionScope.getStore(); if (scope?.projectId !== id) throw Error('Provider access belongs to a different project'); scope.signal.throwIfAborted(); }
  snapshot(): PluginView[] {
    return this.store.installed.map(row => {
      const { builder } = row.package, live = this.live.get(builder.id), error = this.errors.get(builder.id);
      return { id: builder.id, name: builder.name, description: builder.description, version: row.package.version, digest: row.digest, source: row.source, enabled: row.enabled, status: !row.enabled ? 'disabled' : this.recovery && row.source !== 'builtin' ? 'recovery' : error ? 'failed' : live ? 'active' : 'disabled', ...(error ? { error } : {}), capabilities: builder.capabilities, requires: builder.requires,
        actions: [...live?.actions.values() ?? []].map(({ id, title, description, effect, scope, input }) => ({ id, title, description, effect, scope, input })),
        recipes: [...live?.recipes.values() ?? []].map(({ id, title, version, description }) => ({ id, title, version, description })), settings: live?.settings ?? [], guides: builder.guides, canRollback: !!row.previous,
        ...(live && builder.app ? { appUrl: `/plugin-assets/${builder.id}/${row.digest}/${live.generation}/${builder.app}` } : {}),
      };
    });
  }
  async inspect(source: string) { const pkg = await inspectPackage(source); return { package: pkg.package, digest: pkg.digest, files: Object.keys(pkg.files), trust: 'Full-trust local code. Installation grants access to this user’s machine.' }; }
  async install(source: string, digest: string, trusted: boolean, development = false) {
    await this.ready;
    return this.queue.run(async () => {
      if (this.closed) throw Error('Plugin runtime is closed');
      if (!trusted) throw Error('Explicit trust confirmation is required to install executable plugins');
      const pkg = await inspectPackage(source); if (pkg.digest !== digest) throw Error('Package changed since review. Inspect it again.');
      const id = pkg.package.builder.id; if (id.startsWith('builder.')) throw Error('The builder publisher namespace is reserved');
      const current = this.row(id, false); if (!current && this.store.installed.length >= 100) throw Error('Plugin installation limit reached');
      if (this.reviewsFor(id).length || this.live.get(id)?.running.size) throw Error('Finish or dismiss pending plugin work before updating');
      await materializePackage(path.join(this.root, 'packages'), pkg);
      const next: InstalledPlugin = { package: pkg.package, digest: pkg.digest, source: development ? 'development' : 'local', sourcePath: path.resolve(source), enabled: true, installedAt: new Date().toISOString(), ...(current ? { previous: { package: current.package, digest: current.digest, source: current.source, sourcePath: current.sourcePath, dataRevision: fingerprint(await this.allData(id)) } } : {}) };
      this.assertNoActiveDependents(id);
      await this.host.beforeChange?.(id);
      await this.dispose(id); this.store.installed = [...this.store.installed.filter(row => row.package.builder.id !== id), next]; this.store.uninstalled = this.store.uninstalled.filter(value => value !== id);
      await this.save(); await this.activateAll(); this.emit('change'); return this.snapshot();
    });
  }
  private assertNoActiveDependents(id: string) { const dependents = this.store.installed.filter(row => row.enabled && Object.hasOwn(row.package.builder.requires, id)); if (dependents.length) throw Error(`Disable dependent plugins first: ${dependents.map(row => row.package.builder.name).join(', ')}`); }
  async change(id: string, operation: 'enable' | 'disable' | 'uninstall' | 'reload' | 'rollback') {
    await this.ready;
    return this.queue.run(async () => {
      if (this.closed) throw Error('Plugin runtime is closed');
      const row = this.row(id)!;
      await this.host.beforeChange?.(id);
      if (operation !== 'enable') this.assertNoActiveDependents(id);
      if (this.live.get(id)?.running.size) throw Error('Plugin has active work. Cancel it and wait for completion before changing the plugin.');
      if (operation === 'reload' && row.source === 'development') {
        const pkg = await inspectPackage(row.sourcePath!);
        if (pkg.digest !== row.digest) {
          if (pkg.package.builder.id !== id || fingerprint(pkg.package.builder.capabilities) !== fingerprint(row.package.builder.capabilities) || fingerprint(pkg.package.builder.requires) !== fingerprint(row.package.builder.requires)) throw Error('Plugin identity or capabilities changed. Inspect and install the new package explicitly.');
          await materializePackage(path.join(this.root, 'packages'), pkg);
          row.previous = { package: row.package, digest: row.digest, source: row.source, sourcePath: row.sourcePath, dataRevision: fingerprint(await this.allData(id)) };
          row.package = pkg.package; row.digest = pkg.digest;
        }
      }
      if (operation === 'rollback' && (!row.previous?.dataRevision || row.previous.dataRevision !== fingerprint(await this.allData(id)))) throw Error('Plugin data changed since this update. Automatic code rollback is unavailable; restore a compatible package or recover the data first.');
      await this.dispose(id);
      if (operation === 'uninstall') { this.store.installed = this.store.installed.filter(row => row.package.builder.id !== id); this.store.uninstalled = [...new Set([...this.store.uninstalled, id])]; }
      else if (operation === 'rollback') {
        if (!row.previous) throw Error('No previous plugin package is available');
        const previous = row.previous; row.previous = { package: row.package, digest: row.digest, source: row.source, sourcePath: row.sourcePath, dataRevision: fingerprint(await this.allData(id)) }; Object.assign(row, { package: previous.package, digest: previous.digest, source: previous.source, sourcePath: previous.sourcePath });
      } else row.enabled = operation !== 'disable';
      await this.save(); await this.activateAll(); this.emit('change'); return this.snapshot();
    });
  }
  async restoreDefaults() {
    await this.ready;
    return this.queue.run(async () => {
      for (const [id, builtin] of this.builtins) if (builtin.autoInstall !== false && !this.row(id, false)) { await materializePackage(path.join(this.root, 'packages'), builtin.contents); this.store.installed.push({ package: builtin.contents.package, digest: builtin.contents.digest, source: 'builtin', enabled: builtin.defaultEnabled !== false, installedAt: new Date().toISOString() }); }
      this.store.uninstalled = this.store.uninstalled.filter(id => !this.builtins.has(id) || this.builtins.get(id)!.autoInstall === false); await this.save(); await this.activateAll(); this.emit('change'); return this.snapshot();
    });
  }
  private async activateAll() {
    const visiting = new Set<string>();
    const activate = async (id: string): Promise<void> => {
      if (this.live.has(id)) return;
      const row = this.row(id)!; if (!row.enabled || (this.recovery && row.source !== 'builtin')) return;
      if (visiting.has(id)) throw Error('Plugin dependency cycle');
      visiting.add(id);
      try {
        for (const [dependency, required] of Object.entries(row.package.builder.requires)) {
          const provider = this.row(dependency)!;
          if (!provider.enabled || provider.package.version !== required) throw Error('A required plugin is disabled or has an incompatible version');
          await activate(dependency); if (!this.live.has(dependency)) throw Error('A required plugin failed to activate');
        }
        await this.activate(row); this.errors.delete(id);
      } catch (error) { this.errors.set(id, error instanceof z.ZodError ? 'Invalid plugin contribution' : 'Plugin could not start. Check its package, API version and dependencies, then reload.'); }
      finally { visiting.delete(id); }
    };
    for (const row of this.store.installed) await activate(row.package.builder.id);
  }
  private async activate(row: InstalledPlugin) {
    const id = row.package.builder.id, root = this.directory(row);
    await noSymlinks(this.root, root);
    if ((await inspectPackage(root)).digest !== row.digest) throw Error('Installed plugin digest changed');
    const live: Live = { generation: randomUUID(), actions: new Map(), recipes: new Map(), settings: [], disposers: [], services: new Map(), running: new Set(), accepting: true };
    const previousData = await this.allData(id);
    if (!this.operations.has(id)) {
      const operations = z.array(operationSchema).max(100).parse(previousData['host-operations'] ?? []).map(operation => operation.state === 'running' ? { ...operation, state: 'unknown' as const, message: 'Dunara stopped before completion was recorded. Inspect the outcome before starting another operation.' } : operation);
      this.operations.set(id, operations); if (operations.length) await this.writeData(id, 'host-operations', operations);
    }
    let registering = true;
    const register = () => { if (!registering) throw Error('Register contributions only during activation'); };
    const capabilities = new Set(row.package.builder.capabilities);
    const api: PluginServer = {
      id,
      actions: { register: action => {
        register(); localId.parse(action.id); z.enum(['read', 'write']).parse(action.effect); z.enum(['project', 'global']).parse(action.scope);
        z.string().min(1).max(100).parse(action.title); z.string().max(2000).parse(action.description);
        if (live.actions.has(action.id) || live.actions.size >= 40 || typeof action.run !== 'function') throw Error('Invalid or duplicate plugin action');
        schema(action.input); schema(action.output); live.actions.set(action.id, action);
      } },
      recipes: { register: recipe => {
        register(); localId.parse(recipe.id); version.parse(recipe.version);
        z.object({ title: z.string().min(1).max(100), description: z.string().max(2000), files: z.array(z.object({ path: z.string().min(1).max(240), content: z.string().max(256000) })).min(1).max(20) }).parse(recipe);
        if (recipe.files.some(file => /(^|\/)(package\.json|app\.json|eas\.json|.*lock.*)$/.test(file.path))) throw Error('Dependency and native configuration changes require their existing reviewed workflows');
        if (!capabilities.has('project.write') || live.recipes.has(recipe.id) || live.recipes.size >= 20) throw Error('Recipe requires project.write and a unique ID');
        bounded(recipe); live.recipes.set(recipe.id, structuredClone(recipe));
      } },
      settings: { define: settings => { register(); for (const setting of settings) { localId.parse(setting.id); z.string().min(1).max(100).parse(setting.label); z.enum(['string', 'boolean', 'number']).parse(setting.type); if (live.settings.some(s => s.id === setting.id) || live.settings.length >= 30) throw Error('Duplicate setting or limit exceeded'); if (setting.default !== undefined && typeof setting.default !== setting.type) throw Error('Invalid setting default'); live.settings.push(structuredClone(setting)); } } },
      storage: { get: key => { if (key.startsWith('host-')) throw Error('Reserved storage key'); return this.data(id, key); }, set: (key, value) => { if (!capabilities.has('storage') || key.startsWith('host-')) throw Error('Storage capability and a non-reserved key are required'); return this.writeData(id, key, value); }, delete: key => { if (!capabilities.has('storage') || key.startsWith('host-')) throw Error('Storage capability and a non-reserved key are required'); return this.writeData(id, key, undefined); } },
      credentials: { get: name => { localId.parse(name); if (!capabilities.has('credentials')) throw Error('Credential capability required'); return this.host.getCredential(id, name); } },
      services: { provide: (name, serviceVersion, service) => { register(); localId.parse(name); version.parse(serviceVersion); const key = `${name}:${serviceVersion}`; if (live.services.has(key)) throw Error('Duplicate service'); live.services.set(key, service); }, use: <T>(provider: string, name: string, serviceVersion: string): T => {
        if (!Object.hasOwn(row.package.builder.requires, provider)) throw Error('Declare the required provider before using its service');
        const current = () => { const service = this.live.get(provider)?.services.get(`${name}:${serviceVersion}`); if (!service || !this.isEnabled(provider)) throw Error('Service is unavailable'); return Object(service) as Record<PropertyKey, unknown>; };
        current(); return new Proxy({}, { get: (_target, key) => typeof current()[key] === 'function' ? (...args: unknown[]) => { const service = current(); return (service[key] as (...args: unknown[]) => unknown).apply(service, args); } : current()[key] }) as T;
      } },
      onDispose: callback => { register(); if (live.disposers.length >= 100) throw Error('Disposer limit exceeded'); live.disposers.push(callback); },
    };
    try {
      const builtin = row.source === 'builtin' ? this.builtins.get(id) : undefined;
      let factory = builtin?.activate;
      if (!factory && row.package.builder.server) factory = (await import(`${pathToFileURL(path.join(root, row.package.builder.server)).href}?generation=${live.generation}`)).default as PluginFactory;
      if (factory) { if (typeof factory !== 'function') throw Error('Server must export a plugin factory'); await factory(api); }
      registering = false; this.live.set(id, live);
    } catch (error) { registering = false; for (const dispose of live.disposers.reverse()) { try { await dispose(); } catch { /* Failed activation must release every registered resource. */ } } await this.dataQueue.run(async () => atomicWrite(this.dataFile(id), JSON.stringify(previousData))); throw error; }
  }
  private async dispose(id: string) {
    const live = this.live.get(id); if (!live) return;
    live.accepting = false; for (const controller of live.running) controller.abort();
    for (const review of this.reviewsFor(id)) this.reviews.delete(review.id);
    this.live.delete(id);
    for (const dispose of live.disposers.reverse()) { try { await dispose(); } catch { this.errors.set(id, 'Plugin cleanup failed; restart in recovery mode if needed.'); } }
  }
  private dataFile(id: string) { pluginId.parse(id); return path.join(this.root, 'data', `${id}.json`); }
  private async allData(id: string): Promise<Record<string, Json>> { const file = this.dataFile(id); await noSymlinks(this.root, file); return await exists(file) ? z.record(z.string(), valueSchema).parse(JSON.parse(await readText(file, 1_000_000))) : {}; }
  async data(id: string, key: string) { localId.parse(key); return (await this.allData(id))[key]; }
  async writeData(id: string, key: string, value: Json | undefined) { localId.parse(key); return this.dataQueue.run(async () => { const data = await this.allData(id); if (value === undefined) delete data[key]; else data[key] = json(value); if (Object.keys(data).length > 200) throw Error('Plugin storage key limit reached'); await atomicWrite(this.dataFile(id), JSON.stringify(bounded(data))); }); }
  private settingKey(key: string) { return `host-setting-${fingerprint(key).slice(0, 32)}`; }
  async settings(id: string) { await this.ready; this.assertEnabled(id); const result: Record<string, Json> = {}; for (const setting of this.live.get(id)!.settings) { const value = await this.data(id, this.settingKey(setting.id)) ?? setting.default; if (value !== undefined) result[setting.id] = value; } return result; }
  async setSetting(id: string, key: string, value: Json) { await this.ready; this.assertEnabled(id); const setting = this.live.get(id)!.settings.find(s => s.id === key); if (!setting || typeof value !== setting.type) throw Error('Invalid plugin setting'); await this.writeData(id, this.settingKey(key), value); this.emit('change'); }
  async setCredential(id: string, name: string, value: string | null) { await this.ready; const row = this.row(id)!; localId.parse(name); if (!row.package.builder.capabilities.includes('credentials')) throw Error('Plugin does not declare credential access'); if (value !== null) z.string().min(1).max(8192).parse(value); await this.host.setCredential(id, name, value); this.invalidateReviews(); }
  private context(id: string, projectId: string | null, signal: AbortSignal, writable: boolean, review?: Json, operationId?: string): ActionContext {
    const row = this.row(id)!;
    const check = (write = false) => { signal.throwIfAborted(); this.assertEnabled(id); if (!projectId || !row.package.builder.capabilities.includes(write ? 'project.write' : 'project.read') || (write && !writable)) throw Error('Action does not have this project capability'); return this.host.files(projectId); };
    return { projectId, signal, review, operationId, progress: async message => { signal.throwIfAborted(); if (!operationId) throw Error('Progress requires an approved operation'); const operation = this.operations.get(id)?.find(value => value.id === operationId); if (!operation) throw Error('Operation is unavailable'); await this.recordOperation({ ...operation, message: z.string().max(500).parse(message), updatedAt: new Date().toISOString() }); }, files: { list: () => check().list(), read: file => check().read(file), write: changes => check(true).write(changes) } };
  }
  private action(id: string, name: string) {
    this.assertEnabled(id); const live = this.live.get(id)!;
    if (name.startsWith('recipe:')) {
      const recipe = live.recipes.get(name.slice(7)); if (!recipe) throw Error('Recipe is unavailable');
      const plan = async (_input: Json, ctx: ActionContext) => {
        const tree = await ctx.files.list();
        return { recipe: { id: recipe.id, version: recipe.version }, files: await Promise.all(recipe.files.map(async file => { const previous = tree.files.includes(file.path) ? await ctx.files.read(file.path) : null; return { ...file, expectedRevision: previous?.revision ?? null, before: previous?.content ?? null }; })) };
      };
      return { live, action: { id: name, title: recipe.title, description: recipe.description, effect: 'write', scope: 'project', input: { type: 'object', properties: {}, additionalProperties: false }, output: {}, plan, run: async (_input, ctx) => { const reviewed = z.object({ files: z.array(z.object({ path: z.string(), content: z.string(), expectedRevision: z.string().nullable() })) }).parse(ctx.review); const applied = await ctx.files.write(reviewed.files); await this.host.recordRecipe?.(ctx.projectId!, { pluginId: id, recipeId: recipe.id, version: recipe.version, digest: this.row(id)!.digest, appliedAt: new Date().toISOString() }); await this.writeData(id, `recipe-${fingerprint(`${ctx.projectId}:${recipe.id}`).slice(0,32)}`, { projectId: ctx.projectId, id: recipe.id, version: recipe.version, digest: this.row(id)!.digest, applied: json(applied) }); return json(applied); } } satisfies PluginAction };
    }
    const action = live.actions.get(name); if (!action) throw Error('Plugin action is unavailable'); return { live, action };
  }
  async invoke(id: string, name: string, supplied: unknown, projectId: string | null, signal = new AbortController().signal): Promise<Json> {
    await this.ready; signal.throwIfAborted();
    const { live, action } = this.action(id, name); if (action.scope === 'project' && !projectId) throw Error('Select a project first'); if (action.scope === 'global' && projectId) projectId = null;
    const properties = action.input.properties;
    if (action.scope === 'project' && properties && typeof properties === 'object' && Object.hasOwn(properties, 'projectId')) {
      const object = z.record(z.string(), z.unknown()).parse(supplied);
      if (object.projectId !== undefined && object.projectId !== projectId) throw Error('Action input belongs to a different project');
      supplied = { ...object, projectId };
    }
    const input = json(schema(action.input).parse(supplied)); await this.host.binding(projectId);
    if (this.live.get(id) !== live) throw Error('Plugin changed before dispatch. Discover its actions again.');
    if (action.effect === 'write') {
      for (const [key, review] of this.reviews) if (Date.parse(review.expiresAt) <= Date.now()) this.reviews.delete(key);
      if (this.reviews.size >= 20) throw Error('Review queue is full. Dismiss or complete pending reviews.');
      const plan = json(action.plan ? await this.actionScope.run({ projectId, signal }, () => action.plan!(input, this.context(id, projectId, signal, false))) : { title: action.title, input });
      const binding = await this.host.binding(projectId); signal.throwIfAborted(); if (this.live.get(id) !== live) throw Error('Plugin changed while preparing review');
      const review: Review = { id: randomUUID(), pluginId: id, action: name, projectId, generation: live.generation, input, fingerprint: fingerprint({ binding, plan, input }), plan, expiresAt: new Date(Date.now() + 120000).toISOString(), approved: false };
      this.reviews.set(review.id, review); this.emit('change'); return { reviewId: review.id, status: 'awaiting-user-review', instruction: 'Review and apply this action in Dunara → Plugins. No changes have been applied.' };
    }
    return this.execute(id, action, input, projectId, live, signal, false);
  }
  private async execute(id: string, action: PluginAction, input: Json, projectId: string | null, live: Live, parent: AbortSignal, writable: boolean, review?: Json, operationId?: string) {
    const controller = new AbortController(), abort = () => controller.abort(); parent.addEventListener('abort', abort, { once: true }); if (parent.aborted) abort(); live.running.add(controller);
    try { controller.signal.throwIfAborted(); const output = await this.actionScope.run({ projectId, signal: controller.signal }, () => action.run(input, this.context(id, projectId, controller.signal, writable, review, operationId))); controller.signal.throwIfAborted(); return json(schema(action.output).parse(output)); }
    finally { controller.abort(); parent.removeEventListener('abort', abort); live.running.delete(controller); this.emit('change'); }
  }
  reviewsFor(id?: string) { for (const [key, review] of this.reviews) if (Date.parse(review.expiresAt) <= Date.now()) this.reviews.delete(key); return [...this.reviews.values()].filter(review => !id || review.pluginId === id).map(({ approved: _approved, fingerprint: _fingerprint, ...review }) => structuredClone(review)); }
  async answerReview(reviewId: string, approve: boolean) {
    await this.ready; const review = this.reviews.get(reviewId); if (!review || Date.parse(review.expiresAt) <= Date.now()) throw Error('Review expired or is unavailable');
    this.reviews.delete(reviewId); this.emit('change'); if (!approve) return { dismissed: true };
    const { live, action } = this.action(review.pluginId, review.action); if (live.generation !== review.generation) throw Error('Plugin changed after review');
    const signal = new AbortController().signal, plan = json(action.plan ? await this.actionScope.run({ projectId: review.projectId, signal }, () => action.plan!(review.input, this.context(review.pluginId, review.projectId, signal, false))) : { title: action.title, input: review.input });
    if (fingerprint({ binding: await this.host.binding(review.projectId), plan, input: review.input }) !== review.fingerprint) throw Error('Project, identity or action changed. Prepare a fresh review.');
    if (this.live.get(review.pluginId) !== live) throw Error('Plugin changed during review. Prepare a fresh review.');
    const operation: Operation = { id: review.id, pluginId: review.pluginId, action: review.action, projectId: review.projectId, digest: this.row(review.pluginId)!.digest, state: 'running', updatedAt: new Date().toISOString(), message: 'Applying the reviewed action' };
    const claim = new AbortController(); live.running.add(claim);
    try {
      await this.recordOperation(operation); claim.signal.throwIfAborted();
      const result = await this.execute(review.pluginId, action, review.input, review.projectId, live, claim.signal, true, plan, operation.id);
      await this.recordOperation({ ...operation, state: 'succeeded', updatedAt: new Date().toISOString(), message: 'The action completed' }); return result;
    } catch (error) {
      await this.recordOperation({ ...operation, state: 'unknown', updatedAt: new Date().toISOString(), message: 'Completion was not confirmed. Inspect local files or the provider outcome before retrying; the action will not replay automatically.' }); throw error;
    } finally { live.running.delete(claim); this.emit('change'); }
  }
  private async recordOperation(operation: Operation) {
    return this.operationQueue.run(async () => {
      const records = this.operations.get(operation.pluginId) ?? [];
      const next = [...records.filter(value => value.id !== operation.id), operation];
      while (next.length > 100) { const removable = next.findIndex(value => value.state === 'succeeded' && value.id !== operation.id); if (removable < 0) throw Error('Operation history is full of unresolved work. Reconcile previous outcomes before starting another action.'); next.splice(removable, 1); }
      await this.writeData(operation.pluginId, 'host-operations', next); this.operations.set(operation.pluginId, next); this.emit('change');
    });
  }
  operationList() { return [...this.operations.values()].flat().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 100).map(operation => structuredClone(operation)); }
  invalidateReviews() { this.reviews.clear(); this.emit('change'); }
  interrupt() { this.invalidateReviews(); for (const live of this.live.values()) for (const controller of live.running) controller.abort(); }
  cancel(id: string) { this.assertEnabled(id); for (const controller of this.live.get(id)!.running) controller.abort(); }
  async asset(id: string, digest: string, generation: string, file: string) {
    await this.ready; this.assertEnabled(id); const row = this.row(id)!;
    if (row.digest !== digest || this.live.get(id)!.generation !== generation) throw Error('Plugin asset generation is stale');
    const target = path.join(this.directory(row), file); await noSymlinks(this.directory(row), target);
    // Only static UI code/style is public. Server code, guides and package data use authenticated APIs.
    if (!/\.(?:m?js|css|svg)$/.test(file) || file === row.package.builder.server) throw Error('Plugin asset is unavailable');
    return readText(target, 2 * 1024 * 1024);
  }
  async guide(id: string, name: string) { await this.ready; const row = this.row(id)!; if (!row.package.builder.guides.includes(name)) throw Error('Unknown guide'); const file = path.join(this.directory(row), name); await noSymlinks(this.directory(row), file); return readText(file, 128000); }
  async close() { this.closed = true; await this.ready.catch(() => {}); await this.queue.run(async () => { for (const id of [...this.live.keys()].reverse()) await this.dispose(id); }); this.removeAllListeners(); }
}
