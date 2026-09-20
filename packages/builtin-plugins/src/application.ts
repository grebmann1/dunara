import type { PreviewDriver } from '../../core/src/preview-driver.js';
import { Projects } from "../../core/src/projects.js";
import { Assets } from "../../core/src/assets.js";
import { AppIcons } from "../../core/src/app-icons.js";
import { MediaJobs } from "../../core/src/media-jobs.js";
import type { ImageProvider } from "../../core/src/openai-images.js";
import type { ProviderOptions } from "../../core/src/provider-settings.js";
import { sharedOpenAIStore, EncryptedSettingsStore } from "../../core/src/credentials.js";
import { revision } from "../../core/src/files.js";
import { Designs } from "../../core/src/design.js";
import { Previews } from "../../core/src/preview.js";
import { Captures } from "../../core/src/capture.js";
import { LaunchKits } from "../../core/src/launch-kits.js";
import { BuilderError, errorResult } from "../../core/src/contracts.js";
import { recipes } from "../../templates/src/catalog.js";
import { discoverRoutes } from "../../core/src/routes.js";
import { BoardCaptures } from "../../core/src/board-captures.js";
import { screenCatalog } from "../../core/src/screen-catalog.js";
import { Backends, type BackendOptions } from "../../core/src/backends.js";
import { BackendOAuth } from "../../core/src/backend-oauth.js";
import { ServiceRecipe } from "../../core/src/service-recipe.js";
import { AccountProvider, AccountSession, savedAccountSchema } from "../../platform/src/accounts.js";
import { RecipeUpgrades } from "../../core/src/recipe-upgrades.js";
import { serviceConfiguration, secretProtection, type ServiceConfig } from "../../core/src/service-config.js";
import { NativeBuilds } from "../../core/src/native-builds.js";
import { NativeBuildWorkspaces } from "../../core/src/native-build-workspaces.js";
import { NativeDeliveries } from './features/native-deliveries.js';
import { z } from 'zod';
import { PluginRuntime } from "../../plugin-runtime/src/runtime.js";
import { bundledPlugins } from "./catalog.js";
import { BuiltinActions } from "./registry.js";

import { BuilderKernel } from '../../core/src/kernel.js';

