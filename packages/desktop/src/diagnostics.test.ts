import { Writable } from 'node:stream';
import { setImmediate } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { diagnosticWriter } from './diagnostics.js';

it('survives a detached launcher pipe closing between backend starts', async () => {
  let calls = 0;
  const stream = new Writable({ write(_data, _encoding, callback) { calls++; callback(Object.assign(new Error('broken pipe'), { code: 'EPIPE' })); } });
  const log = diagnosticWriter(stream);
  log('first start\n'); await setImmediate();
  expect(() => log('restart\n')).not.toThrow(); expect(calls).toBe(1);
});
