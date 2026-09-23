import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { BuilderError } from './contracts.js';
import { runtimeEnvironment, type AppEnvironment } from './runtime-environment.js';
export async function freePort(preferred = 0) {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(preferred, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Port allocation failed');
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}
export class Processes {
  private owned = new Set<ChildProcess>();
  spawn(command: string, args: string[], cwd: string, log: (text: string) => void, appEnvironment: AppEnvironment = {}) {
    const env = runtimeEnvironment(process.env, appEnvironment);
    const child = spawn(command, args, { cwd, shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], env });
    this.owned.add(child);
    child.stdout?.on('data', buffer => log(String(buffer)));
    child.stderr?.on('data', buffer => log(String(buffer)));
    child.on('error', error => { log(error.message); if (!child.pid) this.owned.delete(child); });
    child.once('exit', () => {
      // Reap descendants immediately; never retain a dead PID for a later shutdown.
      if (this.owned.has(child) && child.pid && process.platform !== 'win32') {
        try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') log(String(error)); }
      }
      this.owned.delete(child);
    });
    return child;
  }
  async stop(child: ChildProcess) {
    if (!this.owned.has(child)) return;
    const signal = (sig: NodeJS.Signals) => {
      if (!this.owned.has(child)) return;
      try {
        if (child.pid && process.platform !== 'win32') process.kill(-child.pid, sig);
        else if (child.exitCode === null) child.kill(sig);
      } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e; }
    };
    signal('SIGTERM');
    await Promise.race([new Promise<void>(resolve => { if (child.exitCode !== null || child.signalCode !== null) resolve(); else child.once('exit', () => resolve()); }), sleep(1500)]);
    signal('SIGKILL');
    this.owned.delete(child);
  }
  async run(command: string, args: string[], cwd: string, log: (text: string) => void, signal?: AbortSignal, appEnvironment: AppEnvironment = {}) {
    signal?.throwIfAborted();
    const child = this.spawn(command, args, cwd, log, appEnvironment);
    const abort = () => { void this.stop(child); };
    signal?.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(abort, 180_000);
    try {
      await new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', code => code === 0 ? resolve() : reject(new BuilderError('PROCESS_FAILED', `Dependency installation exited with ${code ?? 'a signal'}`)));
      });
      signal?.throwIfAborted();
    } finally { clearTimeout(timeout); signal?.removeEventListener('abort', abort); await this.stop(child); }
  }
  async close() { await Promise.all([...this.owned].map(child => this.stop(child))); }
}
