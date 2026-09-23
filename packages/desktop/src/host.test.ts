import { mkdtemp, rm, stat, writeFile, readFile } from 'node:fs/promises';
import { fork, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:https';
import { fileURLToPath } from 'node:url';
import { desktopEnvironment } from './security.js';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { connectDesktop } from '../../mcp/src/socket.js';

const { DesktopHost } = await import(new URL('../../../dist/packages/desktop/src/host.js', import.meta.url).href);
const roots: string[] = [];
const hosts: { stop(): Promise<void> }[] = [];
afterEach(async () => { await Promise.all(hosts.splice(0).map(host => host.stop())); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
it('supervises one built backend with one-use reconnect, persistence and owned cleanup', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'desktop-host-test-')); roots.push(root);
  const config = { node: process.execPath, workspace: path.join(root, 'apps'), home: path.join(root, 'home'), trusted: false };
  const host = new DesktopHost(config); hosts.push(host);
  const initial = await host.start(); const pid = host.pid;
  await expect(host.start()).rejects.toThrow('already started');
  const next = await host.launchUrl(); expect(host.pid).toBe(pid);
  const redeem = (url: string) => fetch(`${host.origin}/api/bootstrap`, { method: 'POST', headers: { Origin: host.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket: new URL(url).hash.slice(1) }) });
  expect((await redeem(initial)).status).toBe(401); expect((await redeem(next)).status).toBe(200); expect((await redeem(next)).status).toBe(401);
  const client = new Client({ name: 'host-test', version: '1' });
  try {
    await client.connect(await connectDesktop(host.socketPath));
    expect((await client.callTool({ name: 'project_create', arguments: { name: 'Desktop persistent', slug: 'persistent' } })).isError).not.toBe(true);
  } finally { await client.close(); }
  expect(host.running).toBe(true);
  await host.stop(); await host.stop(); expect(host.running).toBe(false);
  await expect(fetch(host.origin)).rejects.toThrow(); await expect(stat(host.socketPath)).rejects.toThrow();
  const replacement = new DesktopHost(config); hosts.push(replacement);
  await replacement.start(); expect(replacement.pid).not.toBe(pid);
  expect(replacement.origin).toBe(host.origin);
  const launch = await replacement.launchUrl();
  const auth = await fetch(`${replacement.origin}/api/bootstrap`, { method: 'POST', headers: { Origin: replacement.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket: new URL(launch).hash.slice(1) }) });
  const { token } = await auth.json();
  const projects = await (await fetch(`${replacement.origin}/api/projects`, { headers: { Authorization: `Bearer ${token}` } })).json();
  expect(JSON.stringify(projects)).toContain('Desktop persistent');
  const stopped = new Promise<boolean>(resolve => replacement.once('stopped', resolve));
  process.kill(replacement.pid, 'SIGTERM'); expect(await stopped).toBe(false);
  expect(replacement.running).toBe(false); expect(replacement.previews.size).toBe(0);
  await expect(replacement.launchUrl()).rejects.toThrow('unavailable');
});
it('loads explicit .env credentials and remembers the shared Settings key across owned backend restarts', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'desktop-credentials-')); roots.push(root);
  const image = 'offline-image-startup-SENTINEL', assistant = 'offline-assistant-startup-SENTINEL', saved = 'offline-assistant-saved-SENTINEL';
  const envFile = path.join(root, '.env');
  await writeFile(envFile, `OPENAI_API_KEY=${image}\nBUILDER_ASSISTANT_API_KEY=${assistant}\n`, { mode: 0o600 });
  const config = { node: process.execPath, workspace: path.join(root, 'apps'), home: path.join(root, 'home'), trusted: false, envFile, startupEnvironment: { BUILDER_BACKEND_ENCRYPTION_KEY: 'a'.repeat(64) } };
  async function launch() {
    const host = new DesktopHost(config); hosts.push(host); const url = await host.start();
    const auth = await fetch(`${host.origin}/api/bootstrap`, { method: 'POST', headers: { Origin: host.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket: new URL(url).hash.slice(1) }) });
    const { token } = await auth.json();
    const request = async (route: string, body?: unknown) => {
      const response = await fetch(`${host.origin}/api/${route}`, { method: body ? 'POST' : 'GET', headers: { Origin: host.origin, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
      expect(response.status).toBe(200); const text = await response.text();
      for (const key of [image, assistant, saved]) expect(text).not.toContain(key);
      return JSON.parse(text);
    };
    return { host, request };
  }
  let running = await launch();
  expect(await running.request('assistant/status')).toMatchObject({ configured: true, source: 'environment' });
  expect(await running.request('settings')).toMatchObject({ source: 'environment' });
  expect(await running.request('settings', { action: 'replace', key: saved, remember: true, expectedRevision: (await running.request('settings')).revision })).toMatchObject({ source: 'saved' });
  await running.host.stop(); running = await launch();
  expect(await running.request('assistant/status')).toMatchObject({ source: 'saved' });
  expect(await running.request('settings')).toMatchObject({ source: 'saved' });
  expect(await running.request('settings', { action: 'disconnect', expectedRevision: (await running.request('settings')).revision })).toMatchObject({ configured: false });
  expect(await running.request('assistant/status')).toMatchObject({ configured: false });
  await expect(readFile(path.join(config.home, 'credentials', 'openai-images-protected.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await running.request('settings', { action: 'environment', expectedRevision: (await running.request('settings')).revision })).toMatchObject({ source: 'environment' });
  expect(await readFile(envFile, 'utf8')).toContain(assistant);
});
it('cleans its socket and Studio when the owning IPC connection disappears', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'desktop-orphan-test-')); roots.push(root);
  const child = fork(fileURLToPath(new URL('../../../dist/packages/desktop/src/runtime.js', import.meta.url)), [], { execArgv: [], env: desktopEnvironment(process.env), stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
  try {
    const ready = new Promise<{ origin: string; socketPath: string }>((resolve, reject) => {
      child.once('error', reject); child.once('exit', () => reject(new Error('Runtime stopped before ready')));
      child.on('message', (message: unknown) => {
        if (message && typeof message === 'object' && 'type' in message && message.type === 'ready' && 'origin' in message && typeof message.origin === 'string' && 'socketPath' in message && typeof message.socketPath === 'string') resolve({ origin: message.origin, socketPath: message.socketPath });
      });
    });
    child.send({ type: 'start', workspace: path.join(root, 'apps'), home: path.join(root, 'home'), trusted: false });
    const runtime = await ready;
    expect((await fetch(runtime.origin)).status).toBe(200);
    child.disconnect(); await exited;
    expect(child.exitCode).toBe(0);
    await expect(fetch(runtime.origin)).rejects.toThrow(); await expect(stat(runtime.socketPath)).rejects.toThrow();
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); await exited; }
});

it('transports private service settings, restores encrypted connections and trusts the explicit CA across restart', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'desktop-services-')); roots.push(root);
  const ca = path.join(root, 'ca.pem'), key = path.join(root, 'tls.key'), envFile = path.join(root, '.env');
  await promisify(execFile)('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', ca, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1']);
  const accountKey = 'sb_publishable_account_fixture', management = 'saved-management-private-canary', encryption = 'ac'.repeat(32);
  let otpCalls = 0;
  const account = createServer({ key: await readFile(key), cert: await readFile(ca) }, (req, res) => {
    if (req.url === '/auth/v1/otp' && req.headers.apikey === accountKey && req.method === 'POST') { otpCalls++; req.resume(); res.setHeader('Content-Type', 'application/json'); res.end('{}'); }
    else { res.statusCode = 403; res.end(); }
  });
  await new Promise<void>(resolve => account.listen(0, '127.0.0.1', resolve));
  const address = account.address(); if (!address || typeof address === 'string') throw new Error('Missing account fixture port');
  await writeFile(envFile, `BUILDER_BACKEND_ENCRYPTION_KEY=${encryption}\nBUILDER_ACCOUNT_SUPABASE_URL=https://127.0.0.1:${address.port}\nBUILDER_ACCOUNT_PUBLISHABLE_KEY=${accountKey}\nNODE_EXTRA_CA_CERTS=${ca}\nNODE_OPTIONS=--import=bad\nNODE_TLS_REJECT_UNAUTHORIZED=0\n`, { mode: 0o600 });
  const config = { node: process.execPath, workspace: path.join(root, 'apps'), home: path.join(root, 'home'), trusted: false, envFile, startupEnvironment: { NODE_EXTRA_CA_CERTS: undefined } };
  async function launch() {
    const host = new DesktopHost(config); hosts.push(host); const url = await host.start();
    const bootstrap = await fetch(`${host.origin}/api/bootstrap`, { method: 'POST', headers: { Origin: host.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket: new URL(url).hash.slice(1) }) });
    const { token } = await bootstrap.json();
    const request = async (route: string, body?: unknown) => {
      const response = await fetch(`${host.origin}/api/${route}`, { method: body ? 'POST' : 'GET', headers: { Origin: host.origin, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
      const source = await response.text(); expect(response.status, source).toBe(200);
      for (const secret of [encryption, management, accountKey]) expect(source).not.toContain(secret);
      return JSON.parse(source);
    };
    return { host, request };
  }
  try {
    let running = await launch();
    expect(await running.request('account/status')).toMatchObject({ available: true, signedIn: false });
    expect(await running.request('backend/connection')).toMatchObject({ rememberAvailable: true, encryption: { state: 'ready' } });
    expect(await running.request('account/request-code', { email: 'fixture@example.com' })).toEqual({ sent: true }); expect(otpCalls).toBe(1);
    expect(await running.request('backend/connection', { action: 'connect', token: management, remember: true })).toMatchObject({ configured: true, source: 'saved' });
    await running.host.stop(); running = await launch();
    expect(await running.request('backend/connection')).toMatchObject({ configured: true, source: 'saved', encryption: { state: 'ready' } });
    expect(await running.request('account/status')).toMatchObject({ available: true, signedIn: false });
    expect(await running.request('account/request-code', { email: 'fixture@example.com' })).toEqual({ sent: true }); expect(otpCalls).toBe(2);
    const client = new Client({ name: 'service-config-redaction-test', version: '1' });
    try {
      await client.connect(await connectDesktop(running.host.socketPath));
      const created = await client.callTool({ name: 'project_create', arguments: { name: 'Private settings test', slug: 'private-settings-test' } });
      const projectId = (created.structuredContent as { project: { id: string } }).project.id;
      const inspection = JSON.stringify(await client.callTool({ name: 'backend_inspect', arguments: { projectId } }));
      for (const secret of [management, encryption, accountKey]) expect(inspection).not.toContain(secret);
    } finally { await client.close(); }
    await running.host.stop();
  } finally { account.closeAllConnections(); await new Promise<void>(resolve => account.close(() => resolve())); }
});
