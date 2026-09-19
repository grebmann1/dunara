import { z } from 'zod';
import { colorSchema, revisionSchema } from './contracts.js';

export const MEDIA_BYTES = 10 * 1024 * 1024;
export const MEDIA_PIXELS = 16_000_000;
export const mediaTypeSchema = z.enum(['image/png', 'image/jpeg', 'image/webp']);
export const roleSchema = z.enum(['illustration', 'background', 'avatar', 'catalog', 'app-icon', 'other']);
export const briefSchema = z.object({
  audience: z.string().max(1000).default(''), purpose: z.string().max(1000).default(''),
  mood: z.string().max(1000).default(''), palette: z.string().max(1000).default(''),
  imageStyle: z.string().max(1000).default(''), avoid: z.string().max(1000).default(''),
  referenceIds: z.array(z.uuid()).max(10).default([]),
}).strict();
export const assetSchema = z.object({
  id: z.uuid(), path: z.string().regex(/^assets\/builder\/[a-f0-9-]{36}\.png$/), hash: revisionSchema,
  width: z.number().int().positive().max(MEDIA_PIXELS), height: z.number().int().positive().max(MEDIA_PIXELS),
  bytes: z.number().int().positive().max(MEDIA_BYTES), mediaType: z.literal('image/png'), transparent: z.boolean(),
  label: z.string().trim().min(1).max(100), role: roleSchema, status: z.enum(['candidate', 'approved']),
  parentId: z.uuid().optional(), provenance: z.enum(['imported', 'generated', 'edited', 'transformed', 'icon']),
  rightsNote: z.string().max(2000), provider: z.literal('openai').optional(), model: z.string().max(100).optional(),
  createdAt: z.iso.datetime(),
}).strict().refine(a => a.width * a.height <= MEDIA_PIXELS && a.path === `assets/builder/${a.id}.png`, 'Invalid asset dimensions or path');
export const manifestSchema = z.object({ version: z.literal(1), brief: briefSchema, assets: z.array(assetSchema).max(100) }).strict();
export const importSchema = z.object({
  expectedRevision: revisionSchema.nullable(), label: z.string().trim().min(1).max(100),
  role: roleSchema.default('other'), rightsNote: z.string().max(2000).default(''), mediaType: mediaTypeSchema,
}).strict();
export const transformSchema = z.object({
  assetId: z.uuid(), expectedRevision: revisionSchema.nullable(), width: z.number().int().min(16).max(4096),
  height: z.number().int().min(16).max(4096), fit: z.enum(['cover', 'contain']),
  focalX: z.number().min(0).max(1).default(0.5), focalY: z.number().min(0).max(1).default(0.5),
  background: colorSchema.default('#ffffff'),
}).strict().refine(a => a.width * a.height <= MEDIA_PIXELS, 'Output exceeds pixel limit');
export const briefUpdateSchema = z.object({ expectedRevision: revisionSchema.nullable(), brief: briefSchema }).strict();
export const approveAssetSchema = z.object({ assetId: z.uuid(), expectedRevision: revisionSchema.nullable() }).strict();
export const jobIdSchema = z.object({ jobId: z.uuid() }).strict();
export const importBase64Schema = z.object({ metadata: importSchema, data: z.string().min(4).max(Math.ceil(MEDIA_BYTES / 3) * 4).regex(/^[A-Za-z0-9+/]+={0,2}$/) }).strict();
export type Asset = z.infer<typeof assetSchema>;
export type Brief = z.infer<typeof briefSchema>;
export type Manifest = z.infer<typeof manifestSchema>;
export type MediaLibrary = Manifest & { revision: string | null };
export type ImportInput = z.input<typeof importSchema>;
export type TransformInput = z.input<typeof transformSchema>;
