import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AccountProvider, AccountSession, savedAccountSchema } from '../../platform/src/accounts.js';
import { EncryptedSettingsStore } from './credentials.js';
let home: string;
const protection = { kind: 'configured' as const, key: 'a'.repeat(64) };
const config = { url: 'https://account.example.test', publishableKey: 'sb_publishable_fixture_account', allowLocal: false };
const user = { id: randomUUID(), email: 'owner@example.test' }, workspace = randomUUID();
const session = { access_token: 'access-private-canary', refresh_token: 'refresh-private-canary', expires_in: 3600, user };
beforeEach(async () => { home = await mkdtemp(path.join(os.tmpdir(), 'account-continuity-')); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });
function create(fetcher: typeof fetch, now = () => 0, key = protection, configuration = config) {
  const store = new EncryptedSettingsStore(home, 'builder-account', savedAccountSchema, key);
  const persistence = { available: true, load: () => store.load(), save: (value: ReturnType<typeof savedAccountSchema.parse>) => store.save(value), remove: () => store.remove() };
  return { store, account: new AccountSession(new AccountProvider(configuration, fetcher), now, persistence) };
}
function requests(refresh: () => Promise<Response> = async () => Response.json({ ...session, refresh_token: 'rotated-private-canary' })) {
  return vi.fn<typeof fetch>().mockImplementation(async url => {
    if (String(url).includes('/auth/v1/token?')) return refresh();
    if (String(url).endsWith('/auth/v1/verify')) return Response.json(session);
    if (String(url).endsWith('/rpc/ensure_personal_workspace')) return Response.json(workspace);
    if (String(url).includes('/workspaces?')) return Response.json([]);
    return new Response(null, { status: 204 });
  });
}
it('restores only opted-in accounts, encrypts rotating tokens, and removes them on sign-out', async () => {
  const fetcher = requests(), first = create(fetcher);
  await first.account.verify(user.email, '123456'); first.account.clear();
  expect(first.store.load()).toBeUndefined();
  await first.account.verify(user.email, '123456', true); first.account.clear();
  const raw = await readFile(path.join(home, 'credentials/builder-account.json'), 'utf8');
  expect(raw).not.toContain(session.refresh_token); expect(raw).not.toContain(session.access_token);
  const second = create(fetcher); await Promise.all([second.account.restore(), second.account.restore()]);
  expect(second.account.status()).toMatchObject({ signedIn: true, lifetime: 'remembered', restoration: 'restored', user });
  expect(second.store.load()?.refreshToken).toBe('rotated-private-canary');
  expect(JSON.stringify(second.account.status())).not.toMatch(/private-canary/);
  expect(fetcher.mock.calls.filter(([url]) => String(url).includes('/token?'))).toHaveLength(1);
  await second.account.signOut(); expect(second.store.load()).toBeUndefined();
  const third = create(fetcher); await third.account.restore(); expect(third.account.status().signedIn).toBe(false);
});
it.each(['sign-out', 'account-switch'] as const)('does not resurrect rotated credentials after %s during refresh', async action => {
  let now = 0, finish!: (response: Response) => void;
  const fetcher = requests(() => new Promise(resolve => { finish = resolve; })), { account, store } = create(fetcher, () => now);
  await account.verify(user.email, '123456', true); now = 3_600_000;
  const pending = Promise.allSettled([account.workspaces(), account.workspaces()]);
  await vi.waitFor(() => expect(finish).toBeDefined());
  if (action === 'sign-out') await account.signOut(); else await account.verify(user.email, '123456', false);
  finish(Response.json({ ...session, refresh_token: 'must-not-resurrect' }));
  expect((await pending).every(result => result.status === 'rejected')).toBe(true);
  expect(store.load()).toBeUndefined(); expect(account.status().lifetime).toBe('session');
});
it('fences logout during startup restoration', async () => {
  const first = create(requests()); await first.account.verify(user.email, '123456', true);
  let finish!: (response: Response) => void;
  const second = create(requests(() => new Promise(resolve => { finish = resolve; })));
  const pending = second.account.restore(); await vi.waitFor(() => expect(finish).toBeDefined());
  await second.account.signOut(); finish(Response.json(session)); await pending;
  expect(second.account.status().signedIn).toBe(false); expect(second.store.load()).toBeUndefined();
});
it('retains encrypted data when locked or the service is temporarily unavailable, but removes revoked sessions', async () => {
  const first = create(requests()); await first.account.verify(user.email, '123456', true);
  const file = path.join(home, 'credentials/builder-account.json'), before = await readFile(file, 'utf8');
  const spy = requests(), locked = create(spy, () => 0, { ...protection, key: 'b'.repeat(64) }); await locked.account.restore();
  expect(locked.account.status()).toMatchObject({ signedIn: false, restoration: 'locked' }); expect(spy).not.toHaveBeenCalled();
  expect(await readFile(file, 'utf8')).toBe(before);
  const temporary = create(requests(async () => Response.json({}, { status: 503 }))); await temporary.account.restore();
  expect(temporary.account.status().restoration).toBe('unavailable'); expect(await readFile(file, 'utf8')).toBe(before);
  const revoked = create(requests(async () => Response.json({}, { status: 400 }))); await revoked.account.restore();
  expect(revoked.account.status().restoration).toBe('expired'); expect(revoked.store.load()).toBeUndefined();
});
it('does not send a saved refresh token to a changed account service or accept a changed user', async () => {
  const first = create(requests()); await first.account.verify(user.email, '123456', true);
  const spy = requests(), changed = create(spy, () => 0, protection, { ...config, url: 'https://other.example.test' });
  await changed.account.restore(); expect(changed.account.status().restoration).toBe('locked'); expect(spy).not.toHaveBeenCalled();
  const mismatch = create(requests(async () => Response.json({ ...session, user: { ...user, id: randomUUID() } })));
  await mismatch.account.restore(); expect(mismatch.account.status().signedIn).toBe(false); expect(mismatch.store.load()).toBeUndefined();
});

it('removes remembered credentials when an active session refresh is revoked', async () => {
  let now = 0;
  const { account, store } = create(requests(async () => Response.json({}, { status: 401 })), () => now);
  await account.verify(user.email, '123456', true); now = 3_600_000;
  await expect(account.workspaces()).rejects.toThrow();
  expect(account.status()).toMatchObject({ signedIn: false, restoration: 'expired' }); expect(store.load()).toBeUndefined();
});
