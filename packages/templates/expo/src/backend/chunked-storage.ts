type Store = { getItemAsync(key: string): Promise<string | null>; setItemAsync(key: string, value: string): Promise<void>; deleteItemAsync(key: string): Promise<void> };
type Manifest = { generation: string; count: number };
function manifest(value: string | null): Manifest | null {
  if (!value) return null;
  try { const parsed = JSON.parse(value); return /^[a-z0-9-]+$/.test(parsed.generation) && Number.isInteger(parsed.count) && parsed.count > 0 && parsed.count <= 320 ? parsed : null; } catch { return null; }
}
/** Commit a small manifest last; partially written sessions are never returned to Auth. */
export function chunkedStorage(store: Store) {
  let queue = Promise.resolve();
  function serial<T>(action: () => Promise<T>) { const result = queue.then(action); queue = result.then(() => {}, () => {}); return result; }
  const chunkKey = (key: string, m: Manifest, i: number) => `${key}.${m.generation}.${i}`;
  async function clean(key: string, old: Manifest | null) { if (old) for (let i = 0; i < old.count; i++) await store.deleteItemAsync(chunkKey(key, old, i)).catch(() => {}); }
  return {
    getItem: (key: string) => serial(async () => { const m = manifest(await store.getItemAsync(key)); if (!m) return null; let value = ''; for (let i = 0; i < m.count; i++) { const chunk = await store.getItemAsync(chunkKey(key, m, i)); if (chunk === null) { await store.deleteItemAsync(key); await clean(key, m); return null; } value += chunk; } return value; }),
    setItem: (key: string, value: string) => serial(async () => {
      if (!value || value.length > 128_000) throw new Error('Account session exceeds secure storage limits.');
      // Split at code-point boundaries: separate UTF-8 writes must not split a surrogate pair.
      const characters = Array.from(value);
      const old = manifest(await store.getItemAsync(key)), next = { generation: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`, count: Math.ceil(characters.length / 400) };
      try { for (let i = 0; i < next.count; i++) await store.setItemAsync(chunkKey(key, next, i), characters.slice(i * 400, (i + 1) * 400).join('')); await store.setItemAsync(key, JSON.stringify(next)); }
      catch (error) { await clean(key, next); throw error; }
      await clean(key, old);
    }),
    removeItem: (key: string) => serial(async () => { const old = manifest(await store.getItemAsync(key)); await store.deleteItemAsync(key); await clean(key, old); }),
  };
}
