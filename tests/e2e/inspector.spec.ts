import { openProjectRoutes } from './preview-actions.js';
import { selectProject } from './project-picker.js';
import { test, expect } from '@playwright/test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';
import { Engine } from '../../packages/core/src/engine.js';
import { Projects } from '../../packages/core/src/projects.js';
import { projectSchema, revisionSchema } from '../../packages/core/src/contracts.js';
import { createMcpServer } from '../../packages/mcp/src/server.js';
import { startStudio } from '../../packages/cli/src/studio-server.js';
import { selectionSchema } from '../../apps/studio/src/preview-context.js';

test.use({ trace: 'off' });
test.beforeEach(() => test.skip(!!process.env.VISUAL, 'Visual suite only'));
const contextSchema = z.object({ project: z.object({ id: z.string(), name: z.string(), root: z.string() }), observed: selectionSchema });
const parse = (text: string) => contextSchema.parse(JSON.parse(text.split('```json\n')[1]!.split('\n```')[0]!));
const filesSchema = z.object({ files: z.array(z.object({ path: z.string(), content: z.string(), revision: revisionSchema })) });

test('real starter: inspect, right-click clipboard, revision-edit via MCP and Fast Refresh', async ({ page, context }, testInfo) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'builder-inspect-e2e-'));
  const engine = new Engine(await Projects.open(path.join(dir, 'apps'), path.join(dir, 'home')), true);
  const server = createMcpServer(engine), client = new Client({ name: 'inspector-acceptance', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const studio = await startStudio(engine, path.resolve('dist/studio'));
  try {
    await server.connect(st); await client.connect(ct);
    const project = z.object({ project: projectSchema }).parse((await client.callTool({ name: 'project_create', arguments: { name: 'Inspect Alpha', slug: 'inspect-alpha' } })).structuredContent).project;
    await page.goto(studio.launchUrl);
    await page.getByRole('button', { name: 'Start preview' }).click();
    const frame = page.frameLocator('iframe');
    const heading = frame.getByText('A softer kind of day.', { exact: false });
    await expect(heading).toBeVisible({ timeout: 180_000 });
    const inspect = page.getByRole('button', { name: 'Inspect', exact: true });
    await expect(inspect).toBeEnabled(); await inspect.click(); await heading.click();
    const textarea = page.getByLabel('Copyable context');
    await expect(textarea).toContainText('A softer kind of day.');
    const payload = parse(await textarea.inputValue());
    expect(payload.project).toEqual({ id: project.id, name: project.name, root: project.root });
    expect(payload.observed.pathname).toBe('/'); expect(payload.observed.viewport).toEqual({ width: 375, height: 812 });
    expect(payload.observed.source.status).toBe('unavailable');
    expect(payload.observed.bounds).toEqual(await heading.evaluate(el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; }));
    expect(payload.observed.styles.fontSize).toBe(await heading.evaluate(el => getComputedStyle(el).fontSize));
    await expect(frame.locator('[data-builder-inspector-overlay]')).toBeVisible();
    const contextToggle = page.getByRole('button', { name: 'Preview context', exact: true });
    const panel = page.getByRole('region', { name: 'Selected preview context' });
    const phone = await page.locator('iframe').elementHandle();
    for (const width of [320, 375, 430, 768, 1280, 1440]) for (const browserZoom of [1, 2]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(value => { document.documentElement.style.zoom = String(value); }, browserZoom);
      await page.getByRole('button', { name: 'Fit', exact: true }).click();
      const dimensions = () => page.locator('.device-area').evaluate(node => ({ width: node.clientWidth, height: node.clientHeight, scrollWidth: node.scrollWidth, scrollHeight: node.scrollHeight }));
      const before = await dimensions(), zoomBefore = await page.getByLabel('Canvas zoom level').textContent();
      await contextToggle.click(); await expect(panel).toBeVisible();
      await expect.poll(dimensions).toEqual(before);
      await expect(page.getByLabel('Canvas zoom level')).toHaveText(zoomBefore!);
      expect(await panel.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
      expect(await panel.evaluate(node => { const panel = node.getBoundingClientRect(), canvas = node.closest('.canvas-viewport')!.getBoundingClientRect(); return panel.left >= canvas.left && panel.right <= canvas.right && panel.top >= canvas.top && panel.bottom <= canvas.bottom; })).toBe(true);
      await panel.getByLabel('Copyable context').scrollIntoViewIfNeeded();
      await expect(panel.getByLabel('Copyable context')).toBeInViewport();
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
      if (width === 375 || width === 1440) await page.screenshot({ path: testInfo.outputPath(`context-side-panel-${width}-${browserZoom}.png`), fullPage: true });
      await panel.getByLabel('Copyable context').focus(); await page.keyboard.press('Escape');
      await expect(panel).toHaveCount(0); await expect(contextToggle).toBeFocused();
      await expect(inspect).toHaveAttribute('aria-pressed', 'true');
      await expect.poll(dimensions).toEqual(before);
    }
    await page.evaluate(() => { document.documentElement.style.zoom = ''; });
    expect(await phone!.evaluate(node => node.isConnected)).toBe(true);
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: studio.origin });
    await page.getByRole('button', { name: '100%', exact: true }).click();
    await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
    await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
    await expect(page.getByLabel('Canvas zoom level')).toHaveText('120%');
    const canvas = page.getByRole('region', { name: 'Phone preview canvas' });
    await canvas.focus(); await canvas.press('Home'); await canvas.press('ArrowDown');
    await expect.poll(() => canvas.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
    await expect(canvas).toBeFocused();
    await heading.click({ button: 'right' });
    const copyMenu = page.getByRole('menuitem', { name: 'Copy context', exact: true });
    await expect(copyMenu).toBeVisible();
    expect(await copyMenu.evaluate(node => { const rect = node.getBoundingClientRect(); return rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight; })).toBe(true);
    await copyMenu.click();
    const copied = await page.evaluate(() => navigator.clipboard.readText()); expect(parse(copied).project.id).toBe(project.id);
    await expect(page.getByRole('status').filter({ hasText: 'Context copied' })).toBeVisible();
    await expect(page.locator('iframe')).toBeFocused();
    expect(parse(copied).observed.bounds).toEqual(payload.observed.bounds);
    expect(parse(copied).observed.viewport).toEqual({ width: 375, height: 812 });
    await page.getByRole('button', { name: 'Pan canvas', exact: true }).click();
    await expect(inspect).toHaveAttribute('aria-pressed', 'false');
    await inspect.click();
    await expect(page.getByRole('button', { name: 'Pan canvas', exact: true })).toHaveAttribute('aria-pressed', 'false');
    await page.getByRole('button', { name: 'Fit', exact: true }).click();
    await heading.click();
    const source = filesSchema.parse((await client.callTool({ name: 'project_inspect', arguments: { projectId: parse(copied).project.id, paths: ['app/index.tsx'] } })).structuredContent).files[0]!;
    // Rendered text spans JSX text nodes; use its distinctive sentence after inspecting actual source.
    const sentence = parse(copied).observed.visibleText.match(/A softer kind of day\./)?.[0];
    expect(sentence).toBeDefined(); expect(source.content).toContain(sentence!);
    const changed = source.content.replace(sentence!, 'A more compact day.');
    expect(changed).not.toBe(source.content);
    expect((await client.callTool({ name: 'project_write_files', arguments: { projectId: project.id, writes: [{ path: source.path, content: changed, expectedRevision: source.revision }] } })).isError).not.toBe(true);
    await expect(frame.getByText('A more compact day.', { exact: false })).toBeVisible({ timeout: 30_000 });
    // React may preserve the DOM node; when it does, the observation must update, not retain old copy.
    await expect(textarea).not.toContainText('A softer kind of day.');
    const capture = await client.callTool({ name: 'preview_capture', arguments: { projectId: project.id, route: parse(copied).observed.pathname, viewport: 'compact' } });
    expect(capture.isError).not.toBe(true);
    expect(z.object({ projectId: z.string(), route: z.string() }).parse(capture.structuredContent)).toEqual({ projectId: project.id, route: '/' });
    const image = z.array(z.object({ type: z.string(), data: z.string().optional() })).parse(capture.content).find(item => item.type === 'image');
    expect(image?.data).toBeDefined();
    const png = Buffer.from(image!.data!, 'base64');
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([375, 812]);
    await page.getByRole('button', { name: 'Reload preview' }).click();
    await expect(textarea).toHaveCount(0); await expect(inspect).toBeEnabled();
    await inspect.click(); await frame.getByText('A more compact day.', { exact: false }).click();
    await page.getByRole('button', { name: 'Preview context', exact: true }).click();
    await page.getByRole('button', { name: 'Select parent', exact: true }).click();
    await expect(textarea).toContainText('A more compact day.');
    await page.getByRole('button', { name: 'Assets', exact: true }).click();
    await page.getByRole('button', { name: 'Preview', exact: true }).click();
    await expect(textarea).toHaveCount(0);
    await inspect.click(); await frame.getByText('A more compact day.', { exact: false }).click();
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => Promise.reject(new Error('denied')) } }));
    await frame.getByText('A more compact day.', { exact: false }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Copy context', exact: true }).click();
    await expect(page.getByText('Clipboard unavailable.', { exact: false })).toBeVisible(); await expect(textarea).toBeFocused();
    await page.getByRole('button', { name: 'Stop preview' }).click(); await expect(textarea).toHaveCount(0);
  } finally { await client.close(); await server.close(); await studio.close(); await engine.close(); await rm(dir, { recursive: true, force: true }); }
});

