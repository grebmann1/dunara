import { lstat, mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { BuilderError, revisionSchema, tokensSchema } from "../../../core/src/contracts.js";
import { dependencyFiles, dependencyProfile } from "../../../core/src/dependency-profiles.js";
import { revision } from "../../../core/src/files.js";
import { Projects, templateRoot } from "../../../core/src/projects.js";
import type { PreviewDriver } from "../../../core/src/preview-driver.js";
import { atomicWrite, exists, noSymlinks, readText } from "../../../core/src/storage.js";

const recipe = 'supabase-notes-v1' as const;
export const recipeUpgradePaths = [
  'src/backend/client.ts', 'src/backend/database.types.ts', 'src/backend/session-storage.ts',
  'src/backend/session-storage.native.ts', 'src/backend/chunked-storage.ts',
  'backend/connection.json', 'backend/README.md',
  'supabase/migrations/20260917000100_notes.sql', 'supabase/tests/notes.sql', 'app/account.tsx',
  'package-lock.json', 'package.json',
] as const;
export const recipeUpgradeApplySchema = z.object({ projectId: z.uuid(), proposedRevision: revisionSchema, confirmed: z.literal(true) }).strict();
const identitySchema = z.object({ id: z.uuid(), root: z.string(), device: z.number(), inode: z.number() }).strict();
const fileSchema = z.object({ path: z.enum(recipeUpgradePaths), before: z.string().max(2_000_000).nullable(), after: z.string().max(2_000_000) }).strict();
const journalSchema = z.object({ version: z.literal(1), recipe: z.literal(recipe), identity: identitySchema, files: z.array(fileSchema).max(recipeUpgradePaths.length) }).strict();
type Journal = z.infer<typeof journalSchema>;
type Change = { path: string; before: string | null; after: string | null; expectedRevision: string | null };
type Conflict = { path: string; reason: string };
export type RecipeUpgradeProposal = {
  project: { id: string; name: string }; recipe: typeof recipe; proposedRevision: string;
  state: 'ready' | 'current' | 'conflict' | 'recovery';
  fromProfile: string | null; toProfile: string; files: Change[]; conflicts: Conflict[];
  dependencyChanges: { name: string; before: string | null; after: string | null }[];
  consequences: string[];
};

/** Only this curated operation can replace a package lock. Generic source writes remain restricted. */
export class RecipeUpgrades {
  constructor(private projects: Projects, private previews: PreviewDriver) {}
  private async journalPath(id: string) {
    z.uuid().parse(id);
    const file = path.join(this.projects.home, 'recipe-upgrades', `${id}.json`);
    await noSymlinks(this.projects.home, file);
    return file;
  }
  async assertReady(id: string) {
    if (await exists(await this.journalPath(id))) throw new BuilderError('REVISION_CONFLICT', 'An interrupted recipe upgrade needs review in Backend before previewing this app.');
  }
  private async content(root: string, relative: string) {
    const target = path.join(root, relative);
    await noSymlinks(root, target);
    return await exists(target) ? readText(target, 2_000_000) : null;
  }
  private async identity(id: string) {
    const project = await this.projects.get(id), info = await lstat(project.root);
    return { id, root: project.root, device: info.dev, inode: info.ino };
  }
  // Include directories and symlinks: a filtered source listing cannot prove a route is unoccupied.
  private async tree(root: string, relative: string, entries: string[] = [], depth = 0): Promise<string[]> {
    const target = path.join(root, relative);
    await noSymlinks(root, target);
    if (!await exists(target)) return entries;
    if (depth > 8) throw new BuilderError('LIMIT_EXCEEDED', 'The recipe source tree is too deep to review safely.');
    for (const entry of (await readdir(target, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entries.length >= 1000) throw new BuilderError('LIMIT_EXCEEDED', 'The recipe source tree is too large to review safely.');
      const child = `${relative}/${entry.name}`;
      await noSymlinks(root, path.join(root, child));
      entries.push(child + (entry.isDirectory() ? '/' : ''));
      if (entry.isDirectory()) await this.tree(root, child, entries, depth + 1);
    }
    return entries;
  }
  preview(id: string) { return this.projects.mutations.run(() => this.proposal(id)); }
  private async proposal(id: string): Promise<RecipeUpgradeProposal> {
    const identity = await this.identity(id), project = await this.projects.get(id), journalPath = await this.journalPath(id);
    const files: Change[] = [], conflicts: Conflict[] = [], guards: Record<string, unknown> = { identity };
    let state: RecipeUpgradeProposal['state'] = 'ready', fromProfile: string | null = null;
    let consequences = [
      'Add pinned Supabase and secure session storage dependencies, an /account screen, typed client and private-notes SQL files.',
      'Keep existing screens, navigation and theme. Add a link to /account when you are ready to expose sign-in.',
      'Stop the running preview when approved. The next preview installs the reviewed dependencies with lifecycle scripts disabled.',
      'This changes local app files only. Connect a development backend and review its SQL separately.',
    ];
    if (await exists(journalPath)) {
      const journalText = await readText(journalPath, 6_000_000), journal = journalSchema.parse(JSON.parse(journalText));
      if (JSON.stringify(journal.identity) !== JSON.stringify(identity)) throw new BuilderError('REVISION_CONFLICT', 'The project root changed since the interrupted upgrade. Preserve the recovery record and restore the original project first.');
      if (new Set(journal.files.map(file => file.path)).size !== journal.files.length) throw new BuilderError('INVALID_INPUT', 'Invalid recipe recovery record.');
      guards.journal = revision(journalText); state = 'recovery';
      consequences = ['Restore the files from before the interrupted upgrade. Review each restoration below.', 'Keep the preview stopped until recovery finishes. Edits made after the interruption are never overwritten.'];
      for (const file of journal.files) {
        const current = await this.content(project.root, file.path);
        guards[file.path] = current === null ? null : revision(current);
        if (current !== file.before && current !== file.after) conflicts.push({ path: file.path, reason: 'Changed after the interruption. Restore its reviewed before/after version manually before recovery.' });
        else if (current !== file.before) files.push({ path: file.path, before: current, after: file.before, expectedRevision: current === null ? null : revision(current) });
      }
    } else {
      const dependencies = await dependencyFiles(project.root);
      fromProfile = await dependencyProfile(dependencies);
      guards.manifest = revision(dependencies.manifest); guards.lock = revision(dependencies.lock);
      if (fromProfile === 'expo-supabase-v1') state = 'current';
      else if (fromProfile !== 'expo-legacy') conflicts.push({ path: 'package.json / package-lock.json', reason: 'Custom dependencies or scripts require a manual upgrade. Only the pinned legacy profile can be upgraded automatically.' });
      else {
        const tree = [...await this.tree(project.root, 'app'), ...await this.tree(project.root, 'src/backend'), ...await this.tree(project.root, 'backend'), ...await this.tree(project.root, 'supabase')];
        guards.tree = tree;
        if (await exists(path.join(project.root, 'src/app'))) conflicts.push({ path: 'src/app', reason: 'This recipe requires the existing app/ router root. Review a manual route integration.' });
        for (const relative of ['app/_layout.tsx', 'src/theme/design.json', 'tsconfig.json', 'app.json']) {
          const content = await this.content(project.root, relative);
          guards[relative] = content === null ? null : revision(content);
          if (content === null) conflicts.push({ path: relative, reason: 'Required starter integration file is missing. Review a manual integration.' });
          else if (relative === 'src/theme/design.json' && !tokensSchema.safeParse(JSON.parse(content).tokens).success) conflicts.push({ path: relative, reason: 'The account screen requires compatible theme tokens. Review a manual integration.' });
          else if (relative === 'app.json') {
            const config = JSON.parse(content);
            if (config.expo?.plugins?.some((plugin: unknown) => Array.isArray(plugin) && plugin[0] === 'expo-router' && plugin[1]?.root && plugin[1].root !== 'app')) conflicts.push({ path: relative, reason: 'A custom router root requires manual route integration.' });
          }
        }
        for (const relative of ['app.config.js', 'app.config.ts']) if (await exists(path.join(project.root, relative))) conflicts.push({ path: relative, reason: 'Dynamic Expo configuration requires manual route integration.' });
        for (const relative of tree) {
          const route = relative.replace(/^app\//, '').split('/').filter(segment => !/^\(.*\)$/.test(segment)).join('/').replace(/\.(ios|android|native|web)?\.?[jt]sx?$/, '');
          if (relative.startsWith('app/') && (route.toLowerCase() === 'account' || route.toLowerCase().startsWith('account/')) && relative !== 'app/account.tsx') conflicts.push({ path: relative, reason: 'An existing account route or directory conflicts with the new screen.' });
          if (/^(src\/backend|backend)\//.test(relative) && !recipeUpgradePaths.includes(relative as typeof recipeUpgradePaths[number])) conflicts.push({ path: relative, reason: 'Existing backend integration needs a manual merge.' });
          if (/^supabase\/migrations\/20260917000100/.test(relative) && relative !== 'supabase/migrations/20260917000100_notes.sql') conflicts.push({ path: relative, reason: 'The recipe migration timestamp is already in use.' });
        }
        for (const relative of recipeUpgradePaths) {
          const before = await this.content(project.root, relative);
          let after = await readText(path.join(templateRoot, relative), 2_000_000);
          if (relative === 'package.json' || relative === 'package-lock.json') {
            const value = JSON.parse(after), current = JSON.parse(before!);
            value.name = current.name;
            if (relative === 'package-lock.json') value.packages[''].name = current.packages[''].name;
            after = JSON.stringify(value, null, 2) + '\n';
          } else if (before !== null && before !== after) conflicts.push({ path: relative, reason: 'This file already contains different content. Review a manual merge; the upgrade will not replace it.' });
          guards[relative] = before === null ? null : revision(before);
          if (before !== after) files.push({ path: relative, before, after, expectedRevision: before === null ? null : revision(before) });
        }
      }
    }
    if (conflicts.length) state = 'conflict';
    const lockChange = files.find(file => file.path === 'package-lock.json');
    const beforePackages = lockChange?.before ? JSON.parse(lockChange.before).packages : {}, afterPackages = lockChange?.after ? JSON.parse(lockChange.after).packages : {};
    const dependencyChanges = [...new Set<string>([...Object.keys(beforePackages), ...Object.keys(afterPackages)])].filter(name => name && beforePackages[name]?.version !== afterPackages[name]?.version).sort().map(name => ({ name, before: beforePackages[name]?.version ?? null, after: afterPackages[name]?.version ?? null }));
    const result = { project: { id, name: project.name }, recipe, state, fromProfile, toProfile: Object.hasOwn(guards, 'journal') ? 'expo-legacy' : 'expo-supabase-v1', files: conflicts.length ? [] : files, conflicts, consequences, dependencyChanges: conflicts.length ? [] : dependencyChanges };
    return { ...result, proposedRevision: revision(JSON.stringify({ ...result, guards })) };
  }
  async apply(id: string, input: unknown) {
    const value = recipeUpgradeApplySchema.parse(input);
    if (value.projectId !== id) throw new BuilderError('INVALID_INPUT', 'Upgrade belongs to another project.');
    return this.projects.mutations.run(async () => {
      const plan = await this.proposal(id);
      if (plan.proposedRevision !== value.proposedRevision) throw new BuilderError('REVISION_CONFLICT', 'The upgrade changed. Review a fresh proposal before applying.');
      if (plan.state === 'conflict') throw new BuilderError('REVISION_CONFLICT', 'Resolve the listed conflicts before upgrading.');
      if (plan.state === 'current') return { applied: [], recipe, recovered: false };
      return this.previews.withStopped(id, async () => {
        // Stopping an in-flight installation yields; recheck everything before writing.
        if ((await this.proposal(id)).proposedRevision !== value.proposedRevision) throw new BuilderError('REVISION_CONFLICT', 'Source changed while stopping the preview. Review again.');
        const identity = await this.identity(id), journalPath = await this.journalPath(id);
        if (plan.state === 'recovery') {
          for (const file of [...plan.files].reverse()) await this.replace(identity, file);
          await rm(journalPath);
        } else {
          const journal: Journal = { version: 1, recipe, identity, files: plan.files.map(file => ({ path: z.enum(recipeUpgradePaths).parse(file.path), before: file.before, after: file.after! })) };
          await mkdir(path.dirname(journalPath), { recursive: true });
          await this.journalPath(id); await atomicWrite(journalPath, JSON.stringify(journal));
          try {
            for (const file of plan.files) await this.replace(identity, file);
            await rm(journalPath);
          } catch (error) {
            // Restore only our exact writes. A concurrent editor's content remains untouched.
            let restored = true;
            for (const file of [...journal.files].reverse()) {
              try {
                const current = await this.content(identity.root, file.path);
                if (current === file.before) continue;
                if (current !== file.after) { restored = false; continue; }
                await this.replace(identity, { path: file.path, before: current, after: file.before, expectedRevision: revision(current) });
              } catch { restored = false; }
            }
            if (restored) await rm(journalPath);
            throw new BuilderError('WRITE_FAILED', restored ? 'Upgrade failed. Original files were restored; review again before retrying.' : 'Upgrade interrupted. Review recovery in Backend before previewing.', { cause: error instanceof Error ? error.message : 'Write failed', recoveryRequired: !restored });
          }
        }
        this.previews.diagnostics.emit('change', id);
        return { applied: plan.files.map(file => ({ path: file.path })), recipe, recovered: plan.state === 'recovery' };
      });
    });
  }
  private async replace(identity: z.infer<typeof identitySchema>, file: Change) {
    if (JSON.stringify(await this.identity(identity.id)) !== JSON.stringify(identity)) throw new BuilderError('REVISION_CONFLICT', 'Project root changed.');
    const target = path.join(identity.root, file.path);
    await noSymlinks(identity.root, target);
    await mkdir(path.dirname(target), { recursive: true });
    await noSymlinks(identity.root, target);
    if (await this.content(identity.root, file.path) !== file.before) throw new BuilderError('REVISION_CONFLICT', `Source changed: ${file.path}`);
    if (file.after === null) await rm(target); else await atomicWrite(target, file.after);
  }
}
