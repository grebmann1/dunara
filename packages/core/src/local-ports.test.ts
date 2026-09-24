import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { localPort } from './local-ports.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
it('retains distinct app and Studio origins across allocation and refuses to replace an occupied origin', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'builder-local-ports-')); roots.push(home);
  const app = `preview-${randomUUID()}`, other = `preview-${randomUUID()}`;
  const ports = await Promise.all([localPort(home, app), localPort(home, other), localPort(home, 'studio')]);
  expect(new Set(ports).size).toBe(3);
  expect(await localPort(home, app)).toBe(ports[0]);
  const occupied = createServer();
  await new Promise<void>((resolve, reject) => { occupied.once('error', reject); occupied.listen(ports[0], '127.0.0.1', resolve); });
  try {
    await expect(localPort(home, app)).rejects.toMatchObject({ code: 'PREVIEW_NOT_READY', message: expect.stringContaining('address was kept') });
    expect(occupied.listening).toBe(true);
    expect(await localPort(home, other)).toBe(ports[1]);
  } finally { await new Promise<void>(resolve => occupied.close(() => resolve())); }
  expect(await localPort(home, app)).toBe(ports[0]);
  await expect(localPort(home, '__proto__')).rejects.toThrow();
});
