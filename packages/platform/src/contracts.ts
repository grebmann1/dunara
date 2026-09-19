import { z } from 'zod';

export const uuid = z.uuid();
export const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const environmentName = z.enum(['development', 'staging', 'production']);
export const providerRef = z.string().regex(/^[a-z0-9]{20}$/);
export const organizationSlug = z.string().min(1).max(100).regex(/^[a-z0-9-]+$/);
export const publicKey = z.string().regex(/^sb_publishable_[A-Za-z0-9_-]+$/).max(4096);
export const projectUrl = z.string().url().refine(value => {
  const url = new URL(value);
  return url.protocol === 'https:' && /^[a-z0-9]{20}\.supabase\.co$/.test(url.hostname) && !url.port && url.pathname === '/' && !url.search && !url.hash && !url.username && !url.password;
}, 'Use the hosted Supabase project URL');
export const connectionInput = z.object({ token: z.string().min(16).max(4096).regex(/^[\x21-\x7e]+$/), remember: z.boolean().default(false) }).strict();
export const bindingSchema = z.object({
  projectId: uuid, environment: environmentName, provider: z.literal('supabase'), projectRef: providerRef, organization: organizationSlug,
  url: projectUrl, publishableKey: publicKey, connectedAt: z.iso.datetime(), ownershipMode: z.literal('user'),
}).strict().refine(value => new URL(value.url).hostname === `${value.projectRef}.supabase.co`, 'Project reference and URL must match');
export type BackendBinding = z.infer<typeof bindingSchema>;
export type EnvironmentName = z.infer<typeof environmentName>;

export const operationStates = ['awaiting_approval', 'queued', 'running', 'succeeded', 'failed', 'cancelled', 'reconciliation_required'] as const;
export const operationSchema = z.object({
  id: uuid, workspaceId: uuid, projectId: uuid, environment: environmentName, actorId: z.string().min(1).max(200),
  kind: z.string().min(1).max(80), idempotencyKey: uuid, planHash: digest, plan: z.record(z.string(), z.unknown()),
  state: z.enum(operationStates), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
  leaseOwner: z.string().nullable(), leaseUntil: z.number().nullable(), fence: z.number().int().nonnegative(),
  error: z.string().nullable(), result: z.record(z.string(), z.unknown()).nullable(),
});
export type Operation = z.infer<typeof operationSchema>;
export type OperationState = Operation['state'];
export type Actor = { id: string; workspaceId: string; role: 'owner' | 'admin' | 'editor' | 'viewer'; source: 'local-owner' | 'account' | 'runner' };
export function authorize(actor: Actor, workspaceId: string, action: 'read' | 'write' | 'manage' | 'production') {
  if (actor.workspaceId !== workspaceId || !actor.id || (action !== 'read' && actor.role === 'viewer') || (['manage', 'production'].includes(action) && !['owner', 'admin'].includes(actor.role))) throw new PlatformError('FORBIDDEN', 'This account cannot perform the requested workspace action.', 403);
}
export class PlatformError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message); }
}
export function publicError(error: unknown) {
  return error instanceof PlatformError ? { code: error.code, message: error.message } : { code: 'INVALID_INPUT', message: 'The request could not be completed. Check its configuration and current revision.' };
}
