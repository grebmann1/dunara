import { expect, it } from 'vitest';
import { desktopEnvironment, downloadAllowed, managedOrigins, navigationAllowed, rendererPreferences, setupLinkAllowed } from './security.js';

const studio = 'http://127.0.0.1:4000';
const previews = new Set(['http://localhost:5000']);
it('opens only the exact official phone and Supabase setup destinations', () => {
  for (const url of ['https://expo.dev/go', 'https://supabase.com/dashboard/account/tokens', 'https://supabase.com/dashboard/project/abcdefghijklmnopqrst']) {
    expect(setupLinkAllowed(url)).toBe(true);
    expect(setupLinkAllowed(url + '?token=private-canary')).toBe(false);
    expect(setupLinkAllowed(url + '#private-canary')).toBe(false);
    expect(setupLinkAllowed(url + '\n')).toBe(false);
    expect(navigationAllowed(url, true, studio, previews)).toBe(false);
  }
  for (const url of ['https://expo.dev.evil.test/go', 'https://expo.dev/@untrusted/app', 'https://supabase.com/dashboard/project/too-short', 'https://supabase.com/dashboard/project/abcdefghijklmnopqrst/settings/api', 'https://supabase.com/dashboard/account/tokens/redirect', 'https://user:secret@expo.dev/go', 'https://expo.dev:8443/go', 'http://expo.dev/go', 'file:///tmp/help.html', 'javascript:alert(1)', 'exp://192.168.1.20:8081']) expect(setupLinkAllowed(url)).toBe(false);
});
it('locks down renderer privileges without exposing a preload bridge', () => {
  expect(rendererPreferences).toMatchObject({ sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false, nodeIntegrationInWorker: false, webSecurity: true, webviewTag: false });
  expect(rendererPreferences).not.toHaveProperty('preload');
});
it('restricts navigation to Studio and exact managed app origins', () => {
  expect(navigationAllowed(`${studio}/#ticket`, true, studio, previews)).toBe(true);
  expect(navigationAllowed('http://localhost:5000/habit', false, studio, previews)).toBe(true);
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'https://example.com', 'http://localhost:5001', 'http://localhost:5000.evil.test', 'http://user@localhost:5000']) {
    expect(navigationAllowed(url, false, studio, previews)).toBe(false);
    expect(navigationAllowed(url, true, studio, previews)).toBe(false);
  }
  expect(navigationAllowed(`${studio}/api/projects`, true, studio, previews)).toBe(false);
  expect(navigationAllowed(studio, false, studio, previews)).toBe(false);
  expect(managedOrigins(['http://localhost:5000', studio, 'file:///tmp', 'http://localhost:5000/evil'])).toEqual(previews);
});
it('allows only top-level Studio-owned downloads', () => {
  expect(downloadAllowed(`blob:${studio}/uuid`, studio, studio, true)).toBe(true);
  expect(downloadAllowed(`${studio}/api/file`, studio, studio, true)).toBe(true);
  expect(downloadAllowed(`blob:${studio}/uuid`, studio, studio, false)).toBe(false);
  expect(downloadAllowed('blob:http://localhost:5000/uuid', 'http://localhost:5000', studio, false)).toBe(false);
  expect(downloadAllowed('https://example.com/file', studio, studio, true)).toBe(false);
  expect(downloadAllowed(`blob:${studio}/uuid`, 'http://localhost:5000', studio, true)).toBe(false);
});
it('does not inherit credentials, Node injection, or Electron overrides', () => {
  expect(desktopEnvironment({ PATH: '/bin', HOME: '/tmp/home', OPENAI_API_KEY: 'secret', NODE_OPTIONS: '--import attacker', ELECTRON_RUN_AS_NODE: '1', AWS_SECRET_ACCESS_KEY: 'private', DYLD_INSERT_LIBRARIES: 'bad' })).toEqual({ PATH: '/bin', HOME: '/tmp/home' });
});

it('opens only known HTTPS Assistant sign-in hosts without embedded credentials', async () => {
  const { assistantSignInAllowed } = await import('./security.js');
  for (const url of ['https://auth.openai.com/oauth/authorize?state=test', 'https://auth.x.ai/activate', 'https://accounts.x.ai/authorize']) expect(assistantSignInAllowed(url)).toBe(true);
  for (const url of ['https://auth.openai.com.evil.test/authorize', 'https://secret@auth.x.ai/', 'http://auth.x.ai/', 'https://auth.x.ai:8443/', 'javascript:alert(1)']) expect(assistantSignInAllowed(url)).toBe(false);
});
