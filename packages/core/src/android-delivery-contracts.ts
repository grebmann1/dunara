import { z } from 'zod';
import { revisionSchema } from './contracts.js';
export const androidSelection = z.object({ workspaceId: z.uuid() }).strict();
export const androidBuildInput = z.object({ selection: androidSelection, proposedRevision: revisionSchema, requestId: z.uuid(), confirmed: z.literal(true) }).strict();
export const androidAction = z.object({ id: z.uuid(), expectedRevision: z.uuid() }).strict();
export const androidDeviceId = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/);
export const androidInstallInput = androidAction.extend({ deviceId: androidDeviceId, confirmed: z.literal(true), proposedRevision: revisionSchema }).strict();
export const androidRecord = z.object({
  version: z.literal(1), id: z.uuid(), projectId: z.uuid(), revision: z.uuid(), epoch: z.uuid(), workspaceId: z.uuid(), inputFingerprint: revisionSchema,
  packageName: z.string().regex(/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/), sourceFingerprint: revisionSchema,
  state: z.enum(['building', 'ready', 'installing', 'installed', 'failed', 'interrupted', 'cancelled']),
  step: z.enum(['copy', 'dependencies', 'prebuild', 'compile', 'verify', 'install']), createdAt: z.iso.datetime(),
  artifact: z.object({ fingerprint: revisionSchema, bytes: z.number().positive().max(256 * 1024 * 1024) }).strict().optional(),
  deviceId: androidDeviceId.optional(), error: z.string().max(1000).optional(),
}).strict();
export type AndroidDelivery = z.infer<typeof androidRecord>;
export type AndroidPreflight = { available: boolean; issues: string[]; devices: { id: string; name: string }[] };
export type AndroidPlan = { selection: z.infer<typeof androidSelection>; proposedRevision: string; packageName: string; backend: string; consequences: string[] };
export type AndroidInstallPlan = { id: string; expectedRevision: string; deviceId: string; replacesExistingApp: boolean; packageName: string; proposedRevision: string };
