import path from 'node:path';
import { lstat, readdir } from 'node:fs/promises';
import { z } from 'zod';
import { hash } from "../../../platform/src/crypto.js";
import { PlatformError } from "../../../platform/src/contracts.js";
import { Files } from "../../../core/src/files.js";
import { templateRoot } from "../../../core/src/projects.js";
import { exists, noSymlinks, readText } from "../../../core/src/storage.js";
import type { PreviewDriver } from "../../../core/src/preview-driver.js";

export const serviceRecipePaths = ['backend/configuration.json', 'backend/templates/confirmation.html', 'backend/templates/sign-in.html', 'backend/SERVICES.md', 'src/backend/uploads.ts', 'src/backend/social.ts', 'app/private-files.tsx', 'app/oauth-callback.tsx', 'supabase/migrations/20260917000300_private_uploads.sql', 'supabase/functions/owner-note/index.ts'] as const;
export class ServiceRecipe {
  constructor(private readonly files: Files, private readonly previews: PreviewDriver) {}
  private async tree(root: string, relative: string, result: string[] = [], depth = 0): Promise<string[]> {
    await noSymlinks(root, path.join(root, relative));
    if (!await exists(path.join(root, relative))) return result;
    if (depth > 8 || result.length > 1000) throw new PlatformError('LIMIT_EXCEEDED', 'The service source tree needs manual review.', 400);
    for (const entry of (await readdir(path.join(root, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = `${relative}/${entry.name}`;
      await noSymlinks(root, path.join(root, child));
      result.push(child + (entry.isDirectory() ? '/' : ''));
      if (result.length > 1000) throw new PlatformError('LIMIT_EXCEEDED', 'The service source tree needs manual review.', 400);
      if (entry.isDirectory()) await this.tree(root, child, result, depth + 1);
    }
    return result;
  }
  async preview(projectId: string) {
    const project = await this.files.projects.get(projectId), files: { path: string; content: string; expectedRevision: string | null }[] = [], conflicts: string[] = [];
    const identity = await lstat(project.root), guards: Record<string, unknown> = { device: identity.dev, inode: identity.ino };
    const client = await this.files.read(projectId, 'src/backend/client.ts').catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; });
    if (!client) conflicts.push('Add the reviewed Supabase account/notes recipe first.');
    const tree = [...await this.tree(project.root, 'app'), ...await this.tree(project.root, 'src/backend'), ...await this.tree(project.root, 'supabase')];
    for (const relative of ['src/app', 'app.config.ts', 'app.config.js']) if (await exists(path.join(project.root, relative))) conflicts.push(`Review custom routing in ${relative} manually.`);
    for (const relative of ['package.json', 'app.json']) {
      const current = await this.files.read(projectId, relative); guards[relative] = current.revision;
      if (relative === 'app.json') {
        const plugins = JSON.parse(current.content).expo?.plugins;
        if (Array.isArray(plugins) && plugins.some(p => Array.isArray(p) && p[0] === 'expo-router' && p[1]?.root)) conflicts.push('A custom Expo router root needs manual integration.');
      }
    }
    for (const file of tree) {
      const route = file.replace(/\([^/]+\)\//g, '');
      if (/^app\/(private-files|oauth-callback)(?:\/|\.(?:native\.|web\.|ios\.|android\.)?[jt]sx?$)/i.test(route) && !serviceRecipePaths.includes(file as typeof serviceRecipePaths[number])) conflicts.push(`Route conflict: ${file}`);
      if (/^src\/backend\/(social|uploads)\.(?:native\.|web\.|ios\.|android\.)?[jt]sx?$/.test(file) && !serviceRecipePaths.includes(file as typeof serviceRecipePaths[number])) conflicts.push(`Client conflict: ${file}`);
      if (file.startsWith('supabase/migrations/20260917000300') && !serviceRecipePaths.includes(file as typeof serviceRecipePaths[number])) conflicts.push(`Migration timestamp conflict: ${file}`);
    }
    for (const relative of serviceRecipePaths) {
      await noSymlinks(templateRoot, path.join(templateRoot, relative));
      const content = await readText(path.join(templateRoot, relative));
      const current = await this.files.read(projectId, relative).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; });
      guards[relative] = current?.revision ?? null;
      if (current && current.content !== content) conflicts.push(`Preserve existing edits in ${relative}; merge this example manually.`);
      else if (!current) files.push({ path: relative, content, expectedRevision: null });
    }
    return { recipe: 'supabase-services-v1', projectId, root: project.root, files, conflicts, proposedRevision: hash({ projectId, root: project.root, clientRevision: client?.revision, guards, tree, files, conflicts }), consequences: ['Add independent /private-files and /oauth-callback routes, private upload and web Google clients, email-code configuration/templates, Storage policies and owner-note function source.', 'Keep existing navigation and edited files. No dependencies change. Provider setup, policy execution and deployment require separate reviews.'] };
  }
  async apply(projectId: string, input: unknown) {
    const value = z.object({ proposedRevision: z.string().regex(/^[a-f0-9]{64}$/), confirmed: z.literal(true) }).strict().parse(input);
    return this.files.projects.mutations.run(async () => {
      const proposal = await this.preview(projectId);
      if (proposal.proposedRevision !== value.proposedRevision || proposal.conflicts.length) throw new PlatformError('REVISION_CONFLICT', 'The service recipe changed or conflicts with existing source. Review it again.', 409);
      if (proposal.files.length) await this.previews.withStopped(projectId, () => this.files.writeUnlocked(projectId, proposal.files));
      return { recipe: proposal.recipe, written: proposal.files.map(f => f.path) };
    });
  }
}
