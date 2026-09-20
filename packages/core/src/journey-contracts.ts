import { z } from 'zod';
import { revisionSchema } from './contracts.js';

export const journeyPreferencesSchema = z.object({
  brief: z.string().trim().max(2000).default(''),
  idea: z.boolean().default(false),
  assetsLater: z.boolean().default(false),
  backendLater: z.boolean().default(false),
  testedSourceRevision: revisionSchema.nullable().default(null),
}).strict();
export type JourneyPreferences = z.infer<typeof journeyPreferencesSchema>;
export const journeyUpdateSchema = z.object({
  expectedRevision: revisionSchema,
  patch: z.object({ brief: z.string().trim().max(2000).optional(), idea: z.boolean().optional(), assetsLater: z.boolean().optional(), backendLater: z.boolean().optional(), tested: z.boolean().optional() }).strict(),
  sourceRevision: revisionSchema.optional(),
}).strict();
