import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createSchema, projectSchema, type Project } from './contracts.js';
import { projectMetadataSchema } from './studio-contracts.js';
import { sourcePath } from './source.js';
import { noSymlinks, SerialQueue } from './storage.js';

export type DurableProject = {
  project: Omit<Project, 'root'>;
  files: { path: string; content: Uint8Array }[];
};
export type ProjectWorkspaceSnapshot = { version: 1; projects: DurableProject[] };
export type ProjectWorkspaceHead = { revision: string; snapshot: ProjectWorkspaceSnapshot };
/** The host binds this adapter to one authorized owner. No tenant ID is accepted from a tool. */
export interface ProjectWorkspacePersistence {
  load(): Promise<ProjectWorkspaceHead | null>;
  /** Resolve only after durable commit. A repeated mutationId must return the original result. */
  commit(input: { expectedRevision: string | null; mutationId: string; snapshot: ProjectWorkspaceSnapshot }): Promise<{ revision: string }>;
}

const identity = projectSchema.omit({ root: true }).extend({ name: createSchema.shape.name, slug: createSchema.shape.slug }).strict();
const metadataFile = '.mobile-builder.json';
export function validateProjectWorkspace(input: ProjectWorkspaceSnapshot): ProjectWorkspaceSnapshot {
  if (input?.version !== 1 || !Array.isArray(input.projects) || input.projects.length > 200) throw Error('Invalid durable workspace');
  const ids = new Set<string>(), slugs = new Set<string>();
  let total = 0;
  for (const entry of input.projects) {
    const project = identity.parse(entry.project);
    if (ids.has(project.id) || slugs.has(project.slug)) throw Error('Duplicate durable project');
    ids.add(project.id); slugs.add(project.slug);
    if (!Array.isArray(entry.files) || entry.files.length > 501) throw Error('Durable project file limit exceeded');
    const names = new Set<string>(); let bytes = 0;
    for (const file of entry.files) {
      if (typeof file.path !== 'string' || (file.path !== metadataFile && !sourcePath(file.path)) || names.has(file.path) || !(file.content instanceof Uint8Array)) throw Error('Invalid durable project file');
      names.add(file.path); bytes += file.content.byteLength;
      if (file.content.byteLength > 8_000_000 || bytes > 32_016_384) throw Error('Durable project byte limit exceeded');
    }
    // Reject file/directory collisions before writing any bytes into the cache.
    for (const name of names) {
      const parts = name.split('/');
      for (let i = 1; i < parts.length; i++) if (names.has(parts.slice(0, i).join('/'))) throw Error('Conflicting durable project paths');
    }
    const raw = entry.files.find(file => file.path === metadataFile);
    if (!raw || raw.content.byteLength > 16_384) throw Error('Durable project metadata is missing');
    const metadata = projectMetadataSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw.content)));
    if (JSON.stringify(identity.parse(metadata.project)) !== JSON.stringify(project)) throw Error('Durable project identity mismatch');
    total += bytes;
    if (total > 256_000_000) throw Error('Durable workspace byte limit exceeded');
  }
  return input;
}

/** Only hydrate disposable, empty caches. Existing local projects must never be overwritten. */
export async function hydrateProjectWorkspace(workspace: string, home: string, snapshot: ProjectWorkspaceSnapshot) {
  validateProjectWorkspace(snapshot);
  if ((await readdir(workspace)).length || (await readdir(home)).length) throw Error('Durable project hydration requires empty cache directories');
  const records: Project[] = [];
  for (const entry of snapshot.projects) {
    const root = path.join(workspace, entry.project.slug);
    await noSymlinks(workspace, root); await mkdir(root, { mode: 0o700 });
    for (const file of entry.files) {
      const target = path.join(root, file.path);
      await noSymlinks(root, target); await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await noSymlinks(root, target); await writeFile(target, file.content, { flag: 'wx', mode: 0o600 });
    }
    records.push({ ...entry.project, root });
  }
  await writeFile(path.join(home, 'projects.json'), JSON.stringify(records), { flag: 'wx', mode: 0o600 });
}

/** Explicit service-level durability boundary, independent of HTTP/MCP and filesystem watchers. */
export class ProjectTransactions extends SerialQueue {
  private context = new AsyncLocalStorage<{ active: boolean }>();
  private failed = false;
  constructor(private readonly commit?: () => Promise<void>) { super(); }
  assertAvailable() { if (this.failed) throw Error('Workspace persistence is uncertain. Reopen the workspace to recover saved changes.'); }
  override run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.context.getStore()?.active) { this.assertAvailable(); return fn(); }
    return super.run(async () => {
      this.assertAvailable();
      const context = { active: true };
      try {
        return await this.context.run(context, async () => {
          const result = await fn();
          await this.commit?.();
          return result;
        });
      } catch (error) {
        // A partial local mutation or an ambiguous remote commit must never be used for further work.
        if (this.commit) this.failed = true;
        throw error;
      } finally { context.active = false; }
    });
  }
  read<T>(fn: () => Promise<T>): Promise<T> {
    if (this.context.getStore()?.active) { this.assertAvailable(); return fn(); }
    return super.run(async () => {
      this.assertAvailable(); const context = { active: true };
      try { return await this.context.run(context, fn); }
      finally { context.active = false; }
    });
  }
}

export class ProjectDurability {
  private revision: string | null = null;
  constructor(readonly persistence: ProjectWorkspacePersistence) {}
  async restore(workspace: string, home: string) {
    const head = await this.persistence.load();
    if (head && !validRevision(head.revision)) throw Error('Invalid durable workspace revision');
    await hydrateProjectWorkspace(workspace, home, head?.snapshot ?? { version: 1, projects: [] });
    this.revision = head?.revision ?? null;
  }
  async commit(snapshot: ProjectWorkspaceSnapshot) {
    const result = await this.persistence.commit({ expectedRevision: this.revision, mutationId: randomUUID(), snapshot: validateProjectWorkspace(snapshot) });
    if (!validRevision(result.revision)) throw Error('Invalid durable commit receipt');
    this.revision = result.revision;
  }
}
function validRevision(value: unknown): value is string { return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value); }
