import { openProjectRoutes } from './preview-actions.js';
import { test, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Engine } from '../../packages/core/src/engine.js';
import { Projects } from '../../packages/core/src/projects.js';
import { startStudio } from '../../packages/cli/src/studio-server.js';
import { selectProject } from './project-picker.js';

test.use({ trace: 'off' });
test.beforeEach(() => test.skip(!!process.env.VISUAL, 'Visual suite only'));

test('two routed views preserve siblings and target reload/capture; project memory isolates delayed actions', async ({ page }) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'studio-board-'));
  const engine = new Engine(await Projects.open(path.join(dir, 'apps'), path.join(dir, 'home')), false);
  const a = await engine.projects.create({ name: 'Board Alpha', slug: 'board-alpha' });
  const b = await engine.projects.create({ name: 'Board Beta', slug: 'board-beta' });
  const studio = await startStudio(engine, path.resolve('dist/studio'));
  const captures: unknown[] = [];
  let release: (() => void) | undefined;
  try {
    await page.route('**/*', route => route.request().isNavigationRequest() && route.request().frame().parentFrame() ? route.fulfill({ contentType: 'text/html', body: '<!doctype html><h1>Board app</h1><input aria-label="Draft"><div style="height:2000px">Scroll content</div><button style="position:fixed;bottom:0" onclick="this.textContent=\'Done\'">Bottom action</button>' }) : route.continue());
    engine.previews.status = projectId => ({ projectId, status: 'ready', url: studio.origin.replace('127.0.0.1', 'localhost') });
    await page.route(`**/api/projects/${a.id}/capture`, async route => { captures.push(route.request().postDataJSON()); await new Promise<void>(resolve => { release = resolve; }); await route.fulfill({ status: 400, json: { error: { code: 'CAPTURE_FAILED', message: 'Delayed Alpha failure' } } }); });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(studio.launchUrl); await selectProject(page, a.id);
    const first = page.locator('[data-view-label="1"]'), second = page.locator('[data-view-label="2"]');
    await expect(first.frameLocator('iframe').getByRole('heading')).toBeVisible();
    const mounted = await first.locator('iframe').elementHandle();
    await first.frameLocator('iframe').getByLabel('Draft').fill('Sibling stays');
    await page.getByRole('button', { name: 'Compare', exact: true }).click();
    await page.getByRole('group', { name: 'Active comparison screen' }).getByRole('button').nth(1).click();
    await expect(page.getByRole('group', { name: 'Active comparison screen' }).getByRole('button').nth(1)).toHaveAttribute('aria-pressed', 'true');
    await expect(second.frameLocator('iframe').getByRole('heading')).toBeVisible();
    await expect(page.locator('iframe')).toHaveCount(2);
    await openProjectRoutes(page);
    await page.getByLabel('Agent-added screen').fill('/habit'); await page.getByLabel('Agent-added screen').press('Enter');
    await page.getByRole('button', { name: 'Large phone', exact: true }).click();
    await expect(second.locator('iframe')).toHaveAttribute('src', /\/habit$/);
    await expect.poll(() => second.locator('iframe').evaluate(el => [el.clientWidth, el.clientHeight])).toEqual([430, 932]);
    expect(await first.locator('iframe').evaluate(el => [el.clientWidth, el.clientHeight])).toEqual([375, 812]);
    await second.frameLocator('iframe').getByLabel('Draft').fill('Reload only me');
    await page.getByRole('button', { name: 'Reload preview', exact: true }).click();
    await expect(second.frameLocator('iframe').getByLabel('Draft')).toHaveValue('');
    await expect(first.frameLocator('iframe').getByLabel('Draft')).toHaveValue('Sibling stays');
    expect(await mounted!.evaluate(el => el.isConnected)).toBe(true);
    await page.getByRole('button', { name: 'Capture', exact: true }).click();
    await expect.poll(() => captures).toEqual([{ route: '/habit', viewport: 'large' }]);
    await selectProject(page, b.id);
    await expect(page.locator('iframe')).toHaveCount(1);
    release!();
    await expect(page.getByRole('button', { name: 'Capture', exact: true })).toBeEnabled();
    await expect(page.getByText('Delayed Alpha failure', { exact: true })).toHaveCount(0);
    await selectProject(page, a.id);
    await expect(page.locator('iframe')).toHaveCount(2);
    await expect(second.locator('iframe')).toHaveAttribute('src', /\/habit$/);
    await expect(page.getByRole('group', { name: 'Active comparison screen' }).getByRole('button').nth(1)).toHaveAttribute('aria-pressed', 'true');
    const sibling = await first.locator('iframe').elementHandle();
    await page.getByRole('group', { name: 'Active comparison screen' }).getByRole('button').nth(0).click();
    await expect(page.getByRole('group', { name: 'Active comparison screen' }).getByRole('button').nth(0)).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: 'Focus', exact: true }).click();
    expect(await sibling!.evaluate(el => el.isConnected)).toBe(true);
    await expect(page.getByRole('button', { name: 'Focus', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('iframe')).toHaveCount(1);
  } finally { release?.(); await page.unrouteAll({ behavior: 'wait' }); await page.close(); await studio.close(); await engine.close(); await rm(dir, { recursive: true, force: true }); }
});

