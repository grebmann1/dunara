import { PlatformError, publicError, type EnvironmentName } from "../../../platform/src/contracts.js";
import type { SupabaseManagement } from "../../../platform/src/supabase.js";
import type { Backends } from "../../../core/src/backends.js";
import { socialProviders } from "../../../platform/src/configuration.js";

type Inspection = Awaited<ReturnType<Backends['inspect']>>;
type Observation = { id: string; permission: 'verified' | 'denied' | 'unknown'; evidence: 'read_probe' | 'prerequisite'; error?: { code: string; message: string } };

/** Read probes establish only their own permission. A successful GET never grants a write. */
export async function backendCapabilities(state: Inspection, environment: EnvironmentName, provider: () => SupabaseManagement, signal?: AbortSignal) {
  const binding = state.environments.find(item => item.environment === environment), reads: Observation[] = [];
  async function probe<T>(id: string, work: () => Promise<T>, needsBinding = false): Promise<T | undefined> {
    if (!state.connection.configured || needsBinding && !binding) {
      reads.push({ id, permission: 'unknown', evidence: 'prerequisite', error: { code: !state.connection.configured ? 'CONNECTION_REQUIRED' : 'BACKEND_NOT_CONFIGURED', message: !state.connection.configured ? 'Connect Supabase in Settings.' : 'Connect the selected environment.' } }); return;
    }
    try { const value = await work(); reads.push({ id, permission: 'verified', evidence: 'read_probe' }); return value; }
    catch (error) {
      signal?.throwIfAborted(); const safe = publicError(error);
      reads.push({ id, permission: safe.code === 'PROVIDER_PERMISSION_REQUIRED' ? 'denied' : 'unknown', evidence: 'read_probe', error: safe });
    }
  }
  await Promise.all([
    probe('organizations_read', () => provider().organizations(signal)),
    probe('projects_read', () => provider().projects(signal)),
  ]);
  const target = await probe('project_read', async () => {
    const project = await provider().getProject(binding!.projectRef, signal);
    if (project.ref !== binding!.projectRef || project.organization !== binding!.organization) throw new PlatformError('PROVIDER_SCOPE_MISMATCH', 'The remote project no longer matches this environment binding.');
    return project;
  }, true);
  let services: { name: string; status: string }[] | undefined;
  if (target) {
    [services] = await Promise.all([
      probe('health_read', () => provider().health(target.ref, signal)),
      probe('auth_config_read', () => provider().authConfig(target.ref, signal)),
      probe('migrations_read', () => provider().migrations(target.ref, signal)),
    ]);
  } else {
    for (const id of ['health_read', 'auth_config_read', 'migrations_read']) reads.push({ id, permission: 'unknown', evidence: 'prerequisite', error: { code: 'PROJECT_NOT_VERIFIED', message: 'Verify access to the bound project first.' } });
  }
  const missing = [...(!state.connection.configured ? ['supabase_connection'] : [])];
  const boundMissing = [...missing, ...(!binding ? ['environment_binding'] : [])];
  const feature = (id: string, prerequisites: string[], humanReview: boolean) => ({ id, implemented: true, permission: 'unknown' as const, prerequisites, humanReview });
  return { projectId: state.projectId, environment, connectionRevision: state.connection.revision, environmentRevision: state.environmentRevision, checkedAt: new Date().toISOString(),
    credential: { source: state.connection.source, configured: state.connection.configured, scopes: 'unknown' as const }, encryption: state.connection.encryption,
    resources: { projectRef: binding?.projectRef ?? null, organization: binding?.organization ?? null, projectVerified: !!target, services: services ?? null },
    reads: reads.sort((a, b) => a.id.localeCompare(b.id)), socialLogin: socialProviders,
    actions: [feature('link_project', missing, true), feature('create_project', [...missing, ...(state.connection.encryption.state !== 'ready' ? ['encrypted_storage'] : [])], true),
      feature('apply_migration', boundMissing, true), feature('generate_types', boundMissing, false),
      { id: 'select_environment', implemented: true, permission: 'local' as const, prerequisites: binding ? [] : ['environment_binding'], humanReview: false },
      { id: 'export_configuration', implemented: true, permission: 'local' as const, prerequisites: binding ? [] : ['environment_binding'], humanReview: false },
      ...['configure_auth', 'configure_smtp', 'configure_storage', 'deploy_function', 'configure_function_secrets'].map(id => feature(id, [...boundMissing, 'reviewed_configuration_source', ...(id === 'configure_storage' ? ['project_server_credential'] : [])], true)),
      { id: 'connect_oauth', implemented: true, permission: 'unknown' as const, prerequisites: ['hosted_oauth_broker'], humanReview: true },
    ], limitation: 'Permission observations apply only to the listed reads at this time. Write permissions are unknown and were not probed. Remote changes still require a reviewed backend plan. Live provider qualification is pending.' };
}
