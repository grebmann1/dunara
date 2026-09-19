import { describe, expect, it, vi } from 'vitest';
import { OPENCODE_CANDIDATE, qualificationConfig, qualificationEnvironment } from './opencode.js';

describe('OpenCode qualification-only configuration', () => {
  it('pins the available candidate without enabling a real provider', () => {
    const config = qualificationConfig('http://127.0.0.1:12345');
    expect(OPENCODE_CANDIDATE).toBe('1.18.30');
    expect(config.enabled_providers).toEqual(['builder-mock']);
    expect(config.provider['builder-mock'].options).toEqual({
      baseURL: 'http://127.0.0.1:12345/v1', apiKey: 'offline-sentinel-not-a-real-key', maxRetries: 0,
    });
    expect(config.provider['builder-mock'].env).toEqual([]);
  });

  it.each([
    'https://example.com', 'http://localhost:12345', 'http://0.0.0.0:12345', 'http://127.0.0.1',
    'http://user:password@127.0.0.1:12345', 'http://127.0.0.1:12345/redirect',
    'http://127.0.0.1:12345?redirect=1', 'http://127.0.0.1:12345#fragment',
  ])('rejects nonfixture provider URL %s', value => {
    expect(() => qualificationConfig(value)).toThrow('explicit loopback mock provider');
  });

  it('requests no built-in tools, implicit agents, plugins, or sharing', () => {
    const config = qualificationConfig('http://127.0.0.1:12345');
    expect(config.permission).toEqual({ '*': 'deny' });
    expect(config.tools).toEqual({ '*': false });
    expect(config.agent.builder.permission).toEqual({ '*': 'deny' });
    for (const name of ['title', 'summary', 'compaction', 'build', 'plan', 'general', 'explore'] as const) {
      expect(config.agent[name].disable).toBe(true);
    }
    expect(config.mcp).toEqual({});
    expect(config.plugin).toEqual([]);
    expect(config.instructions).toEqual([]);
    expect(config.share).toBe('disabled');
    expect(config.compaction).toEqual({ auto: false, prune: false });
    expect(config.experimental.openTelemetry).toBe(false);
  });

  it('does not inherit host credentials, configuration, plugins, or runtime injection', () => {
    vi.stubEnv('OPENAI_API_KEY', 'host-credential-sentinel');
    vi.stubEnv('NODE_OPTIONS', '--require=/untrusted/plugin.cjs');
    vi.stubEnv('OPENCODE_CONFIG_CONTENT', '{"plugin":["untrusted"]}');
    try {
      const env = qualificationEnvironment('/private/probe', 'http://127.0.0.1:12345', 'private-server-password');
      expect(env.HOME).toBe('/private/probe/home');
      expect(env.XDG_DATA_HOME).toBe('/private/probe/data');
      expect(env).not.toHaveProperty('OPENAI_API_KEY');
      expect(env).not.toHaveProperty('NODE_OPTIONS');
      expect(JSON.stringify(env)).not.toContain('untrusted');
      expect(JSON.stringify(env)).not.toContain('host-credential-sentinel');
      expect(env.OPENCODE_CONFIG_CONTENT).not.toContain('private-server-password');
      expect(env.OPENCODE_SERVER_PASSWORD).toBe('private-server-password');
      expect(env.OPENCODE_DISABLE_MODELS_FETCH).toBe('1');
      expect(env.OPENCODE_PURE).toBe('1');
    } finally { vi.unstubAllEnvs(); }
  });
});
