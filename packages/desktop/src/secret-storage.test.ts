import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { desktopSecretProtection } from './secret-storage.js';
let home: string;
beforeEach(async () => { home = await mkdtemp(path.join(os.tmpdir(), 'desktop-protection-')); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });
// Deterministic adapter for storage decisions; actual Electron protection is qualified separately.
const storage = () => ({ isEncryptionAvailable: () => true, encryptString: (text: string) => Buffer.from(text.split('').reverse().join('')), decryptString: (bytes: Buffer) => bytes.toString().split('').reverse().join('') });
it('restores the wrapped key without exposing its plaintext in the settings envelope', async () => {
  const first = desktopSecretProtection(home, storage()); expect(first?.kind).toBe('os');
  expect(desktopSecretProtection(home, storage())).toEqual(first);
  expect(await readFile(path.join(home, 'credentials/desktop-protection.json'), 'utf8')).not.toContain(first!.key);
});
it('rejects unavailable and plaintext backends, and retains locked or malformed envelopes', async () => {
  expect(desktopSecretProtection(home, { ...storage(), isEncryptionAvailable: () => false })).toBeUndefined();
  expect(desktopSecretProtection(home, { ...storage(), getSelectedStorageBackend: () => 'basic_text' })).toBeUndefined();
  desktopSecretProtection(home, storage()); const file = path.join(home, 'credentials/desktop-protection.json'), before = await readFile(file, 'utf8');
  const encrypt = vi.fn(storage().encryptString);
  expect(desktopSecretProtection(home, { ...storage(), encryptString: encrypt, decryptString: () => { throw new Error('locked'); } })).toBeUndefined();
  expect(encrypt).not.toHaveBeenCalled(); expect(await readFile(file, 'utf8')).toBe(before);
  await writeFile(file, '{}'); expect(desktopSecretProtection(home, storage())).toBeUndefined(); expect(await readFile(file, 'utf8')).toBe('{}');
});
