import { randomUUID } from 'node:crypto';
import { setInterval, clearInterval } from 'node:timers';
import { PlatformError, publicError, type Actor, type BackendBinding, type EnvironmentName } from "../../../platform/src/contracts.js";
import { PlatformStore, type Lease } from "../../../platform/src/store.js";
import { hash } from "../../../platform/src/crypto.js";
import { configurationPlan, desiredConfiguration, functionEnvironmentDeclare, validationInput, setupInput, verificationInput, type AuthPublic, type ConfigurationPlan, type ConfigurationStep } from "../../../platform/src/configuration.js";
import { functionIdentity, SupabaseManagement, type Fetcher } from "../../../platform/src/supabase.js";
import { SupabaseStorage } from "../../../platform/src/storage-api.js";
import { Files } from "../../../core/src/files.js";
import { BackendSecrets } from "../../../core/src/backend-secrets.js";
import { prepareFunction, readArtifact, saveArtifact } from "../../../core/src/function-artifacts.js";
import { BackendVerification } from "../../../core/src/backend-verification.js";

type Context = { store: PlatformStore; actor: Actor; files: Files; provider: () => SupabaseManagement; binding: (id: string, env: EnvironmentName) => Promise<BackendBinding | null>; connectionRevision: () => string; fetch?: Fetcher };
const stale = () => new PlatformError('REVISION_CONFLICT', 'Source, credentials, binding, or provider configuration changed. Prepare a new backend review.', 409);

