import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, expect, it, vi } from 'vitest';
import { attachmentsSchema, inspectorAttachmentSchema, type HarnessInput, type InspectorAttachment } from './contracts.js';
import { resolveImages, validateInspector } from './attachments.js';
import { AssistantService, type AssistantGateway } from './service.js';

const projectId = randomUUID(), viewId = randomUUID();
function inspector(): InspectorAttachment {
  return { projectId, viewId, view: { route: '/', viewport: 'compact', refresh: 0 }, selection: { pathname: '/', timestamp: new Date().toISOString(), viewport: { width: 375, height: 812 }, element: { tag: 'h1' }, visibleText: 'Untrusted app label', ancestors: [], locator: { selector: 'h1', unique: true, kind: 'DOM hint, not source identity' }, bounds: { x: 1, y: 1, width: 100, height: 40 }, styles: {}, source: { status: 'unavailable' }, truncated: false } };
}
function gateway(call: AssistantGateway['call']): AssistantGateway { return { tools: [], call, async close() {} }; }
function state(value = inspector()) { return { content: [], details: { structuredContent: { projectId, studio: { board: { activeId: viewId, views: [{ id: viewId, ...value.view }] } } } } }; }
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

it('bounds Inspector selections and image references without accepting private protocol fields', () => {
  expect(inspectorAttachmentSchema.safeParse(inspector()).success).toBe(true);
  for (const selection of [{ ...inspector().selection, pathname: '/?token=private' }, { ...inspector().selection, source: { status: 'app-declared, unverified', path: '/private/source.ts' } }, { ...inspector().selection, rawHtml: '<input value="private">' }]) expect(inspectorAttachmentSchema.safeParse({ ...inspector(), selection }).success).toBe(false);
  const image = { projectId, kind: 'media', id: randomUUID() };
  expect(attachmentsSchema.safeParse({ images: [image, image] }).success).toBe(false);
  expect(attachmentsSchema.safeParse({ images: [image, { ...image, id: randomUUID() }, { ...image, id: randomUUID() }] }).success).toBe(false);
  expect(attachmentsSchema.safeParse({ images: [{ ...image, data: 'not permitted' }] }).success).toBe(false);
});
it('rejects inactive, reloaded, rerouted, resized, future and expired Inspector selections before model work', async () => {
  const current = inspector(), bridge = gateway(async () => state(current)), signal = new AbortController().signal;
  await validateInspector(current, bridge, signal);
  for (const value of [
    { ...current, viewId: randomUUID() }, { ...current, projectId: randomUUID() },
    ...[{ refresh: 1 }, { route: '/other' }, { viewport: 'large' as const }].map(change => ({ ...current, view: { ...current.view, ...change } })),
    ...[-700_000, 60_000].map(age => ({ ...current, selection: { ...current.selection, timestamp: new Date(Date.now() + age).toISOString() } })),
  ]) await expect(validateInspector(value, bridge, signal)).rejects.toThrow('stale');
});
it('resolves canonical PNGs and records expired or metadata-only images as blocked without recapturing', async () => {
  const png = (await sharp({ create: { width: 16, height: 16, channels: 4, background: '#ffffff' } }).png().toBuffer()).toString('base64');
  const media = { projectId, kind: 'media' as const, id: randomUUID() }, capture = { projectId, kind: 'capture' as const, id: randomUUID() };
  const call = vi.fn<AssistantGateway['call']>(async name => name === 'media_read' ? { content: [{ type: 'image', data: png, mimeType: 'image/png' }], details: { structuredContent: { asset: { label: 'Fixture', width: 16, height: 16 }, root: '/private/project' } } } : name === 'project_inspect' ? { content: [], details: { structuredContent: { captures: [{ id: capture.id, route: '/habit', viewport: 'compact', createdAt: new Date().toISOString() }] } } } : { content: [{ type: 'image', data: png, mimeType: 'image/png' }] });
  const result = await resolveImages([media, capture], gateway(call), new AbortController().signal);
  expect(result.images).toHaveLength(2); expect(result.images.every(image => image.data === png)).toBe(true);
  expect(JSON.stringify(result)).not.toContain('/private/project'); expect(result.records[1]?.description).toContain('not visible-phone state or native proof');
  expect(call.mock.calls.map(args => args[0])).toEqual(['media_read', 'project_inspect', 'builder_mcp_read_resource']);
  const unavailable = vi.fn<AssistantGateway['call']>(async () => ({ content: [], details: { structuredContent: { captures: [], asset: { label: 'Missing PNG', width: 16, height: 16 } } } }));
  const blocked = await resolveImages([media, capture], gateway(unavailable), new AbortController().signal);
  expect(blocked.images).toEqual([]); expect(blocked.records.every(record => record.status === 'blocked' && record.description.includes('Visual review blocked'))).toBe(true);
  expect(unavailable.mock.calls.map(args => args[0])).toEqual(['media_read', 'project_inspect']);
  const controller = new AbortController(); controller.abort(); await expect(resolveImages([media], gateway(call), controller.signal)).rejects.toThrow();
});
it('sends attachments only to the bound run, records adapter acceptance, and persists no PNG or selected text', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'assistant-attachments-')); cleanups.push(() => rm(home, { recursive: true, force: true }));
  const png = (await sharp({ create: { width: 16, height: 16, channels: 4, background: '#ffffff' } }).png().toBuffer()).toString('base64');
  const image = { projectId, kind: 'media' as const, id: randomUUID() };
  const run = vi.fn(async (input: HarnessInput, callbacks: { imageAccepted?: () => void }) => { expect(input.images?.[0]?.data).toBe(png); expect(input.inspector?.selection.visibleText).toBe('Untrusted app label'); callbacks.imageAccepted?.(); });
  const service = new AssistantService({ home, createHarness: () => ({ run, async close() {} }), createGateway: async () => gateway(async name => name === 'studio_inspect' ? state() : { content: [{ type: 'image', data: png, mimeType: 'image/png' }], details: { structuredContent: { asset: { label: 'Fixture', width: 16, height: 16 } } } }) }); cleanups.push(() => service.close());
  service.configure({ action: 'connect', key: 'offline-attachment-credential' });
  const conversation = await service.createConversation(projectId);
  const input = { conversationId: conversation.id, runId: randomUUID(), prompt: 'Review the selection', attachments: { inspector: inspector(), images: [image] } };
  await expect(service.start({ ...input, attachments: { images: [{ ...image, projectId: randomUUID() }] } })).rejects.toThrow('conversation project');
  await service.start(input); await vi.waitFor(() => expect(service.status().busy).toBe(false));
  const stored = await service.conversation(conversation.id);
  expect(stored.turns[0]).toMatchObject({ state: 'completed', imageContentAccepted: true, images: [{ ...image, status: 'adapter-accepted' }] });
  const disk = await readFile(path.join(home, 'assistant', `${conversation.id}.json`), 'utf8');
  for (const privateValue of [png, 'Untrusted app label', 'offline-attachment-credential']) expect(disk).not.toContain(privateValue);
  await service.start({ ...input, runId: randomUUID(), attachments: { inspector: { ...inspector(), view: { ...inspector().view, refresh: 5 } } } });
  await vi.waitFor(() => expect(service.status().busy).toBe(false)); expect(run).toHaveBeenCalledTimes(1);
  expect((await service.conversation(conversation.id)).turns[1]?.state).toBe('failed');
});

it('resolves retained board captures through a scoped resource and reports stale source context', async () => {
  const png = (await sharp({ create: { width: 16, height: 16, channels: 4, background: '#ffffff' } }).png().toBuffer()).toString('base64');
  const reference = { projectId, kind: 'board' as const, id: randomUUID() };
  const call = vi.fn<AssistantGateway['call']>(async name => name === 'project_inspect' ? { content: [], details: { structuredContent: { boardCaptures: [{ id: reference.id, route: '/journal', viewport: 'compact', createdAt: new Date().toISOString(), stale: true }] } } } : { content: [{ type: 'image', data: png, mimeType: 'image/png' }] });
  const result = await resolveImages([reference], gateway(call), new AbortController().signal);
  expect(result.images).toHaveLength(1);
  expect(result.images[0]?.description).toContain('Source changed');
  expect(call).toHaveBeenCalledWith('builder_mcp_read_resource', { uri: `builder://projects/${projectId}/board-captures/${reference.id}` }, expect.any(AbortSignal));
});
