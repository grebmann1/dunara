import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AssistantMode, RunBinding } from './contracts.js';

export const TOOL_POLICY: Readonly<Record<string, 'catalog' | 'read' | 'write' | 'review' | 'project' | 'studio' | 'cancel'>> = Object.freeze({
  plugin_list: 'catalog', plugin_guide: 'catalog', plugin_action: 'write',
  native_build_inspect: 'read', native_build_plan: 'read', native_build_apply: 'review',
  native_workspace_plan: 'read', native_workspace_list: 'read', native_workspace_prepare: 'review', native_workspace_cancel: 'review', native_workspace_remove: 'review',
  recipe_upgrade_preview: 'read', recipe_upgrade_apply: 'review',
  backend_catalog: 'read', backend_capabilities: 'read', backend_select_environment: 'write',
  backend_environment_inspect: 'read', backend_environment_declare: 'write', preview_set_transport: 'review',
  backend_validate: 'read', backend_requirements: 'read', backend_setup: 'write',
  backend_recipe_preview: 'read', backend_recipe_apply: 'review',
  backend_inspect: 'read', backend_plan: 'read', backend_apply: 'write', backend_operation: 'read', backend_cancel: 'write', backend_reconcile: 'write', backend_generate_types: 'write', backend_export_config: 'write',
  project_list: 'catalog', project_open: 'project', project_create: 'project', studio_inspect: 'catalog', studio_control: 'studio',
  project_inspect: 'read', project_write_files: 'write', design_apply: 'write', preview_start: 'write', preview_stop: 'write', preview_capture: 'write', project_diagnostics: 'read',
  activity_list: 'read', board_capture: 'write', inspector_setup_preview: 'read', inspector_setup_apply: 'review',
  media_list: 'read', media_read: 'read', media_import: 'write', media_brief: 'write', media_approve: 'review', media_transform: 'write', media_request: 'write', media_job: 'read', media_cancel: 'cancel',
  icon_check: 'read', icon_prepare: 'write', icon_preview: 'read', icon_apply: 'review',
  launch_kit_create: 'review', launch_kit_list: 'read', launch_kit_read: 'read', launch_kit_remove: 'review',
});
export function pluginToolPolicy(name: string, meta?: Record<string, unknown>) {
  if (!/^mb_[a-f0-9]{16}_[a-z0-9_]+$/.test(name)) return undefined;
  const value = z.object({ id: z.string(), action: z.string(), effect: z.enum(['read', 'write']), scope: z.enum(['project', 'global']), digest: z.string().regex(/^[a-f0-9]{64}$/) }).safeParse(meta?.builderPlugin);
  if (!value.success) return undefined;
  return { ...value.data, policy: value.data.effect === 'write' ? 'write' as const : value.data.scope === 'global' ? 'catalog' as const : 'read' as const };
}
export function toolAllowedInMode(name: string, mode: AssistantMode = 'build', meta?: Record<string, unknown>) {
  if (mode === 'build') return true;
  if (['builder_mcp_discover', 'builder_mcp_read_resource', 'builder_mcp_get_prompt'].includes(name)) return true;
  // This capability also declares private-input requirements, so reserve it for Build.
  const policy = TOOL_POLICY[name] ?? pluginToolPolicy(name, meta)?.policy;
  return name !== 'backend_requirements' && !!policy && ['read', 'catalog'].includes(policy);
}
export type Approval = RunBinding & { id: string; tool: string; args: Record<string, unknown>; review: unknown; expiresAt: string; consequence: string };
export const approvalResponseSchema = z.object({ id: z.uuid(), epoch: z.uuid(), runId: z.uuid(), conversationId: z.uuid(), projectId: z.uuid().nullable(), approve: z.boolean() }).strict();
export function fingerprint(value: unknown): string {
  const normalized = JSON.stringify(value, (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
  return createHash('sha256').update(normalized).digest('hex');
}
/** Only the authenticated human API may answer these requests. No authorization is returned to the model. */
export class ApprovalBroker {
  private pending = new Map<string, { value: Approval; finish(error?: Error): void }>();
  constructor(private changed: () => void = () => {}, private ttlMs = 120_000) {}
  list() { return structuredClone([...this.pending.values()].map(item => item.value)); }
  async request(binding: RunBinding, tool: string, args: Record<string, unknown>, review: unknown, consequence: string, signal: AbortSignal) {
    signal.throwIfAborted();
    if (this.pending.size) throw new Error('An approval is already waiting');
    const value: Approval = structuredClone({ ...binding, id: randomUUID(), tool, args, review, consequence, expiresAt: new Date(Date.now() + this.ttlMs).toISOString() });
    if (Buffer.byteLength(JSON.stringify(value)) > 128 * 1024) throw new Error('Review is too large. Use the dedicated Studio review workspace.');
    await new Promise<void>((resolve, reject) => {
      const abort = () => finish(new Error('Approval cancelled'));
      const finish = (error?: Error) => {
        if (!this.pending.delete(value.id)) return;
        clearTimeout(timer); signal.removeEventListener('abort', abort); this.changed();
        if (error) reject(error); else resolve();
      };
      this.pending.set(value.id, { value, finish });
      const timer = setTimeout(() => finish(new Error('Approval expired. A new review is required.')), this.ttlMs);
      signal.addEventListener('abort', abort, { once: true }); this.changed();
      if (signal.aborted) abort();
    });
    signal.throwIfAborted();
  }
  respond(input: unknown) {
    const answer = approvalResponseSchema.parse(input), entry = this.pending.get(answer.id);
    if (!entry || ['epoch', 'runId', 'conversationId', 'projectId'].some(key => Reflect.get(answer, key) !== Reflect.get(entry.value, key))) throw new Error('Approval is stale or belongs to another turn');
    if (Date.parse(entry.value.expiresAt) <= Date.now()) { entry.finish(new Error('Approval expired')); throw new Error('Approval expired'); }
    entry.finish(answer.approve ? undefined : new Error('The user declined this action. Do not retry without a new instruction.'));
  }
  close() { for (const entry of [...this.pending.values()]) entry.finish(new Error('Approval cancelled')); }
}
