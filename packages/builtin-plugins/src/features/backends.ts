import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { PlatformStore, type Lease } from "../../../platform/src/store.js";
import { SecretBox, hash } from "../../../platform/src/crypto.js";
import { bindingSchema, connectionInput, environmentName, PlatformError, publicError, type Actor, type BackendBinding, type EnvironmentName } from "../../../platform/src/contracts.js";
import { SupabaseManagement, type Fetcher } from "../../../platform/src/supabase.js";
import { anyBackendPlan, backendApprovalSchema, backendCatalogInput, backendEnvironmentInput, backendPlanInput, backendRecoverySchema, backendSubmitSchema, type BackendPlan } from "../../../core/src/backend-contracts.js";
import { Projects } from "../../../core/src/projects.js";
import { Files } from "../../../core/src/files.js";
import { noSymlinks } from "../../../core/src/storage.js";
import type { AppEnvironment } from "../../../core/src/runtime-environment.js";
import { backendCapabilities } from "../../../core/src/backend-capabilities.js";
import { BackendConfiguration } from "../../../core/src/backend-configuration.js";
import { type ConfigurationPlan } from "../../../platform/src/configuration.js";
import type { BackendOAuth } from "../../../core/src/backend-oauth.js";
type AnyPlan = BackendPlan | ConfigurationPlan;

