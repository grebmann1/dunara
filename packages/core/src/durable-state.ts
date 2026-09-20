import path from 'node:path';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

export type DurableStateRecord = { key: string; content: Uint8Array };
/** Protected home state. Hosts must encrypt values and bind authorization/ownership server-side. */
export interface HomeStatePersistence {
  load(): Promise<DurableStateRecord[]>;
  write(input: { mutationId: string; records: { key: string; content: Uint8Array | null }[] }): Promise<void>;
}
type Mount = { home: string; adapter: HomeStatePersistence; tail: Promise<void>; failure?: Error; closing: boolean };
// Explicit mounts are owned by runtime lifecycle, never ambient process credentials or caller IDs.
const mounts = new Map<string, Mount>();
export function stateKey(key: string) {
  return key.length <= 240 && key !== 'projects.json' && !key.includes('\\') && key.split('/').every(part => /^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/.test(part))
    && !/(?:^|\/)(?:node_modules|native-workspaces|native-deliveries)(?:\/|$)/.test(key)
    && !/\.(?:sqlite(?:-wal|-shm)?|sock|tmp)$/.test(key);
}
function mountFor(file: string) {
  for (const mount of mounts.values()) {
    const relative = path.relative(mount.home, file);
    if (relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) return mount;
  }
}
export function assertStateAvailable(file: string) { const mount = mountFor(file); if (mount?.failure) throw mount.failure; }
export function hasStatePersistence(file: string) { return !!mountFor(file); }

/** Restore before service constructors run. The project registry is hydrated by its separate contract. */
export async function mountHomeState(home: string, adapter: HomeStatePersistence) {
  home = path.resolve(home);
  if (mountFor(home) || [...mounts.keys()].some(other => other.startsWith(home + path.sep))) throw Error('Home state is already owned');
  const existing = await readdir(home);
  if (existing.some(name => name !== 'projects.json')) throw Error('Home state hydration requires an empty disposable cache');
  const records = await adapter.load(), keys = new Set<string>(); let bytes = 0;
  if (!Array.isArray(records) || records.length > 5000) throw Error('Home state record limit exceeded');
  for (const record of records) {
    if (!stateKey(record.key) || keys.has(record.key) || !(record.content instanceof Uint8Array) || record.content.byteLength > 16_000_000) throw Error('Invalid home state record');
    keys.add(record.key); bytes += record.content.byteLength;
    if (bytes > 128_000_000) throw Error('Home state byte limit exceeded');
  }
  for (const key of keys) {
    const parts = key.split('/'); for (let i = 1; i < parts.length; i++) if (keys.has(parts.slice(0, i).join('/'))) throw Error('Conflicting home state paths');
  }
  for (const record of records) {
    const file = path.join(home, record.key); await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file, record.content, { flag: 'wx', mode: 0o600 });
  }
  const mount: Mount = { home, adapter, tail: Promise.resolve(), closing: false }; mounts.set(home, mount);
  return async () => {
    mount.closing = true;
    try { await mount.tail; }
    finally { if (mounts.get(home) === mount) mounts.delete(home); }
  };
}

/** Synchronous stores stage an immutable value, then their service must await flushHomeState before acknowledging it. */
export function stageHomeState(file: string, content: Uint8Array | null): Promise<void> {
  return stageHomeStateBatch([{ file, content }]);
}
/** One atomic remote update for compound artifacts such as a launch kit and its manifest. */
export function stageHomeStateBatch(records: { file: string; content: Uint8Array | null }[]): Promise<void> {
  if (!records.length) return Promise.resolve();
  const mount = mountFor(records[0]!.file);
  if (!mount) { if (records.some(record => mountFor(record.file))) throw Error('Mixed home state ownership'); return Promise.resolve(); }
  if (mount.failure) throw mount.failure;
  if (mount.closing) throw Error('Home state is closing');
  let values: { key: string; content: Uint8Array | null }[];
  try {
  const keys = new Set<string>(); let bytes = 0;
  values = records.flatMap(({ file, content }) => {
    if (mountFor(file) !== mount) throw Error('Mixed home state ownership');
    const key = path.relative(mount.home, file).split(path.sep).join('/');
    if (key === 'projects.json') return [];
    if (!stateKey(key) || keys.has(key) || (content && content.byteLength > 16_000_000)) throw Error('Unsupported durable home state write');
    keys.add(key); bytes += content?.byteLength ?? 0;
    return [{ key, content: content === null ? null : Uint8Array.from(content) }];
  });
  if (!values.length) return Promise.resolve();
  if (values.length > 5000 || bytes > 128_000_000) throw Error('Home state batch limit exceeded');
  } catch { mount.failure = Error('Workspace state could not be saved. Reopen the workspace to recover saved state.'); throw mount.failure; }
  const input = { mutationId: randomUUID(), records: values };
  const result = mount.tail.then(async () => { if (mount.failure) throw mount.failure; await mount.adapter.write(input); });
  mount.tail = result.catch(() => { mount.failure = Error('Workspace state could not be saved. Reopen the workspace to recover saved state.'); throw mount.failure; });
  // A synchronous caller flushes later; prevent an unhandled rejection before that acknowledgment barrier.
  void mount.tail.catch(() => {});
  return mount.tail;
}
export async function flushHomeState(home: string) {
  const mount = mountFor(home); if (!mount) return;
  await mount.tail; if (mount.failure) throw mount.failure;
}
