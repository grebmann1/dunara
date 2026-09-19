import { z } from 'zod';
import { setTimeout as delay } from 'node:timers/promises';
import { PlatformError, providerRef, organizationSlug, publicKey } from './contracts.js';
import { authPublicSchema, authSecretField, authSecretValuesSchema, type AuthPublic, resourceName } from './configuration.js';

export type Fetcher = typeof fetch;
const text = z.string().max(1000);
const remoteProject = z.object({ id: text, ref: providerRef.optional(), name: text, region: text, status: text, organization_slug: organizationSlug.optional(), organization_id: text.optional() });
export type RemoteProject = { ref: string; name: string; region: string; status: string; organization: string };
const migration = z.object({ version: text, name: text.nullable().optional() });
function providerResult<T>(schema: z.ZodType<T>, value: unknown, write = false): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new PlatformError(write ? 'RECONCILIATION_REQUIRED' : 'PROVIDER_RESPONSE_INVALID', write ? 'Supabase did not return a valid resource identity. Inspect remote state before retrying.' : 'Supabase returned an unexpected or oversized response. No partial results were used.', 502);
  return parsed.data;
}

export async function boundedJson(response: Response, limit = 2_000_000): Promise<unknown> {
  if (!response.body) return null;
  if (Number(response.headers.get('content-length')) > limit) { await response.body.cancel(); throw new PlatformError('PROVIDER_RESPONSE_INVALID', 'The provider response exceeded its size limit.', 502); }
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
  try {
    for (;;) { const part = await reader.read(); if (part.done) break; bytes += part.value.length; if (bytes > limit) throw new PlatformError('PROVIDER_RESPONSE_INVALID', 'The provider response exceeded its size limit.', 502); chunks.push(part.value); }
    const source = Buffer.concat(chunks).toString('utf8');
    return source ? JSON.parse(source) : null;
  } catch (error) { if (error instanceof PlatformError) throw error; throw new PlatformError('PROVIDER_RESPONSE_INVALID', 'The provider returned an unreadable response.', 502); }
  finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/** Never returns raw API-key payloads, provider error bodies, or database passwords. */
export class SupabaseManagement {
  constructor(private readonly token: string, private readonly request: Fetcher = fetch) {
    if (!/^[\x21-\x7e]{16,4096}$/.test(token)) throw new PlatformError('CONNECTION_REQUIRED', 'Connect a Supabase management account first.');
  }
  private async call(endpoint: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await this.request(`https://api.supabase.com/v1${endpoint}`, {
          method, headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/json', ...(body === undefined || body instanceof FormData ? {} : { 'Content-Type': 'application/json' }) },
          ...(body === undefined ? {} : { body: body instanceof FormData ? body : JSON.stringify(body) }), redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
        });
      } catch { throw new PlatformError(method === 'GET' ? 'PROVIDER_UNAVAILABLE' : 'RECONCILIATION_REQUIRED', method === 'GET' ? 'Supabase could not be reached. Check your connection and retry.' : 'Supabase did not confirm the request. Inspect remote state before retrying.', 502); }
      if (response.ok) {
        try { return await boundedJson(response); }
        catch (error) { if (method === 'GET') throw error; throw new PlatformError('RECONCILIATION_REQUIRED', 'Supabase returned an unreadable change response. Inspect remote state before retrying.', 502); }
      }
      await response.body?.cancel();
      if (method === 'GET' && [429, 502, 503].includes(response.status) && attempt < 2) {
        const retry = Number(response.headers.get('retry-after'));
        if (Number.isFinite(retry) && retry > 2) throw new PlatformError('PROVIDER_RATE_LIMITED', 'Supabase is rate limiting requests. Retry later.', 429);
        await delay(Math.max(250 * (attempt + 1), Number.isFinite(retry) ? retry * 1000 : 0), undefined, { signal }); continue;
      }
      if (response.status === 401) throw new PlatformError('CONNECTION_REQUIRED', 'Supabase authorization expired or was revoked. Reconnect the account.', 401);
      if (response.status === 403) throw new PlatformError('PROVIDER_PERMISSION_REQUIRED', 'The Supabase connection lacks permission for this operation.', 403);
      if (response.status === 429) throw new PlatformError('PROVIDER_RATE_LIMITED', 'Supabase is rate limiting requests. Retry later.', 429);
      if (method !== 'GET' && response.status >= 500) throw new PlatformError('RECONCILIATION_REQUIRED', 'Supabase may have applied the change. Inspect remote state before retrying.', 502);
      throw new PlatformError('PROVIDER_REQUEST_FAILED', `Supabase rejected this ${method === 'GET' ? 'read' : 'change'} request (HTTP ${response.status}). Review its prerequisites.`, 502);
    }
  }
  private project(value: unknown, write = false): RemoteProject {
    const p = providerResult(remoteProject, value, write);
    return { ref: providerResult(providerRef, p.ref ?? p.id, write), name: p.name, region: p.region, status: p.status, organization: providerResult(organizationSlug, p.organization_slug ?? p.organization_id, write) };
  }
  async organizations(signal?: AbortSignal) {
    return providerResult(z.array(z.object({ id: text.optional(), slug: organizationSlug.optional(), name: text })).max(200), await this.call('/organizations', 'GET', undefined, signal)).map(p => ({ slug: providerResult(organizationSlug, p.slug ?? p.id), name: p.name }));
  }
  async projects(signal?: AbortSignal) {
    return providerResult(z.array(z.unknown()).max(1000), await this.call('/projects', 'GET', undefined, signal)).map(p => this.project(p));
  }
  async getProject(ref: string, signal?: AbortSignal) { return this.project(await this.call(`/projects/${providerRef.parse(ref)}`, 'GET', undefined, signal)); }
  async createProject(input: { name: string; organization: string; region: string; password: string }, signal?: AbortSignal) {
    z.string().trim().min(1).max(100).parse(input.name); organizationSlug.parse(input.organization);
    if (!/^[a-z0-9-]{2,80}$/.test(input.region)) throw new PlatformError('INVALID_INPUT', 'Select a valid Supabase region.');
    return this.project(await this.call('/projects', 'POST', { name: input.name, organization_slug: input.organization, db_pass: input.password, region_selection: { type: 'specific', code: input.region } }, signal), true);
  }
  async health(ref: string, signal?: AbortSignal) {
    return providerResult(z.array(z.object({ name: text, status: text })).max(30), await this.call(`/projects/${providerRef.parse(ref)}/health?services=db,auth,rest,storage,realtime`, 'GET', undefined, signal));
  }
  async publishableKey(ref: string, signal?: AbortSignal) {
    const keys = providerResult(z.array(z.object({ type: text.optional(), api_key: z.string().max(4096).optional() })).max(100), await this.call(`/projects/${providerRef.parse(ref)}/api-keys?reveal=true`, 'GET', undefined, signal));
    const key = keys.find(k => k.type === 'publishable' && k.api_key?.startsWith('sb_publishable_'))?.api_key;
    if (!key) throw new PlatformError('CONFIGURATION_REQUIRED', 'Create a publishable API key in the Supabase project, then retry linking.');
    return providerResult(publicKey, key);
  }
  async migrations(ref: string, signal?: AbortSignal) { return providerResult(z.array(migration).max(2000), await this.call(`/projects/${providerRef.parse(ref)}/database/migrations`, 'GET', undefined, signal)); }
  async migration(ref: string, version: string, signal?: AbortSignal) {
    z.string().regex(/^[0-9]{1,20}$/).parse(version);
    return providerResult(migration.extend({ statements: z.array(z.string().max(256_000)).max(2000) }), await this.call(`/projects/${providerRef.parse(ref)}/database/migrations/${version}`, 'GET', undefined, signal));
  }
  async applyMigration(ref: string, name: string, query: string, signal?: AbortSignal) {
    if (!/^[a-z0-9_]{1,160}$/.test(name) || !query.trim() || Buffer.byteLength(query) > 256_000) throw new PlatformError('INVALID_INPUT', 'Invalid migration name or size.');
    await this.call(`/projects/${providerRef.parse(ref)}/database/migrations`, 'POST', { name, query }, signal);
  }
  async types(ref: string, signal?: AbortSignal) {
    const result = await this.call(`/projects/${providerRef.parse(ref)}/types/typescript?included_schemas=public`, 'GET', undefined, signal);
    return providerResult(z.object({ types: z.string().max(256_000) }), result).types;
  }
  async authConfig(ref: string, signal?: AbortSignal) {
    const result = await this.call(`/projects/${providerRef.parse(ref)}/config/auth`, 'GET', undefined, signal);
    return providerResult(z.object({ site_url: text, uri_allow_list: z.string().max(8000), external_email_enabled: z.boolean(), mailer_autoconfirm: z.boolean() }), result);
  }
  async configureAuth(ref: string, config: { site_url: string; uri_allow_list: string }, signal?: AbortSignal) {
    // Credentials and unrelated settings are not accepted through this capability.
    z.string().url().max(1000).parse(config.site_url); z.string().max(8000).parse(config.uri_allow_list);
    await this.call(`/projects/${providerRef.parse(ref)}/config/auth`, 'PATCH', config, signal);
  }
  async authFields(ref: string, fields: (keyof AuthPublic)[], signal?: AbortSignal) {
    const result = providerResult(z.record(z.string(), z.unknown()), await this.call(`/projects/${providerRef.parse(ref)}/config/auth`, 'GET', undefined, signal));
    const selected: Record<string, string | boolean | null> = {};
    for (const field of fields) {
      if (!(field in authPublicSchema.shape)) throw new PlatformError('INVALID_INPUT', 'Unsupported Auth field.');
      const value = result[field] ?? null;
      if (value !== null && typeof value !== 'string' && typeof value !== 'boolean' || typeof value === 'string' && value.length > 32_000) throw new PlatformError('PROVIDER_RESPONSE_INVALID', 'Supabase returned an invalid Auth field.', 502);
      selected[field] = value as string | boolean | null;
    }
    return selected;
  }
  async patchAuth(ref: string, fields: AuthPublic, secrets: Partial<Record<z.infer<typeof authSecretField>, string>>, signal?: AbortSignal) {
    const patch = authPublicSchema.parse(fields), privateFields = authSecretValuesSchema.parse(secrets);
    await this.call(`/projects/${providerRef.parse(ref)}/config/auth`, 'PATCH', { ...patch, ...privateFields }, signal);
  }
  async functions(ref: string, signal?: AbortSignal) {
    return providerResult(z.array(functionIdentity).max(200), await this.call(`/projects/${providerRef.parse(ref)}/functions`, 'GET', undefined, signal));
  }
  async deployFunction(ref: string, input: { slug: string; entrypoint: string; files: { path: string; content: string }[] }, signal?: AbortSignal) {
    resourceName.parse(input.slug);
    const form = new FormData();
    form.set('metadata', JSON.stringify({ name: input.slug, entrypoint_path: input.entrypoint, verify_jwt: true }));
    for (const file of input.files) form.append('file', new Blob([file.content], { type: 'application/typescript' }), file.path);
    return providerResult(functionIdentity, await this.call(`/projects/${providerRef.parse(ref)}/functions/deploy?slug=${input.slug}`, 'POST', form, signal), true);
  }
  async setFunctionSecrets(ref: string, values: { name: string; value: string }[], signal?: AbortSignal) {
    z.array(z.object({ name: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/).refine(name => !name.startsWith('SUPABASE_')), value: z.string().min(1).max(16_384) }).strict()).min(1).max(20).parse(values);
    await this.call(`/projects/${providerRef.parse(ref)}/secrets`, 'POST', values, signal);
  }
}
export const functionIdentity = z.object({ id: z.string().max(200), slug: resourceName, version: z.number().int().nonnegative(), status: z.string().max(80), verify_jwt: z.boolean(), ezbr_sha256: z.string().max(128).optional() });
