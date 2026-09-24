import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { BuilderError } from '../../core/src/contracts.js';
import { PrivateSettingsStore } from '../../core/src/credentials.js';
import { assistantModeSchema, assistantText, attachmentsSchema, type AssistantAttachments } from './contracts.js';
import { workspaceDraftSchema } from '../../core/src/workspace-draft-contracts.js';

export const draftScopeSchema = z.object({ projectId: z.uuid().nullable(), conversationId: z.uuid().nullable() }).strict();
export const draftValueSchema = z.object({ text: assistantText(16384), mode: assistantModeSchema, attachments: attachmentsSchema }).strict();
export type DraftScope = z.infer<typeof draftScopeSchema>;
export type DraftValue = z.infer<typeof draftValueSchema>;
const rowSchema = draftScopeSchema.extend({ owner: z.string().max(100), revision: z.uuid(), epoch: z.uuid(), value: draftValueSchema }).strict();
const preferenceSchema = z.object({ owner: z.string().max(100), enabled: z.boolean(), revision: z.uuid() }).strict();
const workspaceRowSchema = z.object({ owner: z.string().max(100), projectId: z.uuid(), revision: z.uuid(), value: workspaceDraftSchema }).strict();
const storeSchema = z.object({ version: z.literal(1), preferences: z.array(preferenceSchema).max(100), rows: z.array(rowSchema).max(100), workspaces: z.array(workspaceRowSchema).max(100).default([]) }).strict();
const conflict = () => new BuilderError('REVISION_CONFLICT', 'Draft storage or account changed. Your current text was kept. Reload the draft before saving again.');
export type DraftContext = { owner: string; revision: string };

/** Local unsent content only. No run IDs, approvals, image bytes, or automatic submission. */
export class AssistantDrafts {
  private store: PrivateSettingsStore<z.infer<typeof storeSchema>>;
  constructor(home: string, private epoch: string, private context: () => DraftContext) {
    this.store = new PrivateSettingsStore(home, 'assistant-drafts', storeSchema, 4 * 1024 * 1024);
  }
  private load() { return this.store.load() ?? { version: 1 as const, preferences: [], rows: [], workspaces: [] }; }
  private matches(row: DraftScope & { owner: string }, scope: DraftScope, owner: string) { return row.owner === owner && row.projectId === scope.projectId && row.conversationId === scope.conversationId; }
  read(scope: DraftScope) {
    const context = this.context(), data = this.load(), preference = data.preferences.find(item => item.owner === context.owner);
    const row = data.rows.find(row => this.matches(row, scope, context.owner));
    return { context: context.revision, enabled: preference?.enabled ?? false, preferenceRevision: preference?.revision ?? null, revision: row?.revision ?? null, value: preference?.enabled ? row?.value ?? null : null, previousRuntime: !!row && row.epoch !== this.epoch };
  }
  save(scope: DraftScope, input: unknown) {
    const value = z.object({ context: z.string(), preferenceRevision: z.uuid().nullable(), expectedRevision: z.uuid().nullable(), value: draftValueSchema }).strict().parse(input);
    const snapshot = this.read(scope);
    if (snapshot.context !== value.context || snapshot.preferenceRevision !== value.preferenceRevision || snapshot.revision !== value.expectedRevision || !snapshot.enabled) throw conflict();
    const attachments = value.value.attachments;
    if ((attachments.inspector && attachments.inspector.projectId !== scope.projectId) || attachments.images?.some(image => image.projectId !== scope.projectId)) throw new BuilderError('INVALID_INPUT', 'Draft attachments must belong to this project.');
    const owner = this.context().owner, data = this.load();
    data.rows = data.rows.filter(row => !this.matches(row, scope, owner));
    data.rows.push({ ...scope, owner, revision: randomUUID(), epoch: this.epoch, value: value.value });
    this.store.save(data); return this.read(scope);
  }
  configure(scope: DraftScope, input: unknown) {
    const value = z.object({ context: z.string(), preferenceRevision: z.uuid().nullable(), enabled: z.boolean() }).strict().parse(input), snapshot = this.read(scope);
    if (snapshot.context !== value.context || snapshot.preferenceRevision !== value.preferenceRevision) throw conflict();
    const owner = this.context().owner, data = this.load();
    data.preferences = data.preferences.filter(item => item.owner !== owner);
    data.preferences.push({ owner, enabled: value.enabled, revision: randomUUID() });
    if (!value.enabled) { data.rows = data.rows.filter(row => row.owner !== owner); data.workspaces = data.workspaces.filter(row => row.owner !== owner); }
    this.store.save(data); return this.read(scope);
  }
  readWorkspace(projectId: string) {
    z.uuid().parse(projectId);
    const preference = this.read({ projectId, conversationId: null }), owner = this.context().owner;
    const row = this.load().workspaces.find(item => item.owner === owner && item.projectId === projectId);
    return { context: preference.context, enabled: preference.enabled, preferenceRevision: preference.preferenceRevision, revision: row?.revision ?? null, value: preference.enabled ? row?.value ?? null : null };
  }
  saveWorkspace(projectId: string, input: unknown) {
    const value = z.object({ context: z.string(), preferenceRevision: z.uuid().nullable(), expectedRevision: z.uuid().nullable(), value: workspaceDraftSchema }).strict().parse(input);
    const snapshot = this.readWorkspace(projectId);
    if (!snapshot.enabled || snapshot.context !== value.context || snapshot.preferenceRevision !== value.preferenceRevision || snapshot.revision !== value.expectedRevision) throw conflict();
    const owner = this.context().owner, data = this.load();
    data.workspaces = data.workspaces.filter(row => row.owner !== owner || row.projectId !== projectId);
    data.workspaces.push({ owner, projectId, revision: randomUUID(), value: value.value });
    this.store.save(data); return this.readWorkspace(projectId);
  }
  removeConversation(conversationId: string) {
    const data = this.load();
    data.rows = data.rows.filter(row => row.conversationId !== conversationId); this.store.save(data);
  }
}
export type DraftSnapshot = ReturnType<AssistantDrafts['read']> & { notice?: string };
export async function revalidateDraft(snapshot: DraftSnapshot, validImage: (reference: NonNullable<AssistantAttachments['images']>[number]) => Promise<boolean>) {
  if (!snapshot.value) return snapshot;
  const original = snapshot.value.attachments, attachments: AssistantAttachments = { ...original };
  if (snapshot.previousRuntime || original.inspector && Date.now() - Date.parse(original.inspector.selection.timestamp) > 600_000) delete attachments.inspector;
  const images = [];
  for (const reference of original.images ?? []) if (await validImage(reference)) images.push(reference);
  if (original.images) attachments.images = images;
  return { ...snapshot, value: { ...snapshot.value, attachments }, notice: JSON.stringify(attachments) !== JSON.stringify(original) ? 'Draft restored. Expired or unavailable attachments were removed; attach current context before sending.' : 'Draft restored. Review it before sending.' };
}
