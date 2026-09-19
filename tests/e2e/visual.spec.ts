import { test, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Engine } from '../../packages/core/src/engine.js';
import { Projects } from '../../packages/core/src/projects.js';
import { viewports } from '../../packages/core/src/capture.js';

test('all starter screens, presets, appearances and phone sizes', async ({ page }) => {
  test.skip(!process.env.VISUAL, 'Run separately with pnpm test:visual');
  test.setTimeout(360_000);
  const dir = await mkdtemp(path.join(os.tmpdir(), 'builder-visual-'));
  const engine = new Engine(await Projects.open(path.join(dir, 'apps'), path.join(dir, 'home')), true);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  try {
    const project = await engine.projects.create({ name: 'Daily Ritual', slug: 'daily-ritual' });
    const preview = await engine.previews.start(project.id);
    for (const preset of ['sage', 'clay', 'midnight'] as const) {
      for (const mode of ['light', 'dark'] as const) {
        const current = await engine.designs.read(project.id);
        const design = await engine.designs.apply(project.id, { expectedRevision: current.revision, preset, mode });
        for (const [size, viewport] of Object.entries(viewports)) {
          await page.setViewportSize(viewport);
          for (const [route, title] of [['/', 'A softer kind of day.'], ['/habit', 'to your breath.'], ['/progress', 'you’ve come.']]) {
            await page.goto(preview.url! + route);
            await expect(page.getByText(title!, { exact: false })).toBeVisible();
            // Verify Fast Refresh applied the new tokens before creating a baseline.
            await expect.poll(() => page.getByRole('link', { name: 'Today', exact: true }).evaluate(el => getComputedStyle(el.parentElement!).backgroundColor)).toBe(hexRgb(design.tokens.surface));
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
            const controls = page.getByRole('button').or(page.getByRole('link')).or(page.getByRole('textbox'));
            for (const control of await controls.all()) {
              await expect(control).toHaveAccessibleName(/.+/);
              const bounds = await control.boundingBox();
              expect(bounds).not.toBeNull();
              expect(bounds!.height, await control.getAttribute('aria-label') ?? 'control').toBeGreaterThanOrEqual(44);
              expect(bounds!.x).toBeGreaterThanOrEqual(0);
              expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width + 1);
            }
            await expect(page).toHaveScreenshot(`${preset}-${mode}-${size}-${route === '/' ? 'today' : route!.slice(1)}.png`, { animations: 'disabled', fullPage: true, maxDiffPixelRatio: 0.001 });
          }
        }
      }
    }
    expect(errors).toEqual([]);
  } finally { await engine.close(); await rm(dir, { recursive: true, force: true }); }
});
function hexRgb(hex: string) { return `rgb(${[1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)).join(', ')})`; }
