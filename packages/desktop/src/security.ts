export const rendererPreferences = {
  nodeIntegration: false,
  nodeIntegrationInWorker: false,
  nodeIntegrationInSubFrames: false,
  contextIsolation: true,
  sandbox: true,
  webSecurity: true,
  webviewTag: false,
  allowRunningInsecureContent: false,
  navigateOnDragDrop: false,
  spellcheck: false,
} as const;

/** Fixed setup destinations never carry app content, credentials, query strings or fragments. */
export function setupLinkAllowed(value: string) {
  if (['https://expo.dev/go', 'https://supabase.com/dashboard/account/tokens'].includes(value)) return true;
  try { return new URL(value).href === value && /^https:\/\/supabase\.com\/dashboard\/project\/[a-z0-9]{20}$/.test(value); }
  catch { return false; }
}

export { oauthAuthorizationAllowed } from '../../platform/src/oauth-contracts.js';

export function navigationAllowed(value: string, mainFrame: boolean, studioOrigin: string, previews: Set<string>) {
  try {
    const url = new URL(value);
    if (url.username || url.password) return false;
    if (mainFrame) return url.origin === studioOrigin && url.pathname === '/' && !url.search;
    return url.protocol === 'http:' && previews.has(url.origin);
  } catch { return false; }
}

export function managedOrigins(urls: string[]) {
  return new Set(urls.filter(value => {
    try { const url = new URL(value); return url.protocol === 'http:' && url.hostname === 'localhost' && !!url.port && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash; }
    catch { return false; }
  }).map(value => new URL(value).origin));
}

export function downloadAllowed(value: string, initiator: string, studioOrigin: string, mainFrame: boolean) {
  try {
    const url = new URL(value);
    return mainFrame && initiator === studioOrigin && url.origin === studioOrigin && ['blob:', 'http:'].includes(url.protocol) && !url.username && !url.password;
  } catch { return false; }
}

export function desktopEnvironment(input: NodeJS.ProcessEnv) {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'SHELL', 'USER', 'LOGNAME', 'NODE_EXTRA_CA_CERTS']) {
    if (input[name]) env[name] = input[name];
  }
  return env;
}

/** Subscription sign-in links emitted by the local Assistant runtime. */
export function assistantSignInAllowed(value: string) {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.port && !url.username && !url.password && ['auth.openai.com', 'auth.x.ai', 'accounts.x.ai', 'grok.com', 'x.ai'].includes(url.hostname); } catch { return false; }
}
