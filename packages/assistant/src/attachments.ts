import { z } from 'zod';
import type { AssistantGateway } from './service.js';
import { harnessImageSchema, type AssistantAttachments, type HarnessInput, type InspectorAttachment } from './contracts.js';

export async function validateInspector(inspector: InspectorAttachment, gateway: AssistantGateway, signal: AbortSignal) {
  const result = await gateway.call('studio_inspect', {}, signal);
  const state = z.object({ projectId: z.uuid(), studio: z.object({ board: z.object({ activeId: z.uuid(), views: z.array(z.object({ id: z.uuid(), route: z.string(), viewport: z.string(), refresh: z.number() })) }) }) }).parse(z.object({ structuredContent: z.unknown() }).parse(result.details).structuredContent);
  const view = state.studio.board.views.find(view => view.id === inspector.viewId);
  const age = Date.now() - Date.parse(inspector.selection.timestamp);
  if (result.isError || state.projectId !== inspector.projectId || state.studio.board.activeId !== inspector.viewId || !view || view.route !== inspector.view.route || view.viewport !== inspector.view.viewport || view.refresh !== inspector.view.refresh || age < -30_000 || age > 600_000) throw new Error('Inspector context is stale or no longer belongs to the active view. Select the element again before sending.');
}

export async function resolveImages(references: AssistantAttachments['images'], gateway: AssistantGateway, signal: AbortSignal) {
  const images: NonNullable<HarnessInput['images']> = [];
  const records = [];
  for (const reference of references ?? []) {
    signal.throwIfAborted();
    let description = `${reference.kind} ${reference.id}; visual review blocked: image unavailable or over the attachment limit.`;
    try {
      const result = await gateway.call(reference.kind === 'media' ? 'media_read' : 'project_inspect', reference.kind === 'media' ? { projectId: reference.projectId, assetId: reference.id } : { projectId: reference.projectId }, signal);
      if (result.isError) throw new Error('Image metadata unavailable');
      const details = z.object({ structuredContent: z.record(z.string(), z.unknown()) }).parse(result.details).structuredContent;
      let content = result.content;
      if (reference.kind === 'capture' || reference.kind === 'board') {
        const captures = z.array(z.object({ id: z.string(), route: z.string(), viewport: z.string(), createdAt: z.string(), stale: z.boolean().optional() })).parse(reference.kind === 'board' ? details.boardCaptures : details.captures);
        const capture = captures.find(item => item.id === reference.id);
        if (!capture) throw new Error('Capture expired');
        description = `Capture ${reference.id}: route ${capture.route}, viewport ${capture.viewport}, captured ${capture.createdAt}.${capture.stale ? ' Source changed since capture; review the current source.' : ''} Fresh-context React Native Web render, not visible-phone state or native proof.`;
        const resource = await gateway.call('builder_mcp_read_resource', { uri: `builder://projects/${reference.projectId}/${reference.kind === 'board' ? 'board-captures' : 'captures'}/${reference.id}` }, signal);
        if (resource.isError) throw new Error('Capture unavailable');
        content = resource.content;
      } else {
        const asset = z.object({ label: z.string(), width: z.number(), height: z.number() }).parse(details.asset);
        description = `Immutable media ${reference.id}: ${asset.label}, ${asset.width} × ${asset.height}.`;
      }
      const image = content.find(block => block.type === 'image' && block.mimeType === 'image/png');
      if (!image || image.type !== 'image') throw new Error('Image content missing');
      const parsed = harnessImageSchema.parse({ ...reference, data: image.data, mimeType: image.mimeType, description });
      // Construct explicitly: the harness never receives protocol details or absolute paths.
      images.push(parsed);
      records.push({ ...reference, description, status: 'requested' as const });
    } catch {
      signal.throwIfAborted();
      records.push({ ...reference, description: `${description.slice(0, 1900)} Visual review blocked: image content unavailable.`, status: 'blocked' as const });
    }
  }
  return { images, records };
}
