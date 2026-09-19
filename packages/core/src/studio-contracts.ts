import { z } from 'zod';
import { createSchema, revisionSchema, routeSchema, viewportSchema } from './contracts.js';

export const workspaceSchema = z.enum(['preview', 'assets', 'icons', 'backend', 'activity', 'settings', 'plugins']);
export const canvasModeSchema = z.enum(['overview', 'focus', 'compare']);
export const comparisonSchema = z.enum(['screens', 'sizes']);
export const boardScreensSchema = z.array(z.object({ route: routeSchema, name: z.string().trim().min(1).max(80) }).strict()).min(1).max(24).refine(screens => new Set(screens.map(screen => screen.route)).size === screens.length, 'Each screen needs a unique route');
export const savedViewSchema = z.object({ id: z.uuid(), label: z.number().int().min(1).max(2), route: routeSchema, viewport: viewportSchema }).strict();
export const savedBoardSchema = z.object({ views: z.array(savedViewSchema).min(1).max(2), activeId: z.uuid(), mode: canvasModeSchema.optional(), comparison: comparisonSchema.default('screens'), screens: boardScreensSchema.optional() }).strict().transform(board => ({ ...board, mode: board.mode ?? (board.views.length > 1 ? 'compare' as const : 'focus' as const) })).refine(board =>
  new Set(board.views.map(v => v.id)).size === board.views.length && new Set(board.views.map(v => v.label)).size === board.views.length && board.views.some(v => v.id === board.activeId), 'Views must have unique IDs and labels and an existing active view');
export const studioPreferencesSchema = z.object({ workspace: workspaceSchema, designOpen: z.boolean(), assetsTab: z.enum(['library', 'launch-kit']), board: savedBoardSchema }).strict();
export type StudioPreferences = z.infer<typeof studioPreferencesSchema>;
export function defaultStudio(id: string): StudioPreferences {
  return { workspace: 'preview', designOpen: false, assetsTab: 'library', board: { views: [{ id, label: 1, route: '/', viewport: 'compact' }], activeId: id, mode: 'focus', comparison: 'screens' } };
}
export const recipeApplicationSchema = z.object({ pluginId: z.string().max(81), recipeId: z.string().max(48), version: z.string().max(32), digest: z.string().regex(/^[a-f0-9]{64}$/), appliedAt: z.iso.datetime() }).strict();
export const projectMetadataSchema = z.object({
  version: z.literal(1),
  project: z.object({ id: z.uuid(), name: createSchema.shape.name, slug: createSchema.shape.slug, recipe: z.literal('wellness'), createdAt: z.iso.datetime() }).strict(),
  studio: studioPreferencesSchema,
  recipeApplications: z.array(recipeApplicationSchema).max(30).optional(),
}).strict();
export const studioActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('select-project'), projectId: z.uuid() }).strict(),
  z.object({ type: z.literal('navigate'), workspace: workspaceSchema }).strict(),
  z.object({ type: z.literal('design'), open: z.boolean() }).strict(),
  z.object({ type: z.literal('assets-tab'), tab: z.enum(['library', 'launch-kit']) }).strict(),
  z.object({ type: z.literal('canvas-mode'), mode: canvasModeSchema }).strict(),
  z.object({ type: z.literal('compare'), comparison: comparisonSchema, route: routeSchema, otherRoute: routeSchema.optional() }).strict(),
  z.object({ type: z.literal('focus-screen'), route: routeSchema }).strict(),
  z.object({ type: z.literal('screen-list'), screens: boardScreensSchema.nullable() }).strict(),
  z.object({ type: z.literal('add'), id: z.uuid() }).strict(),
  z.object({ type: z.literal('remove'), id: z.uuid() }).strict(),
  z.object({ type: z.literal('activate'), id: z.uuid() }).strict(),
  z.object({ type: z.literal('reload'), id: z.uuid() }).strict(),
  z.object({ type: z.literal('update'), id: z.uuid(), patch: z.object({ route: routeSchema.optional(), viewport: viewportSchema.optional() }).strict() }).strict(),
]);
export const studioControlSchema = z.object({ expectedRevision: revisionSchema, action: studioActionSchema }).strict();
export type StudioAction = z.infer<typeof studioActionSchema>;
