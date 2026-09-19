import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { Engine } from '../../core/src/engine.js';
import { Projects } from '../../core/src/projects.js';
import { AssistantService } from '../../assistant/src/service.js';
import { startStudio } from './studio-server.js';

let root: string, engine: Engine, assistant: AssistantService, studio: Awaited<ReturnType<typeof startStudio>>, headers: Record<string, string>, projectId: string, conversationId: string, runId: string;
const post = (action: string, value: unknown, authorization = true) => fetch(`${studio.origin}/api/assistant/changes/${action}`, { method: 'POST', headers: authorization ? headers : { Origin: studio.origin, 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'source-recovery-http-'));
  engine = new Engine(await Projects.open(path.join(root, 'apps'), path.join(root, 'home')), false);
  projectId = (await engine.projects.create({ name: 'Recovery', slug: 'recovery' })).id;
  await engine.files.write(projectId, [{ path: 'src/change.ts', content: 'before', expectedRevision: null }]);
  assistant = new AssistantService({ home: path.join(root, 'home'), createHarness: () => ({ async run(_, callbacks, signal) { await callbacks.tool('project_write_files', {}, signal); }, async close() {} }), createGateway: async (binding, _, context) => ({ tools: [{ name: 'project_write_files', inputSchema: { type: 'object' } }], async call() {
    await engine.sourceChanges.withToken(context.sourceToken, async () => {
      const file = await engine.files.read(binding.projectId!, 'src/change.ts');
      await engine.files.write(binding.projectId!, [{ path: file.path, content: 'after', expectedRevision: file.revision }]);
    });
    return { content: [] };
  }, async close() {} }) });
  studio = await startStudio(engine, path.resolve('dist/studio'), assistant);
  await engine.mediaJobs.configureProvider({ action: 'replace', key: 'fake-recovery-boundary-key', expectedRevision: engine.mediaJobs.providerStatus().revision });
  conversationId = (await assistant.createConversation(projectId)).id; runId = randomUUID();
  await assistant.start({ conversationId, runId, prompt: 'Change source' }); await vi.waitFor(() => expect(assistant.status().busy).toBe(false));
  expect((await assistant.conversation(conversationId)).turns[0]?.state).toBe('completed');
  expect((await engine.files.read(projectId, 'src/change.ts')).content).toBe('after');
  const auth = await fetch(`${studio.origin}/api/bootstrap`, { method: 'POST', headers: { Origin: studio.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket: new URL(studio.launchUrl).hash.slice(1) }) });
  headers = { Origin: studio.origin, 'Content-Type': 'application/json', Authorization: `Bearer ${(await auth.json()).token}` };
});
afterEach(async () => { await assistant.close(); await studio.close(); await engine.close(); await rm(root, { recursive: true, force: true }); });
async function input() {
  const review = await (await post('review', { conversationId, runId })).json();
  return { conversationId, runId, expectedRevision: review.revision, epoch: assistant.epoch, accountContext: assistant.status().accountContext, confirmed: true };
}
it('requires local authentication, exact conversation, current session/account and explicit confirmation', async () => {
  const value = await input();
  expect((await post('review', { conversationId, runId }, false)).status).toBe(401);
  expect((await post('file', { conversationId, runId, path: 'app/index.tsx' })).status).toBe(400);
  for (const override of [{ confirmed: false }, { epoch: randomUUID() }, { accountContext: 'old-account' }, { runId: randomUUID() }, { conversationId: (await assistant.createConversation(projectId)).id }, { expectedRevision: '0'.repeat(64) }]) {
    expect((await post('restore', { ...value, ...override })).status).toBe(400);
    expect((await engine.files.read(projectId, 'src/change.ts')).content).toBe('after');
  }
  expect((await post('restore', value)).status).toBe(200);
  expect((await engine.files.read(projectId, 'src/change.ts')).content).toBe('before');
});
it('requires the conversation app to be selected and leaves both apps untouched on rejection', async () => {
  const value = await input(), other = await engine.projects.create({ name: 'Other app', slug: 'other' });
  await engine.studio.control({ expectedRevision: (await engine.studio.snapshot()).revision, action: { type: 'select-project', projectId: other.id } });
  expect((await post('restore', value)).status).toBe(400);
  expect((await engine.files.read(projectId, 'src/change.ts')).content).toBe('after');
  await engine.studio.control({ expectedRevision: (await engine.studio.snapshot()).revision, action: { type: 'select-project', projectId } });
  expect((await post('restore', value)).status).toBe(200);
});
it('rechecks account changes during restore and does not overwrite source', async () => {
  const value = await input();
  assistant.useSourceChanges(engine.sourceChanges, async () => { await assistant.interruptAccountWork(); });
  expect((await post('restore', value)).status).toBe(400);
  expect((await engine.files.read(projectId, 'src/change.ts')).content).toBe('after');
  expect(assistant.status().busy).toBe(false);
});