export type BackendOptions = { encryptionKey?: string; fetch?: Fetcher; changed?: () => void; oauth?: BackendOAuth };
export class Backends {
  private database?: PlatformStore;
  private sessionToken?: string;
  private tokenLoaded = false;
  private source: 'none' | 'session' | 'saved' = 'none';
  private readonly active = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  private closed = false;
  private scheduler?: ReturnType<typeof setInterval>;
  private closing = false;
  private shutdown?: Promise<void>;
  private configurationService?: BackendConfiguration;
  get configuration() {
    return this.configurationService ??= new BackendConfiguration({ store: this.store, actor: this.actor, files: this.files, provider: () => this.provider(), binding: (id, env) => this.binding(id, env), connectionRevision: () => this.connectionRevision(), fetch: this.options.fetch });
  }
  constructor(readonly projects: Projects, readonly files: Files, private readonly options: BackendOptions = {}) {
    options.oauth?.attachPersistence({ read: userId => this.store.getRecord(this.actor, 'oauth-desktop', userId), write: (userId, value) => this.store.putRecord(this.actor, 'oauth-desktop', userId, value) });
  }
  private get store() {
    if (this.closed) throw new PlatformError('RUNTIME_CLOSED', 'The Dunara runtime is closing.');
    if (!this.database) {
      this.database = new PlatformStore(path.join(this.projects.home, 'platform'), this.options.encryptionKey ? new SecretBox(this.options.encryptionKey) : undefined);
      this.database.recoverExpired();
      this.scheduler = setInterval(() => this.pump(), 2000);
      this.scheduler.unref();
    }
    return this.database;
  }
  private get actor(): Actor { return { id: 'local-owner', workspaceId: this.store.identity(), role: 'owner', source: 'local-owner' }; }
  private connectionRevision() {
    const old = this.store.getRecord<{ revision: string; mode?: string; oauthRevision?: string }>(this.actor, 'settings', 'supabase');
    if (old?.mode === 'oauth') {
      const oauthRevision = this.options.oauth?.status().revision ?? 'unavailable';
      if (old.oauthRevision !== oauthRevision) { const revision = randomUUID(); this.store.putRecord(this.actor, 'settings', 'supabase', { ...old, oauthRevision, revision }); return revision; }
    }
    if (old) return old.revision;
    const revision = randomUUID(); this.store.putRecord(this.actor, 'settings', 'supabase', { revision }); return revision;
  }
  private token() {
    if (this.store.getRecord<{ mode?: string }>(this.actor, 'settings', 'supabase')?.mode === 'oauth') throw new PlatformError('CONNECTION_REQUIRED', 'Reconnect Supabase OAuth in Settings.');
    if (!this.tokenLoaded) {
      const saved = this.store.getSecret(this.actor, 'supabase-management');
      if (saved) { this.sessionToken = saved; this.source = 'saved'; }
      this.tokenLoaded = true;
    }
    if (!this.sessionToken) throw new PlatformError('CONNECTION_REQUIRED', 'Connect Supabase in Settings before using the backend.');
    return this.sessionToken;
  }
  private provider() { return this.oauthSelected() ? this.options.oauth!.provider() : new SupabaseManagement(this.token(), this.options.fetch); }
  private oauthSelected() { return this.store.getRecord<{ mode?: string }>(this.actor, 'settings', 'supabase')?.mode === 'oauth'; }
  activateOAuth() {
    if (this.active.size) throw new PlatformError('OPERATION_BUSY', 'Wait for backend operations to finish before changing connections.', 409);
    if (!this.options.oauth?.status().connected) throw new PlatformError('CONNECTION_REQUIRED', 'Complete the OAuth connection first.');
    this.sessionToken = undefined; this.tokenLoaded = true; this.source = 'none';
    this.store.putRecord(this.actor, 'settings', 'supabase', { revision: randomUUID(), mode: 'oauth' }); this.options.changed?.(); return this.status();
  }
  private encryptionStatus() {
    try { this.store.assertSecretStorage(this.actor); return { state: this.options.encryptionKey ? 'ready' as const : 'not_configured' as const, issue: null as string | null }; }
    catch (error) { return { state: 'unavailable' as const, issue: publicError(error).message }; }
  }
  status() {
    let issue: string | null = null;
    try { this.token(); } catch (error) { if (!(error instanceof PlatformError) || error.code !== 'CONNECTION_REQUIRED') issue = publicError(error).message; }
    const encryption = this.encryptionStatus();
    const oauth = this.options.oauth?.status(), selected = this.oauthSelected();
    return { configured: selected ? !!oauth?.connected : !!this.sessionToken, source: selected ? 'oauth' as const : this.source, revision: this.connectionRevision(), rememberAvailable: encryption.state === 'ready', encryption, busy: this.active.size > 0, issue: issue ?? encryption.issue };
  }
  configure(input: unknown) {
    if (this.active.size) throw new PlatformError('OPERATION_BUSY', 'Wait for the current backend operation before changing its connection.', 409);
    const config = connectionInput.parse(input);
    if (config.remember) this.store.putSecret(this.actor, 'supabase-management', config.token);
    else this.store.deleteSecret(this.actor, 'supabase-management');
    this.sessionToken = config.token; this.tokenLoaded = true; this.source = config.remember ? 'saved' : 'session';
    this.store.putRecord(this.actor, 'settings', 'supabase', { revision: randomUUID() }); this.options.changed?.(); return this.status();
  }
  disconnect() {
    if (this.active.size) throw new PlatformError('OPERATION_BUSY', 'Wait for the current backend operation before disconnecting.', 409);
    this.store.deleteSecret(this.actor, 'supabase-management'); this.sessionToken = undefined; this.source = 'none'; this.tokenLoaded = true;
    this.store.putRecord(this.actor, 'settings', 'supabase', { revision: randomUUID() }); this.options.changed?.(); return this.status();
  }
  async catalog(projectId: string, input: unknown = {}, signal?: AbortSignal) {
    await this.projects.get(projectId);
    const { offset, limit, expectedRevision } = backendCatalogInput.parse(input), connectionRevision = this.connectionRevision();
    const provider = this.provider(); const [organizations, projects] = await Promise.all([provider.organizations(signal), provider.projects(signal)]);
    organizations.sort((a, b) => a.slug.localeCompare(b.slug)); projects.sort((a, b) => a.ref.localeCompare(b.ref));
    const revision = hash({ projectId, connectionRevision, organizations, projects });
    if (connectionRevision !== this.connectionRevision() || expectedRevision && expectedRevision !== revision) throw new PlatformError('REVISION_CONFLICT', 'The Supabase catalog or connection changed. Reload from the first page.', 409);
    const truncated = offset + limit < Math.max(organizations.length, projects.length);
    return { projectId, connectionRevision, revision, organizations: organizations.slice(offset, offset + limit), projects: projects.slice(offset, offset + limit),
      pagination: { offset, limit, nextOffset: truncated ? offset + limit : null, truncated, totalOrganizations: organizations.length, totalProjects: projects.length }, selectionRequired: true as const };
  }
  async binding(projectId: string, environment: EnvironmentName = 'development'): Promise<BackendBinding | null> {
    await this.projects.get(projectId); environmentName.parse(environment);
    const binding = this.store.getRecord(this.actor, 'backend', `${projectId}:${environment}`);
    return binding ? bindingSchema.parse(binding) : null;
  }
  async capabilities(projectId: string, environment?: EnvironmentName, signal?: AbortSignal) {
    const state = await this.inspect(projectId);
    const report = await backendCapabilities(state, environmentName.parse(environment ?? state.activeEnvironment), () => this.provider(), signal);
    const current = await this.inspect(projectId);
    if (state.connection.revision !== current.connection.revision || state.environmentRevision !== current.environmentRevision) throw new PlatformError('REVISION_CONFLICT', 'The backend connection or environment changed during capability checks. Inspect again.', 409);
    return report;
  }
  async inspect(projectId: string) {
    await this.projects.get(projectId);
    const selection = this.environmentState(projectId), connection = this.status();
    const active = selection.environments.find(binding => binding.environment === selection.activeEnvironment);
    return { projectId, connection, ...selection, setup: await this.configuration.progress(projectId, selection.activeEnvironment), operations: this.store.list(this.actor, projectId).map(op => ({ ...op, steps: this.store.steps(this.actor, op.id) })),
      readiness: { preview: active ? 'configured' as const : 'not_configured' as const, management: connection.configured ? 'credential_present' as const : 'connection_required' as const, providerPermissions: 'unknown' as const,
        missingPrerequisites: [...(!connection.configured ? ['supabase_connection'] : []), ...(!active ? ['environment_binding'] : []), ...(connection.encryption.state !== 'ready' ? ['encrypted_storage_for_creation_and_saved_credentials'] : [])] } };
  }
  private environmentState(projectId: string) {
    const selection = this.store.getRecord<{ name: EnvironmentName; generation?: string }>(this.actor, 'active-environment', projectId);
    const environments = environmentName.options.flatMap(name => { const value = this.store.getRecord(this.actor, 'backend', `${projectId}:${name}`); return value ? [bindingSchema.parse(value)] : []; });
    return { environments, activeEnvironment: environmentName.parse(selection?.name ?? 'development'), environmentRevision: hash({ projectId, selection, environments }) };
  }
  private selectedEnvironment(projectId: string): EnvironmentName {
    return environmentName.parse(this.store.getRecord<{ name: EnvironmentName }>(this.actor, 'active-environment', projectId)?.name ?? 'development');
  }
  async checkEnvironmentSelection(projectId: string, input: unknown) {
    await this.projects.get(projectId); const value = backendEnvironmentInput.parse(input), state = this.environmentState(projectId);
    if (value.expectedRevision !== state.environmentRevision) throw new PlatformError('REVISION_CONFLICT', 'The backend environment changed. Inspect it again before selecting.', 409);
    if (!state.environments.some(binding => binding.environment === value.environment)) throw new PlatformError('BACKEND_NOT_CONFIGURED', 'Connect this backend environment before selecting it.');
    return value;
  }
  /** Engine owns the preview fence and Studio selection guard around this commit. */
  async selectEnvironment(projectId: string, input: unknown) {
    const value = await this.checkEnvironmentSelection(projectId, input);
    this.store.putRecord(this.actor, 'active-environment', projectId, { name: value.environment, generation: randomUUID() }); this.options.changed?.();
  }
  async appEnvironment(projectId: string): Promise<AppEnvironment> {
    const binding = await this.binding(projectId, this.selectedEnvironment(projectId));
    return binding ? { EXPO_PUBLIC_SUPABASE_URL: binding.url, EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: binding.publishableKey, EXPO_PUBLIC_BUILDER_ENVIRONMENT: binding.environment } : {};
  }
  async plan(projectId: string, input: { action: 'configure' | 'function_environment'; environment?: EnvironmentName; path?: 'backend/configuration.json' }, signal?: AbortSignal): Promise<ConfigurationPlan>;
  async plan(projectId: string, input: unknown, signal?: AbortSignal): Promise<BackendPlan>;
  async plan(projectId: string, input: unknown, signal?: AbortSignal): Promise<AnyPlan> {
    await this.projects.get(projectId); const value = backendPlanInput.parse(input), provider = this.provider();
    if (value.action === 'configure' || value.action === 'function_environment') return this.configuration.plan(projectId, value.environment, signal, value.action);
    if (value.action === 'verify') return this.configuration.planVerification(projectId, value, signal);
    const binding = await this.binding(projectId, value.environment);
    const base = { version: 1 as const, projectId, environment: value.environment, action: value.action, connectionRevision: this.connectionRevision(), expectedBindingHash: hash(binding), expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() };
    if (value.action === 'link') {
      if (binding && binding.projectRef !== value.projectRef) throw new PlatformError('BACKEND_ALREADY_CONFIGURED', 'This environment is already linked. Use a separate environment to change projects.');
      const target = await provider.getProject(value.projectRef, signal);
      if (target.organization !== value.organization) throw new PlatformError('PROVIDER_SCOPE_MISMATCH', 'The selected project does not belong to the selected organization.');
      return { ...base, target: { organization: value.organization, projectRef: value.projectRef, name: target.name, region: target.region }, consequences: ['Link this existing Supabase project without changing its schema or data.', 'Use its public connection settings in generated app previews.'] };
    }
    if (value.action === 'create') {
      if (binding) throw new PlatformError('BACKEND_ALREADY_CONFIGURED', 'This environment already has a backend.');
      if (this.encryptionStatus().state !== 'ready') throw new PlatformError('CONFIGURATION_REQUIRED', 'New project creation requires readable encrypted storage for its generated database password. Configure the original BUILDER_BACKEND_ENCRYPTION_KEY on the Dunara process first.');
      const organizations = await provider.organizations(signal);
      if (!organizations.some(org => org.slug === value.organization)) throw new PlatformError('PROVIDER_SCOPE_MISMATCH', 'The selected organization is not available through this connection.');
      return { ...base, target: { organization: value.organization, name: value.name, region: value.region }, consequences: ['Create one Supabase project in the selected organization.', 'This allocates provider resources and may increase the organization’s bill. No pricing quote is available from Dunara.', 'The backend remains allocated if a later setup step fails.'] };
    }
    if (!binding) throw new PlatformError('BACKEND_NOT_CONFIGURED', 'Connect this environment before proposing a migration.');
    const file = await this.files.read(projectId, value.path);
    if (!file.content.trim()) throw new PlatformError('INVALID_INPUT', 'The migration file is empty.');
    const name = path.basename(value.path, '.sql');
    const history = await provider.migrations(binding.projectRef, signal);
    if (history.some(item => item.name === name)) throw new PlatformError('MIGRATION_ALREADY_APPLIED', 'This migration name already exists in the provider history. Create a new migration.');
    return { ...base, target: { organization: binding.organization, projectRef: binding.projectRef }, migration: { path: value.path, revision: file.revision, name, query: file.content, historyHash: hash(history) }, consequences: ['Execute this exact SQL against the selected backend.', 'Review grants, row policies, destructive changes, and compatibility with installed app versions.', ...(value.environment === 'production' ? ['This operation changes production. Confirm recovery and app compatibility before approval.'] : [])] };
  }
  private async validatePlan(plan: AnyPlan, signal?: AbortSignal) {
    if (plan.version === 2) return this.configuration.validatePlan(plan, signal);
    await this.projects.get(plan.projectId);
    if (Date.parse(plan.expiresAt) <= Date.now() || plan.connectionRevision !== this.connectionRevision() || plan.expectedBindingHash !== hash(await this.binding(plan.projectId, plan.environment))) throw new PlatformError('REVISION_CONFLICT', 'The backend proposal is stale. Generate a new plan before applying it.', 409);
    if (plan.action !== 'create') {
      const target = await this.provider().getProject(plan.target.projectRef!, signal);
      if (target.organization !== plan.target.organization) throw new PlatformError('PROVIDER_SCOPE_MISMATCH', 'The backend project moved or its organization changed.');
    }
    if (plan.migration) {
      const source = await this.files.read(plan.projectId, plan.migration.path);
      if (source.revision !== plan.migration.revision || source.content !== plan.migration.query || hash(await this.provider().migrations(plan.target.projectRef!, signal)) !== plan.migration.historyHash) throw new PlatformError('REVISION_CONFLICT', 'Migration source or provider history changed. Generate a new plan.', 409);
    }
  }
  async submit(projectId: string, input: unknown, signal?: AbortSignal) {
    const parsed = backendSubmitSchema.parse(input);
    const value = 'preparedPlanHash' in parsed ? { plan: this.configuration.prepared(projectId, parsed.preparedPlanHash), requestId: parsed.requestId } : parsed;
    if (value.plan.projectId !== projectId) throw new PlatformError('FORBIDDEN', 'The plan belongs to a different app.', 403);
    await this.projects.get(projectId);
    const submission = { projectId, environment: value.plan.environment, kind: `backend_${value.plan.action}`, idempotencyKey: value.requestId, plan: value.plan };
    const existing = this.store.submitted(this.actor, submission);
    if (existing) return existing;
    await this.validatePlan(value.plan, signal);
    const op = this.store.submit(this.actor, submission);
    this.options.changed?.(); return op;
  }
  async operation(projectId: string, operationId: string) {
    await this.projects.get(projectId); const op = this.store.get(this.actor, operationId);
    if (op.projectId !== projectId) throw new PlatformError('NOT_FOUND', 'Operation not found for this app.', 404); return { ...op, steps: this.store.steps(this.actor, op.id) };
  }
  /** Only called by the authenticated Studio human route, never registered as an MCP tool. */
  async approve(projectId: string, input: unknown) {
    const value = backendApprovalSchema.parse(input), op = await this.operation(projectId, value.operationId);
    const plan = anyBackendPlan.parse(op.plan); await this.validatePlan(plan);
    this.store.approve(this.actor, op.id, value.planHash);
    this.launch(op.id, plan); this.options.changed?.(); return this.operation(projectId, op.id);
  }
  private pump() {
    if (this.closing || !this.database) return;
    this.store.recoverExpired();
    for (const op of this.store.queued(this.actor)) {
      const decoded = anyBackendPlan.safeParse(op.plan);
      if (!decoded.success || op.kind !== `backend_${decoded.data.action}` || op.projectId !== decoded.data.projectId || op.environment !== decoded.data.environment || op.planHash !== hash({ projectId: op.projectId, environment: op.environment, kind: op.kind, plan: op.plan })) { this.store.rejectUnsupported(this.actor, op.id); continue; }
      if (!this.active.has(op.id) && this.active.size < 3) this.launch(op.id, decoded.data);
    }
  }
  private launch(id: string, plan: AnyPlan) {
    if (this.closing || this.active.has(id)) return;
    const controller = new AbortController();
    const promise = (plan.version === 2 ? this.configuration.run(id, plan, controller.signal) : this.run(id, plan, controller.signal)).finally(() => { this.active.delete(id); this.options.changed?.(); });
    this.active.set(id, { controller, promise }); void promise.catch(() => {});
  }
  async reconcile(projectId: string, input: unknown) {
    const value = backendRecoverySchema.parse(input), op = await this.operation(projectId, value.operationId);
    if (op.planHash !== value.planHash) throw new PlatformError('REVISION_CONFLICT', 'The recovery request does not match this operation.', 409);
    if (op.state === 'succeeded') return op;
    if (this.closing || this.active.has(op.id)) throw new PlatformError('OPERATION_BUSY', 'Wait for the current worker to stop before checking recovery.', 409);
    const plan = anyBackendPlan.parse(op.plan);
    const lease = this.store.claimRecovery(this.actor, op.id, randomUUID(), value.planHash, value.fence);
    const controller = new AbortController();
    const promise = (plan.version === 2 ? this.configuration.recover(lease, plan, controller.signal) : this.recover(lease, plan, controller.signal)).finally(() => { this.active.delete(op.id); this.options.changed?.(); });
    this.active.set(op.id, { controller, promise }); void promise.catch(() => {});
    this.options.changed?.(); return this.operation(projectId, op.id);
  }
  private async recover(lease: Lease, plan: BackendPlan, signal: AbortSignal) {
    const timer = setInterval(() => { try { this.store.heartbeat(lease); } catch { /* Every local commit also checks the lease. */ } }, 15_000);
    try {
      const id = lease.operationId, provider = this.provider();
      if (plan.action === 'migration' && !this.store.step(id, 'migration') || plan.action === 'create' && !this.store.step(id, 'create-project')) {
        this.store.finish(lease, 'failed', null, 'No external change was started. Prepare a new proposal using the current revisions.'); return;
      }
      const created = this.store.step(id, 'create-project');
      const ref = plan.action === 'create' ? created?.state === 'completed' ? created.result?.ref : undefined : plan.target.projectRef;
      if (typeof ref !== 'string') throw new PlatformError('RECONCILIATION_REQUIRED', 'Project creation has no confirmed resource reference. Inspect the organization in Supabase; Dunara will not create another project or identify one by name.', 409);
      const target = await provider.getProject(ref, signal);
      if (target.ref !== ref || target.organization !== plan.target.organization || plan.action === 'create' && (target.name !== plan.target.name || target.region !== plan.target.region)) throw new PlatformError('PROVIDER_SCOPE_MISMATCH', 'The provider resource no longer matches the original target. Recovery remains paused.', 409);
      const binding = await this.binding(plan.projectId, plan.environment);
      const saved = this.store.step(id, 'connect-project');
      const savedBinding = saved?.state === 'completed' ? bindingSchema.parse(saved.result?.binding) : null;
      if (hash(binding) !== plan.expectedBindingHash && (!savedBinding || hash(binding) !== hash(savedBinding))) throw new PlatformError('REVISION_CONFLICT', 'This environment binding changed after the operation. Recovery cannot replace it.', 409);
      if (plan.action === 'migration') {
        const migration = plan.migration!;
        const matches = (await provider.migrations(ref, signal)).filter(item => item.name === migration.name);
        if (matches.length !== 1) throw new PlatformError('RECONCILIATION_REQUIRED', 'The migration outcome is not uniquely recorded in provider history. SQL will not be replayed.', 409);
        const evidence = await provider.migration(ref, matches[0]!.version, signal);
        if (evidence.version !== matches[0]!.version || evidence.name !== migration.name || evidence.statements.join('\n').trim() !== migration.query.trim()) throw new PlatformError('RECONCILIATION_REQUIRED', 'Provider history does not contain the exact reviewed SQL. Inspect the migration before proceeding.', 409);
        this.store.resolveStep(lease, 'migration', { name: migration.name, revision: migration.revision, version: evidence.version });
        this.store.finish(lease, 'succeeded', { migration: migration.name, version: evidence.version, recovered: true }); return;
      }
      const health = await provider.health(ref, signal);
      if (!health.length || health.some(service => service.status !== 'ACTIVE_HEALTHY')) throw new PlatformError('BACKEND_NOT_READY', 'Supabase services are not ready. The existing resource is retained; check recovery again when it is healthy.');
      const key = await provider.publishableKey(ref, signal);
      const recovered = bindingSchema.parse({ projectId: plan.projectId, environment: plan.environment, provider: 'supabase', projectRef: ref, organization: target.organization, url: `https://${ref}.supabase.co`, publishableKey: key, connectedAt: savedBinding?.connectedAt ?? new Date().toISOString(), ownershipMode: 'user' });
      this.store.resolveStep(lease, 'connect-project', { binding: recovered });
      this.store.putLeasedRecord(lease, 'backend', `${plan.projectId}:${plan.environment}`, recovered);
      this.store.resolveStep(lease, 'save-binding', {});
      this.store.finish(lease, 'succeeded', { projectRef: ref, environment: plan.environment, recovered: true });
    } catch (error) {
      try { this.store.finish(lease, 'reconciliation_required', null, publicError(error).message); } catch { /* A newer worker or cancellation owns the state. */ }
    } finally { clearInterval(timer); this.options.changed?.(); }
  }
  private async run(id: string, plan: BackendPlan, signal: AbortSignal) {
    let lease: Lease | undefined;
    try {
      lease = this.store.claim(this.actor, id, randomUUID());
      const timer = setInterval(() => { try { this.store.heartbeat(lease!); } catch { /* Fencing is checked again before each durable step. */ } }, 15_000);
      try {
        const provider = this.provider(); await this.validatePlan(plan, signal); signal.throwIfAborted();
        if (plan.action === 'migration') {
          const migration = plan.migration!;
          if (this.store.beginStep(lease, 'migration')) { await provider.applyMigration(plan.target.projectRef!, migration.name, migration.query, signal); this.store.completeStep(lease, 'migration', { name: migration.name, revision: migration.revision }); }
          this.store.finish(lease, 'succeeded', { migration: migration.name }); return;
        }
        let ref = plan.target.projectRef;
        if (plan.action === 'create') {
          const password = randomBytes(32).toString('base64url');
          this.store.putSecret(this.actor, `${id}:database-password`, password);
          this.store.beginStep(lease, 'create-project');
          const remote = await provider.createProject({ name: plan.target.name!, region: plan.target.region!, organization: plan.target.organization, password }, signal);
          this.store.completeStep(lease, 'create-project', { ref: remote.ref }); ref = remote.ref;
        }
        this.store.beginStep(lease, 'connect-project');
        const deadline = Date.now() + 180_000;
        for (;;) {
          signal.throwIfAborted();
          const health = await provider.health(ref!, signal);
          if (health.length && health.every(service => service.status === 'ACTIVE_HEALTHY')) break;
          if (Date.now() >= deadline) throw new PlatformError('BACKEND_NOT_READY', 'Supabase services are not ready yet. The allocated project is retained.');
          await delay(2000, undefined, { signal });
        }
        const key = await provider.publishableKey(ref!, signal);
        const binding = bindingSchema.parse({ projectId: plan.projectId, environment: plan.environment, provider: 'supabase', projectRef: ref, organization: plan.target.organization, url: `https://${ref}.supabase.co`, publishableKey: key, connectedAt: new Date().toISOString(), ownershipMode: 'user' });
        this.store.completeStep(lease, 'connect-project', { binding });
        this.store.beginStep(lease, 'save-binding');
        this.store.putLeasedRecord(lease, 'backend', `${plan.projectId}:${plan.environment}`, binding);
        this.store.completeStep(lease, 'save-binding'); this.store.finish(lease, 'succeeded', { projectRef: ref!, environment: plan.environment });
      } finally { clearInterval(timer); }
    } catch (error) {
      if (lease) {
        const inFlight = ['migration', 'create-project', 'connect-project', 'save-binding'].some(name => this.store.step(id, name)?.state === 'in_flight');
        try { this.store.finish(lease, inFlight ? 'reconciliation_required' : 'failed', null, publicError(error).message); } catch { /* A cancellation/expired lease already fenced this worker. */ }
      }
    } finally { this.options.changed?.(); }
  }
  async cancel(projectId: string, operationId: string) {
    await this.operation(projectId, operationId); const result = this.store.cancel(this.actor, operationId); this.active.get(operationId)?.controller.abort(); this.options.changed?.(); return result;
  }
  async exportConfiguration(projectId: string, environment: EnvironmentName, expectedRevision: string | null) {
    const binding = await this.binding(projectId, environment);
    if (!binding) throw new PlatformError('BACKEND_NOT_CONFIGURED', 'Configure this environment first.');
    const project = await this.projects.get(projectId), destination = path.join(project.root, 'backend', 'connection.json');
    const current = await this.files.read(projectId, 'backend/connection.json').catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; });
    if ((current?.revision ?? null) !== expectedRevision) throw new PlatformError('REVISION_CONFLICT', 'Public configuration changed. Read it again before exporting.', 409);
    await this.files.write(projectId, [{ path: 'backend/connection.json', expectedRevision, content: JSON.stringify({ environment, url: binding.url, publishableKey: binding.publishableKey }, null, 2) + '\n' }]);
    await noSymlinks(project.root, destination);
    return { path: 'backend/connection.json', environment };
  }
  async generateTypes(projectId: string, environment: EnvironmentName, expectedRevision: string | null, signal?: AbortSignal) {
    const binding = await this.binding(projectId, environment);
    if (!binding) throw new PlatformError('BACKEND_NOT_CONFIGURED', 'Configure this environment first.');
    const content = await this.provider().types(binding.projectRef, signal);
    return this.files.write(projectId, [{ path: 'src/backend/database.types.ts', expectedRevision, content }]);
  }
  close() { return this.shutdown ??= this.dispose(); }
  private async dispose() {
    this.closing = true; clearInterval(this.scheduler);
    for (const operation of this.active.values()) operation.controller.abort();
    await Promise.allSettled([...this.active.values()].map(value => value.promise)); this.configurationService?.secrets.clear(); this.database?.close(); this.closed = true;
  }
}
