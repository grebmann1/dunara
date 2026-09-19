import { expect, it } from 'vitest';
import { chunkedStorage } from '../../templates/expo/src/backend/chunked-storage.js';
it('stores large native sessions in bounded chunks and preserves the old session on a failed update', async () => {
  const values = new Map<string, string>(); let fail = false;
  const storage = chunkedStorage({ async getItemAsync(key) { return values.get(key) ?? null; }, async setItemAsync(key, value) { if (fail && key.endsWith('.1')) throw new Error('Device storage full'); expect(Buffer.byteLength(value)).toBeLessThan(2048); values.set(key, Buffer.from(value, 'utf8').toString('utf8')); }, async deleteItemAsync(key) { values.delete(key); } });
  const original = 'x' + '🦊'.repeat(1500);
  await storage.setItem('session', original); expect(await storage.getItem('session')).toBe(original);
  fail = true; await expect(storage.setItem('session', 'new'.repeat(2000))).rejects.toThrow('Device storage full'); expect(await storage.getItem('session')).toBe(original);
  await storage.removeItem('session'); expect(values.size).toBe(0); expect(await storage.getItem('session')).toBeNull();
});
