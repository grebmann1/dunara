import { createHash, randomUUID } from 'node:crypto';
import { BuilderError } from './contracts.js';

const CHUNK = 4 * 1024 * 1024, MAX_BYTES = 256 * 1024 * 1024;
/** Short-lived scoped downloads. Chunking keeps ZIP/APK data out of tool context and socket limits. */
export class AgentArtifacts {
  private entries = new Map<string, { projectId: string; context: string; bytes: Buffer; expires: number }>();
  constructor(private context: () => string) {}
  private prune() { for (const [id, item] of this.entries) if (item.expires <= Date.now() || item.context !== this.context()) this.entries.delete(id); }
  add(projectId: string, bytes: Buffer, filename: string, mimeType: string) {
    this.prune();
    if (!bytes.length || bytes.length > MAX_BYTES) throw new BuilderError('LIMIT_EXCEEDED', 'Agent downloads support up to 256 MiB.');
    while (this.entries.size && (this.entries.size >= 4 || [...this.entries.values()].reduce((sum, item) => sum + item.bytes.length, bytes.length) > MAX_BYTES)) this.entries.delete(this.entries.keys().next().value!);
    const id = randomUUID(), expires = Date.now() + 15 * 60_000;
    this.entries.set(id, { projectId, context: this.context(), bytes, expires });
    return { filename, mimeType, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), expiresAt: new Date(expires).toISOString(), resources: Array.from({ length: Math.ceil(bytes.length / CHUNK) }, (_, part) => `builder://projects/${projectId}/downloads/${id}/${part}`) };
  }
  read(projectId: string, id: string, part: number) {
    this.prune(); const entry = this.entries.get(id);
    if (!entry || entry.projectId !== projectId || !Number.isSafeInteger(part) || part < 0 || part * CHUNK >= entry.bytes.length) throw new BuilderError('INVALID_INPUT', 'Download expired or does not belong to this project. Prepare it again.');
    return entry.bytes.subarray(part * CHUNK, (part + 1) * CHUNK);
  }
}
