import { z } from 'zod';
import { PlatformError, providerRef } from './contracts.js';
import { privateBucket, resourceName } from './configuration.js';
import { boundedJson, type Fetcher } from './supabase.js';

/** Bucket lifecycle uses Storage's HTTP API, with a project server key. */
export class SupabaseStorage {
  private readonly origin: string;
  constructor(ref: string, private readonly credential: string, private readonly request: Fetcher = fetch) {
    this.origin = `https://${providerRef.parse(ref)}.supabase.co`;
    if (!/^sb_secret_[A-Za-z0-9_-]{16,}$/.test(credential)) throw new PlatformError('SECRET_REQUIRED', 'A project server secret API key is required for Storage.');
  }
  private async call(endpoint: string, method: string, body?: unknown, signal?: AbortSignal) {
    let response: Response;
    try { response = await this.request(`${this.origin}/storage/v1${endpoint}`, { method, headers: { apikey: this.credential, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000) }); }
    catch { throw new PlatformError(method === 'GET' ? 'PROVIDER_UNAVAILABLE' : 'RECONCILIATION_REQUIRED', 'Storage did not confirm the request. Inspect operation evidence before retrying.', 502); }
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 404 && method === 'GET') return null;
      throw new PlatformError(response.status === 401 || response.status === 403 ? 'PROVIDER_PERMISSION_REQUIRED' : method !== 'GET' && response.status >= 500 ? 'RECONCILIATION_REQUIRED' : 'PROVIDER_REQUEST_FAILED', 'Storage rejected the request. Check the project credential and resource prerequisites.', 502);
    }
    try { return await boundedJson(response); }
    catch { throw new PlatformError(method === 'GET' ? 'PROVIDER_RESPONSE_INVALID' : 'RECONCILIATION_REQUIRED', 'Storage returned an unreadable response. Inspect the resource before retrying.', 502); }
  }
  async bucket(id: string, signal?: AbortSignal) {
    const result = await this.call(`/bucket/${resourceName.parse(id)}`, 'GET', undefined, signal);
    if (result === null) return null;
    const shape = z.object({ id: resourceName, public: z.boolean(), file_size_limit: z.union([z.number(), z.string(), z.null()]), allowed_mime_types: z.array(z.string()).nullable(), type: z.string().optional() }).safeParse(result);
    if (!shape.success) throw new PlatformError('PROVIDER_RESPONSE_INVALID', 'Storage returned an unsupported bucket configuration.', 502);
    const bucket = shape.data;
    if (bucket.id !== id || bucket.public || bucket.type && bucket.type !== 'STANDARD') throw new PlatformError('RESOURCE_CONFLICT', 'The existing bucket has a different identity, public access, or unsupported type. Choose a new private bucket name.', 409);
    const parsed = privateBucket.safeParse({ id: bucket.id, public: false, file_size_limit: bucket.file_size_limit === null ? null : Number(bucket.file_size_limit), allowed_mime_types: bucket.allowed_mime_types?.slice().sort() });
    if (!parsed.success) throw new PlatformError('RESOURCE_CONFLICT', 'The existing bucket has unsupported or unrestricted limits. Review it in Supabase before configuring it in Dunara.', 409);
    return parsed.data;
  }
  async configure(bucket: z.infer<typeof privateBucket>, exists: boolean, signal?: AbortSignal) {
    const value = privateBucket.parse(bucket);
    await this.call(exists ? `/bucket/${value.id}` : '/bucket', exists ? 'PUT' : 'POST', exists ? { public: false, file_size_limit: value.file_size_limit, allowed_mime_types: value.allowed_mime_types } : { ...value, name: value.id }, signal);
  }
}
