import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { PlatformError } from './contracts.js';

export function canonical(value: unknown): string {
  const result = JSON.stringify(value, (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
  if (result === undefined) throw new PlatformError('INVALID_INPUT', 'A serializable value is required.');
  return result;
}
export function hash(value: unknown) { return createHash('sha256').update(canonical(value)).digest('hex'); }
export class SecretBox {
  private readonly key: Buffer;
  constructor(key: string) {
    if (!/^[a-fA-F0-9]{64}$/.test(key)) throw new PlatformError('CONFIGURATION_REQUIRED', 'Configure a 32-byte encryption key as 64 hexadecimal characters.');
    this.key = Buffer.from(key, 'hex');
  }
  seal(value: string, context: string) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(context));
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join('.');
  }
  open(value: string, context: string) {
    try {
      const [version, iv, tag, ciphertext, extra] = value.split('.');
      if (version !== 'v1' || !iv || !tag || !ciphertext || extra !== undefined) throw new Error();
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'));
      decipher.setAAD(Buffer.from(context)); decipher.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8');
    } catch { throw new PlatformError('CREDENTIAL_UNAVAILABLE', 'Encrypted configuration is unavailable or belongs to a different context. Restore the original encryption key; saved data was retained.'); }
  }
}
