import { z } from 'zod';
export const pluginId = z.string().regex(/^[a-z][a-z0-9-]{0,39}\.[a-z][a-z0-9-]{0,39}$/);
export const localId = z.string().regex(/^[a-z][a-z0-9-]{0,47}$/);
export const version = z.string().regex(/^\d+\.\d+\.\d+$/);
export const entryPath = z.string().max(240).refine(p => !p.startsWith('/') && !p.includes('\\') && p.split('/').every(s => /^[a-zA-Z0-9_@.-]+$/.test(s) && s !== '..' && s !== '.' && !s.startsWith('.')), 'Use a package-relative path without hidden or parent segments');
export const manifestSchema = z.object({
  id: pluginId, name: z.string().min(1).max(80), description: z.string().max(1000), apiVersion: z.literal(1),
  server: entryPath.regex(/\.(m?js)$/).optional(), app: entryPath.regex(/\.(m?js)$/).optional(),
  guides: z.array(entryPath).max(10).default([]),
  capabilities: z.array(z.enum(['project.read', 'project.write', 'storage', 'credentials'])).max(4).default([]),
  requires: z.record(pluginId, version).default({}),
}).strict();
export const packageSchema = z.object({ name: z.string().min(1).max(160), version, type: z.literal('module'), builder: manifestSchema }).passthrough();
export type PluginPackage = z.infer<typeof packageSchema>;
export const installedSchema = z.object({
  package: packageSchema, digest: z.string().regex(/^[a-f0-9]{64}$/), enabled: z.boolean(),
  source: z.enum(['builtin', 'local', 'development']), sourcePath: z.string().optional(), installedAt: z.string(),
  previous: z.object({ package: packageSchema, digest: z.string(), source: z.enum(['builtin', 'local', 'development']), sourcePath: z.string().optional(), dataRevision: z.string().optional() }).optional(),
});
export type InstalledPlugin = z.infer<typeof installedSchema>;
export const storeSchema = z.object({ version: z.literal(1), installed: z.array(installedSchema).max(100), uninstalled: z.array(pluginId).max(200) });
export type PluginStore = z.infer<typeof storeSchema>;
export type PluginView = { id: string; name: string; description: string; version: string; digest: string; source: InstalledPlugin['source']; enabled: boolean; status: 'active' | 'disabled' | 'failed' | 'recovery'; error?: string; capabilities: string[]; requires: Record<string, string>; actions: Array<{ id: string; title: string; description: string; effect: 'read' | 'write'; scope: 'project' | 'global'; input: Record<string, unknown> }>; recipes: Array<{ id: string; title: string; version: string; description: string }>; settings: Array<{ id: string; label: string; type: 'string' | 'boolean' | 'number'; default?: unknown }>; appUrl?: string; guides: string[]; canRollback: boolean };
