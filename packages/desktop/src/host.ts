import { fork, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { desktopEnvironment, managedOrigins } from './security.js';
import { startupConfiguration, type StartupEnvironment } from '../../core/src/service-config.js';
import type { SecretProtection } from '../../core/src/credentials.js';

export class DesktopHost extends EventEmitter {
  private child?: ChildProcess;
  private stopping?: Promise<void>;
  private launchPending?: { resolve: (url: string) => void; reject: (error: Error) => void };
  origin = '';
  socketPath = '';
  previews = new Set<string>();
  get pid() { return this.child?.pid; }
  get running() { return !!this.child && this.child.exitCode === null && this.child.signalCode === null && this.child.connected; }
  constructor(private config: { node: string; workspace: string; home: string; trusted: boolean; assistantOfflineFixture?: string; startupEnvironment?: StartupEnvironment; envFile?: string; browserPath?: string; protectSecrets?: () => SecretProtection | undefined }) { super(); }
  async start() {
    if (this.child) throw new Error('Desktop runtime already started');
    const startup = this.config.assistantOfflineFixture ? { credentials: {}, services: {}, extraCaCertificates: process.env.NODE_EXTRA_CA_CERTS } : startupConfiguration(this.config.envFile, { NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS, ...this.config.startupEnvironment });
    if (!startup.services.encryptionKey) startup.services.secretProtection = this.config.protectSecrets?.();
    const child = fork(fileURLToPath(new URL('./runtime.js', import.meta.url)), [], {
      execPath: this.config.node, execArgv: [], env: { ...desktopEnvironment(process.env), NODE_EXTRA_CA_CERTS: startup.extraCaCertificates, ...(this.config.browserPath ? { PLAYWRIGHT_BROWSERS_PATH: this.config.browserPath } : {}) },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    this.child = child;
    return new Promise<string>((resolve, reject) => {
      const failed = () => reject(new Error('Dunara backend failed to start. Check the build, Node version, and workspace permissions.'));
      const timer = setTimeout(() => { failed(); void this.stop(); }, 20_000);
      child.once('error', () => { clearTimeout(timer); failed(); });
      child.once('exit', () => {
        clearTimeout(timer); failed();
        this.launchPending?.reject(new Error('Dunara backend stopped')); this.launchPending = undefined;
        this.previews.clear(); this.emit('stopped', !!this.stopping);
      });
      child.on('message', (message: unknown) => {
        if (!message || typeof message !== 'object' || !('type' in message)) return;
        if (message.type === 'ready' && 'origin' in message && typeof message.origin === 'string' && 'launchUrl' in message && typeof message.launchUrl === 'string' && 'socketPath' in message && typeof message.socketPath === 'string') {
          clearTimeout(timer); this.origin = message.origin; this.socketPath = message.socketPath; resolve(message.launchUrl);
        } else if (message.type === 'launch' && 'launchUrl' in message && typeof message.launchUrl === 'string') {
          this.launchPending?.resolve(message.launchUrl); this.launchPending = undefined;
        } else if (message.type === 'origins' && 'urls' in message && Array.isArray(message.urls)) {
          this.previews = managedOrigins(message.urls.filter((value): value is string => typeof value === 'string'));
        } else if (message.type === 'failed') { clearTimeout(timer); failed(); }
      });
      child.send({ type: 'start', workspace: this.config.workspace, home: this.config.home, trusted: this.config.trusted, assistantOfflineFixture: this.config.assistantOfflineFixture, credentials: startup.credentials, services: startup.services });
    });
  }
  async launchUrl() {
    if (!this.running || this.launchPending) throw new Error('Dunara unavailable or reconnect already in progress');
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => { this.launchPending = undefined; reject(new Error('Dunara reconnect timed out')); }, 5000);
      this.launchPending = { resolve: url => { clearTimeout(timer); resolve(url); }, reject: error => { clearTimeout(timer); reject(error); } };
      this.child?.send({ type: 'launch' });
    });
  }
  stop() {
    return this.stopping ??= (async () => {
      const child = this.child;
      if (!child || child.exitCode !== null || child.signalCode !== null) return;
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => { child.kill('SIGKILL'); }, 15_000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
        if (child.connected) child.send({ type: 'stop' }); else child.kill('SIGTERM');
      });
    })();
  }
}