export class BackendConfiguration {
  readonly secrets: BackendSecrets;
  readonly verification: BackendVerification;
  constructor(private readonly ctx: Context) { this.secrets = new BackendSecrets(ctx.store, ctx.actor); this.verification = new BackendVerification(ctx.store, ctx.actor, ctx.fetch); }
  private async desired(projectId: string) {
    const source = await this.ctx.files.read(projectId, 'backend/configuration.json');
    let value: unknown;
    try { value = JSON.parse(source.content); } catch { throw new PlatformError('INVALID_CONFIGURATION', 'backend/configuration.json must contain valid JSON.'); }
    const parsed = desiredConfiguration.safeParse(value);
    if (!parsed.success) throw new PlatformError('INVALID_CONFIGURATION', `Unsupported backend configuration: ${parsed.error.issues.map(i => i.path.join('.') || 'configuration').slice(0, 5).join(', ')}. Check the configuration guide.`);
    return { source, value: parsed.data };
  }
  async functionEnvironment(projectId: string, environment: EnvironmentName, declareInputs = false) {
    await this.ctx.files.projects.get(projectId);
    const config = await this.desired(projectId).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; });
    if (!config) return { environment, sourceRevision: null, variables: [] };
    const bindings = [...new Map([...config.value.functionEnvironment, ...config.value.functions.flatMap(fn => fn.secrets)].map(item => [item.name, item])).values()];
    const names = new Set(bindings.map(item => item.secret));
    const requirements = config.value.requirements.filter(item => names.has(item.name));
    const inputs = declareInputs ? this.secrets.declare(projectId, environment, requirements) : requirements.map(item => {
      try { const input = this.secrets.status(projectId, environment, item.name); if (input.purpose !== item.purpose) throw new PlatformError('REVISION_CONFLICT', 'A private input has a different purpose. Review the configuration.', 409); return input; }
      catch (error) { if (!(error instanceof PlatformError) || error.code !== 'INPUT_NOT_REQUESTED') throw error; return { ...item, revision: null, persistence: 'missing' as const, available: false }; }
    });
    return { environment, sourceRevision: config.source.revision, variables: bindings.map(item => ({ ...item, input: inputs.find(value => value.name === item.secret)! })) };
  }
  async declareFunctionEnvironment(projectId: string, input: unknown) {
    const value = functionEnvironmentDeclare.parse(input);
    return this.ctx.files.projects.mutations.run(async () => {
      const current = await this.functionEnvironment(projectId, value.environment, true);
      if (current.sourceRevision !== value.expectedSourceRevision) throw stale();
      if (current.variables.some(item => item.name === value.name)) return current;
      const config = current.sourceRevision ? (await this.desired(projectId)).value : desiredConfiguration.parse({ version: 1 });
      const secret = `env_${value.name.toLowerCase().slice(0, 48)}_${hash(value.name).slice(0, 8)}`;
      if (config.requirements.some(item => item.name === secret)) throw new PlatformError('REVISION_CONFLICT', 'The generated private input already exists. Choose another variable name.', 409);
      config.functionEnvironment.push({ name: value.name, secret }); config.requirements.push({ name: secret, purpose: 'function', label: value.name });
      const parsed = desiredConfiguration.safeParse(config);
      if (!parsed.success) throw new PlatformError('INVALID_CONFIGURATION', 'This variable exceeds the configuration limits. Review the existing variables.');
      this.secrets.declare(projectId, value.environment, [{ name: secret, purpose: 'function', label: value.name }]);
      await this.ctx.files.writeUnlocked(projectId, [{ path: 'backend/configuration.json', content: JSON.stringify(parsed.data, null, 2) + '\n', expectedRevision: current.sourceRevision }]);
      return this.functionEnvironment(projectId, value.environment);
    });
  }
  async requirements(projectId: string, environment: EnvironmentName) {
    const { value } = await this.desired(projectId);
    const inputs = this.secrets.declare(projectId, environment, value.requirements);
    for (const name of ['qualification_owner', 'qualification_other']) if (!inputs.some(i => i.name === name)) { try { inputs.push(this.secrets.status(projectId, environment, name)); } catch { /* Requested only by a verification journey. */ } }
    return { projectId, environment, inputs };
  }
  async planVerification(projectId: string, input: unknown, signal?: AbortSignal) {
    const value = verificationInput.parse(input), { source } = await this.desired(projectId), binding = await this.ctx.binding(projectId, 'development');
    if (!binding) throw new PlatformError('BACKEND_NOT_CONFIGURED', 'Connect development before live verification.');
    const names = value.scenario === 'email' ? [] : value.scenario === 'cleanup' ? ['qualification_owner'] : ['qualification_owner', 'qualification_other'];
    const secrets = this.secrets.declare(projectId, 'development', names.map(name => ({ name, purpose: 'app_user_session' as const, label: name === 'qualification_owner' ? 'Isolated development owner session' : 'Isolated second development user session' })));
    const plan: ConfigurationPlan = { version: 2, action: 'configure', projectId, workspaceId: this.ctx.actor.workspaceId, environment: 'development', target: { organization: binding.organization, projectRef: binding.projectRef }, connectionRevision: this.ctx.connectionRevision(), expectedBindingHash: hash(binding), expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(), sources: [source], secrets, steps: [], requiredCapabilities: ['development_app_user'], prerequisites: secrets.filter(s => !s.available).map(s => `Enter ${s.label} in Backend, then prepare verification again.`), consequences: [value.scenario === 'email' ? `Request one email code for ${value.recipient}. No new account is created.` : 'Exercise fixed synthetic development resources using isolated app-user sessions.', 'Successful checks remove their own fixtures. Failures retain the recorded resource IDs for separately reviewed cleanup.', 'Invoking a function or sending email can have external side effects. Uncertain verification is never replayed.'] };
    const step: Extract<ConfigurationStep, { kind: 'verification' }> = { kind: 'verification', id: `verify.${value.scenario}`, scenario: value.scenario, fixtureId: value.fixtureId ?? randomUUID(), dependsOn: [], observedHash: hash(null), recovery: 'receipt_required', bucket: value.bucket, functionSlug: value.functionSlug, recipient: value.recipient };
    for (const item of secrets) if (item.available) { const id = await this.verification.user(binding, this.secrets.resolve(projectId, 'development', item), signal); if (item.name === 'qualification_owner') step.ownerId = id; else step.otherId = id; }
    if (step.ownerId && step.ownerId === step.otherId) throw new PlatformError('INVALID_CONFIGURATION', 'Owner and second-user qualification sessions must belong to distinct users.');
    if (value.scenario === 'cleanup') { const target = this.verification.cleanupTarget(projectId, step.fixtureId); if (target.projectRef !== binding.projectRef || step.ownerId && target.ownerId !== step.ownerId) throw new PlatformError('FORBIDDEN', 'Cleanup is restricted to this environment’s recorded owner fixtures.', 403); }
    plan.steps.push(step); const prepared = configurationPlan.parse(plan); this.ctx.store.putRecord(this.ctx.actor, 'configuration-plan', hash(prepared), prepared); return prepared;
  }
  private secret(plan: ConfigurationPlan, name: string) {
    const reference = plan.secrets.find(s => s.name === name);
    if (!reference) throw new PlatformError('SECRET_REQUIRED', 'The approved plan has no matching credential requirement.');
    return this.secrets.resolve(plan.projectId, plan.environment, reference);
  }
  private storage(plan: ConfigurationPlan, name: string) { return new SupabaseStorage(plan.target.projectRef, this.secret(plan, name), this.ctx.fetch); }
  async plan(projectId: string, environment: EnvironmentName, signal?: AbortSignal, scope: 'configure' | 'function_environment' = 'configure'): Promise<ConfigurationPlan> {
    const { source, value } = await this.desired(projectId), binding = await this.ctx.binding(projectId, environment);
    if (!binding) throw new PlatformError('BACKEND_NOT_CONFIGURED', 'Link or create this environment first. Dependent configuration is planned from its actual binding.');
    const plan: ConfigurationPlan = { version: 2, action: 'configure', projectId, workspaceId: this.ctx.actor.workspaceId, environment, target: { organization: binding.organization, projectRef: binding.projectRef }, connectionRevision: this.ctx.connectionRevision(), expectedBindingHash: hash(binding), expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(), sources: [source], secrets: this.secrets.declare(projectId, environment, value.requirements), steps: [], requiredCapabilities: [], prerequisites: [], consequences: ['Apply only the reviewed fields and resources. Other provider settings are preserved.', 'Provider updates are not atomic across services. Completed changes remain after a later failure.', 'Uncertain changes require evidence-based recovery; cancellation never deletes resources.'] };
    const bindings = [...new Map([...value.functionEnvironment, ...value.functions.flatMap(f => f.secrets)].map(s => [s.name, s])).values()];
    if (scope === 'function_environment') { const names = new Set(bindings.map(s => s.secret)); plan.secrets = plan.secrets.filter(s => names.has(s.name)); }
    for (const s of plan.secrets) if (!s.available) plan.prerequisites.push(`Enter ${s.label} (${s.name}) for ${environment} in Backend.`);
    const target = await this.ctx.provider().getProject(binding.projectRef, signal);
    if (target.organization !== binding.organization) throw stale();
    if (value.auth && scope === 'configure') {
      const after: AuthPublic = { ...value.auth.settings };
      if (after.external_google_enabled) { after.external_google_skip_nonce_check = false; for (const relative of ['src/backend/social.ts', 'app/oauth-callback.tsx']) plan.sources.push(await this.ctx.files.read(projectId, relative)); }
      for (const template of value.auth.templates) {
        const file = await this.ctx.files.read(projectId, template.path);
        if (Buffer.byteLength(file.content) > 32_000 || !file.content.includes('{{ .Token }}')) throw new PlatformError('INVALID_CONFIGURATION', 'Email-code templates must include {{ .Token }} and be at most 32 KB.');
        plan.sources.push(file); after[template.field] = file.content;
      }
      const before = await this.ctx.provider().authFields(binding.projectRef, Object.keys(after) as (keyof AuthPublic)[], signal);
      if (hash(before) !== hash(after) || value.auth.secrets.length) plan.steps.push({ kind: 'auth', id: 'auth', dependsOn: [], observedHash: hash(before), recovery: value.auth.secrets.length ? 'receipt_required' : 'readback', before, after, secrets: value.auth.secrets });
      plan.requiredCapabilities.push('auth:read', 'auth:write');
    }
    if (value.storage && scope === 'configure') {
      plan.requiredCapabilities.push('storage_server');
      const available = plan.secrets.find(s => s.name === value.storage!.serverCredential)?.available;
      if (available) for (const raw of value.storage.buckets) {
        const after = { ...raw, allowed_mime_types: raw.allowed_mime_types.slice().sort() }, before = await this.storage(plan, value.storage.serverCredential).bucket(after.id, signal);
        if (hash(before) !== hash(after)) plan.steps.push({ kind: 'bucket', id: `bucket.${after.id}`, dependsOn: [], before, after, credential: value.storage.serverCredential, observedHash: hash(before), recovery: 'readback' });
      }
    }
    if (bindings.length) {
      plan.requiredCapabilities.push('edge_functions:write');
      plan.consequences.push('Environment variables are shared by all Edge Functions in the selected Supabase project. Existing values with these names will be replaced; other variables are preserved. No redeployment is required.');
      plan.steps.push({ kind: 'function_secrets', id: 'function-inputs', dependsOn: [], observedHash: hash(null), bindings, recovery: 'receipt_required' });
    }
    if (value.functions.length && scope === 'configure') {
      plan.requiredCapabilities.push('edge_functions:read', 'edge_functions:write');
      const remote = await this.ctx.provider().functions(binding.projectRef, signal);
      for (const fn of value.functions) {
        const artifact = await prepareFunction(this.ctx.files, projectId, fn.slug, fn.entrypoint), artifactId = saveArtifact(this.ctx.store, this.ctx.actor, artifact);
        for (const file of artifact.files) if (!plan.sources.some(s => s.path === file.sourcePath)) plan.sources.push({ path: file.sourcePath, content: file.content, revision: file.revision });
        const before = remote.find(f => f.slug === fn.slug) ?? null;
        const deployed = this.ctx.store.getRecord<{ artifactId: string; identity: unknown }>(this.ctx.actor, 'function-deployment', `${projectId}:${environment}:${fn.slug}`);
        if (!deployed || deployed.artifactId !== artifactId || hash(deployed.identity) !== hash(before)) plan.steps.push({ kind: 'function', id: `function.${fn.slug}`, dependsOn: bindings.length ? ['function-inputs'] : [], slug: fn.slug, artifactId, before, verify_jwt: true, observedHash: hash(before), recovery: 'receipt_required' });
      }
    }
    const result = configurationPlan.parse(plan);
    if (Buffer.byteLength(JSON.stringify(result)) > 450_000) throw new PlatformError('LIMIT_EXCEEDED', 'The configuration review exceeds 450 KB. Split it into smaller changes.');
    await this.validateIdentity(result, false);
    this.ctx.store.putRecord(this.ctx.actor, 'configuration-plan', hash(result), result);
    return result;
  }
  private issued(plan: ConfigurationPlan) {
    const original = this.ctx.store.getRecord(this.ctx.actor, 'configuration-plan', hash(plan));
    if (!original || hash(original) !== hash(plan)) throw new PlatformError('INVALID_PLAN', 'Only the exact configuration plan prepared by this Dunara workspace can be staged.');
  }
  prepared(projectId: string, planHash: string) {
    const plan = this.ctx.store.getRecord<ConfigurationPlan>(this.ctx.actor, 'configuration-plan', planHash);
    if (!plan || plan.projectId !== projectId || hash(plan) !== planHash) throw new PlatformError('INVALID_PLAN', 'The prepared plan is unavailable for this app.');
    return configurationPlan.parse(plan);
  }
  private async validateIdentity(plan: ConfigurationPlan, execution: boolean) {
    if (plan.workspaceId !== this.ctx.actor.workspaceId || plan.connectionRevision !== this.ctx.connectionRevision() || plan.expectedBindingHash !== hash(await this.ctx.binding(plan.projectId, plan.environment)) || execution && Date.parse(plan.expiresAt) <= Date.now()) throw stale();
    for (const source of plan.sources) {
      const current = await this.ctx.files.read(plan.projectId, source.path);
      if (current.revision !== source.revision || current.content !== source.content) throw stale();
    }
    for (const s of plan.secrets) {
      const current = this.secrets.status(plan.projectId, plan.environment, s.name);
      if (hash(current) !== hash(s)) throw stale();
      if (execution) this.secrets.resolve(plan.projectId, plan.environment, s);
    }
  }
  private async observed(plan: ConfigurationPlan, step: ConfigurationStep, signal?: AbortSignal) {
    if (step.kind === 'auth') return this.ctx.provider().authFields(plan.target.projectRef, Object.keys(step.after) as (keyof AuthPublic)[], signal);
    if (step.kind === 'bucket') return this.storage(plan, step.credential).bucket(step.after.id, signal);
    if (step.kind === 'function') return (await this.ctx.provider().functions(plan.target.projectRef, signal)).find(f => f.slug === step.slug) ?? null;
    return null;
  }
  async validatePlan(plan: ConfigurationPlan, signal?: AbortSignal) {
    this.issued(plan); await this.validateIdentity(plan, true);
    if (plan.prerequisites.length) throw new PlatformError('PREREQUISITE_REQUIRED', 'Complete the pending secure inputs and prepare a new review.');
    const target = await this.ctx.provider().getProject(plan.target.projectRef, signal);
    if (target.organization !== plan.target.organization) throw stale();
    for (const step of plan.steps) {
      if (hash(await this.observed(plan, step, signal)) !== step.observedHash) throw stale();
      if (step.kind === 'function') readArtifact(this.ctx.store, this.ctx.actor, plan.projectId, step.artifactId);
    }
  }
  async validate(projectId: string, input: unknown, signal?: AbortSignal) {
    const value = validationInput.parse(input), checks: { name: string; status: 'pass' | 'fail' | 'blocked' | 'not_run'; detail: string }[] = [];
    let plan: ConfigurationPlan | undefined;
    try {
      plan = value.planHash ? this.ctx.store.getRecord<ConfigurationPlan>(this.ctx.actor, 'configuration-plan', value.planHash) ?? undefined : await this.plan(projectId, value.environment, signal);
      if (!plan || plan.projectId !== projectId || plan.environment !== value.environment) throw new PlatformError('INVALID_PLAN', 'This plan is unavailable for the selected app and environment.');
      await this.validatePlan(plan, signal); checks.push({ name: 'configuration', status: 'pass', detail: 'Source, binding, credentials and relevant remote preconditions match. No provider changes executed.' });
    } catch (error) { const e = publicError(error); checks.push({ name: 'configuration', status: ['REVISION_CONFLICT', 'INVALID_CONFIGURATION', 'INVALID_PLAN', 'INVALID_ARTIFACT'].includes(e.code) ? 'fail' : 'blocked', detail: e.message }); }
    for (const name of ['email_delivery', 'owner_isolation', 'storage_objects', 'function_invocation', 'ios_device', 'android_device', 'independent_export']) checks.push({ name, status: 'not_run', detail: 'Requires a separately reviewed live qualification run.' });
    return { projectId, environment: value.environment, planHash: plan ? hash(plan) : value.planHash ?? null, sourceHash: plan ? hash(plan.sources.map(s => ({ path: s.path, revision: s.revision }))) : null, checkedAt: new Date().toISOString(), status: checks[0]!.status, checks };
  }
  async setup(projectId: string, input: unknown) {
    await this.ctx.files.projects.get(projectId); const value = setupInput.parse(input), id = `${projectId}:${value.environment}:${value.requestId}`;
    const existing = this.ctx.store.getRecord<{ scenario: string }>(this.ctx.actor, 'backend-setup', id);
    if (existing && existing.scenario !== value.scenario) throw stale();
    if (!existing) this.ctx.store.putRecord(this.ctx.actor, 'backend-setup', id, { id, projectId, ...value, createdAt: new Date().toISOString() });
    return this.progress(projectId, value.environment);
  }
  async progress(projectId: string, environment: EnvironmentName) {
    const binding = await this.ctx.binding(projectId, environment), operations = this.ctx.store.list(this.ctx.actor, projectId).filter(op => op.environment === environment);
    const journeys = this.ctx.store.recordEntries<{ projectId: string; environment: EnvironmentName; scenario: string; createdAt: string }>(this.ctx.actor, 'backend-setup').filter(row => row.value.projectId === projectId && row.value.environment === environment).sort((a, b) => b.value.createdAt.localeCompare(a.value.createdAt)).slice(0, 10).map(row => ({ id: row.id, scenario: row.value.scenario, createdAt: row.value.createdAt, operationIds: operations.filter(op => op.createdAt >= row.value.createdAt).map(op => op.id) }));
    let inputs: Awaited<ReturnType<BackendConfiguration['requirements']>>['inputs'] = [], sourceReady = false;
    try { inputs = (await this.requirements(projectId, environment)).inputs; sourceReady = true; } catch { /* The journey can begin before recipe/configuration source exists. */ }
    const pending = operations.filter(op => ['awaiting_approval', 'queued', 'running', 'reconciliation_required'].includes(op.state));
    return { environment, journeys, phase: !sourceReady ? 'prepare_source' : !binding ? 'select_backend' : inputs.some(s => !s.available) ? 'secure_inputs' : pending.length ? 'review_or_recover' : 'configure_or_verify', inputs, operations: pending.map(op => ({ id: op.id, state: op.state, planHash: op.planHash })), next: !sourceReady ? 'Prepare backend/configuration.json and review app source changes.' : !binding ? 'Discover and explicitly choose a project, then review link/create. Configuration follows the actual binding.' : inputs.some(s => !s.available) ? 'Enter missing credentials in Backend, then prepare a new configuration plan.' : 'Prepare configuration from current source, review each operation, then run live verification and export public config/types.' };
  }
  async run(id: string, plan: ConfigurationPlan, signal: AbortSignal) {
    let lease: Lease | undefined;
    try {
      lease = this.ctx.store.claim(this.ctx.actor, id, randomUUID());
      await this.withHeartbeat(lease, async () => {
        await this.validatePlan(plan, signal);
        for (const step of plan.steps) await this.ctx.files.projects.mutations.run(async () => {
          signal.throwIfAborted(); await this.validateIdentity(plan, true);
          if (hash(await this.observed(plan, step, signal)) !== step.observedHash) throw stale();
          for (const dep of step.dependsOn) if (this.ctx.store.step(id, dep)?.state !== 'completed') throw new PlatformError('DEPENDENCY_REQUIRED', 'An earlier configuration step is incomplete.');
          signal.throwIfAborted(); this.ctx.store.heartbeat(lease!);
          this.ctx.store.beginStep(lease!, step.id);
          await this.ctx.store.flush();
          await this.execute(lease!, plan, step, signal);
        });
        this.ctx.store.finish(lease!, 'succeeded', { configurationHash: hash(plan), steps: plan.steps.length, qualification: plan.steps.some(step => step.kind === 'verification') ? 'service_checks_only' : 'not_run' });
      });
    } catch (error) { if (lease) this.finishError(lease, plan, error); }
    finally { await this.ctx.store.flush(); }
  }
  private async withHeartbeat(lease: Lease, fn: () => Promise<void>) {
    const timer = setInterval(() => { try { this.ctx.store.heartbeat(lease); } catch { /* Commits are fenced. */ } }, 15_000);
    try { await fn(); } finally { clearInterval(timer); }
  }
  private receipt(lease: Lease, step: ConfigurationStep, value: Record<string, unknown> = {}) {
    this.ctx.store.beginStep(lease, `${step.id}.receipt`); this.ctx.store.completeStep(lease, `${step.id}.receipt`, value);
  }
  private async execute(lease: Lease, plan: ConfigurationPlan, step: ConfigurationStep, signal: AbortSignal) {
    try {
    if (step.kind === 'auth') {
      const secrets = Object.fromEntries(step.secrets.map(s => [s.field, this.secret(plan, s.secret)]));
      await this.ctx.provider().patchAuth(plan.target.projectRef, step.after, secrets, signal); this.receipt(lease, step);
      if (hash(await this.observed(plan, step, signal)) !== hash(step.after)) throw new PlatformError('RECONCILIATION_REQUIRED', 'Auth readback differs from the reviewed settings. Check concurrent changes.', 409);
    } else if (step.kind === 'bucket') {
      await this.storage(plan, step.credential).configure(step.after, step.before !== null, signal); this.receipt(lease, step);
      if (hash(await this.observed(plan, step, signal)) !== hash(step.after)) throw new PlatformError('RECONCILIATION_REQUIRED', 'Storage readback differs from the reviewed bucket.', 409);
    } else if (step.kind === 'function_secrets') {
      await this.ctx.provider().setFunctionSecrets(plan.target.projectRef, step.bindings.map(s => ({ name: s.name, value: this.secret(plan, s.secret) })), signal); this.receipt(lease, step);
    } else if (step.kind === 'verification') {
      const binding = await this.ctx.binding(plan.projectId, plan.environment);
      if (!binding) throw stale();
      const result = await this.verification.execute(lease, binding, step, { owner: plan.secrets.some(s => s.name === 'qualification_owner') ? this.secret(plan, 'qualification_owner') : undefined, other: plan.secrets.some(s => s.name === 'qualification_other') ? this.secret(plan, 'qualification_other') : undefined }, signal);
      this.receipt(lease, step, result);
    } else {
      const artifact = readArtifact(this.ctx.store, this.ctx.actor, plan.projectId, step.artifactId);
      const identity = await this.ctx.provider().deployFunction(plan.target.projectRef, artifact, signal);
      this.receipt(lease, step, { identity, artifactId: step.artifactId });
      if (identity.slug !== step.slug || !identity.verify_jwt || identity.status !== 'ACTIVE' || identity.version <= Number(step.before?.version ?? -1) || hash(await this.observed(plan, step, signal)) !== hash(identity)) throw new PlatformError('RECONCILIATION_REQUIRED', 'Function deployment identity, status, or readback differs. Inspect its version before continuing.', 409);
      this.ctx.store.putLeasedRecord(lease, 'function-deployment', `${plan.projectId}:${plan.environment}:${step.slug}`, { artifactId: step.artifactId, identity });
    }
    this.ctx.store.completeStep(lease, step.id, { evidence: step.kind === 'function_secrets' ? 'provider_acknowledged_value_not_readable' : step.kind === 'verification' ? 'reviewed_service_checks' : 'provider_readback', checkedAt: new Date().toISOString() });
    } catch (error) {
      if (step.kind === 'verification' && error instanceof PlatformError && error.code === 'VERIFICATION_FAILED') this.ctx.store.failStep(lease, step.id, this.verification.report(plan.projectId, step.fixtureId) ?? { fixtureId: step.fixtureId, fixturesRetained: true });
      if (step.kind !== 'verification' && !this.ctx.store.step(lease.operationId, `${step.id}.receipt`) && error instanceof PlatformError && ['CONNECTION_REQUIRED', 'PROVIDER_PERMISSION_REQUIRED', 'PROVIDER_RATE_LIMITED', 'PROVIDER_REQUEST_FAILED'].includes(error.code)) this.ctx.store.rejectStep(lease, step.id);
      throw error;
    }
  }
  async recover(lease: Lease, plan: ConfigurationPlan, signal: AbortSignal) {
    try { await this.withHeartbeat(lease, async () => {
      this.issued(plan);
      // Source may be edited after cancellation; recovery only observes the original remote target.
      if (plan.connectionRevision !== this.ctx.connectionRevision() || plan.expectedBindingHash !== hash(await this.ctx.binding(plan.projectId, plan.environment))) throw stale();
      const target = await this.ctx.provider().getProject(plan.target.projectRef, signal);
      if (target.organization !== plan.target.organization) throw stale();
      for (const step of plan.steps) {
        const stored = this.ctx.store.step(lease.operationId, step.id);
        if (!stored || stored.state === 'completed' || stored.state === 'rejected' || stored.state === 'failed') continue;
        signal.throwIfAborted();
        const receipt = this.ctx.store.step(lease.operationId, `${step.id}.receipt`);
        if (step.recovery === 'receipt_required' && receipt?.state !== 'completed') throw new PlatformError('RECONCILIATION_REQUIRED', 'No confirmed response proves this secret update or function deployment. Masked values and matching names are insufficient; no change was replayed.', 409);
        const observed = await this.observed(plan, step, signal);
        if (step.kind === 'auth' || step.kind === 'bucket') { if (hash(observed) !== hash(step.after)) throw stale(); }
        if (step.kind === 'function') {
          const identity = functionIdentity.safeParse(observed);
          if (!identity.success || identity.data.slug !== step.slug || !identity.data.verify_jwt || identity.data.status !== 'ACTIVE' || identity.data.version <= Number(step.before?.version ?? -1) || receipt?.result?.artifactId !== step.artifactId || hash(observed) !== hash(receipt.result.identity)) throw stale();
          this.ctx.store.putLeasedRecord(lease, 'function-deployment', `${plan.projectId}:${plan.environment}:${step.slug}`, { artifactId: step.artifactId, identity: observed });
        }
        this.ctx.store.resolveStep(lease, step.id, { evidence: step.kind === 'function_secrets' ? 'provider_acknowledgement' : 'provider_readback', checkedAt: new Date().toISOString() });
      }
      const complete = plan.steps.every(step => this.ctx.store.step(lease.operationId, step.id)?.state === 'completed');
      this.ctx.store.finish(lease, complete ? 'succeeded' : 'failed', { configurationHash: hash(plan), completedSteps: plan.steps.filter(step => this.ctx.store.step(lease.operationId, step.id)?.state === 'completed').map(step => step.id) }, complete ? null : 'Started changes were reconciled. Remaining steps were not executed. Prepare a new review.');
    }); } catch (error) { this.finishError(lease, plan, error, true); }
  }
  private finishError(lease: Lease, plan: ConfigurationPlan, error: unknown, recovery = false) {
    const uncertain = recovery || plan.steps.some(s => this.ctx.store.step(lease.operationId, s.id)?.state === 'in_flight');
    try { this.ctx.store.finish(lease, uncertain ? 'reconciliation_required' : 'failed', null, publicError(error).message); } catch { /* Cancellation/lease expiry retains evidence and fences this worker. */ }
  }
}
