import { expect, it } from 'vitest';
import { recoveryKind, recoveryMessage } from './recovery.js';
it.each([
  [{ code: 401, message: 'private-token' }, 'sign-in'],
  [{ type: 'usageLimitExceeded' }, 'usage'],
  [new Error('fetch failed for private-url'), 'network'],
  [{ code: -32601, message: 'private-method' }, 'runtime'],
  [new Error('private unrecognized detail'), 'unknown'],
] as const)('gives safe actionable recovery for %j', (error, kind) => {
  expect(recoveryKind(error)).toBe(kind);
  const message = recoveryMessage(kind, 'ChatGPT image generation');
  expect(message).not.toContain('private'); expect(message.length).toBeLessThanOrEqual(300);
  expect(message).toContain('No automatic retry');
});
