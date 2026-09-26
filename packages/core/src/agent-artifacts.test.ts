import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { AgentArtifacts } from './agent-artifacts.js';
it('chunks downloads and enforces project ownership, expiry and account invalidation', () => {
  let context = 'local'; const artifacts = new AgentArtifacts(() => context), projectId = randomUUID();
  const bytes = Buffer.alloc(5 * 1024 * 1024, 7);
  const download = artifacts.add(projectId, bytes, 'app.zip', 'application/zip');
  const id = download.resources[0]!.split('/')[5]!;
  expect(download.resources).toHaveLength(2);
  expect(Buffer.concat([artifacts.read(projectId, id, 0), artifacts.read(projectId, id, 1)])).toEqual(bytes);
  expect(() => artifacts.read(randomUUID(), id, 0)).toThrow('does not belong');
  expect(() => artifacts.read(projectId, id, 2)).toThrow('does not belong');
  context = 'other'; expect(() => artifacts.read(projectId, id, 0)).toThrow('expired');
  const next = artifacts.add(projectId, Buffer.from('one'), 'app.zip', 'application/zip');
  const time = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 16 * 60_000);
  try { expect(() => artifacts.read(projectId, next.resources[0]!.split('/')[5]!, 0)).toThrow('expired'); }
  finally { time.mockRestore(); }
});
