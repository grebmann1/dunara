import { z } from 'zod';
import { revisionSchema } from './contracts.js';

export const workspaceSelection = z.object({ profile: z.enum(['development', 'preview']), platform: z.enum(['ios', 'android', 'all']), environment: z.enum(['none', 'development', 'staging']) }).strict();
export const workspacePrepareInput = z.object({ selection: workspaceSelection, proposedRevision: revisionSchema, requestId: z.uuid(), confirmed: z.literal(true) }).strict();
export const workspaceActionInput = z.object({ workspaceId: z.uuid(), expectedRevision: z.uuid() }).strict();
export const workspaceRemoveInput = workspaceActionInput.extend({ confirmed: z.literal(true) }).strict();
export const workspaceFile = z.object({ path: z.string().max(240), bytes: z.number().int().nonnegative(), sha256: revisionSchema }).strict();
export const workspaceState = z.enum(['preparing', 'cancelling', 'ready', 'failed', 'cancelled', 'interrupted']);
export const workspaceStep = z.enum(['copy', 'install', 'typecheck', 'export-web', 'export-ios', 'export-android', 'verify']);
export const workspaceRecord = z.object({
  version: z.literal(1), id: z.uuid(), projectId: z.uuid(), revision: z.uuid(), inputFingerprint: revisionSchema,
  sourceFingerprint: revisionSchema, dependencyFingerprint: revisionSchema, selection: workspaceSelection,
  backend: z.object({ environment: z.string(), url: z.string(), publishableKeyFingerprint: revisionSchema.nullable() }).strict(),
  files: z.array(workspaceFile).max(600), state: workspaceState, step: workspaceStep,
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(), epoch: z.uuid(),
  directoryIdentity: z.object({ device: z.number(), inode: z.number() }).strict(),
  receipts: z.array(z.object({ step: workspaceStep, completedAt: z.iso.datetime() }).strict()).max(8),
  exports: z.array(z.object({ platform: z.enum(['web', 'ios', 'android']), files: z.number().int(), bytes: z.number().int(), fingerprint: revisionSchema }).strict()).max(3),
  error: z.string().max(2000).optional(),
}).strict();
export type WorkspaceSelection = z.infer<typeof workspaceSelection>;
export type WorkspaceRecord = z.infer<typeof workspaceRecord>;
export type WorkspaceFile = z.infer<typeof workspaceFile>;
export type WorkspacePlan = {
  project: { id: string; name: string }; selection: WorkspaceSelection; proposedRevision: string;
  sourceFingerprint: string; dependencyFingerprint: string; backend: WorkspaceRecord['backend'];
  files: WorkspaceFile[]; bytes: number; dependencyProfile: string;
  overlays: { path: string; before: string | null; after: string }[];
  consequences: string[];
};
export type WorkspaceStatus = Omit<WorkspaceRecord, 'epoch' | 'directoryIdentity'>;