test('shared Fit all, focus, wheel and responsive bounds retain exact mixed phone sizes', async ({ page }, info) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'studio-board-layout-'));
  const engine = new Engine(await Projects.open(path.join(dir, 'apps'), path.join(dir, 'home')), false);
  await engine.projects.create({ name: 'Board Layout', slug: 'board-layout' });
  const studio = await startStudio(engine, path.resolve('dist/studio'));
  try {
    await page.route('**/*', route => route.request().isNavigationRequest() && route.request().frame().parentFrame() ? route.fulfill({ contentType: 'text/html', body: '<!doctype html><h1>Board layout</h1><div style="height:2000px">Scroll content</div><button style="position:fixed;bottom:0" onclick="this.textContent=\'Done\'">Bottom action</button>' }) : route.continue());
    engine.previews.status = projectId => ({ projectId, status: 'ready', url: studio.origin.replace('127.0.0.1', 'localhost') });
    await page.goto(studio.launchUrl);
    await expect(page.locator('iframe')).toHaveCount(1);
    const mounted = await page.locator('iframe').elementHandle();
    await page.getByRole('button', { name: 'Compare', exact: true }).click();
    await page.getByRole('group', { name: 'Active comparison screen' }).getByRole('button').nth(1).click();
    await expect(page.getByRole('group', { name: 'Active comparison screen' }).getByRole('button').nth(1)).toHaveAttribute('aria-pressed', 'true');
    const compact = page.getByRole('button', { name: 'Compact phone', exact: true });
    const large = page.getByRole('button', { name: 'Large phone', exact: true });
    await expect(compact).toHaveText('Compact375 × 812');
    await expect(large).toHaveText('Large430 × 932');
    await large.click();
    await expect(large).toHaveAttribute('aria-pressed', 'true');
    await compact.focus();
    await page.keyboard.press('Enter');
    await expect(compact).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => page.locator('iframe').evaluateAll(els => els.map(el => [el.clientWidth, el.clientHeight]))).toEqual([[375, 812], [375, 812]]);
    await large.focus();
    await page.keyboard.press('Space');
    await expect(large).toHaveAttribute('aria-pressed', 'true');
    await expect(compact).toHaveAttribute('aria-pressed', 'false');
    const area = page.getByRole('region', { name: 'Phone preview canvas' });
    for (const width of [320, 375, 430, 768, 1280, 1440]) for (const zoom of [1, 2]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.evaluate(value => { document.documentElement.style.zoom = String(value); }, zoom);
      await page.getByRole('button', { name: 'Fit all', exact: true }).click();
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
      expect(await page.locator('iframe').evaluateAll(els => els.map(el => [el.clientWidth, el.clientHeight]))).toEqual([[375, 812], [430, 932]]);
      for (const choice of [compact, large]) {
        if (width <= 760) await expect(choice.locator('small')).toBeVisible();
        else { await expect(choice.locator('small')).toBeHidden(); await expect(choice).toHaveAttribute('title', /375 × 812|430 × 932/); }
        expect(await choice.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
        const bounds = await choice.boundingBox();
        expect(bounds!.width).toBeGreaterThanOrEqual(44);
        expect(bounds!.height).toBeGreaterThanOrEqual(width <= 760 ? 44 : 32);
      }
      await expect.poll(() => area.evaluate(el => { const a = el.getBoundingClientRect(), board = el.querySelector('.device-fit')!.getBoundingClientRect(); return (board.width <= a.width && board.height <= a.height) || !!document.querySelector('.canvas-hint[role=status]'); })).toBe(true);
      await page.getByRole('button', { name: 'Focus active view', exact: true }).click();
      await expect.poll(() => area.evaluate(el => { const a = el.getBoundingClientRect(), phone = el.querySelector('[data-active=true] .device')!.getBoundingClientRect(); return Math.abs((phone.left + phone.right - a.left - a.right) / 2) < 3; })).toBe(true);
      if ([375, 430, 1440].includes(width)) await page.screenshot({ path: info.outputPath(`board-${width}-${zoom}.png`), fullPage: true });
    }
    expect(await mounted!.evaluate(el => el.isConnected)).toBe(true);
    await page.evaluate(() => { document.documentElement.style.zoom = ''; });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole('button', { name: 'Fit all', exact: true }).click();
    await expect(page.locator('.preview-phones')).toHaveAttribute('data-vertical', 'false');
    const box = await area.boundingBox();
    const before = await page.getByRole('status', { name: 'Canvas zoom level' }).textContent();
    const background = { x: box!.x + 15, y: box!.y + box!.height / 2 };
    expect(await page.evaluate(({ x, y }) => !!document.elementFromPoint(x, y)?.closest('.device-area'), background)).toBe(true);
    await page.mouse.move(background.x, background.y); await page.keyboard.down('Control'); await page.mouse.wheel(0, -100); await page.keyboard.up('Control');
    await expect(page.getByRole('status', { name: 'Canvas zoom level' })).not.toHaveText(before!);
    await page.getByRole('button', { name: 'Focus active view', exact: true }).click();
    const frame = page.locator('[data-view-label="2"]').frameLocator('iframe');
    await frame.getByRole('button', { name: 'Bottom action' }).click(); await expect(frame.getByRole('button', { name: 'Done', exact: true })).toBeVisible();
  } finally { await studio.close(); await engine.close(); await rm(dir, { recursive: true, force: true }); }
});

