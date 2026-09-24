import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { AssistantDrafts, revalidateDraft } from './drafts.js';
let home: string;
const scope = { projectId: randomUUID(), conversationId: randomUUID() }, value = { text: 'Unsent idea', mode: 'plan' as const, attachments: {} };
beforeEach(async () => { home = await mkdtemp(path.join(os.tmpdir(), 'assistant-drafts-')); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });
function setup() {
  let context = { owner: 'local', revision: randomUUID() };
  const drafts = new AssistantDrafts(home, randomUUID(), () => context);
  const enable = () => drafts.configure(scope, { context: context.revision, preferenceRevision: drafts.read(scope).preferenceRevision, enabled: true });
  const save = (next = value) => { const s = drafts.read(scope); return drafts.save(scope, { context: s.context, preferenceRevision: s.preferenceRevision, expectedRevision: s.revision, value: next }); };
  return { drafts, enable, save, change: () => { context = { owner: randomUUID(), revision: randomUUID() }; } };
}
it('persists only opted-in drafts, restores their mode and scope, and creates private files', async () => {
  const { drafts, enable, save } = setup();
  expect(drafts.read(scope)).toMatchObject({ enabled: false, value: null }); expect(() => save()).toThrow();
  enable(); save();
  const restored = new AssistantDrafts(home, randomUUID(), () => ({ owner: 'local', revision: randomUUID() })).read(scope);
  expect(restored).toMatchObject({ enabled: true, value, previousRuntime: true });
  expect(drafts.read({ ...scope, projectId: randomUUID() }).value).toBeNull();
  expect((await stat(path.join(home, 'credentials/assistant-drafts.json'))).mode & 0o777).toBe(0o600);
  expect(await readFile(path.join(home, 'credentials/assistant-drafts.json'), 'utf8')).not.toContain('runId');
});
it('rejects stale writes, another account, cross-project attachments and unrecognized approvals', () => {
  const { drafts, enable, save, change } = setup(); enable(); const before = drafts.read(scope); save();
  const update = { context: before.context, preferenceRevision: before.preferenceRevision, expectedRevision: before.revision, value };
  expect(() => drafts.save(scope, update)).toThrow('changed');
  const current = drafts.read(scope);
  expect(() => drafts.save(scope, { ...update, expectedRevision: current.revision, value: { ...value, attachments: { images: [{ projectId: randomUUID(), kind: 'media', id: randomUUID() }] } } })).toThrow('project');
  expect(() => drafts.save(scope, { ...update, expectedRevision: current.revision, value: { ...value, approval: true } })).toThrow();
  change(); expect(drafts.read(scope).value).toBeNull(); expect(() => drafts.save(scope, { ...update, expectedRevision: current.revision })).toThrow();
});
it('forgetting drafts fences queued writes and deleting conversations removes their drafts', () => {
  const { drafts, enable, save } = setup(); enable(); const saved = save();
  drafts.configure(scope, { context: saved.context, preferenceRevision: saved.preferenceRevision, enabled: false });
  enable(); expect(() => drafts.save(scope, { context: saved.context, preferenceRevision: saved.preferenceRevision, expectedRevision: saved.revision, value })).toThrow();
  save(); drafts.removeConversation(scope.conversationId); expect(drafts.read(scope).value).toBeNull();
});
it('revalidates stored image references and drops transient inspector context after restart', async () => {
  const { drafts, enable } = setup(); enable(); const initial = drafts.read(scope), media = { projectId: scope.projectId, kind: 'media' as const, id: randomUUID() }, capture = { projectId: scope.projectId, kind: 'capture' as const, id: randomUUID() };
  const saved = drafts.save(scope, { context: initial.context, preferenceRevision: initial.preferenceRevision, expectedRevision: null, value: { ...value, attachments: { images: [media, capture] } } });
  const inspector = { projectId: scope.projectId, viewId: randomUUID(), view: { route: '/', viewport: 'compact' as const, refresh: 0 }, selection: { pathname: '/', timestamp: new Date().toISOString(), viewport: { width: 375, height: 812 }, element: { tag: 'div' }, visibleText: 'Preview fixture', ancestors: [], locator: { selector: 'div', unique: true, kind: 'DOM hint, not source identity' as const }, bounds: { x: 0, y: 0, width: 10, height: 10 }, styles: {}, source: { status: 'unavailable' as const }, truncated: false } };
  const restored = await revalidateDraft({ ...saved, previousRuntime: true, value: { ...value, attachments: { images: [media, capture], inspector } } }, async reference => reference.kind === 'media');
  expect(restored.value?.attachments.images).toEqual([media]); expect(restored.value?.attachments.inspector).toBeUndefined(); expect(restored.notice).toContain('removed');
});
it('restores creative drafts across runtimes and fences project, account, preference and revision changes', () => {
  const { drafts, enable, change } = setup(); enable();
  const before = drafts.readWorkspace(scope.projectId);
  const content = { design: { tokens: { accent: '#123456' }, revision: 'base' }, kit: { captureIds: [], iconId: '', name: 'My app', summary: 'Draft summary', description: '', supportUrl: '', privacyUrl: '', attribution: '' } };
  const update = { context: before.context, preferenceRevision: before.preferenceRevision, expectedRevision: before.revision, value: content };
  const saved = drafts.saveWorkspace(scope.projectId, update);
  expect(new AssistantDrafts(home, randomUUID(), () => ({ owner: 'local', revision: 'new-runtime' })).readWorkspace(scope.projectId).value).toEqual(content);
  expect(drafts.readWorkspace(randomUUID()).value).toBeNull();
  expect(() => drafts.saveWorkspace(scope.projectId, update)).toThrow('changed');
  expect(() => drafts.saveWorkspace(scope.projectId, { ...update, expectedRevision: saved.revision, value: { ...content, apiKey: 'must not be stored' } })).toThrow();
  drafts.configure(scope, { context: saved.context, preferenceRevision: saved.preferenceRevision, enabled: false });
  enable(); expect(drafts.readWorkspace(scope.projectId).value).toBeNull();
  expect(() => drafts.saveWorkspace(scope.projectId, { ...update, expectedRevision: saved.revision })).toThrow('changed');
  change(); expect(drafts.readWorkspace(scope.projectId).value).toBeNull();
});
