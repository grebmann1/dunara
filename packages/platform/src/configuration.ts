import { z } from 'zod';
import { digest, environmentName, organizationSlug, providerRef, uuid } from './contracts.js';

export const logicalSecret = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
export const resourceName = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/);
const trustedUrl = z.url().max(1000).refine(value => {
  const url = new URL(value);
  return !url.username && !url.password && !url.hash && !url.search && !value.includes('*') && (url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname));
}, 'Use an exact HTTPS URL or a loopback development URL, without credentials or wildcards.');
export const authPublicSchema = z.object({
  external_google_enabled: z.boolean().optional(), external_google_client_id: z.string().regex(/^[A-Za-z0-9._-]{8,500}$/).optional(), external_google_skip_nonce_check: z.literal(false).optional(),
  site_url: trustedUrl.optional(), uri_allow_list: z.string().max(8000).refine(value => value === '' || value.split(',').every(url => trustedUrl.safeParse(url).success)).optional(),
  external_email_enabled: z.boolean().optional(), disable_signup: z.boolean().optional(), mailer_autoconfirm: z.boolean().optional(),
  smtp_host: z.string().regex(/^[a-zA-Z0-9.-]{1,253}$/).optional(), smtp_port: z.string().regex(/^(465|587|2525)$/).optional(),
  smtp_admin_email: z.email().max(254).optional(), smtp_sender_name: z.string().min(1).max(100).optional(),
  mailer_subjects_confirmation: z.string().max(200).optional(), mailer_subjects_magic_link: z.string().max(200).optional(),
  mailer_templates_confirmation_content: z.string().max(32_000).optional(), mailer_templates_magic_link_content: z.string().max(32_000).optional(),
}).strict();
export type AuthPublic = z.infer<typeof authPublicSchema>;
export const authSecretField = z.enum(['smtp_user', 'smtp_pass', 'external_google_secret']);
export const authSecretValuesSchema = z.object({ smtp_user: z.string().max(16_384).optional(), smtp_pass: z.string().max(16_384).optional(), external_google_secret: z.string().max(16_384).optional() }).strict();
export const secretRequirement = z.object({ name: logicalSecret, purpose: z.enum(['smtp', 'app_login', 'storage_server', 'function', 'app_user_session']), label: z.string().min(1).max(100) }).strict();
export const secretVersion = secretRequirement.extend({ revision: uuid.nullable(), available: z.boolean(), persistence: z.enum(['session', 'saved', 'missing']) }).strict();
export type SecretVersion = z.infer<typeof secretVersion>;
export const secretInput = z.object({ environment: environmentName, name: logicalSecret, value: z.string().min(1).max(16_384).refine(v => !v.includes('\0')), remember: z.boolean().default(false), expectedRevision: uuid.nullable() }).strict();
export const privateBucket = z.object({ id: resourceName, public: z.literal(false), file_size_limit: z.number().int().min(1).max(52_428_800), allowed_mime_types: z.array(z.string().regex(/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/)).min(1).max(20) }).strict();
export const functionEnvironmentName = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/).refine(v => !/^(SUPABASE_|SB_|DENO_)/.test(v), 'Choose a custom name outside provider-reserved prefixes.');
export const functionEnvironmentBinding = z.object({ name: functionEnvironmentName, secret: logicalSecret }).strict();
export const functionEnvironmentDeclare = z.object({ environment: environmentName, name: functionEnvironmentName, expectedSourceRevision: digest.nullable() }).strict();
export const functionSpec = z.object({ slug: resourceName, entrypoint: z.string().regex(/^supabase\/functions\/[a-z][a-z0-9-]*\/[a-zA-Z0-9_/-]+\.ts$/).max(200), verify_jwt: z.literal(true).default(true), secrets: z.array(functionEnvironmentBinding).max(20).default([]) }).strict();
export const desiredConfiguration = z.object({
  version: z.literal(1),
  auth: z.object({ settings: authPublicSchema.omit({ mailer_templates_confirmation_content: true, mailer_templates_magic_link_content: true }).default({}),
    templates: z.array(z.object({ field: z.enum(['mailer_templates_confirmation_content', 'mailer_templates_magic_link_content']), path: z.string().regex(/^backend\/templates\/[a-z0-9_-]+\.html$/).max(200) }).strict()).max(2).default([]),
    secrets: z.array(z.object({ field: authSecretField, secret: logicalSecret }).strict()).max(3).default([]),
  }).strict().optional(),
  storage: z.object({ serverCredential: logicalSecret, buckets: z.array(privateBucket).max(10) }).strict().optional(),
  functions: z.array(functionSpec).max(10).default([]), functionEnvironment: z.array(functionEnvironmentBinding).max(20).default([]), requirements: z.array(secretRequirement).max(40).default([]),
}).strict().superRefine((value, ctx) => {
  const names = value.requirements.map(item => item.name);
  const unique = (items: string[], label: string) => { if (new Set(items).size !== items.length) ctx.addIssue({ code: 'custom', message: `Duplicate ${label}.` }); };
  unique(names, 'secret requirement'); unique(value.functions.map(f => f.slug), 'function'); unique(value.storage?.buckets.map(b => b.id) ?? [], 'bucket'); unique(value.auth?.templates.map(t => t.field) ?? [], 'template'); unique(value.auth?.secrets.map(s => s.field) ?? [], 'Auth secret');
  if (value.auth?.settings.external_google_enabled && (!value.auth.settings.external_google_client_id || !value.auth.secrets.some(s => s.field === 'external_google_secret') || !value.auth.settings.uri_allow_list?.split(',').some(url => new URL(url).pathname === '/oauth-callback'))) ctx.addIssue({ code: 'custom', message: 'Google login requires a client ID, private provider input, and an exact web /oauth-callback redirect.' });
  const requirePurpose = (name: string, purpose: string) => { if (!value.requirements.some(r => r.name === name && r.purpose === purpose)) ctx.addIssue({ code: 'custom', message: `Declare a ${purpose} requirement for ${name}.` }); };
  for (const item of value.auth?.secrets ?? []) requirePurpose(item.secret, item.field === 'external_google_secret' ? 'app_login' : 'smtp');
  if (value.storage) requirePurpose(value.storage.serverCredential, 'storage_server');
  const functionSecrets = new Map<string, string>();
  unique(value.functionEnvironment.map(s => s.name), 'function environment name');
  for (const s of value.functionEnvironment) { requirePurpose(s.secret, 'function'); functionSecrets.set(s.name, s.secret); }
  for (const fn of value.functions) {
    if (!fn.entrypoint.startsWith(`supabase/functions/${fn.slug}/`)) ctx.addIssue({ code: 'custom', message: 'Function source must belong to its named root.' });
    unique(fn.secrets.map(s => s.name), 'function secret');
    for (const s of fn.secrets) { requirePurpose(s.secret, 'function'); if (functionSecrets.has(s.name) && functionSecrets.get(s.name) !== s.secret) ctx.addIssue({ code: 'custom', message: 'Project function secrets must use one consistent reference.' }); functionSecrets.set(s.name, s.secret); }
  }
  if (functionSecrets.size > 20) ctx.addIssue({ code: 'custom', message: 'At most 20 distinct function environment variables per review.' });
});
export type DesiredConfiguration = z.infer<typeof desiredConfiguration>;
export const sourceSnapshot = z.object({ path: z.string().max(240), revision: digest, content: z.string().max(256_000) }).strict();
const stepBase = { id: z.string().regex(/^[a-zA-Z0-9_.-]{1,120}$/), dependsOn: z.array(z.string()).max(40), observedHash: digest, recovery: z.enum(['readback', 'receipt_required']) };
export const configurationStep = z.discriminatedUnion('kind', [
  z.object({ ...stepBase, kind: z.literal('auth'), before: z.record(z.string(), z.union([z.string(), z.boolean(), z.null()])), after: authPublicSchema, secrets: z.array(z.object({ field: authSecretField, secret: logicalSecret }).strict()).max(3) }).strict(),
  z.object({ ...stepBase, kind: z.literal('bucket'), before: privateBucket.nullable(), after: privateBucket, credential: logicalSecret }).strict(),
  z.object({ ...stepBase, kind: z.literal('function_secrets'), bindings: z.array(z.object({ name: z.string(), secret: logicalSecret }).strict()).max(20) }).strict(),
  z.object({ ...stepBase, kind: z.literal('function'), slug: resourceName, artifactId: digest, before: z.record(z.string(), z.unknown()).nullable(), verify_jwt: z.literal(true) }).strict(),
  z.object({ ...stepBase, kind: z.literal('verification'), scenario: z.enum(['records', 'storage', 'function', 'email', 'cleanup']), fixtureId: uuid, ownerId: uuid.optional(), otherId: uuid.optional(), bucket: resourceName.optional(), functionSlug: resourceName.optional(), recipient: z.email().max(254).optional() }).strict(),
]);
export type ConfigurationStep = z.infer<typeof configurationStep>;
export const configurationPlan = z.object({
  version: z.literal(2), action: z.literal('configure'), workspaceId: uuid, projectId: uuid, environment: environmentName, connectionRevision: uuid, expectedBindingHash: digest,
  target: z.object({ organization: organizationSlug, projectRef: providerRef }).strict(), expiresAt: z.iso.datetime(),
  sources: z.array(sourceSnapshot).min(1).max(100), secrets: z.array(secretVersion).max(40), steps: z.array(configurationStep).max(40),
  requiredCapabilities: z.array(z.string().max(80)).max(20), prerequisites: z.array(z.string().max(200)).max(50), consequences: z.array(z.string().max(500)).max(10),
}).strict();
export type ConfigurationPlan = z.infer<typeof configurationPlan>;
export const configurationInput = z.object({ action: z.enum(['configure', 'function_environment']), environment: environmentName.default('development'), path: z.literal('backend/configuration.json').default('backend/configuration.json') }).strict();
export const validationInput = z.object({ environment: environmentName.default('development'), planHash: digest.optional() }).strict();
export const setupInput = z.object({ environment: environmentName.default('development'), scenario: z.enum(['email', 'complete']).default('complete'), requestId: uuid }).strict();
export const verificationInput = z.object({ action: z.literal('verify'), environment: z.literal('development').default('development'), scenario: z.enum(['records', 'storage', 'function', 'email', 'cleanup']), bucket: resourceName.optional(), functionSlug: resourceName.optional(), recipient: z.email().max(254).optional(), fixtureId: uuid.optional() }).strict().superRefine((value, ctx) => {
  if (value.scenario === 'email' && !value.recipient || value.scenario === 'storage' && !value.bucket || value.scenario === 'function' && !value.functionSlug || value.scenario === 'cleanup' && !value.fixtureId) ctx.addIssue({ code: 'custom', message: 'This verification scenario is missing its exact target.' });
});

// No social provider is advertised as qualified until its callback and native lifecycle are verified.
export const socialProviders = [{ id: 'google', state: 'web_implemented_live_qualification_required', prerequisite: 'Registered Google web client and callback, exact app redirect, secure provider input; installable native OAuth remains separate.' }, { id: 'github', state: 'qualification_required', prerequisite: 'Registered callback and provider-field contract qualification.' }] as const;