test('real shared runtime: active-only Inspector rejects sibling/late messages, copy and setup results', async ({ page }) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'studio-board-inspector-'));
  const engine = new Engine(await Projects.open(path.join(dir, 'apps'), path.join(dir, 'home')), true);
  const project = await engine.projects.create({ name: 'Board Inspect', slug: 'board-inspect' });
  const fixture = 'export default function BoardFixture() { return <div style={{padding:20}}><h1>Shared revision one</h1><input aria-label="Private draft" defaultValue="EXCLUDED_VALUE"/><button>App action</button></div>; }';
  await engine.files.write(project.id, [{ path: 'src/board-fixture.tsx', content: fixture, expectedRevision: null }, ...['board-a', 'board-b'].map(name => ({ path: `app/${name}.tsx`, content: "export { default } from '../src/board-fixture';", expectedRevision: null }))]);
  const studio = await startStudio(engine, path.resolve('dist/studio'));
  let releaseSetup: (() => void) | undefined;
  try {
    await page.addInitScript(() => {
      Object.assign(window, { boardMessages: [] });
      window.addEventListener('message', event => {
        if (typeof event.data === 'string' && event.data.includes('builder-inspector')) Reflect.get(window, 'boardMessages').push(event.data);
      });
    });
    await page.setViewportSize({ width: 1440, height: 1000 }); await page.goto(studio.launchUrl);
    await page.getByRole('button', { name: 'Start preview', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Stop preview', exact: true })).toBeVisible({ timeout: 180_000 });
    await openProjectRoutes(page);
    await page.getByLabel('Agent-added screen').fill('/board-a'); await page.getByLabel('Agent-added screen').press('Enter');
    const first = page.locator('[data-view-label="1"]'), second = page.locator('[data-view-label="2"]');
    const frameA = first.frameLocator('iframe'), frameB = second.frameLocator('iframe');
    await expect(frameA.getByRole('heading', { name: 'Shared revision one' })).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'Project routes', exact: true })).toHaveCount(0);
    const preview = engine.previews.status(project.id);
    await page.getByRole('button', { name: 'Compare', exact: true }).click();
    await page.getByRole('group', { name: 'Active comparison screen' }).getByRole('button').nth(1).click();
    await expect(page.getByRole('group', { name: 'Active comparison screen' }).getByRole('button').nth(1)).toHaveAttribute('aria-pressed', 'true');
    await openProjectRoutes(page);
    await page.getByLabel('Agent-added screen').fill('/board-b'); await page.getByLabel('Agent-added screen').press('Enter');
    await expect(page.getByRole('dialog', { name: 'Project routes', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Large phone', exact: true }).click();
    await expect(frameB.getByRole('heading', { name: 'Shared revision one' })).toBeVisible();
    const nodeA = await first.locator('iframe').elementHandle(), nodeB = await second.locator('iframe').elementHandle();
    const inspect = page.getByRole('button', { name: 'Inspect', exact: true });
    await expect(inspect).toBeEnabled(); await inspect.click();
    await frameB.getByRole('heading').click();
    await page.getByRole('button', { name: 'Preview context', exact: true }).click();
    const text = page.getByLabel('Copyable context');
    await expect(text).toContainText('/board-b');
    expect(await text.inputValue()).not.toContain('EXCLUDED_VALUE');
    const bSelection = await page.evaluate(() => Reflect.get(window, 'boardMessages').filter((raw: string) => JSON.parse(raw).type === 'selection').at(-1));
    expect(typeof bSelection).toBe('string');
    // A sibling uses the valid active nonce/payload but the wrong source Window.
    const siblingFrame = await nodeA!.contentFrame();
    const beforeSpoof = await text.inputValue();
    await siblingFrame!.evaluate(async raw => { const spoof = JSON.parse(raw); spoof.selection.visibleText = 'SIBLING SPOOF'; parent.postMessage(JSON.stringify(spoof), '*'); await new Promise(resolve => setTimeout(resolve, 100)); }, bSelection);
    await expect(text).toHaveValue(beforeSpoof);
    await page.getByRole('group', { name: 'Active comparison screen' }).getByRole('button').nth(0).click();
    await expect(page.getByRole('group', { name: 'Active comparison screen' }).getByRole('button').nth(0)).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('region', { name: 'Selected preview context' })).toHaveCount(0);
    await expect(inspect).toHaveAttribute('aria-pressed', 'false');
    await expect(frameB.locator('[data-builder-inspector-overlay]')).toHaveCount(0);
    await expect(inspect).toBeEnabled(); await inspect.click(); await frameA.getByRole('heading').click();
    await page.getByRole('button', { name: 'Preview context', exact: true }).click();
    await expect(text).toContainText('/board-a');
    const currentText = await text.inputValue();
    const inactiveFrame = await nodeB!.contentFrame();
    await inactiveFrame!.evaluate(raw => parent.postMessage(raw, '*'), bSelection);
    await expect(text).toHaveValue(currentText);
    // Clipboard completion after changing the active phone cannot reopen or focus old context.
    await page.evaluate(() => { Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: () => new Promise<void>((_resolve, reject) => { Object.assign(window, { finishBoardCopy: () => reject(new Error('Delayed clipboard denial')) }); }) }); });
    await page.getByRole('button', { name: 'Copy context', exact: true }).click();
    await page.getByRole('group', { name: 'Active comparison screen' }).getByRole('button').nth(1).click();
    await expect(page.getByRole('group', { name: 'Active comparison screen' }).getByRole('button').nth(1)).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('group', { name: 'Active comparison screen' }).getByRole('button').nth(1)).toHaveAttribute('aria-pressed', 'true');
    await page.evaluate(() => Reflect.get(window, 'finishBoardCopy')());
    await expect(page.getByRole('group', { name: 'Active comparison screen' }).getByRole('button').nth(1)).toBeFocused();
    await expect(page.getByRole('region', { name: 'Selected preview context' })).toHaveCount(0);
    await expect(inspect).toBeEnabled(); await inspect.click(); await frameB.getByRole('heading').click();
    await inspect.click();
    await expect(inspect).toHaveAttribute('aria-pressed', 'false');
    await expect(frameB.locator('[data-builder-inspector-overlay]')).toHaveCount(0);
    const shared = await engine.files.read(project.id, 'src/board-fixture.tsx');
    await engine.files.write(project.id, [{ path: shared.path, content: shared.content.replace('Shared revision one', 'Shared revision two'), expectedRevision: shared.revision }]);
    await expect(frameA.getByRole('heading', { name: 'Shared revision two' })).toBeVisible();
    await expect(frameB.getByRole('heading', { name: 'Shared revision two' })).toBeVisible();
    expect(await nodeA!.evaluate(el => el.isConnected)).toBe(true); expect(await nodeB!.evaluate(el => el.isConnected)).toBe(true);
    expect(engine.previews.status(project.id)).toEqual(preview);
    await page.getByRole('button', { name: 'Capture', exact: true }).click();
    await expect.poll(() => engine.captures.list(project.id).length).toBe(1);
    expect(engine.captures.list(project.id)[0]).toMatchObject({ route: '/board-b', width: 430, height: 932, rendering: 'React Native Web' });
    // Missing-bridge setup replies are bound to their originating active view.
    await page.route('**/board-a', route => route.fulfill({ contentType: 'text/html', body: '<h1>Legacy view</h1>' }));
    await page.getByRole('group', { name: 'Active comparison screen' }).getByRole('button').nth(0).click();
    await expect(page.getByRole('group', { name: 'Active comparison screen' }).getByRole('button').nth(0)).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: 'Reload preview', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Review inspection setup', exact: true })).toBeVisible({ timeout: 15_000 });
    await page.route(`**/api/projects/${project.id}/inspector/setup-preview`, async route => { const response = await route.fetch(); await new Promise<void>(resolve => { releaseSetup = resolve; }); await route.fulfill({ response }); });
    await page.getByRole('button', { name: 'Review inspection setup', exact: true }).click();
    await expect.poll(() => !!releaseSetup).toBe(true);
    await page.getByRole('group', { name: 'Active comparison screen' }).getByRole('button').nth(1).click();
    await expect(page.getByRole('group', { name: 'Active comparison screen' }).getByRole('button').nth(1)).toHaveAttribute('aria-pressed', 'true'); releaseSetup!();
    await expect(page.getByRole('button', { name: 'Capture', exact: true })).toBeEnabled();
    await expect(page.getByRole('dialog', { name: 'Review inspection setup' })).toHaveCount(0);
  } finally { releaseSetup?.(); await studio.close(); await engine.close(); await rm(dir, { recursive: true, force: true }); }
});
