import { z } from 'zod';

export const providerRevisionSchema = z.uuid();
export const providerStatusSchema = z.object({
  configured: z.boolean(), source: z.enum(['environment', 'session', 'saved', 'none', 'managed', 'chatgpt']),
  revision: providerRevisionSchema, busy: z.boolean(), environmentAvailable: z.boolean(),
  storage: z.enum(['os', 'configured', 'session', 'locked']),
  rememberAvailable: z.boolean(),
  chatgpt: z.object({ connected: z.boolean(), available: z.boolean(), selected: z.boolean(), reason: z.string().optional() }).optional(),
  personalConfigured: z.boolean().optional(),
  managed: z.object({ label: z.string(), selected: z.boolean(), personalConfigured: z.boolean(), balance: z.object({ remaining: z.number(), reserved: z.number(), limit: z.number(), resetsAt: z.string(), reason: z.string().optional() }).optional() }).optional(),
}).strict();
const expectedRevision = providerRevisionSchema;
const key = z.string().max(4096).transform(value => value.trim()).refine(value => value.length > 0 && [...value].every(char => char.charCodeAt(0) >= 33 && char.charCodeAt(0) <= 126), 'Use a nonempty ASCII token without whitespace');
export const providerUpdateSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('replace'), expectedRevision, key, remember: z.boolean().default(false) }).strict(),
  z.object({ action: z.literal('disconnect'), expectedRevision }).strict(),
  z.object({ action: z.literal('environment'), expectedRevision }).strict(),
  z.object({ action: z.literal('managed'), expectedRevision }).strict(),
  z.object({ action: z.literal('personal'), expectedRevision }).strict(),
  z.object({ action: z.literal('chatgpt'), expectedRevision }).strict(),
]);
export const paidApprovalSchema = z.object({ jobId: z.uuid(), expectedConfigurationRevision: providerRevisionSchema }).strict();
export type ProviderStatus = z.infer<typeof providerStatusSchema>;
export type ProviderUpdate = z.infer<typeof providerUpdateSchema>;
