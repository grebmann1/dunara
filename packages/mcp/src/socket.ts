import { createServer, createConnection, type Socket } from 'node:net';
import { chmod, lstat, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Engine } from '../../core/src/engine.js';
import { createMcpServer } from './server.js';

const MAX_MESSAGE = 24 * 1024 * 1024;
export class SocketTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private started = false;
  private buffer = new ReadBuffer({ maxBufferSize: MAX_MESSAGE });
  constructor(private socket: Socket) { socket.pause(); }
  async start() {
    if (this.started) throw new Error('Transport already started');
    this.started = true;
    this.socket.on('error', error => this.onerror?.(error));
    this.socket.once('close', () => { this.buffer.clear(); this.onclose?.(); });
    this.socket.on('data', chunk => {
      try {
        this.buffer.append(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
        let message;
        while ((message = this.buffer.readMessage()) !== null) this.onmessage?.(message);
      } catch { this.onerror?.(new Error('Invalid or oversized desktop MCP message')); this.socket.destroy(); }
    });
    this.socket.resume();
  }
  async send(message: JSONRPCMessage) {
    const data = serializeMessage(message);
    if (Buffer.byteLength(data) > MAX_MESSAGE || this.socket.writableLength > MAX_MESSAGE || this.socket.destroyed) {
      this.socket.destroy(); throw new Error('Desktop MCP connection unavailable or buffer exceeded');
    }
    await new Promise<void>((resolve, reject) => this.socket.write(data, error => error ? reject(error) : resolve()));
  }
  async close() { this.socket.destroy(); }
}

export async function startDesktopMcp(engine: Engine) {
  await engine.plugins.ready;
  // Filesystem ownership is the credential; never expose this transport over TCP.
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mb-mcp-'));
  await chmod(directory, 0o700);
  const socketPath = path.join(directory, 'mcp.sock');
  const clients = new Set<ReturnType<typeof createMcpServer>>();
  const server = createServer(socket => {
    if (clients.size >= 4) { socket.destroy(); return; }
    const client = createMcpServer(engine); clients.add(client);
    socket.once('close', () => { clients.delete(client); void client.close(); });
    void client.connect(new SocketTransport(socket)).catch(() => socket.destroy());
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
    await chmod(socketPath, 0o600);
  } catch (error) { server.close(); await rm(directory, { recursive: true, force: true }); throw error; }
  return { socketPath, async close() {
    const closed = new Promise<void>(resolve => server.close(() => resolve()));
    await Promise.all([...clients].map(client => client.close()));
    await closed; await rm(directory, { recursive: true, force: true });
  } };
}

export async function connectDesktop(socketPath: string) {
  if (process.platform === 'win32' || !path.isAbsolute(socketPath)) throw new Error('Desktop MCP requires an absolute local Unix socket path');
  const [socketInfo, parent] = await Promise.all([lstat(socketPath), lstat(path.dirname(socketPath))]);
  if (!socketInfo.isSocket() || !parent.isDirectory() || socketInfo.uid !== process.getuid?.() || parent.uid !== process.getuid?.() || (socketInfo.mode & 0o077) || (parent.mode & 0o077)) {
    throw new Error('Desktop MCP endpoint must be a private socket owned by the current user');
  }
  const socket = createConnection(socketPath);
  await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  return new SocketTransport(socket);
}

export async function bridgeDesktop(socketPath: string) {
  const remote = await connectDesktop(socketPath);
  const local = new StdioServerTransport();
  let closed = false;
  const close = () => { if (closed) return; closed = true; void local.close(); void remote.close(); };
  local.onmessage = message => { void remote.send(message).catch(close); };
  remote.onmessage = message => { void local.send(message).catch(close); };
  local.onclose = close; remote.onclose = close;
  local.onerror = close; remote.onerror = close;
  process.once('SIGTERM', close); process.once('SIGINT', close); process.stdin.once('end', close);
  await remote.start(); await local.start();
}
