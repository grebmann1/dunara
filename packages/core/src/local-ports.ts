import { z } from 'zod';
import { BuilderError } from './contracts.js';
import { PrivateSettingsStore } from './credentials.js';
import { freePort } from './processes.js';

const portSchema = z.number().int().min(1024).max(65535);
const slotSchema = z.string().regex(/^(?:studio|preview-[a-f0-9-]{36})$/);
const slotsSchema = z.record(slotSchema, portSchema).refine(slots => Object.keys(slots).length <= 4096 && new Set(Object.values(slots)).size === Object.keys(slots).length);
const pending = new Map<string, Promise<unknown>>();

/** Keep browser storage bound to the same app. Never silently replace an occupied saved origin. */
export async function localPort(home: string, slot: string): Promise<number> {
  slotSchema.parse(slot);
  const previous = pending.get(home) ?? Promise.resolve();
  const request = previous.catch(() => {}).then(async () => {
    const store = new PrivateSettingsStore(home, 'local-ports', slotsSchema, 512_000);
    const slots = store.load() ?? {};
    const saved = slots[slot];
    if (saved !== undefined) {
      try { return await freePort(saved); }
      catch { throw new BuilderError('PREVIEW_NOT_READY', `The saved local port ${saved} is in use. Close the other process using this port, then retry. The app address was kept to preserve saved browser data.`); }
    }
    const used = new Set(Object.values(slots));
    for (let attempt = 0; attempt < 100; attempt++) {
      const port = await freePort();
      if (used.has(port)) continue;
      store.save({ ...slots, [slot]: port });
      return port;
    }
    throw new BuilderError('PREVIEW_NOT_READY', 'A distinct local port could not be allocated. Try again.');
  });
  pending.set(home, request);
  try { return await request; }
  finally { if (pending.get(home) === request) pending.delete(home); }
}
