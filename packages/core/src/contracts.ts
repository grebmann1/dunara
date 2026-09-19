import { z } from 'zod';

export const presetSchema = z.enum(['sage', 'clay', 'midnight']);
export const colorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/);
export const tokensSchema = z.object({
  background: colorSchema, surface: colorSchema, text: colorSchema, muted: colorSchema,
  accent: colorSchema, onAccent: colorSchema, border: colorSchema,
  radius: z.number().int().min(0).max(32), spacing: z.number().int().min(4).max(12),
  bodySize: z.number().int().min(14).max(20), titleSize: z.number().int().min(28).max(40),
  elevation: z.number().int().min(0).max(8),
}).strict();
export const designSchema = z.object({
  preset: presetSchema, mode: z.enum(['light', 'dark']), tokens: tokensSchema,
}).strict();
export const createSchema = z.object({
  // Keep Unicode validation at runtime: JSON Schema patterns cannot carry the required JS flags.
  name: z.string().trim().min(1).max(60)
    .refine(value => /^[\p{L}\p{N} .'-]+$/u.test(value), 'Use letters, numbers, spaces, periods, apostrophes or hyphens')
    .describe('App name: letters, numbers, spaces, periods, apostrophes or hyphens.'),
  slug: z.string().min(1).max(48).regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/),
  recipe: z.literal('wellness').default('wellness'), preset: presetSchema.default('sage'),
}).strict();
export const projectSchema = z.object({
  id: z.uuid(), name: z.string(), slug: z.string(), root: z.string(),
  recipe: z.literal('wellness'), createdAt: z.iso.datetime(),
});
export const revisionSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const writeSchema = z.object({
  path: z.string().min(1).max(240), content: z.string().max(256_000),
  expectedRevision: revisionSchema.nullable(),
}).strict();
export const routeSchema = z.string().max(200).refine(value => {
  if (!/^\/(?!\/)/.test(value) || /[\\%?#\s]/.test(value) || [...value].some(char => char.charCodeAt(0) < 32)) return false;
  return !value.split('/').some(part => part === '.' || part === '..');
}, 'Use an absolute app path such as /progress, without query, fragment, traversal or encoding');
export const viewportSchema = z.enum(['compact', 'large']);
export const phoneCheck = z.enum(['opened', 'live_refresh', 'sign_in', 'saved_data', 'reopened', 'sign_out']);
export const previewTransportInput = z.object({ transport: z.enum(['localhost', 'lan']), expectedSessionId: z.uuid().nullable() }).strict();
export const phoneTestInput = z.object({ sessionId: z.uuid(), platform: z.enum(['ios', 'android']), expectedRevision: z.uuid().nullable(), checks: z.array(phoneCheck).max(6) }).strict().refine(value => new Set(value.checks).size === value.checks.length && (!value.checks.length || value.checks.includes('opened')), 'Open the app before recording other checks.');
export const phoneTestReport = z.object({ platform: z.enum(['ios', 'android']), revision: z.uuid(), checks: z.array(phoneCheck).max(6), checkedAt: z.iso.datetime(), evidence: z.literal('user_reported') });
export const previewSchema = z.object({
  projectId: z.uuid(), status: z.enum(['stopped', 'starting', 'ready', 'failed']),
  url: z.string().optional(), error: z.string().optional(), deviceUrl: z.string().optional(),
  configurationRevision: revisionSchema.optional(), backendUrl: z.string().url().optional(), environment: z.string().optional(),
  sessionId: z.uuid().optional(), startedAt: z.iso.datetime().optional(),
  transport: z.enum(['localhost', 'lan', 'cloud']).optional(), runtime: z.enum(['expo-go', 'web']).optional(), sdkVersion: z.string().optional(),
  deviceIssue: z.string().optional(),
  phoneTests: z.array(phoneTestReport).max(2).optional(),
});
export const diagnosticSchema = z.object({
  time: z.string(), source: z.enum(['install', 'preview', 'browser', 'builder']),
  level: z.enum(['info', 'error']), message: z.string(),
});
export type Project = z.infer<typeof projectSchema>;
export type Design = z.infer<typeof designSchema>;
export type Tokens = z.infer<typeof tokensSchema>;
export type Preview = z.infer<typeof previewSchema>;
export type Diagnostic = z.infer<typeof diagnosticSchema>;
export type FileWrite = z.infer<typeof writeSchema>;
export const errorCodes = ['PROJECT_NOT_FOUND', 'REVISION_CONFLICT', 'PREVIEW_NOT_READY', 'TRUST_REQUIRED', 'INVALID_PATH', 'LIMIT_EXCEEDED', 'INVALID_INPUT', 'DEPENDENCIES_CHANGED', 'PROCESS_FAILED', 'WRITE_FAILED'] as const;
export class BuilderError extends Error {
  constructor(public code: typeof errorCodes[number], message: string, public details?: unknown) { super(message); }
}
export function errorResult(error: unknown) {
  return { error: {
    code: error instanceof BuilderError ? error.code : 'INVALID_INPUT',
    message: error instanceof Error ? error.message : 'Operation failed',
    ...(error instanceof BuilderError && error.details ? { details: error.details } : {}),
  } };
}