const fixture = `import { useState } from 'react';
import { Text, View } from 'react-native';
import { Link } from 'expo-router';
export default function InspectionFixture() {
  const [count, setCount] = useState(0);
  return <View style={{padding: 20, gap: 10}}>
    <Text accessibilityRole="header" testID="fixture-title">Inspection station</Text>
    <div id="nested-card" style={{padding: 12, border: '1px solid gray'}}>
      <h2 data-testid="nested-title" data-builder-source="app/inspection.tsx" data-builder-component="InspectionFixture">Nested card</h2>
      <button onClick={() => setCount(count + 1)}>Action {count}</button>
      <input aria-label="Public input" defaultValue="INPUT_SECRET" />
      <input type="password" defaultValue="PASSWORD_SECRET" />
      <textarea defaultValue="TEXTAREA_SECRET" />
      <div contentEditable suppressContentEditableWarning>EDIT_SECRET</div>
      <p data-builder-private>PRIVATE_SECRET</p>
      <img alt="Survey forest" width="40" height="40" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==" />
      <p>{'Script-like: <script>alert(1)</script> \u0060\u0060\u0060'}</p>
    </div>
    <Link href="/progress">Open progress</Link>
  </View>;
}`;

test('existing project: explicit setup, privacy, events, security, keyboard, responsive menu and lifecycle', async ({ page }) => {
  test.setTimeout(90_000);
  const dir = await mkdtemp(path.join(os.tmpdir(), 'builder-inspect-legacy-'));
  const engine = new Engine(await Projects.open(path.join(dir, 'apps'), path.join(dir, 'home')), true);
  const project = await engine.projects.create({ name: 'Inspect Legacy', slug: 'inspect-legacy' });
  const second = await engine.projects.create({ name: 'Inspect Other', slug: 'inspect-other' });
  const layout = await engine.files.read(project.id, 'app/_layout.tsx');
  const legacyLayout = layout.content.replace(/\n\/\/ Mobile App Builder: development-only preview inspection\nimport '[^']+';\n$/, '\n');
  await engine.files.write(project.id, [{ path: layout.path, content: legacyLayout, expectedRevision: layout.revision }, { path: 'app/inspection.tsx', content: fixture, expectedRevision: null }]);
  for (const file of ['src/builder-inspector.tsx', 'src/builder-inspector.web.tsx']) await rm(path.join(project.root, file));
  const studio = await startStudio(engine, path.resolve('dist/studio'));
  try {
    await page.addInitScript(() => {
      const messages: string[] = []; Object.assign(window, { inspectorCommands: messages });
      window.addEventListener('message', event => { if (typeof event.data === 'string' && event.data.includes('builder-inspector')) messages.push(event.data); });
    });
    await page.goto(studio.launchUrl); await selectProject(page, project.id);
    await page.getByRole('button', { name: 'Start preview' }).click();
    await expect(page.getByRole('button', { name: 'Stop preview' })).toBeVisible({ timeout: 180_000 });
    await page.getByRole('button', { name: 'Review inspection setup' }).click();
    const dialog = page.getByRole('dialog', { name: 'Review inspection setup' });
    await expect(dialog).toBeVisible(); await expect(dialog.getByText('src/builder-inspector.web.tsx', { exact: true })).toBeVisible();
    expect(await readFile(path.join(project.root, layout.path), 'utf8')).toBe(legacyLayout);
    await expect(dialog.getByRole('button', { name: 'Apply inspection setup' })).toBeDisabled();
    // A stale, explicitly reviewed proposal never clobbers intervening edits.
    const current = await engine.files.read(project.id, layout.path);
    await engine.files.write(project.id, [{ path: layout.path, content: current.content + '// concurrent edit\n', expectedRevision: current.revision }]);
    await dialog.getByRole('checkbox').check(); await dialog.getByRole('button', { name: 'Apply inspection setup' }).click();
    await expect(page.getByRole('alert')).toContainText('Setup changed');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('button', { name: 'Review inspection setup' }).click();
    await dialog.getByRole('checkbox').check(); await dialog.getByRole('button', { name: 'Apply inspection setup' }).click();
    await expect(dialog).toHaveCount(0);
    const inspect = page.getByRole('button', { name: 'Inspect', exact: true }); await expect(inspect).toBeEnabled({ timeout: 30_000 });
    await openProjectRoutes(page); await page.getByLabel('Agent-added screen').fill('/inspection'); await page.getByLabel('Agent-added screen').press('Enter');
    const frame = page.frameLocator('iframe'), nested = frame.getByTestId('nested-title');
    await expect(nested).toBeVisible(); await expect(inspect).toBeEnabled();
    await inspect.click(); await frame.getByRole('button', { name: 'Action 0' }).click();
    await expect(frame.getByRole('button', { name: 'Action 0' })).toBeVisible();
    await page.getByRole('button', { name: 'Preview context', exact: true }).click();
    await page.getByRole('button', { name: 'Select parent', exact: true }).click();
    const textarea = page.getByLabel('Copyable context');
    await expect(textarea).toContainText('Nested card');
    const parentText = await textarea.inputValue();
    for (const secret of ['INPUT_SECRET', 'PASSWORD_SECRET', 'TEXTAREA_SECRET', 'EDIT_SECRET', 'PRIVATE_SECRET', 'data:image']) expect(parentText).not.toContain(secret);
    expect(parentText).not.toContain('<script>'); expect(parse(parentText).observed.visibleText).toContain('<script>');
    await page.getByRole('button', { name: 'Close preview context' }).click();
    await nested.click(); await expect.poll(async () => parse(await textarea.inputValue()).observed.source).toEqual({ status: 'app-declared, unverified', path: 'app/inspection.tsx', component: 'InspectionFixture' });
    await frame.getByAltText('Survey forest').click(); await expect(textarea).toHaveValue(/Survey forest/);
    // Shape, sender, origin and generation are independent validation boundaries.
    await nested.click(); await expect(textarea).toContainText('Nested card');
    const valid = parse(await textarea.inputValue()).observed;
    const child = page.frames().find(item => item.url().includes('/inspection'))!;
    const commands = await child.evaluate(() => (window as unknown as { inspectorCommands: string[] }).inspectorCommands.map(item => JSON.parse(item)));
    expect(commands.length).toBeGreaterThan(0);
    for (const item of commands) expect(Object.keys(item).sort()).toEqual(['nonce', 'protocol', 'type', 'version']);
    const nonce = commands.at(-1).nonce;
    const attack = { protocol: 'builder-inspector', version: 1, nonce, type: 'selection', selection: { ...valid, visibleText: 'FORGED_SELECTION' } };
    await child.evaluate(({ attack, origin }) => {
      for (const data of [JSON.stringify({ ...attack, nonce: crypto.randomUUID() }), JSON.stringify({ ...attack, version: 99 }), JSON.stringify({ ...attack, project: { id: 'attacker' } }), JSON.stringify({ ...attack, selection: { ...attack.selection, visibleText: 'x'.repeat(40000) } }), '{malformed', attack]) window.parent.postMessage(data, origin);
    }, { attack, origin: studio.origin });
    await page.evaluate(({ attack, origin }) => {
      window.postMessage(JSON.stringify(attack), origin);
      window.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(attack), origin: 'http://localhost:1', source: document.querySelector('iframe')!.contentWindow }));
    }, { attack, origin: studio.origin });
    await page.waitForTimeout(300); await expect(textarea).not.toContainText('FORGED_SELECTION');
    // Detached DOM nodes and actual in-app paths invalidate the current selection.
    await child.evaluate(() => document.querySelector('[data-testid="nested-title"]')!.remove());
    await expect(textarea).toHaveValue('');
    await frame.getByTestId('fixture-title').click();
    await child.evaluate(() => history.pushState({}, '', '/observed-path?QUERY_SECRET#HASH_SECRET'));
    await expect(textarea).toHaveValue(''); await frame.getByTestId('fixture-title').click();
    await expect(textarea).toContainText('/observed-path'); expect(await textarea.inputValue()).not.toMatch(/QUERY_SECRET|HASH_SECRET/);
    await inspect.click(); await frame.getByRole('button', { name: 'Action 0' }).click(); await expect(frame.getByRole('button', { name: 'Action 1' })).toBeVisible();
    await frame.getByRole('textbox', { name: 'Public input' }).fill('Typed input stays private');
    await expect(frame.getByRole('textbox', { name: 'Public input' })).toHaveValue('Typed input stays private');
    await child.evaluate(() => window.addEventListener('contextmenu', event => { document.body.dataset.normalContext = String(!event.defaultPrevented); }, { once: true }));
    await frame.getByTestId('fixture-title').click({ button: 'right' }); expect(await child.locator('body').getAttribute('data-normal-context')).toBe('true');
    await inspect.click(); await expect(frame.locator('[data-builder-inspector-overlay]')).toHaveCount(1);
    await page.keyboard.press('ArrowDown');
    await expect(textarea).not.toHaveValue('');
    await page.keyboard.press('Shift+F10'); await expect(page.getByRole('menu')).toBeVisible();
    await page.keyboard.press('Escape'); await expect(page.getByRole('menu')).toHaveCount(0); await expect(inspect).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('Escape'); await expect(inspect).toHaveAttribute('aria-pressed', 'false'); await expect(inspect).toBeFocused();
    for (const width of [375, 768, 1440]) {
      await page.setViewportSize({ width, height: 1100 });
      for (const device of ['Compact phone', 'Large phone']) {
        await page.getByRole('button', { name: device }).click(); await inspect.click();
        const title = frame.getByTestId('fixture-title'); await title.click({ button: 'right' });
        const menu = page.getByRole('menu'); await expect(menu).toBeVisible();
        const r = await menu.boundingBox(); expect(r!.x).toBeGreaterThanOrEqual(0); expect(r!.x + r!.width).toBeLessThanOrEqual(width); expect(r!.y + r!.height).toBeLessThanOrEqual(1100);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await page.keyboard.press('Escape'); await expect(menu).toHaveCount(0);
        await page.keyboard.press('Escape'); await expect(inspect).toHaveAttribute('aria-pressed', 'false');
      }
    }
    await page.evaluate(() => { document.body.style.zoom = '2'; });
    await inspect.click(); await expect(frame.locator('[data-builder-inspector-overlay]')).toHaveCount(1);
    await frame.getByTestId('fixture-title').scrollIntoViewIfNeeded();
    // Use actual screen coordinates for a CSS-zoomed cross-origin iframe.
    const anchor = await child.evaluate(() => { const r = document.querySelector('[data-testid="fixture-title"]')!.getBoundingClientRect(); return { x: (r.x + r.width / 2) / innerWidth, y: (r.y + r.height / 2) / innerHeight }; });
    const iframeRect = await page.locator('iframe').boundingBox();
    await page.mouse.click(iframeRect!.x + anchor.x * iframeRect!.width, iframeRect!.y + anchor.y * iframeRect!.height, { button: 'right' });
    await expect(page.getByRole('menu')).toBeVisible();
    const zoomMenu = await page.getByRole('menu').boundingBox(); expect(zoomMenu!.x + zoomMenu!.width).toBeLessThanOrEqual(1440);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.keyboard.press('Escape'); await page.keyboard.press('Escape'); await page.evaluate(() => { document.body.style.zoom = ''; });
    await inspect.click(); await frame.getByTestId('fixture-title').click();
    await selectProject(page, second.id); await expect(textarea).toHaveCount(0);
    await selectProject(page, project.id); await expect(textarea).toHaveCount(0);
  } finally { await studio.close(); await engine.close(); await rm(dir, { recursive: true, force: true }); }
});

