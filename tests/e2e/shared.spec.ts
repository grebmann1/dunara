import { openProjectRoutes } from './preview-actions.js';
import { selectProject } from './project-picker.js';
import { test, expect } from '@playwright/test';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';
import { Engine } from '../../packages/core/src/engine.js';
import { Projects } from '../../packages/core/src/projects.js';
import { projectSchema, revisionSchema, previewSchema } from '../../packages/core/src/contracts.js';
import { createMcpServer } from '../../packages/mcp/src/server.js';
import { startStudio } from '../../packages/cli/src/studio-server.js';

test.use({ trace: 'off', actionTimeout: 20_000 });
const filesSchema = z.object({ project: projectSchema, files: z.array(z.object({ path: z.string(), content: z.string(), revision: revisionSchema })) });
test('one Engine: real MCP edits, Studio preview/design/captures and shared stop', async ({ page }) => {
  test.skip(!!process.env.VISUAL, 'Visual suite only');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'builder-shared-'));
  const engine = new Engine(await Projects.open(path.join(dir, 'apps'), path.join(dir, 'home')), true);
  const server = createMcpServer(engine), client = new Client({ name: 'shared-acceptance', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const studio = await startStudio(engine, path.resolve('dist/studio'));
  const urls: string[] = [];
  const metroEvents: unknown[] = [];
  const metroErrors: unknown[] = [];
  let metroSession: { registered: boolean; closed: boolean } | undefined;
  page.on('websocket', socket => {
    if (new URL(socket.url()).pathname !== '/hot') return;
    const current = { registered: false, closed: false }; metroSession = current;
    metroEvents.push({ event: 'open', url: socket.url() });
    socket.on('close', () => { current.closed = true; metroEvents.push({ event: 'close' }); });
    socket.on('framereceived', frame => {
      try {
        const message = JSON.parse(String(frame.payload));
        if (message.type === 'bundle-registered') current.registered = true;
        if (message.type === 'error') metroErrors.push(message.body);
        metroEvents.push({ event: 'message', type: message.type, ...(message.type === 'error' ? { body: message.body } : {}) });
      } catch { /* Ignore non-JSON heartbeat frames. */ }
    });
  });
  try {
    await server.connect(serverTransport); await client.connect(clientTransport);
    await page.goto(studio.launchUrl);
    await expect(page.getByRole('heading', { name: 'Create your first app' })).toBeVisible();
    const created = await client.callTool({ name: 'project_create', arguments: { name: 'Connected Alpha', slug: 'connected-alpha' } });
    const first = z.object({ project: projectSchema }).parse(created.structuredContent).project;
    const second = z.object({ project: projectSchema }).parse((await client.callTool({ name: 'project_create', arguments: { name: 'Connected Beta', slug: 'connected-beta', preset: 'midnight' } })).structuredContent).project;
    await expect(page.getByRole('combobox', { name: 'Project', exact: true })).toContainText(first.name);
    const inspected = filesSchema.parse((await client.callTool({ name: 'project_inspect', arguments: { projectId: first.id, paths: ['app/index.tsx'] } })).structuredContent);
    expect(inspected.project.root).toBe(await realpath(path.join(dir, 'apps', 'connected-alpha')));
    await page.getByLabel('Preview tools', { exact: true }).click();
    await page.getByRole('button', { name: 'Project settings', exact: true }).click();
    await expect(page.getByText(first.id, { exact: true })).toBeVisible();
    await expect(page.getByText(first.root, { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Preview', exact: true }).click();
    await page.getByRole('button', { name: 'Start preview' }).click();
    await expect(page.getByRole('button', { name: 'Stop preview' })).toBeVisible({ timeout: 180_000 });
    const frame = page.frameLocator('iframe');
    await expect(frame.getByText('A softer kind of day.', { exact: false })).toBeVisible({ timeout: 60_000 });
    const preview = previewSchema.parse((await client.callTool({ name: 'preview_start', arguments: { projectId: first.id } })).structuredContent);
    expect(preview.url).toBe(engine.previews.status(first.id).url); urls.push(preview.url!);
    const source = inspected.files[0]!;
    const content = source.content.replace('A softer kind of day.', 'Connected through one runtime.');
    expect((await client.callTool({ name: 'project_write_files', arguments: { projectId: first.id, writes: [
      { path: source.path, content, expectedRevision: source.revision },
      { path: 'app/survey.tsx', expectedRevision: null, content: "import { Screen, Type } from '../src/ui'; export default function Survey() { return <Screen><Type>Survey station</Type></Screen>; }\n" },
    ] } })).isError).not.toBe(true);
    expect(await readFile(path.join(first.root, source.path), 'utf8')).toBe(content);
    await expect(frame.getByText('Connected through one runtime.', { exact: false })).toBeVisible({ timeout: 30_000 });
    const before = await engine.designs.read(first.id);
    await page.getByRole('button', { name: 'Design', exact: true }).click();
    await page.getByRole('button', { name: 'clay', exact: true }).click();
    await expect.poll(async () => (await engine.designs.read(first.id)).preset).toBe('clay');
    const state = z.object({ design: z.object({ revision: revisionSchema, preset: z.string() }) }).parse((await client.callTool({ name: 'project_inspect', arguments: { projectId: first.id } })).structuredContent);
    expect(state.design.revision).not.toBe(before.revision);
    expect(state.design.revision).toBe((await engine.designs.read(first.id)).revision);
    await expect(frame.locator('[style*="background-color: rgb(251, 243, 236)"]').first()).toBeVisible();
    await openProjectRoutes(page);
    await expect(page.getByRole('button', { name: '/survey File candidate', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '/survey File candidate', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Project routes', exact: true })).toHaveCount(0);
    await expect(page.getByLabel('Preview tools', { exact: true })).toBeFocused();
    await openProjectRoutes(page);
    await page.getByLabel('Agent-added screen').fill('/survey'); await page.getByLabel('Agent-added screen').press('Enter');
    await expect(frame.getByText('Survey station', { exact: true })).toBeVisible();
    // Bind the error-injection check to a newly registered HMR connection,
    // rather than a connection from the preceding route navigation.
    const precedingSession = metroSession;
    await page.getByRole('button', { name: 'Reload preview', exact: true }).click();
    await expect.poll(() => metroSession !== precedingSession && metroSession?.registered && !metroSession.closed).toBe(true);
    await expect(frame.getByText('Survey station', { exact: true })).toBeVisible();
    const survey = filesSchema.parse((await client.callTool({ name: 'project_inspect', arguments: { projectId: first.id, paths: ['app/survey.tsx'] } })).structuredContent).files[0]!;
    expect((await client.callTool({ name: 'project_write_files', arguments: { projectId: first.id, writes: [{ path: survey.path, content: survey.content + '\nconst broken = ;', expectedRevision: survey.revision }] } })).isError).not.toBe(true);
    expect(await readFile(path.join(first.root, survey.path), 'utf8')).toBe(survey.content + '\nconst broken = ;');
    await expect.poll(() => metroErrors, { timeout: 30_000 }).toContainEqual(expect.objectContaining({ filename: survey.path, name: 'SyntaxError', message: expect.stringContaining('Unexpected token (3:15)') }));
    // Expo 57 can label a real compilation failure "Unknown": its log parser drops an unchanged originalMessage.
    // Require both the actual Metro syntax error and a visible error overlay, plus actionable Studio diagnostics.
    await expect(frame.getByRole('button', { name: 'Reload application', exact: true })).toBeVisible({ timeout: 30_000 });
    await page.locator('.studio-console').getByRole('button', { name: 'Diagnostics', exact: true }).click();
    await page.getByRole('combobox', { name: 'Diagnostic level', exact: true }).click();
    await page.getByRole('option', { name: /^All output/ }).click();
    const syntaxDiagnostic = page.locator('.studio-console .diagnostic-row').filter({ hasText: 'const broken = ;' }).first();
    await syntaxDiagnostic.locator('summary').click();
    await expect(syntaxDiagnostic).toBeVisible();
    await expect(syntaxDiagnostic).toContainText(/SyntaxError: .*app\/survey\.tsx: Unexpected token \(3:15\)/);
    await page.getByRole('button', { name: 'Collapse console', exact: true }).click();
    const broken = await engine.files.read(first.id, survey.path);
    expect((await client.callTool({ name: 'project_write_files', arguments: { projectId: first.id, writes: [{ path: survey.path, content: survey.content, expectedRevision: broken.revision }] } })).isError).not.toBe(true);
    await page.getByRole('button', { name: 'Reload preview' }).click();
    await expect(frame.getByText('Survey station', { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(frame.getByRole('button', { name: 'Reload application', exact: true })).toHaveCount(0);
    await expect(frame.locator('body')).not.toContainText(/SyntaxError|Syntax Error|Unexpected token/);
    for (const viewport of ['compact', 'large'] as const) {
      await page.getByRole('button', { name: viewport === 'compact' ? 'Compact phone' : 'Large phone' }).click();
      for (const width of [375, 768, 1440]) {
        await page.setViewportSize({ width, height: 1100 });
        await expect.poll(() => frame.locator('body').evaluate(() => ({ width: innerWidth, height: innerHeight }))).toEqual(viewport === 'compact' ? { width: 375, height: 812 } : { width: 430, height: 932 });
        await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      }
      for (const route of ['/', '/habit', '/progress', '/survey']) {
        const capture = await client.callTool({ name: 'preview_capture', arguments: { projectId: first.id, route, viewport } });
        expect(capture.isError).not.toBe(true);
        const meta = z.object({ uri: z.string(), projectId: z.uuid(), route: z.string(), viewport: z.string() }).parse(capture.structuredContent);
        const image = z.array(z.object({ type: z.string(), data: z.string().optional() })).parse(capture.content).find(c => c.type === 'image')!;
        const png = Buffer.from(image.data!, 'base64');
        expect(meta).toMatchObject({ projectId: first.id, route, viewport });
        expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual(viewport === 'compact' ? [375, 812] : [430, 932]);
        expect(z.object({ blob: z.string() }).parse((await client.readResource({ uri: meta.uri })).contents[0]).blob).toBe(image.data);
      }
    }
    await page.locator('.studio-console').getByRole('button', { name: 'Captures', exact: true }).click();
    await expect(page.getByRole('img', { name: 'Capture of /survey · large', exact: true })).toBeVisible();
    await expect.poll(() => page.locator('.studio-console .capture-grid img').count()).toBe(8);
    const thumbnail = page.getByRole('button', { name: 'Open capture of /survey · large', exact: true });
    await thumbnail.focus(); await page.keyboard.press('Enter');
    const captureDialog = page.getByRole('dialog', { name: 'Capture · /survey · large', exact: true });
    const captureImage = captureDialog.getByRole('img', { name: 'Full capture of /survey · large', exact: true });
    for (const viewport of [{ width: 1440, height: 1100 }, { width: 375, height: 812 }, { width: 430, height: 932 }]) {
      await page.setViewportSize(viewport);
      await expect(captureImage).toBeVisible();
      await expect.poll(() => captureImage.evaluate(node => node instanceof HTMLImageElement ? [node.naturalWidth, node.naturalHeight] : [])).toEqual([430, 932]);
      await expect.poll(() => captureDialog.evaluate(node => { const rect = node.getBoundingClientRect(); return rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight; })).toBe(true);
      await expect(captureDialog.getByRole('button', { name: 'Close dialog', exact: true })).toBeInViewport();
      await page.screenshot({ path: test.info().outputPath(`capture-viewer-${viewport.width}.png`) });
    }
    await page.keyboard.press('Escape');
    await expect(captureDialog).toHaveCount(0);
    await expect(thumbnail).toBeFocused();
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.getByRole('button', { name: 'Collapse console', exact: true }).click();
    const refined = await engine.designs.read(first.id);
    await client.callTool({ name: 'design_apply', arguments: { projectId: first.id, update: { expectedRevision: refined.revision, tokens: { radius: 12 } } } });
    await page.getByRole('button', { name: 'Capture', exact: true }).click();
    await expect.poll(() => engine.captures.list(first.id).length).toBe(9);
    expect(engine.captures.list(first.id).at(-1)).toMatchObject({ route: '/survey', viewport: 'large' });
    await page.getByRole('button', { name: 'Reload preview' }).click();
    await expect(frame.getByText('Survey station', { exact: true })).toBeVisible();
    await openProjectRoutes(page);
    await page.getByLabel('Agent-added screen').fill('/not-a-screen'); await page.getByLabel('Agent-added screen').press('Enter');
    await expect(frame.getByText('Unmatched Route', { exact: false })).toBeVisible();
    await selectProject(page, second.id);
    await expect(page.locator('.preview-caption')).toHaveCount(1);
    await expect(page.locator('.preview-caption')).toHaveText('Home · Stopped · 375 × 812 · Opens /');
    await expect(page.getByRole('button', { name: 'Start preview' })).toBeVisible();
    await openProjectRoutes(page);
    await expect(page.getByLabel('Agent-added screen')).toHaveValue('');
    await page.getByLabel('Agent-added screen').press('Escape');
    expect(await engine.files.read(second.id, 'app/index.tsx')).toMatchObject({ content: source.content });
    await client.callTool({ name: 'preview_stop', arguments: { projectId: first.id } });
    await selectProject(page, first.id);
    await expect(page.getByRole('button', { name: 'Start preview' })).toBeVisible();
    await client.callTool({ name: 'preview_start', arguments: { projectId: first.id } }, undefined, { timeout: 180_000 });
    await expect(page.getByRole('button', { name: 'Stop preview' })).toBeVisible();
    urls.push(engine.previews.status(first.id).url!);
    await page.getByRole('button', { name: 'Stop preview' }).click();
    await expect.poll(() => engine.previews.status(first.id).status).toBe('stopped');
    const diagnostics = await client.callTool({ name: 'project_diagnostics', arguments: { projectId: first.id } });
    expect(diagnostics.isError).not.toBe(true);
  } finally {
    const diagnosticPath = test.info().outputPath('metro-runtime-diagnostics.json');
    await writeFile(diagnosticPath, JSON.stringify({ metroEvents, projects: (await engine.projects.list()).map(project => ({ id: project.id, diagnostics: engine.diagnostics.read(project.id) })) }, null, 2));
    await test.info().attach('metro-runtime-diagnostics', { path: diagnosticPath, contentType: 'application/json' });
    await client.close(); await server.close(); await studio.close(); await engine.close(); await rm(dir, { recursive: true, force: true });
  }
  for (const url of urls) await expect(fetch(url, { signal: AbortSignal.timeout(2000) })).rejects.toThrow();
});
