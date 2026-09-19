import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { PrivateSettingsStore, type SecretProtection } from '../../core/src/credentials.js';

type SafeStorage = {
  isEncryptionAvailable(): boolean;
  getSelectedStorageBackend?(): string;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
};
/** Called in Electron main after ready. Only the wrapped master key lives on disk. */
export function desktopSecretProtection(home: string, storage: SafeStorage): SecretProtection | undefined {
  try {
    if (!storage.isEncryptionAvailable() || storage.getSelectedStorageBackend?.() === 'basic_text') return;
    const store = new PrivateSettingsStore(home, 'desktop-protection', z.object({ version: z.literal(1), wrapped: z.string().min(1).max(4096).regex(/^[A-Za-z0-9+/]+={0,2}$/) }).strict());
    const saved = store.load();
    if (saved) {
      const key = storage.decryptString(Buffer.from(saved.wrapped, 'base64'));
      if (!/^[a-f0-9]{64}$/.test(key)) return;
      return { kind: 'os', key };
    }
    const key = randomBytes(32).toString('hex'), wrapped = storage.encryptString(key);
    if (storage.decryptString(wrapped) !== key) return;
    store.save({ version: 1, wrapped: wrapped.toString('base64') });
    if (storage.decryptString(Buffer.from(store.load()!.wrapped, 'base64')) !== key) return;
    return { kind: 'os', key };
  } catch { return; } // Preserve locked/unsafe data; never regenerate a replacement key.
}
