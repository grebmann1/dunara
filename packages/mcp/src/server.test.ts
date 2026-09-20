import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { designSchema, projectSchema, revisionSchema } from '../../core/src/contracts.js';
import { z } from 'zod';

function assertPortableJsonSchemaPatterns(schema: unknown, path: string) {
  if (!schema || typeof schema !== 'object') return;
  const node = schema as Record<string, unknown>;
  if (typeof node.pattern === 'string') {
    const pattern = node.pattern;
    expect(pattern, path).not.toMatch(/\\[pP]\{|\(\?[=!<]/);
    expect(() => new RegExp(pattern), path).not.toThrow();
  }
  for (const [key, value] of Object.entries(node)) assertPortableJsonSchemaPatterns(value, `${path}.${key}`);
}

it.each([
  ['source', ['--import', 'tsx', 'packages/cli/src/index.ts']],
  ['built', ['dist/packages/cli/src/index.js']],
])('exposes portable tool schemas through the %s CLI while preserving Unicode names', async (_label, args) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'builder-mcp-schema-'));
  const transport = new StdioClientTransport({ command: process.execPath, args: [...args, '--workspace', path.join(dir, 'apps'), '--home', path.join(dir, 'home')], stderr: 'pipe' });
  const client = new Client({ name: 'builder-schema-test', version: '1' });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      assertPortableJsonSchemaPatterns(tool.inputSchema, tool.name);
      assertPortableJsonSchemaPatterns(tool.outputSchema, `${tool.name}.output`);
    }
    const name = tools.find(tool => tool.name === 'project_create')?.inputSchema.properties?.name;
    expect(name).toMatchObject({ type: 'string', minLength: 1, maxLength: 60 });
    expect(name).not.toHaveProperty('pattern');
    const created = await client.callTool({ name: 'project_create', arguments: { name: '  Bonsai Érable 盆栽 2  ', slug: 'unicode-name' } });
    expect(created.isError).not.toBe(true);
    expect(created.structuredContent).toMatchObject({ project: { name: 'Bonsai Érable 盆栽 2' } });
    for (const invalid of ['', '   ', 'x'.repeat(61), 'Bad/name', '<script>', 'Tree 🌳']) {
      expect((await client.callTool({ name: 'project_create', arguments: { name: invalid, slug: 'invalid-name' } })).isError).toBe(true);
    }
  } finally { await client.close(); await rm(dir, { recursive: true, force: true }); }
}, 30_000);

