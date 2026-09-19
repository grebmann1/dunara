import { z } from 'zod';
import { selectionSchema } from '../../core/src/preview-selection.js';
import { routeSchema, viewportSchema } from '../../core/src/contracts.js';

export const inspectorAttachmentSchema = z.object({ projectId: z.uuid(), viewId: z.uuid(), view: z.object({ route: routeSchema, viewport: viewportSchema, refresh: z.number().int().nonnegative() }).strict(), selection: selectionSchema }).strict().refine(value => new TextEncoder().encode(JSON.stringify(value)).length <= 16 * 1024, 'Inspector attachment exceeds its byte limit');
export type InspectorAttachment = z.infer<typeof inspectorAttachmentSchema>;
export const imageReferenceSchema = z.object({ projectId: z.uuid(), kind: z.enum(['capture', 'board', 'media']), id: z.uuid() }).strict();
export type ImageReference = z.infer<typeof imageReferenceSchema>;
export const attachmentsSchema = z.object({ inspector: inspectorAttachmentSchema.optional(), images: z.array(imageReferenceSchema).max(2).refine(images => new Set(images.map(image => `${image.kind}:${image.id}`)).size === images.length).optional() }).strict();
export type AssistantAttachments = z.infer<typeof attachmentsSchema>;

export const ASSISTANT_LIMITS = Object.freeze({ startupMs: 20_000, turnMs: 600_000, shutdownMs: 5_000, tools: 40, promptBytes: 16 * 1024, inspectorBytes: 16 * 1024, images: 2, responseBytes: 256 * 1024, conversationBytes: 2 * 1024 * 1024, totalBytes: 100 * 1024 * 1024, conversationsPerProject: 20, events: 512, eventBytes: 2 * 1024 * 1024 });
export type AssistantLimits = { readonly [Key in keyof typeof ASSISTANT_LIMITS]: number };
export const assistantText = (bytes: number) => z.string().max(bytes).refine(value => Buffer.byteLength(value) <= bytes, 'Text exceeds its byte limit');
export const turnStateSchema = z.enum(['starting', 'running', 'completed', 'cancelled', 'interrupted', 'failed', 'limited']);
export type TurnState = z.infer<typeof turnStateSchema>;
export const assistantModeSchema = z.enum(['plan', 'build']);
export type AssistantMode = z.infer<typeof assistantModeSchema>;
export const assistantTasksSchema = z.array(z.object({
  id: z.string().min(1).max(40).regex(/^[a-zA-Z0-9_-]+$/),
  label: z.string().trim().min(1).max(160),
  status: z.enum(['pending', 'in_progress', 'completed']),
}).strict()).min(1).max(12)
  .refine(tasks => new Set(tasks.map(task => task.id)).size === tasks.length, 'Task IDs must be unique')
  .refine(tasks => tasks.filter(task => task.status === 'in_progress').length <= 1, 'Only one task may be in progress');
export const taskUpdateSchema = z.object({ tasks: assistantTasksSchema }).strict();
export type AssistantTask = z.infer<typeof assistantTasksSchema>[number];
export const storedTurnSchema = z.object({
  id: z.uuid(), epoch: z.uuid(), state: turnStateSchema, model: z.string().max(100).optional(), mode: assistantModeSchema.optional(),
  prompt: assistantText(ASSISTANT_LIMITS.promptBytes), response: assistantText(ASSISTANT_LIMITS.responseBytes),
  startedAt: z.iso.datetime(), endedAt: z.iso.datetime().optional(),
  tools: z.array(z.object({ name: z.string().max(160), state: z.enum(['completed', 'failed', 'cancelled']) }).strict()).max(ASSISTANT_LIMITS.tools),
  notice: z.string().max(512).optional(),
  inspector: z.object({ projectId: z.uuid(), viewId: z.uuid(), route: z.string().max(1000), timestamp: z.iso.datetime() }).strict().optional(),
  images: z.array(imageReferenceSchema.extend({ description: z.string().max(2048), status: z.enum(['requested', 'adapter-accepted', 'blocked']) }).strict()).max(2).optional(),
  imageContentAccepted: z.boolean().optional(),
  tasks: assistantTasksSchema.optional(),
}).strict();
export type StoredTurn = z.infer<typeof storedTurnSchema>;
export const conversationSchema = z.object({
  version: z.literal(1), id: z.uuid(), projectId: z.uuid().nullable(), title: z.string().max(100),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(), turns: z.array(storedTurnSchema).max(1000),
}).strict();
export type Conversation = z.infer<typeof conversationSchema>;
export const startTurnSchema = z.object({ conversationId: z.uuid(), runId: z.uuid(), mode: assistantModeSchema.default('build'), prompt: assistantText(ASSISTANT_LIMITS.promptBytes).refine(value => value.trim().length > 0, 'Enter a message'), attachments: attachmentsSchema.optional() }).strict();
export type RunBinding = { epoch: string; runId: string; conversationId: string; projectId: string | null };
export type AssistantEvent = RunBinding & { sequence: number; type: 'state' | 'text' | 'tool' | 'approval'; text?: string; state?: TurnState; tool?: string };
export type HarnessTool = { name: string; description?: string; _meta?: Record<string, unknown>; inputSchema: { type: 'object'; properties?: Record<string, unknown>; required?: string[]; [key: string]: unknown } };
export type HarnessResult = { content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>; details?: unknown; isError?: boolean };
export const harnessImageSchema = imageReferenceSchema.extend({ data: z.string().max(4 * 1024 * 1024).regex(/^[A-Za-z0-9+/]+={0,2}$/), mimeType: z.literal('image/png'), description: z.string().max(2048) }).strict();
export type HarnessInput = RunBinding & { prompt: string; context: string; apiKey: string; model?: string; mode?: AssistantMode; tools: HarnessTool[]; inspector?: InspectorAttachment; images?: z.infer<typeof harnessImageSchema>[] };
export type HarnessCallbacks = { text(value: string): void; imageAccepted?(): void; tool(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<HarnessResult> };
export interface RunHarness {
  run(input: HarnessInput, callbacks: HarnessCallbacks, signal: AbortSignal): Promise<void>;
  close(): Promise<void>;
}
