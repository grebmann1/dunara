import { z } from 'zod';

export const oauthBrokerOrigin = z.url().refine(value => { const url = new URL(value); return url.protocol === 'https:' && url.pathname === '/' && !url.username && !url.password && !url.search && !url.hash; }, 'Use an HTTPS broker origin.');
export const managementActions = z.enum(['organizations', 'projects', 'getProject', 'createProject', 'health', 'publishableKey', 'migrations', 'migration', 'applyMigration', 'types', 'authConfig', 'configureAuth', 'authFields', 'patchAuth', 'functions', 'deployFunction', 'setFunctionSecrets']);
export type ManagementAction = z.infer<typeof managementActions>;
export const managementRequest = z.object({ connectionId: z.uuid(), revision: z.uuid(), action: managementActions, args: z.array(z.unknown()).max(4) }).strict();

/** Supabase authorization uses a separate, narrowly validated browser handoff. */
export function oauthAuthorizationAllowed(value: string) {
  try {
    const url = new URL(value), keys = ['response_type', 'client_id', 'redirect_uri', 'state', 'organization_slug', 'code_challenge', 'code_challenge_method'];
    if (value.length > 8192 || url.origin !== 'https://api.supabase.com' || url.pathname !== '/v1/oauth/authorize' || url.username || url.password || url.hash || [...url.searchParams.keys()].some(key => !keys.includes(key)) || keys.some(key => url.searchParams.getAll(key).length !== 1)) return false;
    const callback = new URL(url.searchParams.get('redirect_uri')!);
    return callback.protocol === 'https:' && !callback.username && !callback.password && !callback.search && !callback.hash && callback.pathname === '/v1/oauth/supabase/callback' && url.searchParams.get('response_type') === 'code' && url.searchParams.get('code_challenge_method') === 'S256' && /^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get('state')!) && /^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get('code_challenge')!) && /^[A-Za-z0-9_-]{1,200}$/.test(url.searchParams.get('client_id')!) && /^[A-Za-z0-9_-]{1,100}$/.test(url.searchParams.get('organization_slug')!);
  } catch { return false; }
}

