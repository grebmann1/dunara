import { z } from 'zod';
import { revisionSchema } from './contracts.js';
import { roleSchema } from './media-contracts.js';
export const IMAGE_MODEL = 'gpt-image-2.5-sunburst-2026-09-08';
export const ASTRA_MODEL = 'gpt-6-astra';
export const mediaModelSchema = z.enum([IMAGE_MODEL, ASTRA_MODEL]);
export const jobRequestSchema = z.object({
  model: mediaModelSchema.default(IMAGE_MODEL),
  requestId: z.uuid(), expectedRevision: revisionSchema.nullable(), prompt: z.string().trim().min(1).max(8000),
  referenceIds: z.array(z.uuid()).max(4).default([]), operation: z.enum(['generate', 'edit']),
  count: z.number().int().min(1).max(2).default(1), quality: z.enum(['low', 'medium', 'high']).default('low'),
  size: z.enum(['1024x1024', '1536x1024', '1024x1536']).default('1024x1024'),
  label: z.string().trim().min(1).max(100), role: roleSchema.default('illustration'), rightsNote: z.string().max(2000).default(''),
}).strict().refine(v => v.operation !== 'edit' || v.referenceIds.length > 0, 'Editing requires an approved reference')
  .refine(v => v.model !== ASTRA_MODEL || v.count === 1, 'Astra supports one candidate per approved request');
export const jobSchema = z.object({
  id: z.uuid(), projectId: z.uuid(), projectRoot: z.string(), rootIdentity: z.string(), model: mediaModelSchema,
  request: jobRequestSchema, state: z.enum(['awaiting-approval', 'queued', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted']),
  createdAt: z.iso.datetime(), approvedAt: z.iso.datetime().optional(), resultIds: z.array(z.uuid()).max(2), error: z.string().max(300).optional(),
}).strict().refine(v => v.model === v.request.model, 'Job model must match the approved request');
export const mediaModelLabel = (model: z.infer<typeof mediaModelSchema>) => model === ASTRA_MODEL ? `${ASTRA_MODEL} → ${IMAGE_MODEL}` : model;
export type MediaJob = z.infer<typeof jobSchema>;
export type JobRequest = z.infer<typeof jobRequestSchema>;
export const jobGuidance = (job: MediaJob) => job.state === 'awaiting-approval' ? 'Ask the user to review this request in Studio. No provider call has occurred.' : ['queued', 'running'].includes(job.state) ? 'Wait and poll this job; do not submit another request.' : job.state === 'succeeded' ? 'Inspect the candidate images and ask the user to approve one before integration.' : 'Do not automatically retry. Review the error with the user; provider-side work or charges may have occurred.';
