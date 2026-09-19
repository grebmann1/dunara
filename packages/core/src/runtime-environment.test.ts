import { expect, it } from 'vitest';
import { runtimeEnvironment } from './runtime-environment.js';

it('withholds provider, platform, injection, and unrelated public variables from generated code', () => {
  const env = runtimeEnvironment({ PATH: '/bin', HOME: '/home/person', OPENAI_API_KEY: 'canary-model', SUPABASE_ACCESS_TOKEN: 'canary-management', SUPABASE_SECRET_KEY: 'canary-admin', BUILDER_ENCRYPTION_KEY: 'canary-encryption', NODE_OPTIONS: '--require=malicious', DYLD_INSERT_LIBRARIES: 'injection', EXPO_PUBLIC_SECRET: 'canary-public', EXPO_PUBLIC_SUPABASE_URL: 'https://wrong.supabase.co', CI: '1', NODE_EXTRA_CA_CERTS: '/corp/ca.pem', NODE_TLS_REJECT_UNAUTHORIZED: '0' });
  expect(env).toMatchObject({ PATH: '/bin', HOME: '/home/person', CI: '0', EXPO_NO_DOTENV: '1', NODE_EXTRA_CA_CERTS: '/corp/ca.pem' });
  expect(env.NODE_TLS_REJECT_UNAUTHORIZED).toBeUndefined();
  expect(JSON.stringify(env)).not.toMatch(/canary|malicious|injection|wrong/);
});

it('accepts only explicitly selected public app configuration', () => {
  const env = runtimeEnvironment({}, { EXPO_PUBLIC_SUPABASE_URL: 'https://app.supabase.co', EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test', EXPO_PUBLIC_BUILDER_ENVIRONMENT: 'development' });
  expect(env.EXPO_PUBLIC_SUPABASE_URL).toBe('https://app.supabase.co');
  expect(() => runtimeEnvironment({}, { EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'line\nbreak' })).toThrow('Invalid app environment');
});
