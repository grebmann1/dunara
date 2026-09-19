import { z } from 'zod';
import { accountConfigSchema } from '../../platform/src/accounts.js';
import { PlatformError } from '../../platform/src/contracts.js';
import { startupCredentials, startupEnvironmentFile } from './credentials.js';
import { oauthBrokerOrigin } from '../../platform/src/oauth-contracts.js';

export const serviceConfigSchema = z.object({
  encryptionKey: z.string().regex(/^[a-fA-F0-9]{64}$/).optional(),
  secretProtection: z.object({ kind: z.enum(['os', 'configured']), key: z.string().regex(/^[a-fA-F0-9]{64}$/) }).strict().optional(),
  account: accountConfigSchema.optional(),
  oauthBrokerOrigin: oauthBrokerOrigin.optional(),
}).strict();
export type ServiceConfig = z.infer<typeof serviceConfigSchema>;
export function secretProtection(services: ServiceConfig) { return services.encryptionKey ? { kind: 'configured' as const, key: services.encryptionKey } : services.secretProtection; }
export const startupVariableNames = ['OPENAI_API_KEY', 'BUILDER_ASSISTANT_API_KEY', 'BUILDER_BACKEND_ENCRYPTION_KEY', 'BUILDER_ACCOUNT_SUPABASE_URL', 'BUILDER_ACCOUNT_PUBLISHABLE_KEY', 'BUILDER_ACCOUNT_ALLOW_LOCAL', 'BUILDER_OAUTH_BROKER_ORIGIN'] as const;
export type StartupEnvironment = Partial<Record<typeof startupVariableNames[number] | 'NODE_EXTRA_CA_CERTS', string>>;

/** The launcher passes only named settings; the backend receives parsed configuration over private IPC. */
export function startupEnvironment(env: NodeJS.ProcessEnv): StartupEnvironment {
  return Object.fromEntries([...startupVariableNames, 'NODE_EXTRA_CA_CERTS'].filter(name => env[name] !== undefined).map(name => [name, env[name]]));
}
export function serviceConfiguration(env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  try {
    const local = env.BUILDER_ACCOUNT_ALLOW_LOCAL;
    if (local !== undefined && local !== '0' && local !== '1') throw new Error();
    const url = env.BUILDER_ACCOUNT_SUPABASE_URL, publishableKey = env.BUILDER_ACCOUNT_PUBLISHABLE_KEY;
    return serviceConfigSchema.parse({ encryptionKey: env.BUILDER_BACKEND_ENCRYPTION_KEY, oauthBrokerOrigin: env.BUILDER_OAUTH_BROKER_ORIGIN,
      ...(url !== undefined || publishableKey !== undefined || local === '1' ? { account: { url, publishableKey, allowLocal: local === '1' } } : {}),
    });
  } catch { throw new PlatformError('CONFIGURATION_REQUIRED', 'Invalid Dunara service configuration. Use a 64-character hexadecimal encryption key and a complete account URL/publishable-key pair; allow-local must be 0 or 1.'); }
}
export function startupConfiguration(envFile?: string, environment: StartupEnvironment = {}) {
  const values = { ...startupEnvironmentFile(envFile), ...startupEnvironment(environment) };
  const extraCaCertificates = values.NODE_EXTRA_CA_CERTS;
  if (extraCaCertificates !== undefined && (!extraCaCertificates.startsWith('/') || extraCaCertificates.length > 4096 || [...extraCaCertificates].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127))) throw new PlatformError('CONFIGURATION_REQUIRED', 'NODE_EXTRA_CA_CERTS must be an absolute certificate-file path.');
  return { credentials: startupCredentials(undefined, values), services: serviceConfiguration(values), extraCaCertificates };
}
