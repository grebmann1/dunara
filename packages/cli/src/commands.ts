import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createHash } from 'node:crypto';
import { lstat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { connectDesktop } from '../../mcp/src/socket.js';
import { readText } from '../../core/src/storage.js';
import { z } from 'zod';

async function pages<T>(load: (cursor?: string) => Promise<{ nextCursor?: string } & Record<string, unknown>>, field: string): Promise<T[]> {
  const result: T[] = [], seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await load(cursor);
    if (!Array.isArray(page[field])) throw Error('Invalid MCP inventory');
    result.push(...page[field] as T[]); cursor = page.nextCursor;
    if (result.length > 10_000 || cursor && seen.has(cursor)) throw Error('MCP inventory pagination exceeded its limit');
    if (cursor) seen.add(cursor);
  } while (cursor);
  return result;
}
/** Save one binary artifact for a vision/file tool, or JSON for ordinary commands. Never overwrite. */
export async function saveCommandOutput(destination: string, value: unknown) {
  const object = z.record(z.string(), z.unknown()).parse(value);
  const blocks = Array.isArray(object.content) ? object.content : Array.isArray(object.contents) ? object.contents : [];
  const binaries = blocks.flatMap(item => {
    if (!item || typeof item !== 'object') return [];
    const resource = Reflect.get(item, 'resource') ?? item;
    if (!resource || typeof resource !== 'object') return [];
    const data = Reflect.get(resource, 'blob') ?? (['image', 'audio'].includes(Reflect.get(item, 'type')) ? Reflect.get(item, 'data') : undefined);
    return typeof data === 'string' ? [{ data, mimeType: Reflect.get(resource, 'mimeType') ?? Reflect.get(item, 'mimeType') }] : [];
  });
  if (binaries.length > 1) throw Error('This response has multiple artifacts. Read one resource at a time.');
  const binary = binaries[0];
  if (binary && (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(binary.data) || binary.data.length > 32 * 1024 * 1024)) throw Error('Invalid or oversized artifact');
  const bytes = binary ? Buffer.from(binary.data, 'base64') : Buffer.from(JSON.stringify(value, null, 2) + '\n');
  const file = path.resolve(destination);
  await writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
  return { output: { path: file, mimeType: binary?.mimeType ?? 'application/json', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }, ...(object.structuredContent ? { structuredContent: object.structuredContent } : {}) };
}
export async function runCommand(socket: string, command: string[], input?: string, inputFile?: string, output?: string) {
  const [verb, target, ...extra] = command;
  const lists = ['tools', 'resources', 'resource-templates', 'prompts'];
  if (extra.length || ![...lists, 'call', 'resource', 'prompt'].includes(verb ?? '') || (lists.includes(verb ?? '') ? !!target : !target)) throw new Error('Use tools, resources, resource-templates, prompts, call <tool>, resource <uri>, or prompt <name>');
  if (input !== undefined && inputFile !== undefined) throw new Error('Use either --input JSON or --input-file, not both');
  if (!['call', 'prompt'].includes(verb ?? '') && (input !== undefined || inputFile !== undefined)) throw new Error('Only call and prompt accept input');
  if (output) {
    const existing = await lstat(path.resolve(output)).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (existing) throw Error('Output destination already exists; choose a new file');
  }
  const raw = inputFile ? await readText(inputFile, 45 * 1024 * 1024) : input ?? '{}';
  if (Buffer.byteLength(raw) > 45 * 1024 * 1024) throw new Error('Tool input exceeds 45 MiB');
  const args = z.record(z.string(), z.unknown()).parse(JSON.parse(raw));
  const client = new Client({ name: 'mobile-builder-cli', version: '0.1.0' });
  try {
    await client.connect(await connectDesktop(socket));
    let value: unknown, failed = false;
    if (verb === 'tools') value = { tools: await pages(cursor => client.listTools({ cursor }), 'tools') };
    else if (verb === 'resources') value = { resources: await pages(cursor => client.listResources({ cursor }), 'resources') };
    else if (verb === 'resource-templates') value = { resourceTemplates: await pages(cursor => client.listResourceTemplates({ cursor }), 'resourceTemplates') };
    else if (verb === 'prompts') value = { prompts: await pages(cursor => client.listPrompts({ cursor }), 'prompts') };
    else if (verb === 'resource') value = await client.readResource({ uri: target! });
    else if (verb === 'prompt') value = await client.getPrompt({ name: target!, arguments: z.record(z.string(), z.string()).parse(args) });
    else { const result = await client.callTool({ name: target!, arguments: args }, undefined, { timeout: 240_000 }); value = result; failed = result.isError === true; }
    if (output && !failed) {
      const metadata = z.object({ structuredContent: z.object({ download: z.unknown().optional() }).optional() }).parse(value);
      if (metadata.structuredContent?.download) {
        const download = z.object({ bytes: z.number().int().positive().max(256 * 1024 * 1024), sha256: z.string().regex(/^[a-f0-9]{64}$/), mimeType: z.string(), resources: z.array(z.string().regex(/^builder:\/\/projects\/[a-f0-9-]{36}\/downloads\/[a-f0-9-]{36}\/\d+$/)).min(1).max(64) }).parse(metadata.structuredContent.download);
        const chunks: Buffer[] = []; let total = 0;
        for (const uri of download.resources) {
          const resource = await client.readResource({ uri });
          const parts = z.array(z.object({ blob: z.string().max(5_592_408).regex(/^[A-Za-z0-9+/]+={0,2}$/) })).length(1).parse(resource.contents);
          const bytes = Buffer.from(parts[0]!.blob, 'base64'); total += bytes.length;
          if (total > download.bytes) throw Error('Download exceeded its advertised size');
          chunks.push(bytes);
        }
        const bytes = Buffer.concat(chunks);
        if (bytes.length !== download.bytes || createHash('sha256').update(bytes).digest('hex') !== download.sha256) throw Error('Download checksum or size mismatch');
        const file = path.resolve(output); await writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
        return { value: { output: { path: file, mimeType: download.mimeType, bytes: bytes.length, sha256: download.sha256 } }, failed: false };
      }
      return { value: await saveCommandOutput(output, value), failed };
    }
    return { value, failed };
  } finally { await client.close(); }
}
