import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createBuilderRuntime } from './index.js';
import { Previews } from '../../core/src/preview.js';
import * as catalog from '../../builtin-plugins/src/catalog.js';

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function options() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'runtime-lifecycle-')); roots.push(root);
  return { workspace: path.join(root, 'apps'), home: path.join(root, 'home') };
}
it('closes an installed runtime once when concurrent hosts dispose it', async () => {
  const engine = await createBuilderRuntime(await options());
  const close = vi.spyOn(engine.previews, 'close');
  await Promise.all([engine.close(), engine.close(), engine.close()]);
  expect(close).toHaveBeenCalledTimes(1);
});
it('disposes the host preview driver if bundled plugin initialization fails', async () => {
  vi.spyOn(catalog, 'bundledPlugins').mockRejectedValue(Error('Broken distribution fixture'));
  const closed = vi.fn();
  await expect(createBuilderRuntime({ ...await options(), host: { previews: (environment, before, diagnostics, projects) => {
    const driver = new Previews(projects, diagnostics, false, false, environment, before);
    const close = driver.close.bind(driver); driver.close = async () => { closed(); await close(); };
    return driver;
  } } })).rejects.toThrow('Broken distribution fixture');
  expect(closed).toHaveBeenCalledTimes(1);
});