test.describe('touch inspection', () => {
  test.use({ hasTouch: true, viewport: { width: 375, height: 1100 } });
  test('tap selects without activating, panel copies, scrolling works and exit restores taps', async ({ page, context }) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'builder-inspect-touch-'));
    const engine = new Engine(await Projects.open(path.join(dir, 'apps'), path.join(dir, 'home')), true);
    const project = await engine.projects.create({ name: 'Inspect Touch', slug: 'inspect-touch' });
    await engine.files.write(project.id, [{ path: 'app/inspection.tsx', content: fixture, expectedRevision: null }]);
    const studio = await startStudio(engine, path.resolve('dist/studio'));
    try {
      await page.goto(studio.launchUrl); await page.getByRole('button', { name: 'Start preview' }).tap();
      await expect(page.frameLocator('iframe').getByText('A softer kind of day.', { exact: false })).toBeVisible({ timeout: 180_000 });
      await openProjectRoutes(page); await page.getByLabel('Agent-added screen').fill('/inspection'); await page.getByLabel('Agent-added screen').press('Enter');
      const frame = page.frameLocator('iframe'), inspect = page.getByRole('button', { name: 'Inspect', exact: true });
      await expect(frame.getByRole('button', { name: 'Action 0' })).toBeVisible(); await expect(inspect).toBeEnabled();
      await inspect.tap(); await expect(frame.locator('[data-builder-inspector-overlay]')).toHaveCount(1);
      await frame.getByRole('button', { name: 'Action 0' }).tap();
      const textarea = page.getByLabel('Copyable context'); await expect(textarea).toContainText('Action 0');
      await expect(frame.getByRole('button', { name: 'Action 0' })).toBeVisible();
      const observed = parse(await textarea.inputValue()).observed;
      expect(observed.element.tag).toBe('button');
      const highlight = await frame.locator('[data-builder-inspector-overlay]').evaluate(el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; });
      expect(highlight).toEqual(observed.bounds);
      await page.getByRole('button', { name: 'Preview context', exact: true }).tap();
      await page.getByRole('button', { name: 'Select parent', exact: true }).tap(); await expect(textarea).toContainText('Nested card');
      await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: studio.origin });
      await page.getByRole('button', { name: 'Copy context', exact: true }).tap();
      expect(parse(await page.evaluate(() => navigator.clipboard.readText())).project.id).toBe(project.id);
      await page.getByRole('button', { name: 'Close preview context' }).tap();
      const child = page.frames().find(item => item.url().includes('/inspection'))!;
      await child.evaluate(() => { document.body.style.height = '2400px'; document.body.style.overflow = 'auto'; });
      await page.locator('iframe').scrollIntoViewIfNeeded();
      const rect = await page.locator('iframe').boundingBox();
      const cdp = await context.newCDPSession(page);
      await cdp.send('Input.synthesizeScrollGesture', { x: rect!.x + rect!.width / 2, y: Math.min(950, rect!.y + rect!.height / 2), yDistance: -180, gestureSourceType: 'touch' });
      await expect.poll(() => child.evaluate(() => scrollY)).toBeGreaterThan(0); await cdp.detach();
      await inspect.tap(); await expect(frame.locator('[data-builder-inspector-overlay]')).toHaveCount(0);
      await frame.getByRole('button', { name: 'Action 0' }).tap(); await expect(frame.getByRole('button', { name: 'Action 1' })).toBeVisible();
      await expect(textarea).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    } finally { await studio.close(); await engine.close(); await rm(dir, { recursive: true, force: true }); }
  });
});