it('performs an actual stdio handshake, discovery, source/design loop and trust errors', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'builder-mcp-'));
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', 'packages/cli/src/index.ts', '--workspace', path.join(dir, 'apps'), '--home', path.join(dir, 'home')], stderr: 'pipe' });
  const client = new Client({ name: 'builder-integration-test', version: '1' });
  let stderr = ''; transport.stderr?.on('data', data => { stderr += data.toString(); });
  try {
    await client.connect(transport);
    const tools = (await client.listTools()).tools;
    expect(tools.map(t => t.name)).toEqual(['backend_environment_inspect', 'backend_environment_declare', 'backend_recipe_preview', 'backend_recipe_apply', 'recipe_upgrade_preview', 'recipe_upgrade_apply', 'backend_inspect', 'backend_catalog', 'backend_capabilities', 'backend_select_environment', 'backend_plan', 'backend_validate', 'backend_requirements', 'backend_setup', 'backend_apply', 'backend_operation', 'backend_cancel', 'backend_reconcile', 'backend_generate_types', 'backend_export_config', 'native_delivery_preflight', 'native_delivery_plan', 'native_delivery_build', 'native_delivery_list', 'native_delivery_install_plan', 'native_delivery_install', 'native_delivery_launch', 'native_delivery_cancel', 'native_delivery_remove', 'native_workspace_plan', 'native_workspace_prepare', 'native_workspace_list', 'native_workspace_cancel', 'native_workspace_remove', 'native_build_inspect', 'native_build_plan', 'native_build_apply', 'project_list', 'project_open', 'studio_inspect', 'studio_control', 'activity_list', 'board_capture', 'inspector_setup_preview', 'inspector_setup_apply', 'project_create', 'project_inspect', 'project_write_files', 'design_apply', 'preview_start', 'preview_set_transport', 'preview_stop', 'preview_capture', 'project_diagnostics', 'icon_check', 'icon_prepare', 'icon_preview', 'icon_apply', 'media_list', 'media_read', 'media_import', 'media_brief', 'media_approve', 'media_transform', 'media_request', 'media_job', 'launch_kit_create', 'launch_kit_list', 'launch_kit_read', 'launch_kit_remove', 'media_cancel', 'plugin_list', 'plugin_guide', 'plugin_action']);
    for (const name of ['project_write_files', 'design_apply']) expect(tools.find(t => t.name === name)?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(tools.find(t => t.name === 'preview_start')?.annotations).toMatchObject({ readOnlyHint: false, openWorldHint: true });
    const created = await client.callTool({ name: 'project_create', arguments: { name: 'Test app', slug: 'test-app' } });
    const { project } = z.object({ project: projectSchema }).parse(created.structuredContent);
    const inspect = await client.callTool({ name: 'project_inspect', arguments: { projectId: project.id, paths: ['app/index.tsx'] } });
    const state = z.object({ files: z.array(z.object({ path: z.string(), content: z.string(), revision: revisionSchema })), design: designSchema.extend({ revision: revisionSchema }) }).parse(inspect.structuredContent);
    const file = state.files[0]!;
    const write = await client.callTool({ name: 'project_write_files', arguments: { projectId: project.id, writes: [{ path: file.path, content: file.content + '\n', expectedRevision: file.revision }] } });
    expect(write.isError).not.toBe(true);
    const conflict = await client.callTool({ name: 'project_write_files', arguments: { projectId: project.id, writes: [{ path: file.path, content: file.content, expectedRevision: file.revision }] } });
    expect(conflict.isError).toBe(true); expect(conflict.structuredContent).toMatchObject({ error: { code: 'REVISION_CONFLICT' } });
    const design = await client.callTool({ name: 'design_apply', arguments: { projectId: project.id, update: { expectedRevision: state.design.revision, preset: 'clay', mode: 'dark' } } });
    expect(design.structuredContent).toMatchObject({ preset: 'clay', mode: 'dark' });
    const start = await client.callTool({ name: 'preview_start', arguments: { projectId: project.id } });
    expect(start.structuredContent).toMatchObject({ error: { code: 'TRUST_REQUIRED' } });
    const capture = await client.callTool({ name: 'preview_capture', arguments: { projectId: project.id } });
    expect(capture.structuredContent).toMatchObject({ error: { code: 'PREVIEW_NOT_READY' } });
    expect((await client.callTool({ name: 'preview_stop', arguments: { projectId: project.id } })).isError).not.toBe(true);
    expect((await client.callTool({ name: 'project_diagnostics', arguments: { projectId: project.id } })).structuredContent).toMatchObject({ entries: [] });
    expect((await client.listResources()).resources).toHaveLength(2);
    const createdGuidance = z.object({ guidance: z.string() }).parse(created.structuredContent).guidance;
    expect(createdGuidance).toContain('same viewport and appearance');
    expect(createdGuidance).toContain('a larger viewport does not prove a compact-layout fix');
    expect(createdGuidance).toContain('client approval denial is a blocker');
    for (const instruction of [
      'not a final-only screenshot pass',
      'after the first renderable screen',
      'after each meaningful layout/style/image/navigation change or small UI batch',
      'before handoff',
      'verify that the harness delivers the actual PNG to the model',
      'base64 text, a saved file, OCR, and DOM geometry alone do not prove visual inspection',
      'report visual review blocked',
      'match content/state and scroll position',
      'A Studio capture is not automatically pushed to the agent',
      'Keep screenshot image content intact through any adapter',
    ]) expect(createdGuidance).toContain(instruction);
    expect(tools.find(t => t.name === 'preview_capture')?.description).toContain('Use after first render, meaningful UI changes and before handoff');
    expect(tools.find(t => t.name === 'preview_capture')?.description).toContain('Report visual review blocked');
    const guideResource = z.object({ text: z.string() }).parse((await client.readResource({ uri: 'builder://guide' })).contents[0]);
    expect(JSON.parse(guideResource.text).guidance).toBe(createdGuidance);
    expect(client.getInstructions()).toBe(createdGuidance);
    expect((await client.readResource({ uri: 'builder://projects' })).contents[0]).toHaveProperty('text');
    expect((await client.listResourceTemplates()).resourceTemplates).toHaveLength(4);
    const prompt = await client.getPrompt({ name: 'build-mobile-app', arguments: { brief: 'Build a habit tracker' } });
    expect(prompt.messages).toHaveLength(1);
    expect(prompt.messages[0]?.content).toMatchObject({ type: 'text', text: expect.stringContaining(createdGuidance) });
    for (const tool of tools) {
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.annotations?.readOnlyHint).toBe(['native_delivery_preflight', 'native_delivery_plan', 'native_delivery_list', 'native_delivery_install_plan', 'native_workspace_plan', 'native_workspace_list', 'native_build_inspect', 'native_build_plan', 'backend_environment_inspect', 'backend_recipe_preview', 'recipe_upgrade_preview', 'backend_inspect', 'backend_catalog', 'backend_capabilities', 'backend_plan', 'backend_validate', 'backend_requirements', 'backend_operation', 'project_list', 'studio_inspect', 'activity_list', 'inspector_setup_preview', 'project_inspect', 'project_diagnostics', 'media_list', 'media_read', 'media_job', 'icon_check', 'icon_preview', 'launch_kit_list', 'launch_kit_read', 'plugin_list', 'plugin_guide'].includes(tool.name));
      assertPortableJsonSchemaPatterns(tool.inputSchema, tool.name);
    }
    expect(tools.find(t => t.name === 'preview_stop')?.annotations?.idempotentHint).toBe(true);
    const freshPath = 'app/new-screen.tsx';
    expect((await client.callTool({ name: 'project_write_files', arguments: { projectId: project.id, writes: [{ path: freshPath, content: 'export default function Screen() { return null; }', expectedRevision: null }] } })).isError).not.toBe(true);
    expect((await client.callTool({ name: 'project_write_files', arguments: { projectId: project.id, writes: [{ path: freshPath, content: 'overwrite', expectedRevision: null }] } })).structuredContent).toMatchObject({ error: { code: 'REVISION_CONFLICT' } });
    const current = z.object({ files: z.array(z.object({ path: z.string(), content: z.string(), revision: revisionSchema })) }).parse((await client.callTool({ name: 'project_inspect', arguments: { projectId: project.id, paths: [file.path] } })).structuredContent).files[0]!;
    const rejected = await client.callTool({ name: 'project_write_files', arguments: { projectId: project.id, writes: [{ path: file.path, content: 'must not apply', expectedRevision: current.revision }, { path: freshPath, content: 'collision', expectedRevision: null }] } });
    expect(rejected.isError).toBe(true);
    expect(z.object({ files: z.array(z.object({ content: z.string() })) }).parse((await client.callTool({ name: 'project_inspect', arguments: { projectId: project.id, paths: [file.path] } })).structuredContent).files[0]?.content).toBe(current.content);
    for (const name of ['project_inspect', 'project_write_files', 'design_apply', 'preview_start', 'preview_capture', 'project_diagnostics']) {
      const unknown = await client.callTool({ name, arguments: { projectId: '00000000-0000-4000-8000-000000000000', ...(name === 'project_write_files' ? { writes: [{ path: 'app/new.tsx', content: '', expectedRevision: null }] } : {}), ...(name === 'design_apply' ? { update: { expectedRevision: state.design.revision, preset: 'sage' } } : {}) } });
      expect(unknown.isError).toBe(true);
      expect(unknown.structuredContent).toMatchObject({ error: { code: name === 'preview_start' ? 'TRUST_REQUIRED' : 'PROJECT_NOT_FOUND' } });
    }
    for (const args of [{ name: '', slug: 'invalid' }, { name: 'Bad', slug: '../escape' }, { name: 'Bad', slug: 'bad', extra: true }]) {
      expect((await client.callTool({ name: 'project_create', arguments: args })).isError).toBe(true);
    }
    expect((await client.callTool({ name: 'preview_capture', arguments: { projectId: project.id, route: '//example.com' } })).isError).toBe(true);
    expect(stderr).not.toMatch(/uncaught|unhandled/i);
  } finally { await client.close(); await rm(dir, { recursive: true, force: true }); }
}, 30_000);
