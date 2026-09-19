import { afterAll, beforeAll, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { chromium, type Browser, type Page } from 'playwright';
import { command, parseReply } from '../../../apps/studio/src/preview-context.js';

let browser: Browser, parent: Server, child: Server, page: Page, parentUrl: string, childUrl: string;
const nonce = '00000000-0000-4000-8000-000000000001';
const listen = (server: Server) => new Promise<string>(resolve => server.listen(0, '127.0.0.1', () => { const a = server.address(); if (a && typeof a !== 'string') resolve(`http://127.0.0.1:${a.port}`); }));
const send = async (type: Parameters<typeof command>[1]) => { await page.evaluate(({ message, origin }) => document.querySelector('iframe')!.contentWindow!.postMessage(message, origin), { message: command(nonce, type), origin: childUrl }); };
beforeAll(async () => {
  const source = await readFile('packages/templates/expo/src/builder-inspector.web.tsx', 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023 } }).outputText.replace('export {};', '');
  child = createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(`<div id="card"><h1>Survey station</h1><button onclick="this.textContent='ACTIVATED'">Start</button><input value="INPUT_SECRET"><textarea>TEXTAREA_SECRET</textarea><div contenteditable>EDIT_SECRET</div><div data-builder-private>PRIVATE_SECRET</div><img alt="A forest" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=="></div><script>var __DEV__=${req.url !== '/production'};${js}</script>`); });
  childUrl = await listen(child);
  parent = createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(`<iframe src="${childUrl}" width="375" height="812"></iframe><script>window.messages=[];addEventListener('message', e=>messages.push(e.data));</script>`); });
  parentUrl = await listen(parent);
  browser = await chromium.launch({ headless: true }); page = await browser.newPage();
});
afterAll(async () => { await browser?.close(); await Promise.all([parent, child].filter(Boolean).map(server => new Promise<void>(resolve => server.close(() => resolve())))); });
it('is inert standalone and in production; pins parent and reports only enabled selections', async () => {
  await page.goto(childUrl); expect(await page.evaluate(() => '__builderInspectorCleanup' in window)).toBe(false);
  await page.goto(parentUrl); const frame = page.frames()[1]!;
  await frame.waitForFunction(() => '__builderInspectorCleanup' in window);
  await send('init'); await expect.poll(async () => page.evaluate(() => (window as unknown as { messages: string[] }).messages.length)).toBe(1);
  await frame.locator('h1').click(); expect(await frame.locator('[data-builder-inspector-overlay]').count()).toBe(0);
  await send('enable'); await frame.locator('button').click(); expect(await frame.locator('button').textContent()).toBe('Start');
  await expect.poll(async () => { const data = await page.evaluate(() => (window as unknown as { messages: string[] }).messages.at(-1)); return parseReply(data, nonce)?.type; }).toBe('selection');
  await send('parent');
  await expect.poll(async () => { const data = await page.evaluate(() => (window as unknown as { messages: string[] }).messages.at(-1)); const parsed = parseReply(data, nonce); return parsed?.type === 'selection' ? parsed.selection.element.tag : ''; }).toBe('div');
  const messages = await page.evaluate(() => (window as unknown as { messages: string[] }).messages.join('\n'));
  expect(messages).toContain('Survey station'); for (const secret of ['INPUT_SECRET', 'TEXTAREA_SECRET', 'EDIT_SECRET', 'PRIVATE_SECRET', 'data:image']) expect(messages).not.toContain(secret);
  await frame.locator('h1').click({ button: 'right' });
  await expect.poll(async () => { const data = await page.evaluate(() => (window as unknown as { messages: string[] }).messages.at(-1)); return parseReply(data, nonce)?.type; }).toBe('context-menu');
  await frame.evaluate(() => history.pushState({}, '', '/changed?QUERY_SECRET#HASH_SECRET'));
  await expect.poll(async () => { const data = await page.evaluate(() => (window as unknown as { messages: string[] }).messages.at(-1)); return parseReply(data, nonce)?.type; }).toBe('clear');
  await send('disable'); await frame.locator('button').click(); expect(await frame.locator('button').textContent()).toBe('ACTIVATED');
  await frame.goto(childUrl + '/production'); expect(await frame.evaluate(() => '__builderInspectorCleanup' in window)).toBe(false);
});
it('bounds traversal including hidden nodes, and truncates oversized text nodes', async () => {
  await page.goto(parentUrl); const frame = page.frames()[1]!;
  await frame.waitForFunction(() => '__builderInspectorCleanup' in window);
  await send('init'); await send('enable');
  await frame.evaluate(() => {
    const card = document.querySelector('#card')!; card.replaceChildren('Bounded text');
    for (let i = 0; i < 1100; i++) { const span = document.createElement('span'); span.hidden = true; span.textContent = 'HIDDEN_SECRET'; card.append(span); }
    card.append('OUTSIDE_TRAVERSAL_BOUND');
  });
  await frame.locator('#card').click({ position: { x: 1, y: 1 } });
  const selection = async () => {
    const value = parseReply(await page.evaluate(() => (window as unknown as { messages: string[] }).messages.at(-1)), nonce);
    return value?.type === 'selection' ? value.selection : undefined;
  };
  await expect.poll(async () => (await selection())?.truncated).toBe(true);
  expect((await selection())?.visibleText).toBe('Bounded text');
  await frame.evaluate(() => { document.querySelector('#card')!.textContent = 'x'.repeat(100_000); });
  await expect.poll(async () => (await selection())?.visibleText).toBe('x'.repeat(500));
  expect((await selection())?.truncated).toBe(true);
  await send('disable');
});
