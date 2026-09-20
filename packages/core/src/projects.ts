import { cp, mkdir, readdir, realpath, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { BuilderError, createSchema, projectSchema, type Project } from './contracts.js';
import { atomicWrite, canonicalDirectory, exists, noSymlinks, readText } from './storage.js';
import { ProjectDurability, ProjectTransactions, type ProjectWorkspacePersistence, type ProjectWorkspaceSnapshot } from './durable-projects.js';
import { snapshotSource } from './source.js';
import { presets } from '../../templates/src/catalog.js';
import { defaultStudio, projectMetadataSchema, recipeApplicationSchema, type StudioPreferences } from './studio-contracts.js';
import type { JourneyPreferences } from './journey-contracts.js';
export type UnavailableProject = { project: Project; reason: 'missing' | 'unreadable' | 'invalid' };
export const projectMetadataFile = '.mobile-builder.json';
export const templateRoot = fileURLToPath(new URL('../../templates/expo/', import.meta.url));

export class Projects {
  readonly mutations: ProjectTransactions;
  private constructor(readonly workspace: string, readonly home: string, durability?: ProjectDurability) {
    this.mutations = new ProjectTransactions(durability ? async () => durability.commit(await this.snapshot()) : undefined);
  }
  static async open(workspace: string, home: string, persistence?: ProjectWorkspacePersistence) {
    const durability = persistence ? new ProjectDurability(persistence) : undefined;
    const service = new Projects(await canonicalDirectory(workspace), await canonicalDirectory(home), durability);
    if (service.workspace === service.home || service.home.startsWith(service.workspace + path.sep)) throw new BuilderError('INVALID_PATH', 'Dunara home must be outside the generated workspace');
    await durability?.restore(service.workspace, service.home);
    return service;
  }
  private async snapshot(): Promise<ProjectWorkspaceSnapshot> {
    const projects = [];
    for (const record of await this.records()) {
      await this.validate(record);
      const { root, ...project } = record;
      const source = await snapshotSource(root);
      const metadata = await readText(path.join(root, projectMetadataFile), 16_384);
      projects.push({ project, files: [...source.files, { path: projectMetadataFile, content: Buffer.from(metadata) }] });
    }
    return { version: 1, projects };
  }
  private async records(): Promise<Project[]> {
    this.mutations.assertAvailable();
    const registry = path.join(this.home, 'projects.json');
    if (!(await exists(registry))) return [];
    return z.array(projectSchema).max(200).parse(JSON.parse(await readText(registry)));
  }
  private async validate(project: Project) {
    if (path.dirname(project.root) !== this.workspace || path.basename(project.root) !== project.slug) throw new BuilderError('INVALID_PATH', 'Project is outside the configured workspace');
    await noSymlinks(this.workspace, project.root);
    if (await realpath(project.root) !== project.root) throw new BuilderError('INVALID_PATH', 'Project root changed');
    if (!(await stat(project.root)).isDirectory()) throw new BuilderError('INVALID_PATH', 'Project root is not a directory');
    return project;
  }
  async catalog() {
    return this.mutations.read(() => this.catalogUnlocked());
  }
  private async catalogUnlocked() {
    const projects: Project[] = [], unavailable: UnavailableProject[] = [];
    for (const project of await this.records()) {
      try { await this.metadata(project); projects.push(project); }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        unavailable.push({ project, reason: code === 'ENOENT' ? 'missing' : code === 'EACCES' || code === 'EPERM' ? 'unreadable' : 'invalid' });
      }
    }
    return { projects, unavailable };
  }
  async list() { return (await this.catalog()).projects; }
  async removeUnavailable(id: string, expectedRoot: string) {
    return this.mutations.run(async () => {
      const records = await this.records(), project = records.find(record => record.id === id);
      if (!project) throw new BuilderError('PROJECT_NOT_FOUND', 'No registered project with this ID');
      if (project.root !== expectedRoot) throw new BuilderError('REVISION_CONFLICT', 'Project location changed. Review the project list again.');
      let available = false;
      try { await this.metadata(project); available = true; } catch { /* Only unavailable registrations may be removed here. */ }
      if (available) throw new BuilderError('REVISION_CONFLICT', 'This app is available again. Its registration was kept.');
      await atomicWrite(path.join(this.home, 'projects.json'), JSON.stringify(records.filter(record => record.id !== id), null, 2));
      return { removed: id, sourceDeleted: false as const };
    });
  }
  async get(id: string) {
    return this.mutations.read(() => this.getUnlocked(id));
  }
  private async getUnlocked(id: string) {
    const project = (await this.records()).find(p => p.id === id);
    if (!project) throw new BuilderError('PROJECT_NOT_FOUND', 'No registered project with this ID');
    return this.validate(project);
  }
  async create(input: unknown) {
    const value = createSchema.parse(input);
    return this.mutations.run(async () => {
      const records = await this.records();
      if (records.length >= 200) throw new BuilderError('LIMIT_EXCEEDED', 'Project registry is full');
      const root = path.join(this.workspace, value.slug);
      await noSymlinks(this.workspace, root);
      if (await exists(root)) throw new BuilderError('INVALID_INPUT', 'Target already exists; choose a new slug');
      let created = false;
      try {
        await mkdir(root); created = true;
        await cp(templateRoot, root, { recursive: true, filter: source => !['node_modules', '.expo', 'dist'].includes(path.basename(source)) });
        const manifest = JSON.parse(await readText(path.join(root, 'package.json')));
        manifest.name = value.slug;
        await atomicWrite(path.join(root, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
        const lock = JSON.parse(await readText(path.join(root, 'package-lock.json'), 2_000_000));
        lock.name = value.slug; lock.packages[''].name = value.slug;
        await atomicWrite(path.join(root, 'package-lock.json'), JSON.stringify(lock, null, 2) + '\n');
        const config = JSON.parse(await readText(path.join(root, 'app.json')));
        Object.assign(config.expo, { name: value.name, slug: value.slug, scheme: value.slug });
        await atomicWrite(path.join(root, 'app.json'), JSON.stringify(config, null, 2) + '\n');
        await atomicWrite(path.join(root, 'src/theme/design.json'), JSON.stringify({ preset: value.preset, mode: 'light', tokens: presets[value.preset].light }, null, 2) + '\n');
        const project: Project = { id: randomUUID(), name: value.name, slug: value.slug, root, recipe: value.recipe, createdAt: new Date().toISOString() };
        await this.writeMetadata(project, defaultStudio(project.id));
        await atomicWrite(path.join(this.home, 'projects.json'), JSON.stringify([...records, project], null, 2));
        return project;
      } catch (error) { if (created) await rm(root, { recursive: true, force: true }); throw error; }
    });
  }
  async metadata(project: Project) {
    await this.validate(project);
    const file = path.join(project.root, projectMetadataFile);
    await noSymlinks(project.root, file);
    if (!(await exists(file))) return { version: 1 as const, project: { id: project.id, name: project.name, slug: project.slug, recipe: project.recipe, createdAt: project.createdAt }, studio: defaultStudio(project.id) };
    const value = projectMetadataSchema.parse(JSON.parse(await readText(file, 16_384)));
    if (value.project.id !== project.id || value.project.slug !== project.slug || value.project.name !== project.name || value.project.createdAt !== project.createdAt) throw new BuilderError('INVALID_INPUT', 'Project metadata does not match its registry identity');
    return value;
  }
  // Call under mutations; the dotfile is deliberately outside generic source-file writes.
  async writeMetadata(project: Project, studio: StudioPreferences, applications?: z.infer<typeof recipeApplicationSchema>[], journey?: JourneyPreferences) {
    return this.mutations.run(() => this.writeMetadataUnlocked(project, studio, applications, journey));
  }
  private async writeMetadataUnlocked(project: Project, studio: StudioPreferences, applications?: z.infer<typeof recipeApplicationSchema>[], journey?: JourneyPreferences) {
    await this.validate(project);
    const file = path.join(project.root, projectMetadataFile);
    await noSymlinks(project.root, file);
    const existing = await this.metadata(project);
    const recipeApplications = applications ?? ('recipeApplications' in existing ? existing.recipeApplications : undefined);
    const savedJourney = journey ?? ('journey' in existing ? existing.journey : undefined);
    const value = projectMetadataSchema.parse({ version: 1, project: { id: project.id, name: project.name, slug: project.slug, recipe: project.recipe, createdAt: project.createdAt }, studio, ...(recipeApplications ? { recipeApplications } : {}), ...(savedJourney ? { journey: savedJourney } : {}) });
    const content = JSON.stringify(value, null, 2) + '\n';
    if (Buffer.byteLength(content) > 16_384) throw new BuilderError('LIMIT_EXCEEDED', 'Studio preferences exceed 16 KiB. Use shorter screen names or fewer screens.');
    await atomicWrite(file, content);
  }
  async recordRecipe(id: string, input: z.infer<typeof recipeApplicationSchema>) {
    return this.mutations.run(async () => {
      const project = await this.get(id), metadata = await this.metadata(project), application = recipeApplicationSchema.parse(input);
      const previous = 'recipeApplications' in metadata ? metadata.recipeApplications ?? [] : [];
      const records = [...previous.filter(record => record.pluginId !== application.pluginId || record.recipeId !== application.recipeId), application];
      await this.writeMetadata(project, metadata.studio, records);
    });
  }
  async register(slug: string) {
    createSchema.shape.slug.parse(slug);
    return this.mutations.run(async () => {
      const records = await this.records();
      const root = path.join(this.workspace, slug);
      await noSymlinks(this.workspace, root);
      if (await realpath(root) !== root) throw new BuilderError('INVALID_PATH', 'Project root changed');
      const known = records.find(p => p.root === root);
      if (known) { const metadata = await this.metadata(known); await this.writeMetadata(known, metadata.studio); return known; }
      if (records.length >= 200) throw new BuilderError('LIMIT_EXCEEDED', 'Project registry is full');
      const metadata = projectMetadataSchema.parse(JSON.parse(await readText(path.join(root, projectMetadataFile), 16_384)));
      if (metadata.project.slug !== slug || records.some(p => p.id === metadata.project.id)) throw new BuilderError('INVALID_INPUT', 'Project directory or identity conflicts with the registry');
      const project: Project = { ...metadata.project, root };
      await this.validate(project);
      await atomicWrite(path.join(this.home, 'projects.json'), JSON.stringify([...records, project], null, 2));
      return project;
    });
  }
  async templateFiles() { return readdir(templateRoot); }
}
