import { test, expect } from '@playwright/test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Engine } from '../../packages/core/src/engine.js';
import { Projects } from '../../packages/core/src/projects.js';
import { previewSchema } from '../../packages/core/src/contracts.js';
import { startStudio } from '../../packages/cli/src/studio-server.js';

// Bootstrap responses contain credentials; never retain network traces.
test.use({ trace: 'off' });
const titles = { '/': 'A softer kind of day.', '/habit': 'to your breath.', '/progress': 'you’ve come.' };
test('real Expo: studio, two projects, source refresh, design, MCP image, failures and cleanup', async ({ page, browser }, info) => {
  test.skip(!!process.env.VISUAL, 'Visual suite only');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'builder-e2e-'));
  const projects = await Projects.open(path.join(dir, 'apps'), path.join(dir, 'home'));
  const engine = new Engine(projects, true);
  const studio = await startStudio(engine, path.resolve('dist/studio'));
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  let client: Client | undefined;
  const urls: string[] = [];
  try {
    const first = await projects.create({ name: 'Daily rituals', slug: 'daily-rituals' });
    await engine.files.write(first.id, [{ path: 'app/accessibility-check.tsx', expectedRevision: null, content: `
import { useState } from 'react';
import { Button, Progress, Screen, Type } from '../src/ui';
export default function AccessibilityCheck() {
  const [presses, setPresses] = useState(0);
  return <Screen>
    <Type>Presses: {presses}</Type>
    <Button label="Disabled action" disabled onPress={() => setPresses(p => p + 1)} />
    <Button label="Loading action" loading onPress={() => setPresses(p => p + 1)} />
    <Progress label="Below range" value={-0.5} />
    <Progress label="Above range" value={1.5} />
  </Screen>;
}
` }]);
    const second = await projects.create({ name: 'Evening calm', slug: 'evening-calm', preset: 'clay' });
    await page.goto(studio.launchUrl);
    await expect(page.locator('.connection')).toHaveText('Local workspace');
    await page.getByRole('button', { name: 'Start preview' }).click();
    await expect(page.getByRole('button', { name: 'Stop preview' })).toBeVisible({ timeout: 180_000 });
    const frame = page.frameLocator('iframe');
    await expect(frame.getByText(/A softer kind of day/)).toBeVisible({ timeout: 60_000 });
    urls.push(engine.previews.status(first.id).url!);
    await expect(engine.previews.start(first.id)).resolves.toMatchObject({ url: urls[0] });
    const secondPreview = await engine.previews.start(second.id); urls.push(secondPreview.url!);
    expect(secondPreview.url).not.toBe(urls[0]);
    const third = await projects.create({ name: 'Limit check', slug: 'limit-check' });
    await expect(engine.previews.start(third.id)).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    const app = await browser.newPage({ viewport: { width: 375, height: 812 }, reducedMotion: 'reduce' });
    app.on('pageerror', error => errors.push(error.message));
    await app.goto(urls[0]!);
    const progress = app.getByRole('progressbar', { name: 'Daily rituals completed' });
    await expect(progress).toHaveAttribute('aria-valuemin', '0');
    await expect(progress).toHaveAttribute('aria-valuemax', '100');
    await expect(progress).toHaveAttribute('aria-valuenow', '33');
    for (const [route, title] of Object.entries(titles)) {
      await app.goto(urls[0]! + route);
      await expect(app.getByText(title, { exact: false })).toBeVisible();
      expect(await app.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const currentLabel = route === '/' ? 'Today' : route === '/habit' ? 'Ritual' : 'Progress';
      await expect(app.getByRole('link', { name: currentLabel, exact: true })).toHaveAttribute('aria-current', 'page');
      await expect(app.locator('[aria-current="page"]')).toHaveCount(1);
    }
    await app.getByRole('link', { name: 'Ritual', exact: true }).click();
    await app.getByRole('textbox', { name: 'TODAY’S INTENTION' }).fill('Make time for a little calm');
    await app.getByRole('button', { name: 'Mark ritual complete' }).click();
    await expect(app.getByRole('button', { name: 'Completed — undo' })).toBeVisible();
    await app.getByRole('link', { name: 'Today', exact: true }).click();
    await expect(app.getByText('2 of 3', { exact: true })).toBeVisible();
    await expect(progress).toHaveAttribute('aria-valuenow', '67');
    await expect(app.getByRole('link', { name: 'Today', exact: true })).toHaveAttribute('aria-current', 'page');
    await expect(app.getByRole('link', { name: 'Ritual', exact: true })).not.toHaveAttribute('aria-current', 'page');
    const source = await engine.files.read(first.id, 'app/index.tsx');
    await engine.files.write(first.id, [{ path: source.path, expectedRevision: source.revision, content: source.content.replace('A softer kind of day.', 'A calmer kind of day.') }]);
    await expect(app.getByText(/A calmer kind of day/)).toBeVisible({ timeout: 30_000 });
    await expect(frame.getByText(/A calmer kind of day/)).toBeVisible();
    await page.getByRole('button', { name: 'Design', exact: true }).click();
    await page.getByRole('button', { name: /clay/i }).click();
    await page.getByRole('button', { name: /Dark/ }).click();
    await expect.poll(async () => (await engine.designs.read(first.id)).mode).toBe('dark');
    await page.getByRole('button', { name: 'Capture', exact: true }).click();
    await expect.poll(() => engine.captures.list(first.id).length, { timeout: 60_000 }).toBe(1);
    await page.screenshot({ path: info.outputPath('studio.png'), fullPage: true });
    const independent = await browser.newPage();
    await independent.goto(secondPreview.url!);
    await expect(independent.getByText(/A softer kind of day/)).toBeVisible();
    expect(await engine.designs.read(second.id)).toMatchObject({ preset: 'clay', mode: 'light' });
    await app.goto(urls[0]! + '/accessibility-check');
    for (const label of ['Disabled action', 'Loading action']) {
      const button = app.getByRole('button', { name: label, exact: true });
      await expect(button).toBeDisabled();
      await expect(button).toHaveAttribute('aria-disabled', 'true');
      await expect(button).toHaveAttribute('aria-busy', String(label === 'Loading action'));
      await button.dispatchEvent('click');
    }
    await expect(app.getByText('Presses: 0', { exact: true })).toBeVisible();
    await expect(app.getByRole('progressbar', { name: 'Below range' })).toHaveAttribute('aria-valuenow', '0');
    await expect(app.getByRole('progressbar', { name: 'Above range' })).toHaveAttribute('aria-valuenow', '100');
    await expect(app.locator('[aria-current="page"]')).toHaveCount(0);
    await promisify(execFile)('npm', ['run', 'typecheck'], { cwd: first.root, timeout: 30_000 });
    await independent.close(); await app.close();
    await engine.previews.stop(first.id); await engine.previews.stop(second.id);

    const transport = new StdioClientTransport({ command: process.execPath, args: ['dist/packages/cli/src/index.js', '--workspace', projects.workspace, '--home', projects.home, '--trust-execution'], stderr: 'pipe' });
    client = new Client({ name: 'builder-e2e-client', version: '1' }); await client.connect(transport);
    expect((await client.listTools()).tools).toHaveLength(65);
    const started = await client.callTool({ name: 'preview_start', arguments: { projectId: first.id } }, undefined, { timeout: 180_000 });
    const mcpPreview = previewSchema.parse(started.structuredContent); urls.push(mcpPreview.url!);
    const result = await client.callTool({ name: 'preview_capture', arguments: { projectId: first.id, route: '/progress', viewport: 'large' } });
    const content = z.array(z.object({ type: z.string(), data: z.string().optional() }).passthrough()).parse(result.content);
    const image = content.find(c => c.type === 'image'); expect(image).toBeDefined();
    expect(Buffer.from(image!.data!, 'base64').subarray(1, 4).toString()).toBe('PNG');
    const meta = z.object({ uri: z.string() }).parse(result.structuredContent);
    expect((await client.readResource({ uri: meta.uri })).contents[0]?.mimeType).toBe('image/png');
    expect((await client.callTool({ name: 'project_diagnostics', arguments: { projectId: first.id } })).isError).not.toBe(true);
    const abort = new AbortController(); abort.abort();
    await expect(client.callTool({ name: 'preview_capture', arguments: { projectId: first.id } }, undefined, { signal: abort.signal })).rejects.toThrow();
    await client.callTool({ name: 'preview_stop', arguments: { projectId: first.id } });
    await client.close(); client = undefined;
    await writeFile(path.join(second.root, 'metro.config.js'), 'throw new Error("Intentional startup failure");');
    await expect(engine.previews.start(second.id)).rejects.toThrow();
    expect(engine.previews.status(second.id).status).toBe('failed');
    expect(engine.diagnostics.read(second.id).entries.some(e => e.message.includes('Intentional startup failure'))).toBe(true);
    expect(errors).toEqual([]);
  } finally { await client?.close(); await studio.close(); await engine.close(); await rm(dir, { recursive: true, force: true }); }
  for (const url of urls) await expect(fetch(url, { signal: AbortSignal.timeout(2000) })).rejects.toThrow();
});
