import { mkdtemp, rm, writeFile, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { serviceConfiguration, startupConfiguration, startupEnvironment } from './service-config.js';
import { desktopEnvironment } from '../../desktop/src/security.js';
import { runtimeEnvironment } from './runtime-environment.js';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

it('merges named environment overrides with a bounded file without loading arbitrary variables', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'builder-services-')); roots.push(root);
  const file = path.join(root, '.env'), before = process.env.BUILDER_BACKEND_ENCRYPTION_KEY;
  await writeFile(file, `BUILDER_BACKEND_ENCRYPTION_KEY=${'ab'.repeat(32)}\nBUILDER_ACCOUNT_SUPABASE_URL=https://account.supabase.co\nBUILDER_ACCOUNT_PUBLISHABLE_KEY=sb_publishable_account_fixture\nOPENAI_API_KEY=image-secret-sentinel\nNODE_EXTRA_CA_CERTS=/corporate/cert.pem\nNODE_OPTIONS=--import=bad\nNODE_TLS_REJECT_UNAUTHORIZED=0\nEXPO_PUBLIC_SECRET=bad\n`, { mode: 0o600 });
  const configuration = startupConfiguration(file, { BUILDER_BACKEND_ENCRYPTION_KEY: 'cd'.repeat(32) });
  expect(configuration.services).toEqual({ encryptionKey: 'cd'.repeat(32), account: { url: 'https://account.supabase.co', publishableKey: 'sb_publishable_account_fixture', allowLocal: false } });
  expect(configuration.credentials.imageKey).toBe('image-secret-sentinel'); expect(configuration.extraCaCertificates).toBe('/corporate/cert.pem');
  expect(process.env.BUILDER_BACKEND_ENCRYPTION_KEY).toBe(before);
  const launcher = { ...desktopEnvironment({ PATH: '/bin' }), ...startupEnvironment({ BUILDER_BACKEND_ENCRYPTION_KEY: 'cd'.repeat(32), NODE_EXTRA_CA_CERTS: '/cert.pem', NODE_OPTIONS: 'bad', NODE_TLS_REJECT_UNAUTHORIZED: '0', AWS_SECRET_ACCESS_KEY: 'bad' }) };
  const generated = runtimeEnvironment(launcher);
  expect(generated.NODE_EXTRA_CA_CERTS).toBe('/cert.pem'); expect(JSON.stringify(generated)).not.toContain('cd'.repeat(32));
  expect(JSON.stringify(launcher)).not.toMatch(/bad|NODE_TLS|NODE_OPTIONS/);
  await symlink(file, path.join(root, 'link.env')); expect(() => startupConfiguration(path.join(root, 'link.env'))).toThrow('storage');
});
it.each([
  { BUILDER_BACKEND_ENCRYPTION_KEY: 'secret-canary' },
  { BUILDER_ACCOUNT_SUPABASE_URL: 'https://account.supabase.co' },
  { BUILDER_ACCOUNT_PUBLISHABLE_KEY: 'sb_publishable_account_fixture' },
  { BUILDER_ACCOUNT_ALLOW_LOCAL: 'true' },
  { BUILDER_ACCOUNT_ALLOW_LOCAL: '1' },
  { BUILDER_ACCOUNT_SUPABASE_URL: 'http://remote.example', BUILDER_ACCOUNT_PUBLISHABLE_KEY: 'sb_publishable_account_fixture', BUILDER_ACCOUNT_ALLOW_LOCAL: '1' },
  { BUILDER_ACCOUNT_SUPABASE_URL: 'https://account.supabase.co', BUILDER_ACCOUNT_PUBLISHABLE_KEY: 'sb_secret_private_canary' },
])('rejects incomplete or unsafe service configuration without echoing its input (%j)', env => {
  try { serviceConfiguration(env); throw new Error('expected rejection'); }
  catch (error) { expect(error).toMatchObject({ code: 'CONFIGURATION_REQUIRED' }); expect(String(error)).not.toMatch(/canary|remote\.example/); }
});
it('allows explicit local account instances and rejects unsafe certificate paths', () => {
  expect(serviceConfiguration({ BUILDER_ACCOUNT_SUPABASE_URL: 'http://127.0.0.1:54321', BUILDER_ACCOUNT_PUBLISHABLE_KEY: 'sb_publishable_fixture', BUILDER_ACCOUNT_ALLOW_LOCAL: '1' }).account?.allowLocal).toBe(true);
  for (const value of ['relative.pem', '/tmp/ca\n.pem', '']) expect(() => startupConfiguration(undefined, { NODE_EXTRA_CA_CERTS: value })).toThrow('absolute');
});
