/** Generated code receives an explicit environment, never the Dunara's provider credentials. */
// Additional CA files are public trust configuration, needed by npm behind a managed registry.
// Do not inherit NODE_OPTIONS, TLS verification overrides, or provider credentials.
const inherited = ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'LC_CTYPE', 'SHELL', 'USER', 'LOGNAME', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'NODE_EXTRA_CA_CERTS'] as const;
export type AppEnvironment = { EXPO_PUBLIC_SUPABASE_URL?: string; EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY?: string; EXPO_PUBLIC_BUILDER_ENVIRONMENT?: string };
export function runtimeEnvironment(parent: NodeJS.ProcessEnv, app: AppEnvironment = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of inherited) if (parent[name]) env[name] = parent[name];
  Object.assign(env, { CI: '0', EXPO_NO_TELEMETRY: '1', EXPO_OFFLINE: '1', EXPO_NO_DOTENV: '1', BROWSER: 'none' });
  for (const name of ['EXPO_PUBLIC_SUPABASE_URL', 'EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'EXPO_PUBLIC_BUILDER_ENVIRONMENT'] as const) {
    const value = app[name];
    if (value !== undefined) {
      if (!value || value.length > 4096 || [...value].some(char => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127)) throw new Error('Invalid app environment configuration');
      env[name] = value;
    }
  }
  return env;
}
