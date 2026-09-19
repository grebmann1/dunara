import { createClient } from '@supabase/supabase-js';
import { AppState, Platform } from 'react-native';
import { sessionStorage } from './session-storage';
import connection from '../../backend/connection.json';
import type { Database } from './database.types';

// Only public configuration is bundled. Never add a management token or secret key here.
const url = process.env.EXPO_PUBLIC_SUPABASE_URL || connection.url;
const publishableKey = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY || connection.publishableKey;
export const backendEnvironment = process.env.EXPO_PUBLIC_BUILDER_ENVIRONMENT || connection.environment;
const configured = /^https:\/\/[a-z0-9]{20}\.supabase\.co$/.test(url) && publishableKey.startsWith('sb_publishable_');
export const supabase = configured ? createClient<Database>(url, publishableKey, { auth: { storage: sessionStorage, persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: `builder-${new URL(url).hostname.split('.')[0]}-${backendEnvironment}` } }) : null;
// Native foreground refresh. Expo Go uses an email code, so no custom callback scheme is needed.
if (Platform.OS !== 'web' && supabase) {
  if (AppState.currentState === 'active') supabase.auth.startAutoRefresh(); else supabase.auth.stopAutoRefresh();
  AppState.addEventListener('change', state => { if (state === 'active') supabase.auth.startAutoRefresh(); else supabase.auth.stopAutoRefresh(); });
}
