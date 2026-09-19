import { createClient } from '@supabase/supabase-js';
import { Platform } from 'react-native';
import { backendEnvironment, supabase } from './client';
import connection from '../../backend/connection.json';
import configuration from '../../backend/configuration.json';

export const googleSignInAvailable = Platform.OS === 'web' && !!supabase && (configuration.auth.settings as { external_google_enabled?: boolean }).external_google_enabled === true;

function client() {
  if (Platform.OS !== 'web' || typeof window === 'undefined' || !supabase) throw new Error('Use email-code sign-in in this mobile build.');
  const url = process.env.EXPO_PUBLIC_SUPABASE_URL || connection.url, key = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY || connection.publishableKey;
  if (!/^https:\/\/[a-z0-9]{20}\.supabase\.co$/.test(url) || !key.startsWith('sb_publishable_')) throw new Error('Connect this app first.');
  // Only the short-lived PKCE verifier survives the web redirect. User sessions remain in the shared client.
  const storage = { getItem(name: string) { if (!name.endsWith('-code-verifier')) return null; const saved = window.sessionStorage.getItem(name); if (!saved) return null; try { const parsed = JSON.parse(saved); if (parsed.expiresAt <= Date.now()) { window.sessionStorage.removeItem(name); return null; } return typeof parsed.value === 'string' ? parsed.value : null; } catch { return null; } }, setItem(name: string, value: string) { if (name.endsWith('-code-verifier')) window.sessionStorage.setItem(name, JSON.stringify({ value, expiresAt: Date.now() + 10 * 60_000 })); }, removeItem(name: string) { window.sessionStorage.removeItem(name); } };
  const storageKey = `builder-social-${new URL(url).hostname}-${backendEnvironment}`;
  const clearVerifier = () => { for (const name of Object.keys(window.sessionStorage)) if (name.startsWith(`${storageKey}-`) && name.endsWith('-code-verifier')) window.sessionStorage.removeItem(name); };
  return { url, clearVerifier, auth: createClient(url, key, { auth: { flowType: 'pkce', storage, storageKey, persistSession: true, detectSessionInUrl: false, autoRefreshToken: false } }).auth };
}
export async function startGoogleSignIn() {
  if (!googleSignInAvailable) throw new Error('Google sign-in has not been configured.');
  const { auth, url, clearVerifier } = client(); clearVerifier();
  const redirectTo = new URL('/oauth-callback', window.location.origin).href;
  const { data, error } = await auth.signInWithOAuth({ provider: 'google', options: { redirectTo, skipBrowserRedirect: true } });
  if (error || !data.url) throw new Error('Google sign-in is unavailable. Try email sign-in.');
  const target = new URL(data.url);
  if (target.origin !== url || target.pathname !== '/auth/v1/authorize') throw new Error('The sign-in redirect is unavailable.');
  window.location.assign(target.href);
}
let exchanging: Promise<void> | undefined;
export function finishGoogleSignIn(clearRoute: () => void) {
  return exchanging ??= (async () => {
    const url = new URL(window.location.href), code = url.searchParams.get('code');
    window.history.replaceState(window.history.state, '', '/oauth-callback');
    clearRoute();
    const { auth, clearVerifier } = client();
    try {
      if (!code || code.length > 4096 || url.searchParams.getAll('code').length !== 1 || url.hash) throw new Error('This sign-in link is unavailable. Start again.');
      const { data, error } = await auth.exchangeCodeForSession(code);
      if (error || !data.session) throw new Error('The sign-in request expired. Start again.');
      const result = await supabase!.auth.setSession({ access_token: data.session.access_token, refresh_token: data.session.refresh_token });
      if (result.error) throw new Error('Your account session could not be restored.');
    } finally { clearVerifier(); }
  })();
}
