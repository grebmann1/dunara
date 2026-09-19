import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { connectDesktop } from '../../mcp/src/socket.js';
import { readText } from '../../core/src/storage.js';

export async function runCommand(socket: string, command: string[], input?: string, inputFile?: string) {
  const [verb, target, ...extra] = command;
  if (extra.length || !['tools', 'call', 'resource'].includes(verb ?? '') || (verb === 'tools' ? !!target : !target)) throw new Error('Use tools, call <tool-name>, or resource <builder-uri>');
  if (input !== undefined && inputFile !== undefined) throw new Error('Use either --input JSON or --input-file, not both');
  if (verb !== 'call' && (input !== undefined || inputFile !== undefined)) throw new Error('Only call accepts input');
  const raw = inputFile ? await readText(inputFile, 16 * 1024 * 1024) : input ?? '{}';
  if (Buffer.byteLength(raw) > 16 * 1024 * 1024) throw new Error('Tool input exceeds 16 MiB');
  const args: unknown = JSON.parse(raw);
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Tool input must be a JSON object');
  const client = new Client({ name: 'mobile-builder-cli', version: '0.1.0' });
  try {
    await client.connect(await connectDesktop(socket));
    if (verb === 'tools') return { value: await client.listTools(), failed: false };
    if (verb === 'resource') return { value: await client.readResource({ uri: target! }), failed: false };
    const value = await client.callTool({ name: target!, arguments: args as Record<string, unknown> }, undefined, { timeout: 240_000 });
    return { value, failed: value.isError === true };
  } finally { await client.close(); }
}
