import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Qualification only. Not connected to Studio, Engine, or real providers.
export const OPENCODE_CANDIDATE = '1.18.30';

export function qualificationConfig(providerUrl: string) {
  const url = new URL(providerUrl);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Qualification requires an explicit loopback mock provider');
  }
  return {
    model: 'builder-mock/mock', small_model: 'builder-mock/mock', default_agent: 'builder',
    enabled_providers: ['builder-mock'],
    provider: {
      'builder-mock': {
        npm: '@ai-sdk/openai-compatible', name: 'Offline qualification', env: [],
        options: { baseURL: `${url.origin}/v1`, apiKey: 'offline-sentinel-not-a-real-key', maxRetries: 0 },
        models: { mock: { name: 'Offline fixture', tool_call: true, limit: { context: 32000, output: 1024 } } },
      },
    },
    agent: {
      build: { disable: true }, plan: { disable: true }, general: { disable: true }, explore: { disable: true },
      title: { disable: true }, summary: { disable: true }, compaction: { disable: true },
      builder: { mode: 'primary', permission: { '*': 'deny' } },
    },
    permission: { '*': 'deny' }, tools: { '*': false }, mcp: {}, plugin: [], instructions: [],
    skills: { paths: [], urls: [] }, lsp: false, formatter: false, snapshot: false,
    share: 'disabled', autoupdate: false, compaction: { auto: false, prune: false },
    experimental: { openTelemetry: false, batch_tool: false },
  };
}

export function qualificationEnvironment(root: string, providerUrl: string, password: string) {
  return {
    PATH: '/usr/bin:/bin', HOME: path.join(root, 'home'), TMPDIR: path.join(root, 'tmp'),
    XDG_CONFIG_HOME: path.join(root, 'config'), XDG_DATA_HOME: path.join(root, 'data'),
    XDG_CACHE_HOME: path.join(root, 'cache'), XDG_STATE_HOME: path.join(root, 'state'),
    OPENCODE_CONFIG_DIR: path.join(root, 'config'), OPENCODE_TEST_MANAGED_CONFIG_DIR: path.join(root, 'managed'),
    OPENCODE_CONFIG_CONTENT: JSON.stringify(qualificationConfig(providerUrl)),
    OPENCODE_SERVER_USERNAME: 'builder-probe', OPENCODE_SERVER_PASSWORD: password,
    OPENCODE_PURE: '1', OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_MODELS_FETCH: '1',
    OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_DISABLE_DEFAULT_PLUGINS: '1', OPENCODE_DISABLE_WEB_UI: '1',
    OPENCODE_DISABLE_EXTERNAL_SKILLS: '1', OPENCODE_DISABLE_LSP_DOWNLOAD: '1', OPENCODE_DISABLE_CLAUDE_CODE: '1',
    OPENCODE_DISABLE_AUTOCOMPACT: '1', OPENCODE_DISABLE_PRUNE: '1',
  };
}

export async function startQualificationHarness(executable: string, providerUrl: string) {
  qualificationConfig(providerUrl);
  if (!path.isAbsolute(executable)) throw new Error('Use an absolute path to the reviewed runtime');
  const root = await mkdtemp(path.join(tmpdir(), 'builder-opencode-probe-'));
  const password = randomBytes(32).toString('hex');
  const env = qualificationEnvironment(root, providerUrl, password);
  try {
    await Promise.all(['home', 'tmp', 'config', 'data', 'cache', 'state', 'managed', 'work'].map(dir => mkdir(path.join(root, dir), { mode: 0o700 })));
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
  const child = spawn(executable, ['serve', '--hostname=127.0.0.1', '--port=0'], {
    cwd: path.join(root, 'work'), env, stdio: ['ignore', 'pipe', 'ignore'],
  });
  let finished = false;
  const exited = new Promise<void>(resolve => {
    const done = () => { finished = true; resolve(); };
    child.once('exit', done); child.once('error', done);
  });
  let stopping: Promise<void> | undefined;
  const stop = () => stopping ??= (async () => {
    if (!finished) {
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
      await exited; clearTimeout(timer);
    }
    await rm(root, { recursive: true, force: true });
  })();
  try {
    const origin = await new Promise<string>((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error('OpenCode qualification startup timed out')), 20_000);
      child.once('error', () => { clearTimeout(timer); reject(new Error('OpenCode qualification failed to launch')); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error('OpenCode qualification runtime exited')); });
      child.stdout.on('data', (chunk: Buffer) => {
        output = (output + chunk.toString()).slice(-16_384);
        const match = output.match(/opencode server listening on (http:\/\/127\.0\.0\.1:\d+)/);
        if (match) { clearTimeout(timer); resolve(match[1]!); }
      });
    });
    return { origin, root, pid: child.pid, authorization: `Basic ${Buffer.from(`builder-probe:${password}`).toString('base64')}`, stop };
  } catch (error) {
    await stop(); throw error;
  }
}
