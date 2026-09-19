import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import type { ChildProcess } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { BuilderError, phoneTestInput, previewTransportInput, type Preview } from "../../../core/src/contracts.js";
import { Projects } from "../../../core/src/projects.js";
import { Diagnostics } from "../../../core/src/diagnostics.js";
import { atomicWrite, exists, noSymlinks, readText } from "../../../core/src/storage.js";
import { checkDependencies } from "../../../core/src/dependency-profiles.js";
import { freePort, Processes } from "../../../core/src/processes.js";
import { revision } from "../../../core/src/files.js";
import type { AppEnvironment } from "../../../core/src/runtime-environment.js";
import { expoDeviceUrl } from "../../../core/src/device-preview.js";

import type { PreviewDriver } from '../../../core/src/preview-driver.js';

export class Previews implements PreviewDriver {
  private sessions = new Map<string, Preview>();
  private children = new Map<string, ChildProcess>();
  private starting = new Map<string, Promise<Preview>>();
  private controllers = new Map<string, AbortController>();
  private maintenance = new Set<string>();
  private closed = false;
  private transports = new Map<string, 'localhost' | 'lan'>();
  readonly processes = new Processes();
  constructor(readonly projects: Projects, readonly diagnostics: Diagnostics, readonly trusted: boolean, readonly lan = false, private readonly environment: (id: string) => Promise<AppEnvironment> = async () => ({}), private readonly beforeStart: (id: string) => Promise<void> = async () => {}) {}
  status(id: string): Preview { return this.sessions.get(id) ?? { projectId: id, status: 'stopped' }; }
  private transport(id: string) { return this.transports.get(id) ?? (this.lan ? 'lan' : 'localhost'); }
  async setTransport(id: string, input: unknown, signal?: AbortSignal) {
    const value = previewTransportInput.parse(input); await this.projects.get(id);
    if (!this.trusted) throw new BuilderError('TRUST_REQUIRED', 'Authorize app execution in Dunara before starting a phone preview.');
    if ((this.status(id).sessionId ?? null) !== value.expectedSessionId) throw new BuilderError('REVISION_CONFLICT', 'The preview changed. Review its current connection before restarting.');
    signal?.throwIfAborted();
    if (this.status(id).status === 'ready' && this.status(id).transport === value.transport && (value.transport === 'localhost' || this.status(id).deviceUrl)) return this.start(id, signal);
    await this.withStopped(id, async () => { signal?.throwIfAborted(); this.transports.set(id, value.transport); });
    return this.start(id, signal);
  }
  async recordPhoneTest(id: string, input: unknown) {
    const value = phoneTestInput.parse(input), current = this.status(id);
    if (current.status !== 'ready' || !current.deviceUrl || current.sessionId !== value.sessionId || current.configurationRevision !== await this.configurationRevision(id)) throw new BuilderError('REVISION_CONFLICT', 'This phone connection changed. Reconnect before recording a check.');
    if (this.status(id).sessionId !== current.sessionId || this.status(id).status !== 'ready') throw new BuilderError('REVISION_CONFLICT', 'The preview stopped or changed.');
    const previous = this.status(id).phoneTests ?? [], report = previous.find(item => item.platform === value.platform);
    if ((report?.revision ?? null) !== value.expectedRevision) throw new BuilderError('REVISION_CONFLICT', 'The phone checklist changed. Refresh and try again.');
    return this.update({ ...this.status(id), phoneTests: [...previous.filter(item => item.platform !== value.platform), { platform: value.platform, revision: randomUUID(), checks: value.checks, checkedAt: new Date().toISOString(), evidence: 'user_reported' }] });
  }
  async configurationRevision(id: string) { return revision(JSON.stringify(await this.environment(id))); }
  private update(state: Preview) { this.sessions.set(state.projectId, state); this.diagnostics.emit('change', state.projectId); return state; }
  async checkDependencies(root: string) { return checkDependencies(root); }
  async withStopped<T>(id: string, work: () => Promise<T>): Promise<T> {
    if (this.maintenance.has(id)) throw new BuilderError('REVISION_CONFLICT', 'A preview configuration change is already in progress.');
    this.maintenance.add(id);
    try { await this.stop(id); return await work(); } finally { this.maintenance.delete(id); }
  }
  private available(id: string) {
    if (this.maintenance.has(id)) throw new BuilderError('REVISION_CONFLICT', 'Wait for the preview configuration change to finish before previewing.');
  }
  async installDependencies(id: string, root: string, signal: AbortSignal) {
    const dependencies = await this.checkDependencies(root), fingerprint = revision(dependencies.lock);
    const stamp = path.join(root, 'node_modules/.builder-dependencies');
    await noSymlinks(root, stamp);
    if (await exists(path.join(root, 'node_modules/expo/bin/cli')) && await exists(stamp) && await readText(stamp, 128) === fingerprint) return;
    this.diagnostics.add(id, 'install', 'info', 'Installing the pinned starter dependencies (lifecycle scripts disabled).');
    await this.processes.run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], root, line => this.diagnostics.add(id, 'install', 'info', line), signal);
    signal.throwIfAborted();
    if (revision((await this.checkDependencies(root)).lock) !== fingerprint) throw new BuilderError('REVISION_CONFLICT', 'Dependencies changed during installation. Restart the preview.');
    await mkdir(path.dirname(stamp), { recursive: true }); await noSymlinks(root, stamp); await atomicWrite(stamp, fingerprint);
  }
  async start(id: string, signal?: AbortSignal): Promise<Preview> {
    if (!this.trusted) throw new BuilderError('TRUST_REQUIRED', 'Restart the CLI with --trust-execution to authorize installing dependencies and executing generated code. This is not a sandbox.');
    if (this.closed) throw new BuilderError('PROCESS_FAILED', 'Runtime is shutting down');
    signal?.throwIfAborted();
    this.available(id);
    // Join before yielding so a concurrent stop cannot turn a duplicate into a restart.
    const existing = this.starting.get(id);
    if (existing) return existing;
    await this.beforeStart(id);
    await this.projects.get(id);
    const pending = this.starting.get(id);
    if (pending) return pending;
    const current = this.status(id);
    if (current.status === 'ready' && current.url) {
      const environmentRevision = await this.configurationRevision(id);
      try { if (current.configurationRevision === environmentRevision && (await fetch(current.url, { signal: AbortSignal.timeout(2000), redirect: 'error' })).ok) return current; } catch { /* Restart unhealthy owned sessions. */ }
      await this.stop(id);
    }
    if ([...this.sessions.values()].filter(s => s.status === 'ready' || s.status === 'starting').length >= 2) throw new BuilderError('LIMIT_EXCEEDED', 'At most two previews can run at once');
    this.available(id);
    const controller = new AbortController(); this.controllers.set(id, controller);
    const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true });
    this.update({ projectId: id, status: 'starting', sessionId: randomUUID(), startedAt: new Date().toISOString(), transport: this.transport(id), runtime: 'expo-go' });
    const promise = this.launch(id, controller.signal).finally(() => {
      signal?.removeEventListener('abort', abort); this.starting.delete(id); this.controllers.delete(id);
    });
    this.starting.set(id, promise);
    return promise;
  }
  private async launch(id: string, signal: AbortSignal) {
    let child: ChildProcess | undefined;
    try {
      const project = await this.projects.get(id);
      await this.beforeStart(id);
      await this.installDependencies(id, project.root, signal);
      signal.throwIfAborted();
      const port = await freePort();
      const url = `http://localhost:${port}`;
      const appEnvironment = await this.environment(id);
      const sessionId = this.status(id).sessionId;
      const lan = this.status(id).transport === 'lan';
      const manifest = JSON.parse(await readText(path.join(project.root, 'package.json')));
      this.update({ ...this.status(id), sdkVersion: manifest.dependencies.expo });
      const addresses = new Set(Object.values(networkInterfaces()).flatMap(entries => entries ?? []).filter(entry => !entry.internal && entry.family === 'IPv4').map(entry => entry.address));
      let output = '';
      child = this.processes.spawn(process.execPath, [path.join(project.root, 'node_modules/expo/bin/cli'), 'start', '--web', '--go', lan ? '--lan' : '--localhost', '--port', String(port)], project.root, line => {
        this.diagnostics.add(id, 'preview', 'info', line);
        output = (output + line).slice(-8192);
        const deviceUrl = expoDeviceUrl(output, port);
        if (lan && deviceUrl && addresses.has(new URL(deviceUrl).hostname) && !signal.aborted && this.status(id).sessionId === sessionId && ['starting', 'ready'].includes(this.status(id).status)) this.update({ ...this.status(id), deviceUrl, deviceIssue: undefined });
      }, appEnvironment);
      this.children.set(id, child);
      let spawnError: Error | undefined;
      child.once('error', error => { spawnError = error; });
      child.once('exit', () => { if (this.status(id).sessionId === sessionId && this.status(id).status === 'ready') this.update({ projectId: id, status: 'failed', error: 'Preview process exited; inspect diagnostics and restart.' }); });
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        signal.throwIfAborted();
        if (spawnError) throw spawnError;
        if (child.exitCode !== null || child.signalCode !== null) throw new BuilderError('PROCESS_FAILED', 'Expo exited before becoming ready');
        try {
          const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(3000)]), redirect: 'error' });
          if (response.ok) return this.update({ ...this.status(id), projectId: id, status: 'ready', url, configurationRevision: revision(JSON.stringify(appEnvironment)), deviceIssue: lan ? this.status(id).deviceUrl ? undefined : 'Expo has not reported a private LAN address. Check your network connection and restart the preview.' : 'Choose Start phone preview to share this app on your local network.', ...(appEnvironment.EXPO_PUBLIC_SUPABASE_URL ? { backendUrl: appEnvironment.EXPO_PUBLIC_SUPABASE_URL, environment: appEnvironment.EXPO_PUBLIC_BUILDER_ENVIRONMENT } : {}) });
        } catch { /* Wait until Metro accepts requests. */ }
        await sleep(300, undefined, { signal });
      }
      throw new BuilderError('PREVIEW_NOT_READY', 'Expo did not become ready within 90 seconds');
    } catch (error) {
      if (child) await this.processes.stop(child);
      this.children.delete(id);
      const message = error instanceof Error ? error.message : 'Preview failed';
      this.diagnostics.add(id, 'preview', 'error', message);
      this.update({ projectId: id, status: 'failed', error: message });
      throw error;
    }
  }
  async stop(id: string) {
    await this.projects.get(id);
    this.controllers.get(id)?.abort();
    await this.starting.get(id)?.catch(() => {});
    const child = this.children.get(id);
    if (child) await this.processes.stop(child);
    this.children.delete(id);
    return this.update({ projectId: id, status: 'stopped' });
  }
  async close() {
    this.closed = true;
    for (const controller of this.controllers.values()) controller.abort();
    await Promise.allSettled(this.starting.values());
    await this.processes.close();
    this.children.clear();
    for (const id of this.sessions.keys()) this.update({ projectId: id, status: 'stopped' });
  }
}
