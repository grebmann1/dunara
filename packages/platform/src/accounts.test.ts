import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { AccountProvider, AccountSession } from './accounts.js';
const user = { id: randomUUID(), email: 'owner@example.test' }, workspace = randomUUID();
const config = { url: 'https://builder-accounts.supabase.co', publishableKey: 'sb_publishable_account_test', allowLocal: false };
const session = { user, access_token: 'private-account-access-token', refresh_token: 'private-refresh-token', expires_in: 3600 };

it('keeps login tokens in the service, refreshes once, and fences refresh after sign-out', async () => {
  let now = 0, finishRefresh!: (value: Response) => void;
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
    const target = String(url);
    if (target.endsWith('/auth/v1/otp')) return Response.json({});
    if (target.endsWith('/auth/v1/verify')) return Response.json(session);
    if (target.endsWith('/rest/v1/rpc/ensure_personal_workspace')) return Response.json(workspace);
    if (target.includes('/auth/v1/token?')) return new Promise(resolve => { finishRefresh = resolve; });
    if (target.includes('/auth/v1/logout')) return new Response(null, { status: 204 });
    if (target.includes('/rest/v1/workspaces?')) { expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${session.access_token}`); return Response.json([{ id: workspace, name: 'Owner workspace', created_at: new Date().toISOString() }]); }
    throw new Error('Unexpected endpoint');
  });
  const account = new AccountSession(new AccountProvider(config, fetcher), () => now);
  await account.requestCode(user.email); await account.verify(user.email, '123456');
  expect(JSON.stringify(account.status())).not.toContain('token'); expect(account.status()).toMatchObject({ signedIn: true, user });
  expect(await account.workspaces()).toHaveLength(1);
  now = 3_600_000;
  const first = account.workspaces(), second = account.workspaces();
  const settled = Promise.allSettled([first, second]);
  await vi.waitFor(() => expect(finishRefresh).toBeDefined());
  await account.signOut(); finishRefresh(Response.json(session));
  expect((await settled).every(result => result.status === 'rejected')).toBe(true);
  expect(fetcher.mock.calls.filter(([url]) => String(url).includes('/auth/v1/token?'))).toHaveLength(1);
  expect(account.status().signedIn).toBe(false);
});

it('rejects insecure account endpoints and secret keys in public configuration', () => {
  expect(() => new AccountProvider({ ...config, url: 'http://example.test' })).toThrow();
  expect(() => new AccountProvider({ ...config, publishableKey: 'sb_secret_should_not_be_used' })).toThrow();
});

it('claims app metadata through the idempotent database operation with the user token', async () => {
  const id = randomUUID();
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(id));
  const provider = new AccountProvider(config, fetcher);
  expect(await provider.registerApp(session.access_token, { id, workspaceId: workspace, name: 'App', slug: 'app' })).toEqual({ id, workspaceId: workspace });
  const [url, init] = fetcher.mock.calls[0]!;
  expect(String(url)).toMatch(/\/rest\/v1\/rpc\/register_app$/);
  expect(JSON.parse(String(init?.body))).toEqual({ app_id: id, target_workspace: workspace, app_name: 'App', app_slug: 'app' });
  expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${session.access_token}`);
});

it('does not return the previous account’s delayed workspace history after sign-out', async () => {
  let finish!: (response: Response) => void;
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async url => {
    if (String(url).endsWith('/auth/v1/verify')) return Response.json(session);
    if (String(url).endsWith('/rpc/ensure_personal_workspace')) return Response.json(workspace);
    if (String(url).includes('/workspaces?')) return new Promise(resolve => { finish = resolve; });
    return new Response(null, { status: 204 });
  });
  const account = new AccountSession(new AccountProvider(config, fetcher));
  await account.verify(user.email, '123456');
  const pending = account.workspaces();
  const assertion = expect(pending).rejects.toMatchObject({ code: 'SIGN_IN_REQUIRED' });
  await vi.waitFor(() => expect(finish).toBeDefined());
  await account.signOut();
  finish(Response.json([{ id: workspace, name: 'Previous account workspace', created_at: new Date().toISOString() }]));
  await assertion;
});
