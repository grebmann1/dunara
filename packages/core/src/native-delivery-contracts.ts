import { z } from 'zod';
import { revisionSchema } from './contracts.js';

export const iosDevice = z.object({ id: z.string().regex(/^[A-Fa-f0-9-]{16,64}$/), name: z.string().max(200), model: z.string().max(200), developerMode: z.boolean() }).strict();
export const signingTeam = z.object({ id: z.string().regex(/^[A-Z0-9]{10}$/), name: z.string().max(200) }).strict();
export const deliverySelection = z.object({ workspaceId: z.uuid(), deviceId: iosDevice.shape.id, teamId: signingTeam.shape.id }).strict();
export const deliveryBuildInput = z.object({ selection: deliverySelection, proposedRevision: revisionSchema, requestId: z.uuid(), confirmed: z.literal(true) }).strict();
export const deliveryActionInput = z.object({ deliveryId: z.uuid(), expectedRevision: z.uuid() }).strict();
export const deliveryInstallInput = deliveryActionInput.extend({ proposedRevision: revisionSchema, confirmed: z.literal(true) }).strict();
export const deliveryLaunchInput = deliveryActionInput.extend({ confirmed: z.literal(true) }).strict();
export const deliveryRemoveInput = deliveryActionInput.extend({ confirmed: z.literal(true) }).strict();
export const deliveryStep = z.enum(['copy', 'dependencies', 'prebuild', 'pods', 'compile', 'verify', 'install', 'launch']);
export const deliveryRecord = z.object({
  version: z.literal(1), id: z.uuid(), projectId: z.uuid(), revision: z.uuid(), epoch: z.uuid(),
  directoryIdentity: z.object({ device: z.number(), inode: z.number() }).strict(),
  selection: deliverySelection, device: iosDevice, team: signingTeam, bundleIdentifier: z.string().max(155).regex(/^[A-Za-z][A-Za-z0-9-]*(\.[A-Za-z][A-Za-z0-9-]*)+$/),
  inputFingerprint: revisionSchema, sourceFingerprint: revisionSchema,
  state: z.enum(['building', 'ready', 'installing', 'installed', 'launching', 'launched', 'failed', 'cancelled', 'interrupted']), step: deliveryStep,
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
  receipts: z.array(z.object({ step: deliveryStep, completedAt: z.iso.datetime() }).strict()).max(30),
  artifact: z.object({ name: z.string().regex(/^[A-Za-z0-9 _-]+\.app$/), fingerprint: revisionSchema, bytes: z.number().int().positive() }).strict().optional(),
  processId: z.number().int().positive().optional(), error: z.string().max(2000).optional(),
}).strict();
export type DeliverySelection = z.infer<typeof deliverySelection>;
export type DeliveryRecord = z.infer<typeof deliveryRecord>;
export type DeliveryStatus = Omit<DeliveryRecord, 'epoch' | 'directoryIdentity'>;
export type NativeDevice = z.infer<typeof iosDevice>;
export type SigningTeam = z.infer<typeof signingTeam>;
export type DeliveryPreflight = { supported: boolean; devices: NativeDevice[]; teams: SigningTeam[]; issues: string[]; xcode?: string; cocoaPods?: string };
export type DeliveryPlan = { selection: DeliverySelection; device: NativeDevice; team: SigningTeam; bundleIdentifier: string; sourceFingerprint: string; proposedRevision: string; consequences: string[] };
export type InstallPlan = { deliveryId: string; expectedRevision: string; device: NativeDevice; bundleIdentifier: string; artifact: NonNullable<DeliveryRecord['artifact']>; replacesExistingApp: boolean; proposedRevision: string; consequences: string[] };