/** First-party distribution composition; the core Engine export remains a compatibility facade. */
export class Engine extends BuilderKernel {
  private shutdown?: Promise<void>;
  readonly plugins: PluginRuntime;
  readonly actions: BuiltinActions;
  readonly assets: Assets;
  readonly appIcons: AppIcons;
  readonly designs: Designs;
  readonly previews: PreviewDriver;
  readonly captures: Captures;
  readonly boardCaptures: BoardCaptures;
  readonly launchKits: LaunchKits;
  readonly mediaJobs: MediaJobs;
  readonly backends: Backends;
  readonly account: AccountSession;
  readonly backendOAuth: BackendOAuth;
  readonly serviceRecipe: ServiceRecipe;
  readonly recipeUpgrades: RecipeUpgrades;
  readonly nativeBuilds: NativeBuilds;
  readonly nativeWorkspaces: NativeBuildWorkspaces;
  readonly nativeDeliveries: NativeDeliveries;
  constructor(projects: Projects, trusted: boolean, lan = false, imageProvider?: ImageProvider, providerOptions: ProviderOptions = {}, backendOptions: BackendOptions = {}, accountProvider?: AccountProvider, services: ServiceConfig = serviceConfiguration(), runtime: {
    hosted?: boolean;
    previews?: (environment: (id: string) => Promise<import('../../core/src/runtime-environment.js').AppEnvironment>, beforeStart: (id: string) => Promise<void>, diagnostics: Engine['diagnostics'], projects: Projects) => PreviewDriver;
    capture?: (id: string, route: string, viewport: {width: number; height: number}, signal?: AbortSignal) => Promise<Buffer>;
  } = {}) {
    super(projects);
    this.designs = new Designs(this.files); this.assets = new Assets(projects);
    this.appIcons = new AppIcons(this.assets, this.files);
    this.mediaJobs = new MediaJobs(this.assets, imageProvider, 180_000, { credentials: sharedOpenAIStore(projects.home, secretProtection(services)), ...providerOptions });
    const protection = secretProtection(services), accountStore = new EncryptedSettingsStore(projects.home, 'builder-account', savedAccountSchema, protection);
    this.account = new AccountSession(accountProvider ?? (services.account ? new AccountProvider(services.account) : undefined), Date.now, { available: !!protection, load: () => accountStore.load(), save: value => accountStore.save(value), remove: () => accountStore.remove() });
    this.backendOAuth = new BackendOAuth(this.account, services.oauthBrokerOrigin, backendOptions.fetch);
    this.backends = new Backends(projects, this.files, { encryptionKey: protection?.key, oauth: this.backendOAuth, ...backendOptions, changed: () => this.diagnostics.emit('change') });
    const environment = (id: string) => this.backends.appEnvironment(id);
    const beforeStart = async (id: string) => { await this.recipeUpgrades.assertReady(id); await this.nativeBuilds.assertReady(id); };
    this.previews = runtime.previews?.(environment, beforeStart, this.diagnostics, projects) ?? new Previews(projects, this.diagnostics, trusted, lan, environment, beforeStart);
    this.captures = new Captures(this.previews, runtime.capture);
    this.recipeUpgrades = new RecipeUpgrades(projects, this.previews);
    this.nativeBuilds = new NativeBuilds(projects, this.previews);
    this.nativeWorkspaces = new NativeBuildWorkspaces(projects, trusted && !runtime.hosted, async (id, selection) => {
      const binding = selection.environment === 'none' ? null : await this.backends.binding(id, selection.environment);
      return { app: binding ? { EXPO_PUBLIC_SUPABASE_URL: binding.url, EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: binding.publishableKey, EXPO_PUBLIC_BUILDER_ENVIRONMENT: binding.environment } : {}, revision: revision(JSON.stringify({ binding, previewConfiguration: await this.previews.configurationRevision(id) })) };
    }, async id => { await this.recipeUpgrades.assertReady(id); await this.nativeBuilds.assertReady(id); }, id => this.diagnostics.emit('change', id));
    this.nativeDeliveries = new NativeDeliveries(projects, this.nativeWorkspaces, trusted, !runtime.hosted, id => this.diagnostics.emit('change', id));
    this.serviceRecipe = new ServiceRecipe(this.files, this.previews);
    this.boardCaptures = new BoardCaptures(this.captures, this.files);
    this.launchKits = new LaunchKits(projects, this.captures, this.assets);
    const pluginCredentials = new Map<string, EncryptedSettingsStore<Record<string, string>>>();
    const credentials = (id: string) => {
      let store = pluginCredentials.get(id);
      if (!store) { store = new EncryptedSettingsStore(projects.home, `plugin-${revision(id).slice(0, 32)}`, z.record(z.string(), z.string()), protection); pluginCredentials.set(id, store); }
      return store;
    };
    this.plugins = new PluginRuntime(projects.home, {
      files: id => ({ list: () => this.files.list(id), read: file => this.files.read(id, file), write: changes => this.files.write(id, changes) }),
      binding: async id => {
        const account = this.account.context().revision, studio = await this.studio.snapshot();
        if (!id) return { account, selected: studio.projectId };
        await this.projects.get(id); const tree = await this.files.list(id);
        if (tree.truncated) throw new Error('Project exceeds the plugin review limits');
        return { account, projectId: id, selected: studio.projectId, source: await this.boardCaptures.sourceRevision(id, tree) };
      },
      getCredential: async (id, name) => credentials(id).load()?.[name],
      setCredential: async (id, name, value) => { const store = credentials(id), values = store.load() ?? {}; if (value === null) delete values[name]; else values[name] = value; if (Object.keys(values).length) store.save(values); else store.remove(); },
      recordRecipe: (id, record) => this.projects.recordRecipe(id, record),
      beforeChange: async id => {
        if (id === 'builder.expo' && this.nativeDeliveries.busy()) throw new Error('Wait for the native build or phone operation to finish before changing its Expo plugin.');
        if (this.actions?.busy(id) || this.backends.status().busy || this.mediaJobs.providerStatus().busy) throw new Error('Finish active Dunara operations before changing plugins.');
        if (id === 'builder.expo') for (const project of await this.projects.list()) {
          if (['starting', 'ready'].includes(this.previews.status(project.id).status)) throw new Error('Stop this app’s preview before changing its Expo plugin.');
          if ((await this.nativeWorkspaces.list(project.id)).some(workspace => ['preparing', 'cancelling'].includes(workspace.state))) throw new Error('Wait for native preparation to finish before changing its Expo plugin.');
        }
      },
    }, bundledPlugins(api => {
      this.actions.contribute(api);
      if (api.id === 'builder.supabase') api.services.provide('backend-environment', '1.0.0', { inspect: async (id: string) => { this.plugins.assertProjectAccess(id); return this.backends.inspect(id); }, publicEnvironment: async (id: string) => { this.plugins.assertProjectAccess(id); return this.backends.appEnvironment(id); } });
      if (api.id === 'builder.expo') api.services.provide('capture', '1.0.0', { list: (id: string) => { this.plugins.assertProjectAccess(id); return this.captures.list(id); }, read: (id: string, captureId: string) => { this.plugins.assertProjectAccess(id); const capture = this.captures.get(id, captureId); return { bytes: capture.png, metadata: capture.meta }; } });
      if (api.id === 'builder.media') api.services.provide('assets', '1.0.0', { list: async (id: string) => { this.plugins.assertProjectAccess(id); return this.assets.list(id); }, read: async (id: string, assetId: string) => { this.plugins.assertProjectAccess(id); return this.assets.read(id, assetId); } });
    }), runtime.hosted ? true : undefined);
    this.actions = new BuiltinActions(this);
    this.plugins.on('change', () => this.diagnostics.emit('change'));
  }
  async inspect(id: string, paths: string[] = []) {
    const project = await this.projects.get(id);
    const design = await this.designs.read(id).catch(error => errorResult(error));
    const tree = await this.files.list(id);
    const routeCandidates = discoverRoutes(tree);
    const [discoveredScreens, sourceRevision, metadata] = await Promise.all([screenCatalog(this.files, id, tree.files, routeCandidates), this.boardCaptures.sourceRevision(id, tree), this.projects.metadata(project)]);
    const screens = metadata.studio.board.screens ?? discoveredScreens;
    return { project, tree, routeCandidates, screens, sourceRevision, boardCaptures: await this.boardCaptures.list(id, sourceRevision), files: await Promise.all(paths.map(p => this.files.read(id, p))), design, routes: recipes[0].routes, preview: this.previews.status(id), captures: this.captures.list(id) };
  }
  async selectBackendEnvironment(id: string, input: unknown, signal?: AbortSignal) {
    return this.projects.mutations.run(async () => {
      signal?.throwIfAborted();
      if ((await this.studio.snapshot()).projectId !== id) throw new BuilderError('REVISION_CONFLICT', 'The selected Studio project changed. Select this app before switching its preview environment.');
      const selection = await this.backends.checkEnvironmentSelection(id, input);
      return this.previews.withStopped(id, async () => {
        signal?.throwIfAborted(); await this.backends.selectEnvironment(id, selection);
        return this.backends.inspect(id);
      });
    });
  }
  async setPreviewTransport(id: string, input: unknown, signal?: AbortSignal) {
    return this.projects.mutations.run(async () => {
      if ((await this.studio.snapshot()).projectId !== id) throw new BuilderError('REVISION_CONFLICT', 'Select this app in Studio before changing its phone connection.');
      return this.previews.setTransport(id, input, signal);
    });
  }
  close() { return this.shutdown ??= this.dispose(); }
  private async dispose() {
    const errors = [];
    for (const close of [() => this.nativeDeliveries.close(), () => this.plugins.close(), () => this.account.clear(), () => this.nativeWorkspaces.close(), () => this.launchKits.close(), () => this.appIcons.close(), () => this.mediaJobs.close(), () => this.assets.close(), () => this.captures.close(), () => this.previews.close(), () => this.backends.close(), () => this.projects.closeState()]) {
      try { await close(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'Runtime shutdown completed with storage errors');
  }
}
