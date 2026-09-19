import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AccountSession } from "../../../platform/src/accounts.js";
import { PlatformError, publicError } from "../../../platform/src/contracts.js";
import { oauthBrokerOrigin, managementActions } from "../../../platform/src/oauth-contracts.js";
import { boundedJson, SupabaseManagement, type Fetcher } from "../../../platform/src/supabase.js";

const connectionSchema = z.object({ id: z.uuid(), actorId: z.uuid(), workspaceId: z.uuid(), organization: z.string(), revision: z.uuid(), state: z.enum(['connected', 'revoked', 'reconnect_required']) });
export class BackendOAuth {
  private selected?: z.infer<typeof connectionSchema>;
  private pending?: { handoffId: string; workspaceId: string; userId: string; expiresAt: string; authorizationUrl: string };
  private generation = 0;
  private localRevision = randomUUID();
  private persistence?: { read: (userId: string) => unknown; write: (userId: string, value: unknown) => void };
  private restoredUser?: string;
  attachPersistence(persistence: { read: (userId: string) => unknown; write: (userId: string, value: unknown) => void }) { this.persistence = persistence; }
  constructor(private readonly account: AccountSession, private readonly origin?: string, private readonly request: Fetcher = fetch) { if (origin) oauthBrokerOrigin.parse(origin); }
  status() {
    const userId = this.account.status().user?.id;
    if (this.selected && this.selected.actorId !== userId || this.pending && this.pending.userId !== userId) this.clear();
    if (userId && userId !== this.restoredUser && !this.selected) {
      this.restoredUser = userId;
      const saved = z.object({ origin: z.string(), connection: connectionSchema }).safeParse(this.persistence?.read(userId));
      if (saved.success && saved.data.origin === this.origin && saved.data.connection.actorId === userId) { this.selected = saved.data.connection; this.localRevision = randomUUID(); }
    }
    return { available: !!this.origin, signedIn: !!userId, connected: this.selected?.state === 'connected', connection: this.selected ?? null, revision: this.localRevision, pending: this.pending ? { expiresAt: this.pending.expiresAt, authorizationUrl: this.pending.authorizationUrl } : null };
  }
  private async call<T>(workspaceId: string, action: string, input: unknown): Promise<T> {
    if (!this.origin) throw new PlatformError('CONFIGURATION_REQUIRED', 'Configure the hosted OAuth broker origin in Dunara service settings.');
    const generation = this.generation;
    return this.account.authorized(async token => {
      let response: Response;
      try { response = await this.request(`${this.origin!.replace(/\/$/, '')}/v1/oauth/supabase/${action}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ workspaceId, input }), redirect: 'error', signal: AbortSignal.timeout(45_000) }); }
      catch { throw new PlatformError(action === 'invoke' ? 'RECONCILIATION_REQUIRED' : 'OAUTH_UNAVAILABLE', 'The hosted connection did not confirm the request. Inspect pending work before retrying.', 502); }
      const result = await boundedJson(response, 2_000_000);
      if (generation !== this.generation) throw new PlatformError('CONNECTION_REQUIRED', 'The Dunara account or connection changed.', 401);
      if (!response.ok) {
        const error = z.object({ error: z.object({ code: z.string().max(100), message: z.string().max(500) }) }).safeParse(result);
        const safe = error.success ? error.data.error : publicError(null);
        if (response.status === 401 || safe.code === 'CONNECTION_REQUIRED' || safe.code === 'REVISION_CONFLICT') { if (this.selected) this.selected.state = 'reconnect_required'; this.localRevision = randomUUID(); }
        throw new PlatformError(safe.code, safe.message, response.status);
      }
      return result as T;
    });
  }
  async start(input: unknown) {
    this.status();
    const value = z.object({ workspaceId: z.uuid(), organization: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/) }).strict().parse(input), userId = this.account.status().user?.id;
    if (!userId) throw new PlatformError('SIGN_IN_REQUIRED', 'Sign in to Dunara before connecting Supabase.', 401);
    const pending = await this.call<{ handoffId: string; authorizationUrl: string; expiresAt: string }>(value.workspaceId, 'start', { organization: value.organization, ...(this.selected?.workspaceId === value.workspaceId ? { connectionId: this.selected.id } : {}) });
    const url = new URL(pending.authorizationUrl);
    if (url.origin !== 'https://api.supabase.com' || url.pathname !== '/v1/oauth/authorize' || url.username || url.password || url.hash || url.searchParams.get('redirect_uri') !== `${this.origin!.replace(/\/$/, '')}/v1/oauth/supabase/callback` || url.searchParams.get('code_challenge_method') !== 'S256') throw new PlatformError('OAUTH_RESPONSE_INVALID', 'The broker returned an invalid authorization handoff.');
    this.pending = { ...pending, workspaceId: value.workspaceId, userId }; return this.status();
  }
  async poll() {
    this.status(); const pending = this.pending;
    if (!pending) throw new PlatformError('OAUTH_STATE_INVALID', 'Start a Supabase connection first.');
    const status = await this.call<{ phase: 'pending' | 'complete'; completionRef?: string }>(pending.workspaceId, 'poll', { handoffId: pending.handoffId });
    if (status.phase === 'complete' && status.completionRef) {
      const connection = connectionSchema.parse(await this.call(pending.workspaceId, 'complete', { handoffId: pending.handoffId, completionRef: status.completionRef }));
      if (connection.actorId !== pending.userId || connection.workspaceId !== pending.workspaceId) throw new PlatformError('FORBIDDEN', 'The returned connection belongs to another account.', 403);
      this.selected = connection; this.pending = undefined; this.localRevision = randomUUID();
      this.persistence?.write(connection.actorId, { origin: this.origin, connection });
    }
    return this.status();
  }
  async disconnect() {
    this.status(); const selected = this.selected, pending = this.pending;
    try { if (pending) await this.call(pending.workspaceId, 'cancel', { handoffId: pending.handoffId }); if (selected) return await this.call(selected.workspaceId, 'revoke', { connectionId: selected.id }); }
    finally { if (selected) this.persistence?.write(selected.actorId, null); this.clear(); }
    return { state: 'revoked', remoteRevoked: false };
  }
  clear() { this.generation++; this.selected = undefined; this.pending = undefined; this.restoredUser = undefined; this.localRevision = randomUUID(); }
  provider(): SupabaseManagement {
    if (!this.status().connected || !this.selected) throw new PlatformError('CONNECTION_REQUIRED', 'Reconnect Supabase in Settings.', 401);
    const connection = { ...this.selected };
    // A typed facade forwards only the named management methods. Tokens never return to desktop.
    return new Proxy(new SupabaseManagement('hosted-oauth-facade'), { get: (_target, key) => {
      if (typeof key !== 'string' || !managementActions.options.includes(key as typeof managementActions.options[number])) return undefined;
      return async (...values: unknown[]) => {
        const current = this.status();
        if (!current.connected || current.connection?.id !== connection.id || current.connection.revision !== connection.revision) throw new PlatformError('CONNECTION_REQUIRED', 'The Supabase connection changed.', 401);
        const args = values.filter(value => value !== undefined && !(value instanceof AbortSignal));
        if (key === 'deployFunction') { const artifact = args[1] as { slug: string; entrypoint: string; files: { path: string; content: string }[] }; args[1] = { slug: artifact.slug, entrypoint: artifact.entrypoint, files: artifact.files.map(f => ({ path: f.path, content: f.content })) }; }
        const response = await this.call<{ result: unknown }>(connection.workspaceId, 'invoke', { connectionId: connection.id, revision: connection.revision, action: key, args });
        return response.result;
      };
    } });
  }
}
