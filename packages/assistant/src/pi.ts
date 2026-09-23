import { fork, type ChildProcess } from 'node:child_process';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { ASSISTANT_LIMITS, type HarnessCallbacks, type HarnessInput, type RunHarness } from './contracts.js';
import { ManagedAiUnavailable } from '../../core/src/managed-ai.js';
import { AssistantModelUnavailable } from './provider-failure.js';

const messageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready') }).strict(), z.object({ type: z.literal('done') }).strict(), z.object({ type: z.literal('failed'), notice: z.string().max(300).optional(), modelUnavailable: z.literal(true).optional() }).strict(),
  z.object({ type: z.literal('text'), text: z.string().max(8192) }).strict(),
  z.object({ type: z.literal('image-accepted') }).strict(),
  z.object({ type: z.literal('tool'), id: z.uuid(), name: z.string().max(160), args: z.record(z.string(), z.unknown()) }).strict(),
]);
export type PiFixture = { baseUrl: string; model: string; reasoning?: boolean };
export function piAvailable() {
  try { for (const name of ['@earendil-works/pi-ai', '@earendil-works/pi-coding-agent', 'typebox']) import.meta.resolve(name); return true; }
  catch { return false; }
}
export class PiHarness implements RunHarness {
  private child?: ChildProcess;
  private directory?: string;
  private closed = false;
  private closing?: Promise<void>;
  private reject?: (reason: Error) => void;
  constructor(private options: { fixture?: PiFixture; startupMs?: number; shutdownMs?: number } = {}) {}
  async run(input: HarnessInput, callbacks: HarnessCallbacks, signal: AbortSignal) {
    try { await this.execute(input, callbacks, signal); } finally { await this.close(); }
  }
  private async execute(input: HarnessInput, callbacks: HarnessCallbacks, signal: AbortSignal) {
    if (this.closed || this.child || this.directory) throw new Error('Harness is not available');
    signal.throwIfAborted();
    this.directory = await mkdtemp(path.join(os.tmpdir(), 'mb-assistant-'));
    if (this.closed || signal.aborted) { await rm(this.directory, { recursive: true, force: true }); throw new Error('Assistant startup cancelled'); }
    await chmod(this.directory, 0o700);
    signal.throwIfAborted();
    const child = fork(fileURLToPath(new URL('./pi-worker.js', import.meta.url)), [], {
      cwd: this.directory, execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: { HOME: this.directory, XDG_CONFIG_HOME: path.join(this.directory, 'config'), XDG_DATA_HOME: path.join(this.directory, 'data'), XDG_CACHE_HOME: path.join(this.directory, 'cache'), PI_CODING_AGENT_DIR: path.join(this.directory, '.pi'), PI_OFFLINE: '1', PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, LANG: 'en_US.UTF-8' },
    });
    this.child = child;
    const abort = () => { void this.close(); };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    try {
      await new Promise<void>((resolve, reject) => {
        this.reject = reject;
        const timer = setTimeout(() => { reject(new Error('Assistant harness startup timed out')); void this.close(); }, this.options.startupMs ?? ASSISTANT_LIMITS.startupMs);
        const failed = () => { clearTimeout(timer); reject(new Error('Assistant harness stopped unexpectedly')); };
        child.once('error', failed); child.once('exit', failed);
        child.on('message', (raw: unknown) => {
          if (this.closed || signal.aborted) return;
          if (Buffer.byteLength(JSON.stringify(raw)) > 24 * 1024 * 1024) { failed(); void this.close(); return; }
          const parsed = messageSchema.safeParse(raw);
          if (!parsed.success) { failed(); void this.close(); return; }
          const message = parsed.data;
          if (message.type === 'ready') clearTimeout(timer);
          else if (message.type === 'image-accepted') {
            try { callbacks.imageAccepted?.(); } catch { failed(); void this.close(); }
          } else if (message.type === 'text') {
            try { callbacks.text(message.text); } catch { failed(); void this.close(); }
          } else if (message.type === 'done') { clearTimeout(timer); resolve(); }
          else if (message.type === 'failed') {
            if (input.provider === 'managed' && message.notice) { clearTimeout(timer); reject(new ManagedAiUnavailable(message.notice)); }
            else if (message.modelUnavailable) { clearTimeout(timer); reject(new AssistantModelUnavailable()); }
            else failed();
          }
          else if (message.type === 'tool') {
            void (async () => {
              try {
                signal.throwIfAborted();
                const result = await callbacks.tool(message.name, message.args, signal);
                if (Buffer.byteLength(JSON.stringify(result)) > 24 * 1024 * 1024) throw new Error('Tool result exceeds transport limit');
                if (!this.closed && !signal.aborted && child.connected) child.send({ type: 'result', id: message.id, result }, () => {});
              } catch {
                if (!this.closed && !signal.aborted && child.connected) child.send({ type: 'result', id: message.id, result: { content: [{ type: 'text', text: 'Dunara rejected this operation. Reinspect the current state; do not retry blindly.' }], isError: true } }, () => {});
              }
            })();
          }
        });
        if (!this.closed && child.connected) child.send({ type: 'start', input, fixture: this.options.fixture }, error => { if (error) failed(); });
        else failed();
      });
    } finally { signal.removeEventListener('abort', abort); await this.close(); }
  }
  close() {
    return this.closing ??= (async () => {
      this.closed = true;
      this.reject?.(new Error('Assistant harness closed'));
      const child = this.child;
      if (child && child.exitCode === null && child.signalCode === null) await new Promise<void>(resolve => {
        const timer = setTimeout(() => child.kill('SIGKILL'), this.options.shutdownMs ?? ASSISTANT_LIMITS.shutdownMs);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
        if (child.connected) child.send({ type: 'stop' }, () => {}); else child.kill('SIGTERM');
      });
      if (this.directory) await rm(this.directory, { recursive: true, force: true });
    })();
  }
}
