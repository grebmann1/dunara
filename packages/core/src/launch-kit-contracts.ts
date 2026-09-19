import { z } from 'zod';
import { revisionSchema, routeSchema, viewportSchema } from './contracts.js';

export const KIT_BYTES = 32 * 1024 * 1024;
export const KIT_STORAGE_BYTES = 256 * 1024 * 1024;
export const KIT_PROJECT_LIMIT = 5;
export const KIT_TEXT_BYTES = 32 * 1024;
// Only explicit export fields are collected; reject common accidental credential/path pastes too.
const portableText = (max: number) => z.string().max(max).refine(value => ![...value].some(char => (char.charCodeAt(0) < 32 && !['\n', '\t'].includes(char)) || char.charCodeAt(0) === 127) && !/(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\)|\bsk-[A-Za-z0-9_-]{12,}|(?:bearer\s+\S+|(?:api[_-]?key|access[_-]?token|ticket)\s*[=:]\s*\S+)/i.test(value), 'Remove credentials, private paths and control characters before exporting');
const publicUrl = portableText(2048).refine(value => {
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash; } catch { return false; }
}, 'Use an HTTP(S) URL without credentials, query or fragment; URLs are never fetched');
export const listingSchema = z.object({
  name: portableText(100).trim().min(1), summary: portableText(500), description: portableText(KIT_TEXT_BYTES),
  supportUrl: publicUrl.optional(), privacyUrl: publicUrl.optional(),
}).strict().refine(value => new TextEncoder().encode(JSON.stringify(value)).length <= KIT_TEXT_BYTES, 'Listing exceeds 32 KiB');
export const launchKitCreateSchema = z.object({
  captureIds: z.array(z.uuid()).min(1).max(10).refine(ids => new Set(ids).size === ids.length, 'Select each capture once'),
  icon: z.object({ assetId: z.uuid(), expectedRevision: revisionSchema }).strict().optional(),
  listing: listingSchema,
  attribution: portableText(8000).default(''),
  confirmed: z.literal(true),
}).strict();
export const launchKitRemoveSchema = z.object({ bundleId: z.uuid(), confirmed: z.literal(true) }).strict();
export const kitFileIdSchema = z.union([z.enum(['manifest', 'listing-json', 'listing', 'credits', 'readiness', 'icon']), z.string().regex(/^screenshot-[a-f0-9-]{36}$/)]);
const fileSchema = z.object({
  id: kitFileIdSchema, name: z.string().max(100), mediaType: z.enum(['application/json', 'text/markdown', 'image/png']),
  bytes: z.number().int().positive().max(KIT_BYTES), sha256: revisionSchema,
}).strict();
export const kitLimitations = [
  'React Native Web — not native App Store screenshots.',
  'Captures use a fresh browser context, not the visible phone input or storage state. Capture time does not prove current source revision.',
  'Listing and attribution are user-authored drafts; rights, marketing claims and URL contents are not verified.',
  'Native interaction, safe areas, keyboard, accessibility and installed launcher appearance require separate qualification.',
  'Native persistence is not provided by this kit. Bonsai native changes remain session-only.',
  'No store-size certification, signing, submission, publication or provider request was performed.',
] as const;
export const launchKitManifestSchema = z.object({
  schemaVersion: z.literal(1), id: z.uuid(), createdAt: z.iso.datetime(),
  project: z.object({ id: z.uuid(), name: portableText(100).min(1), slug: z.string().regex(/^[a-z][a-z0-9-]{0,47}$/) }).strict(),
  captures: z.array(z.object({
    id: z.uuid(), projectId: z.uuid(), route: routeSchema, viewport: viewportSchema,
    width: z.number().int(), height: z.number().int(), createdAt: z.iso.datetime(), rendering: z.literal('React Native Web'), bytes: z.number().int().positive().max(2_000_000),
    environment: z.enum(['development', 'staging', 'production']).optional(), configurationRevision: revisionSchema.optional(),
  }).strict().refine(c => c.viewport === 'compact' ? c.width === 375 && c.height === 812 : c.width === 430 && c.height === 932)).min(1).max(10),
  icon: z.object({ assetId: z.uuid(), mediaRevision: revisionSchema, sha256: revisionSchema, width: z.literal(1024), height: z.literal(1024), status: z.literal('approved'), rightsNote: portableText(2000) }).strict().optional(),
  listing: listingSchema, attribution: portableText(8000),
  files: z.array(fileSchema).min(5).max(15), limitations: z.array(z.string()).length(kitLimitations.length),
}).strict();
export type LaunchKitCreate = z.input<typeof launchKitCreateSchema>;
export type LaunchKitManifest = z.infer<typeof launchKitManifestSchema>;
export type LaunchKitFile = z.infer<typeof fileSchema>;
export type LaunchKit = { manifest: LaunchKitManifest; files: LaunchKitFile[]; location: string };
