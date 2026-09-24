import { z } from 'zod';
import { tokensSchema } from './contracts.js';
import { briefSchema } from './media-contracts.js';
import { mediaModelSchema } from './media-job-contracts.js';

// Only unfinished creative content belongs here. Connections, secret inputs,
// execution requests and approval decisions are deliberately not draft fields.
const creative = z.object({
  model: mediaModelSchema, operation: z.enum(['generate', 'edit']), referenceIds: z.array(z.uuid()).max(4),
  quality: z.enum(['low', 'medium', 'high']), size: z.enum(['1024x1024', '1536x1024', '1024x1536']),
  count: z.number().int().min(1).max(2), label: z.string().max(100), prompt: z.string().max(8000),
  purpose: z.enum(['illustration', 'hero', 'background', 'app-icon', 'avatar', 'catalog']),
  style: z.enum(['art-direction', 'editorial', 'soft-3d', 'paper-cut', 'minimal', 'photography']), useAppDirection: z.boolean(),
}).strict();
export const workspaceDraftSchema = z.object({
  generation: z.object({ assets: creative.optional(), icons: creative.optional() }).strict().optional(),
  design: z.object({ tokens: tokensSchema.partial(), revision: z.string().max(100) }).strict().optional(),
  brief: z.object({ value: briefSchema, base: z.string().max(100).nullable() }).strict().optional(),
  kit: z.object({ captureIds: z.array(z.string().max(100)).max(100), iconId: z.string().max(100), name: z.string().max(100), summary: z.string().max(2000), description: z.string().max(10000), supportUrl: z.string().max(2000), privacyUrl: z.string().max(2000), attribution: z.string().max(10000) }).strict().optional(),
}).strict();
export type WorkspaceDraft = z.infer<typeof workspaceDraftSchema>;
