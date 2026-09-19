import { z } from 'zod';
import { colorSchema, revisionSchema } from './contracts.js';

export const iconCheckSchema = z.object({ assetId: z.uuid() }).strict();
export const iconPrepareSchema = z.object({
  assetId: z.uuid(), expectedRevision: revisionSchema.nullable(),
  kind: z.enum(['master', 'adaptive']), fit: z.enum(['cover', 'contain']), background: colorSchema,
}).strict();
export const iconPreviewSchema = z.object({
  masterId: z.uuid(), foregroundId: z.uuid().optional(), background: colorSchema,
}).strict();
export const iconApplySchema = iconPreviewSchema.extend({
  expectedConfigRevision: revisionSchema, expectedMediaRevision: revisionSchema,
  proposedRevision: revisionSchema, confirmed: z.literal(true),
}).strict();
export type IconPreparation = z.infer<typeof iconPrepareSchema>;
export type IconSelection = z.infer<typeof iconPreviewSchema>;
export type IconApplication = z.infer<typeof iconApplySchema>;
export type IconDiff = {
  path: 'app.json'; before: string; after: string; expectedConfigRevision: string;
  expectedMediaRevision: string; proposedRevision: string; warnings: string[];
};
