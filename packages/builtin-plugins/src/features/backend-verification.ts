import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { PlatformError, publicError, type Actor, type BackendBinding } from "../../../platform/src/contracts.js";
import { boundedJson, type Fetcher } from "../../../platform/src/supabase.js";
import { PlatformStore, type Lease } from "../../../platform/src/store.js";
import type { ConfigurationStep } from "../../../platform/src/configuration.js";

type Verification = Extract<ConfigurationStep, { kind: 'verification' }>;
type Manifest = { projectRef: string; ownerId: string; noteId?: string; bucket?: string; object?: string; probeObject?: string; fixtureId: string };
/** Fixed, bounded development fixtures. Response bodies and app-user tokens never enter evidence. */
export class BackendVerification {
  constructor(private readonly store: PlatformStore, private readonly actor: Actor, private readonly request: Fetcher = fetch) {}
  private async call(binding: BackendBinding, endpoint: string, method: string, token?: string, body?: unknown, signal?: AbortSignal) {
    let response: Response;
    try { response = await this.request(`${binding.url}${endpoint}`, { method, headers: { apikey: binding.publishableKey, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': typeof body === 'string' ? 'text/plain' : 'application/json' }), Prefer: 'return=representation' }, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }), redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000) }); }
    catch { throw new PlatformError(method === 'GET' ? 'PROVIDER_UNAVAILABLE' : 'RECONCILIATION_REQUIRED', 'The development verification request was not confirmed. Check recorded fixture resources before continuing.', 502); }
    return response;
  }
  async user(binding: BackendBinding, token: string, signal?: AbortSignal) {
    const response = await this.call(binding, '/auth/v1/user', 'GET', token, undefined, signal);
    if (!response.ok) { await response.body?.cancel(); throw new PlatformError('SECRET_REQUIRED', 'The isolated development app-user session is unavailable. Sign in again and replace its private input.'); }
    const parsed = z.object({ id: z.uuid() }).safeParse(await boundedJson(response, 32_000));
    if (!parsed.success) throw new PlatformError('PROVIDER_RESPONSE_INVALID', 'Auth did not confirm the test-user identity.');
    return parsed.data.id;
  }
  private manifest(projectId: string, fixtureId: string) { return this.store.getRecord<Manifest>(this.actor, 'verification-fixture', `${projectId}:${fixtureId}`); }
  cleanupTarget(projectId: string, fixtureId: string) { const value = this.manifest(projectId, fixtureId); if (!value) throw new PlatformError('FIXTURE_NOT_FOUND', 'Cleanup only supports fixture resources recorded by this Dunara workspace.'); return value; }
  report(projectId: string, fixtureId: string) { return this.store.getRecord<Record<string, unknown>>(this.actor, 'verification-report', `${projectId}:${fixtureId}`); }
  async execute(lease: Lease, binding: BackendBinding, step: Verification, tokens: { owner?: string; other?: string }, signal: AbortSignal) {
    if (binding.environment !== 'development') throw new PlatformError('FORBIDDEN', 'Fixture writes are restricted to development.', 403);
    const evidence: { check: string; status: 'pass' | 'fail' | 'not_run' }[] = [];
    try {
    async function ok(response: Response, name: string) { const pass = response.ok; await response.body?.cancel(); evidence.push({ check: name, status: pass ? 'pass' : 'fail' }); if (!pass) throw new PlatformError('VERIFICATION_FAILED', `Development verification failed: ${name}. Recorded fixture resources were retained.`); }
    const checkRows = async (token: string | undefined, id: string, expected: number, name: string, method = 'GET', body?: unknown) => {
      const response = await this.call(binding, `/rest/v1/notes?id=eq.${id}&select=id,owner_id,body`, method, token, body, signal);
      if (!response.ok && expected === 0 && [401, 403].includes(response.status)) { await response.body?.cancel(); evidence.push({ check: name, status: 'pass' }); return; }
      const parsed = z.array(z.object({ id: z.uuid(), owner_id: z.uuid(), body: z.string().max(2000) })).max(1).safeParse(await boundedJson(response, 8192));
      if (!response.ok || !parsed.success || parsed.data.length !== expected || parsed.data.some(row => row.id !== id || row.owner_id !== step.ownerId)) throw new PlatformError('VERIFICATION_FAILED', `Development verification failed: ${name}.`);
      evidence.push({ check: name, status: 'pass' });
    };
    if (step.scenario === 'email') {
      await ok(await this.call(binding, '/auth/v1/otp', 'POST', undefined, { email: step.recipient, create_user: false }, signal), 'code_request_accepted');
      evidence.push({ check: 'mailbox_delivery_and_code_lifecycle', status: 'not_run' });
      return { evidence, qualification: 'partial', detail: 'Supabase accepted the request. Delivery, expired/wrong/reused code rejection, refresh and sign-out require the designated mailbox/device.' };
    }
    if (!tokens.owner || await this.user(binding, tokens.owner, signal) !== step.ownerId) throw new PlatformError('SECRET_REQUIRED', 'The reviewed owner session changed.');
    if (step.scenario !== 'cleanup' && (!tokens.other || await this.user(binding, tokens.other, signal) !== step.otherId || step.ownerId === step.otherId)) throw new PlatformError('SECRET_REQUIRED', 'Verification requires two distinct isolated development users.');
    const manifest: Manifest = step.scenario === 'cleanup' ? this.cleanupTarget(binding.projectId, step.fixtureId) : { projectRef: binding.projectRef, ownerId: step.ownerId!, fixtureId: step.fixtureId, ...(step.scenario === 'records' || step.scenario === 'function' ? { noteId: step.fixtureId } : {}), ...(step.scenario === 'storage' ? { bucket: step.bucket!, object: `${step.ownerId}/builder-check-${step.fixtureId}.txt`, probeObject: `${step.ownerId}/builder-denied-${step.fixtureId}.txt` } : {}) };
    if (manifest.projectRef !== binding.projectRef || manifest.ownerId !== step.ownerId) throw new PlatformError('FORBIDDEN', 'The recorded fixture belongs to another backend or app user.', 403);
    if (step.scenario !== 'cleanup') {
      if (this.manifest(binding.projectId, step.fixtureId)) throw new PlatformError('RECONCILIATION_REQUIRED', 'This fixture already has a resource record. Inspect it or prepare cleanup; it will not be replayed.', 409);
      this.store.putLeasedRecord(lease, 'verification-fixture', `${binding.projectId}:${step.fixtureId}`, manifest);
    }
    if (step.scenario === 'records' || step.scenario === 'function') {
      await ok(await this.call(binding, '/rest/v1/notes', 'POST', tokens.owner, { id: manifest.noteId, owner_id: step.ownerId, body: 'Dunara development verification fixture' }, signal), 'owner_insert');
      await checkRows(tokens.owner, manifest.noteId!, 1, 'owner_read');
      await checkRows(tokens.other, manifest.noteId!, 0, 'other_user_read_denied');
      await checkRows(undefined, manifest.noteId!, 0, 'anonymous_read_denied');
      await checkRows(tokens.other, manifest.noteId!, 0, 'other_user_update_denied', 'PATCH', { body: 'Unauthorized change' });
      await checkRows(tokens.other, manifest.noteId!, 0, 'other_user_delete_denied', 'DELETE');
      await checkRows(tokens.owner, manifest.noteId!, 1, 'owner_update', 'PATCH', { body: 'Dunara verified owner update' });
      if (step.scenario === 'function') {
        await ok(await this.call(binding, `/functions/v1/${step.functionSlug}`, 'POST', tokens.owner, { noteId: manifest.noteId }, signal), 'authenticated_function');
        for (const [name, token] of [['other_user_function_denied', tokens.other], ['anonymous_function_denied', undefined]] as const) {
          const response = await this.call(binding, `/functions/v1/${step.functionSlug}`, 'POST', token, { noteId: manifest.noteId }, signal);
          const denied = [401, 403, 404].includes(response.status); await response.body?.cancel();
          if (!denied) throw new PlatformError('VERIFICATION_FAILED', `Development verification failed: ${name}.`); evidence.push({ check: name, status: 'pass' });
        }
      }
      await checkRows(tokens.owner, manifest.noteId!, 1, 'owner_delete', 'DELETE');
      await checkRows(tokens.owner, manifest.noteId!, 0, 'owner_delete_confirmed');
    }
    if (step.scenario === 'storage') {
      const objectPath = `/storage/v1/object/${manifest.bucket}/${manifest.object}`;
      await ok(await this.call(binding, objectPath, 'POST', tokens.owner, 'Dunara private upload fixture', signal), 'owner_upload');
      await ok(await this.call(binding, objectPath, 'GET', tokens.owner, undefined, signal), 'owner_download');
      await ok(await this.call(binding, objectPath, 'PUT', tokens.owner, 'Dunara owner update', signal), 'owner_object_update');
      for (const [name, token] of [['other_user', tokens.other], ['anonymous', undefined]] as const) for (const method of ['GET', 'PUT']) {
        const response = await this.call(binding, objectPath, method, token, method === 'PUT' ? 'Unauthorized' : undefined, signal);
        const denied = [400, 401, 403, 404].includes(response.status); await response.body?.cancel();
        if (!denied) throw new PlatformError('VERIFICATION_FAILED', `Development verification failed: ${name}_${method}_denied.`);
        evidence.push({ check: `${name}_${method}_denied`, status: 'pass' });
      }
      for (const [name, token] of [['other_user', tokens.other], ['anonymous', undefined]] as const) {
        const insert = await this.call(binding, `/storage/v1/object/${manifest.bucket}/${manifest.probeObject}`, 'POST', token, 'Unauthorized', signal);
        const denied = [400, 401, 403].includes(insert.status); await insert.body?.cancel();
        if (!denied) throw new PlatformError('VERIFICATION_FAILED', `Development verification failed: ${name}_upload_denied.`);
        evidence.push({ check: `${name}_upload_denied`, status: 'pass' });
        const deletion = await this.call(binding, `/storage/v1/object/${manifest.bucket}`, 'DELETE', token, { prefixes: [manifest.object] }, signal);
        const deleteChecked = deletion.ok || [400, 401, 403].includes(deletion.status); await deletion.body?.cancel();
        if (!deleteChecked) throw new PlatformError('VERIFICATION_FAILED', `Development verification could not establish ${name}_delete_denied.`);
        await ok(await this.call(binding, objectPath, 'GET', tokens.owner, undefined, signal), `${name}_delete_denied`);
      }
      const signed = await this.call(binding, `/storage/v1/object/sign/${manifest.bucket}/${manifest.object}`, 'POST', tokens.owner, { expiresIn: 1 }, signal);
      const data = z.object({ signedURL: z.string().max(8192) }).safeParse(await boundedJson(signed, 16_384));
      if (!signed.ok || !data.success || !data.data.signedURL.startsWith(`/object/sign/${manifest.bucket}/${manifest.object}?`)) throw new PlatformError('VERIFICATION_FAILED', 'Storage did not return the expected signed object URL.');
      await ok(await this.call(binding, `/storage/v1${data.data.signedURL}`, 'GET', undefined, undefined, signal), 'signed_url_initial');
      await delay(2200, undefined, { signal });
      const expired = await this.call(binding, `/storage/v1${data.data.signedURL}`, 'GET', undefined, undefined, signal); const denied = [400, 401, 403].includes(expired.status); await expired.body?.cancel();
      if (!denied) throw new PlatformError('VERIFICATION_FAILED', 'The short-lived signed URL did not expire.'); evidence.push({ check: 'signed_url_expiry', status: 'pass' });
      await ok(await this.call(binding, `/storage/v1/object/${manifest.bucket}`, 'DELETE', tokens.owner, { prefixes: [manifest.object] }, signal), 'owner_object_delete');
      const deleted = await this.call(binding, objectPath, 'GET', tokens.owner, undefined, signal);
      const absent = [400, 404].includes(deleted.status); await deleted.body?.cancel();
      if (!absent) throw new PlatformError('VERIFICATION_FAILED', 'The deleted owner object remains available.'); evidence.push({ check: 'owner_delete_confirmed', status: 'pass' });
    }
    if (step.scenario === 'cleanup') {
      if (manifest.noteId) { await ok(await this.call(binding, `/rest/v1/notes?id=eq.${manifest.noteId}`, 'DELETE', tokens.owner, undefined, signal), 'recorded_note_cleanup'); await checkRows(tokens.owner, manifest.noteId, 0, 'note_cleanup_confirmed'); }
      if (manifest.object) {
        await ok(await this.call(binding, `/storage/v1/object/${manifest.bucket}`, 'DELETE', tokens.owner, { prefixes: [manifest.object, manifest.probeObject].filter(Boolean) }, signal), 'recorded_object_cleanup');
        for (const object of [manifest.object, manifest.probeObject].filter(Boolean)) {
          const response = await this.call(binding, `/storage/v1/object/${manifest.bucket}/${object}`, 'GET', tokens.owner, undefined, signal), absent = [400, 404].includes(response.status); await response.body?.cancel();
          if (!absent) throw new PlatformError('VERIFICATION_FAILED', 'Recorded fixture cleanup could not be confirmed.');
        }
        evidence.push({ check: 'object_cleanup_confirmed', status: 'pass' });
      }
    }
    this.store.putLeasedRecord(lease, 'verification-fixture', `${binding.projectId}:${step.fixtureId}`, { ...manifest, cleanedAt: new Date().toISOString() });
    return { evidence, qualification: 'service_checks_only', checkedAt: new Date().toISOString(), fixtureId: step.fixtureId };
    } catch (error) {
      this.store.putLeasedRecord(lease, 'verification-report', `${binding.projectId}:${step.fixtureId}`, { fixtureId: step.fixtureId, evidence, failure: publicError(error), checkedAt: new Date().toISOString(), fixturesRetained: !!this.manifest(binding.projectId, step.fixtureId) });
      throw error;
    }
  }
}
