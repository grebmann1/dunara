import { z } from 'zod';
import { PlatformError } from './contracts.js';
import { boundedJson, type Fetcher } from './supabase.js';
import { hash } from './crypto.js';
import { randomUUID } from 'node:crypto';

export const accountConfigSchema = z.object({ url: z.url(), publishableKey: z.string().min(16).max(4096), allowLocal: z.boolean().default(false) }).strict().superRefine((value, ctx) => {
  const url = new URL(value.url);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || !(url.protocol === 'https:' || value.allowLocal && url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname))) ctx.addIssue({ code: 'custom', message: 'Use an HTTPS Supabase origin, or explicitly enable a loopback development instance.' });
  if (!value.publishableKey.startsWith('sb_publishable_') && !(value.allowLocal && value.publishableKey.split('.').length === 3)) ctx.addIssue({ code: 'custom', message: 'A publishable Supabase key is required.' });
});
export type AccountConfig = z.infer<typeof accountConfigSchema>;
const userSchema = z.object({ id: z.uuid(), email: z.email().optional() });
const sessionSchema = z.object({ access_token: z.string().min(16), refresh_token: z.string().min(8).max(16384), expires_in: z.number().positive(), user: userSchema });

/** Uses the user's JWT for all data requests. No service-role key or browser-supplied tenant role. */
export class AccountProvider {
  readonly config: AccountConfig;
  constructor(config: AccountConfig, private readonly request: Fetcher = fetch) { this.config = accountConfigSchema.parse(config); }
  async call(endpoint: string, method = 'GET', body?: unknown, token?: string) {
    let response: Response;
    try { response = await this.request(`${this.config.url.replace(/\/$/, '')}${endpoint}`, { method, headers: { apikey: this.config.publishableKey, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error', signal: AbortSignal.timeout(15_000) }); }
    catch { throw new PlatformError('ACCOUNT_UNAVAILABLE', 'The account service is unreachable. Check its configuration and connection.', 503); }
    if (!response.ok) {
      await response.body?.cancel();
      throw new PlatformError(response.status >= 500 ? 'ACCOUNT_UNAVAILABLE' : response.status === 429 ? 'ACCOUNT_RATE_LIMITED' : 'ACCOUNT_REQUEST_FAILED', response.status === 429 ? 'Too many account requests. Wait before trying again.' : response.status === 401 || response.status === 403 ? 'Your account session or permissions are unavailable. Sign in again.' : 'The account request failed. Check the code, service configuration, and your workspace permissions.', response.status >= 500 ? 503 : response.status === 429 ? 429 : response.status === 401 || response.status === 403 ? 401 : 400);
    }
    return boundedJson(response);
  }
  async user(token: string) { return userSchema.parse(await this.call('/auth/v1/user', 'GET', undefined, token)); }
  async authority(token: string, workspaceId: string) {
    const user = await this.user(token), id = z.uuid().parse(workspaceId);
    const rows = z.array(z.object({ role: z.enum(['owner', 'admin', 'editor', 'viewer']) })).max(1).parse(await this.call(`/rest/v1/workspace_memberships?workspace_id=eq.${id}&user_id=eq.${user.id}&select=role`, 'GET', undefined, token));
    const role = rows[0]?.role;
    if (!role) throw new PlatformError('FORBIDDEN', 'Workspace membership is required.', 403);
    return { id: user.id, workspaceId: id, role, source: 'account' as const };
  }
  async requestCode(email: string) { await this.call('/auth/v1/otp', 'POST', { email: z.email().max(254).parse(email), create_user: true }); }
  async verifyCode(email: string, code: string) { return sessionSchema.parse(await this.call('/auth/v1/verify', 'POST', { email: z.email().parse(email), token: z.string().regex(/^\d{6,10}$/).parse(code), type: 'email' })); }
  async refresh(token: string) { return sessionSchema.parse(await this.call('/auth/v1/token?grant_type=refresh_token', 'POST', { refresh_token: token })); }
  async logout(token: string) { await this.call('/auth/v1/logout?scope=local', 'POST', undefined, token); }
  async workspaces(token: string) { return z.array(z.object({ id: z.uuid(), name: z.string(), created_at: z.string() })).parse(await this.call('/rest/v1/workspaces?select=id,name,created_at&order=created_at', 'GET', undefined, token)); }
  async createWorkspace(token: string, name: string) { return z.uuid().parse(await this.call('/rest/v1/rpc/create_workspace', 'POST', { workspace_name: z.string().trim().min(1).max(100).parse(name) }, token)); }
  async personalWorkspace(token: string) { return z.uuid().parse(await this.call('/rest/v1/rpc/ensure_personal_workspace', 'POST', {}, token)); }
  async apps(token: string, workspaceId: string) { return z.array(z.object({ id: z.uuid(), workspace_id: z.uuid(), name: z.string(), slug: z.string(), created_at: z.string() })).parse(await this.call(`/rest/v1/apps?workspace_id=eq.${z.uuid().parse(workspaceId)}&select=id,workspace_id,name,slug,created_at&order=created_at`, 'GET', undefined, token)); }
  async registerApp(token: string, input: { id: string; workspaceId: string; name: string; slug: string }) {
    const value = z.object({ id: z.uuid(), workspaceId: z.uuid(), name: z.string().trim().min(1).max(100), slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(80) }).strict().parse(input);
    z.uuid().parse(await this.call('/rest/v1/rpc/register_app', 'POST', { app_id: value.id, target_workspace: value.workspaceId, app_name: value.name, app_slug: value.slug }, token));
    return { id: value.id, workspaceId: value.workspaceId };
  }
}

export const savedAccountSchema = z.object({ version: z.literal(1), service: z.string().length(64), userId: z.uuid(), refreshToken: z.string().min(8).max(16384) }).strict();
export type SavedAccount = z.infer<typeof savedAccountSchema>;
export interface AccountPersistence {
  available: boolean;
  load(): SavedAccount | undefined;
  save(value: SavedAccount): void;
  remove(): void;
}

/** Tokens stay in the service. A single refresh writer is fenced by every identity change. */
export class AccountSession {
  private session?: z.infer<typeof sessionSchema>;
  private expiresAt = 0;
  private revision = 0;
  private contextRevision = randomUUID();
  private refreshing?: Promise<string>;
  private restoring?: Promise<void>;
  private restoreAttempted = false;
  private remembered = false;
  private restoration: 'none' | 'restored' | 'locked' | 'expired' | 'unavailable' = 'none';
  constructor(private readonly provider?: AccountProvider, private readonly now = Date.now, private readonly persistence?: AccountPersistence) {}
  context() { return { owner: this.session?.user.id ?? 'local', revision: this.contextRevision }; }
  status() { return { available: !!this.provider, signedIn: !!this.session, user: this.session?.user ?? null, lifetime: this.remembered ? 'remembered' as const : 'session' as const, rememberAvailable: !!this.persistence?.available && this.restoration !== 'locked', restoration: this.restoration }; }
  private identity() { return hash({ url: new URL(this.service().config.url).origin, key: this.service().config.publishableKey }); }
  private service() { if (!this.provider) throw new PlatformError('CONFIGURATION_REQUIRED', 'Configure the Dunara account service before signing in.', 503); return this.provider; }
  private accept(value: z.infer<typeof sessionSchema>, revision: number, userId?: string) {
    if (revision !== this.revision) throw new PlatformError('SIGN_IN_REQUIRED', 'The account session changed.', 401);
    if (userId && value.user.id !== userId) throw new PlatformError('SIGN_IN_REQUIRED', 'The restored account identity did not match. Sign in again.', 401);
    if (this.remembered) this.persistence!.save({ version: 1, service: this.identity(), userId: value.user.id, refreshToken: value.refresh_token });
    if (this.session?.user.id !== value.user.id) this.contextRevision = randomUUID();
    this.session = value; this.expiresAt = this.now() + value.expires_in * 1000;
    return value.access_token;
  }
  restore(): Promise<void> {
    if (this.restoring) return this.restoring;
    if (this.restoreAttempted || !this.provider) return Promise.resolve();
    this.restoreAttempted = true;
    const revision = this.revision;
    const pending = (async () => {
      let saved: SavedAccount | undefined;
      try { saved = this.persistence?.load(); } catch { this.restoration = 'locked'; return; }
      if (!saved) return;
      if (saved.service !== this.identity()) { this.restoration = 'locked'; return; }
      try {
        const value = await this.service().refresh(saved.refreshToken);
        if (revision !== this.revision) return;
        this.remembered = true;
        this.accept(value, revision, saved.userId); this.restoration = 'restored';
      } catch (error) {
        if (revision !== this.revision) return;
        this.session = undefined; this.remembered = false;
        // Rejected/revoked refresh tokens cannot be restored. Network failures retain recoverable ciphertext.
        const rejected = error instanceof PlatformError && ['ACCOUNT_REQUEST_FAILED', 'SIGN_IN_REQUIRED'].includes(error.code);
        this.restoration = rejected ? 'expired' : 'unavailable';
        if (rejected) { try { this.persistence?.remove(); } catch { this.restoration = 'locked'; } }
      }
    })().finally(() => { if (this.restoring === pending) this.restoring = undefined; });
    this.restoring = pending; return pending;
  }
  async requestCode(email: string) { await this.service().requestCode(email); return { sent: true }; }
  async verify(email: string, code: string, remember = false) {
    if (this.restoration === 'locked') throw new PlatformError('CREDENTIAL_UNAVAILABLE', 'Saved account data is locked. Restore the original protection or explicitly forget the saved account before signing in again.', 400);
    if (remember && !this.status().rememberAvailable) throw new PlatformError('CONFIGURATION_REQUIRED', 'Protected account storage is unavailable. Sign in for this session or restore the original protection.', 400);
    this.clear(); this.restoreAttempted = true; this.persistence?.remove(); this.restoration = 'none';
    const revision = this.revision, value = await this.service().verifyCode(email, code);
    if (revision !== this.revision) throw new PlatformError('REVISION_CONFLICT', 'The sign-in attempt is no longer current.', 409);
    await this.service().personalWorkspace(value.access_token);
    if (revision !== this.revision) throw new PlatformError('REVISION_CONFLICT', 'The sign-in attempt is no longer current.', 409);
    this.remembered = remember;
    try { this.accept(value, revision); } catch (error) { this.clear(); throw error; }
    return this.status();
  }
  private async token(): Promise<string> {
    if (!this.session) throw new PlatformError('SIGN_IN_REQUIRED', 'Sign in to your Dunara account first.', 401);
    if (this.expiresAt - this.now() > 60_000) return this.session.access_token;
    if (this.refreshing) return this.refreshing;
    const revision = this.revision, { refresh_token: refreshToken, user } = this.session;
    const pending = this.service().refresh(refreshToken).then(value => this.accept(value, revision, user.id)).catch(error => {
      if (revision === this.revision) {
        const remembered = this.remembered; this.clear();
        const rejected = error instanceof PlatformError && ['ACCOUNT_REQUEST_FAILED', 'SIGN_IN_REQUIRED'].includes(error.code);
        this.restoration = rejected ? 'expired' : 'unavailable';
        if (rejected && remembered) { try { this.persistence?.remove(); } catch { this.restoration = 'locked'; } }
        this.remembered = false;
      }
      throw error;
    }).finally(() => { if (this.refreshing === pending) this.refreshing = undefined; });
    this.refreshing = pending; return pending;
  }
  async signOut() {
    const old = this.session; this.clear(); this.restoreAttempted = true;
    try { this.persistence?.remove(); this.restoration = 'none'; }
    catch { this.restoration = 'locked'; throw new PlatformError('CREDENTIAL_UNAVAILABLE', 'The session ended, but saved account data could not be removed. Restore storage access and sign out again.', 400); }
    if (old) await this.service().logout(old.access_token); return this.status();
  }
  // Shutdown clears memory without undoing the user's explicit opt-in.
  clear() { this.revision++; this.contextRevision = randomUUID(); this.session = undefined; this.expiresAt = 0; this.refreshing = undefined; this.remembered = false; }
  /** Private service-to-service transport. The callback result must never contain account tokens. */
  async authorized<T>(work: (token: string) => Promise<T>) {
    const revision = this.revision, token = await this.token();
    if (revision !== this.revision) throw new PlatformError('SIGN_IN_REQUIRED', 'The account session changed.', 401);
    const result = await work(token);
    if (revision !== this.revision) throw new PlatformError('SIGN_IN_REQUIRED', 'The account session changed.', 401);
    return result;
  }
  async workspaces() { return this.authorized(token => this.service().workspaces(token)); }
  async createWorkspace(name: string) { return this.authorized(token => this.service().createWorkspace(token, name)); }
  async registerApp(input: { id: string; workspaceId: string; name: string; slug: string }) { return this.authorized(token => this.service().registerApp(token, input)); }
}
