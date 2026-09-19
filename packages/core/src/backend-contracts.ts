import { z } from 'zod';
import { digest, environmentName, organizationSlug, providerRef, uuid } from '../../platform/src/contracts.js';
import { configurationInput, configurationPlan, verificationInput } from '../../platform/src/configuration.js';

export const backendCatalogInput = z.object({ offset: z.number().int().min(0).max(1000).default(0), limit: z.number().int().min(1).max(100).default(50), expectedRevision: digest.optional() }).strict().refine(value => value.offset === 0 || !!value.expectedRevision, 'Subsequent pages require the catalog revision.');
export const backendEnvironmentInput = z.object({ environment: environmentName, expectedRevision: digest }).strict();

export const backendMigrationPath = z.string().regex(/^supabase\/migrations\/[0-9]{14}_[a-z0-9_]+\.sql$/).max(200);
export const backendPlanInput = z.union([configurationInput, verificationInput, z.discriminatedUnion('action', [
  z.object({ action: z.literal('link'), environment: environmentName.default('development'), projectRef: providerRef, organization: organizationSlug }).strict(),
  z.object({ action: z.literal('create'), environment: environmentName.default('development'), organization: organizationSlug, region: z.string().regex(/^[a-z0-9-]{2,80}$/), name: z.string().trim().min(1).max(100) }).strict(),
  z.object({ action: z.literal('migration'), environment: environmentName.default('development'), path: backendMigrationPath }).strict(),
])]);
export const backendPlanSchema = z.object({
  version: z.literal(1), projectId: uuid, environment: environmentName,
  action: z.enum(['link', 'create', 'migration']), connectionRevision: uuid,
  expectedBindingHash: digest, expiresAt: z.iso.datetime(),
  target: z.object({ organization: organizationSlug, projectRef: providerRef.optional(), region: z.string().max(80).optional(), name: z.string().max(100).optional() }).strict(),
  migration: z.object({ path: backendMigrationPath, revision: digest, name: z.string().max(160), query: z.string().max(256_000), historyHash: digest }).strict().optional(),
  consequences: z.array(z.string().max(500)).max(10),
}).strict().refine(plan => plan.action === 'migration' ? !!plan.migration && !!plan.target.projectRef : !plan.migration && (plan.action === 'link' ? !!plan.target.projectRef : !!plan.target.name && !!plan.target.region));
export type BackendPlan = z.infer<typeof backendPlanSchema>;
export const anyBackendPlan = z.union([backendPlanSchema, configurationPlan]);
export const backendSubmitSchema = z.union([z.object({ plan: anyBackendPlan, requestId: uuid }).strict(), z.object({ preparedPlanHash: digest, requestId: uuid }).strict()]);
export const backendApprovalSchema = z.object({ operationId: uuid, planHash: digest }).strict();
export const backendRecoverySchema = backendApprovalSchema.extend({ fence: z.number().int().nonnegative() });
