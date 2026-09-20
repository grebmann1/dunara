import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { mountHomeState, type HomeStatePersistence } from '../../core/src/durable-state.js';
import { PlatformStore } from './store.js';
import { SecretBox } from './crypto.js';
import type { Actor } from './contracts.js';
const dirs: string[] = [], stores: PlatformStore[] = [];
afterEach(async () => { for (const store of stores.splice(0)) store.close(); for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function setup(clock?: () => number) { const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'builder-platform-'))); dirs.push(dir); const store = new PlatformStore(dir, new SecretBox('ab'.repeat(32)), clock); stores.push(store); return { dir, store, actor: { id: 'owner', workspaceId: store.identity(), role: 'owner', source: 'local-owner' } as Actor }; }
const input = () => ({ projectId: randomUUID(), environment: 'development' as const, kind: 'backend_link', idempotencyKey: randomUUID(), plan: { projectRef: 'abcdefghijklmnopqrst' } });

it('persists identity and encrypted credentials without cleartext on disk', async () => {
  const { dir, store, actor } = await setup(); store.putSecret(actor, 'supabase', 'canary-private-management-token');
  expect(store.getSecret(actor, 'supabase')).toBe('canary-private-management-token');
  const second = new PlatformStore(dir, new SecretBox('ab'.repeat(32))); stores.push(second);
  expect(second.identity()).toBe(actor.workspaceId); expect(second.getSecret(actor, 'supabase')).toBe('canary-private-management-token');
  expect((await readFile(path.join(dir, 'platform.sqlite-wal'))).toString()).not.toContain('canary-private');
  expect(() => new SecretBox('cd'.repeat(32)).open(new SecretBox('ab'.repeat(32)).seal('value', 'a'), 'a')).toThrow('Encrypted configuration');
  expect(() => new SecretBox('ab'.repeat(32)).open(new SecretBox('ab'.repeat(32)).seal('value', 'a'), 'b')).toThrow('Encrypted configuration');
});
it('deduplicates exact requests but rejects changed plans, stale approval, and foreign workspaces', async () => {
  const { store, actor } = await setup(); const request = input(), op = store.submit(actor, request);
  expect(store.submit(actor, request).id).toBe(op.id);
  expect(() => store.submit(actor, { ...request, plan: { changed: true } })).toThrow('different operation');
  expect(() => store.approve(actor, op.id, 'wrong')).toThrow('reviewed operation');
  expect(() => store.get({ ...actor, workspaceId: randomUUID() }, op.id)).toThrow('not found');
  expect(() => store.approve({ ...actor, role: 'viewer' }, op.id, op.planHash)).toThrow('cannot perform');
  expect(store.approve(actor, op.id, op.planHash).state).toBe('queued');
});
it('serializes an environment and fences cancelled workers', async () => {
  const { store, actor } = await setup(); const first = input(); const a = store.submit(actor, first), b = store.submit(actor, { ...first, idempotencyKey: randomUUID() });
  store.approve(actor, a.id, a.planHash); store.approve(actor, b.id, b.planHash);
  const lease = store.claim(actor, a.id, 'one');
  expect(() => store.claim(actor, b.id, 'two')).toThrow('Another operation');
  expect(store.beginStep(lease, 'migration')).toBe(true);
  expect(store.cancel(actor, a.id).state).toBe('reconciliation_required');
  expect(() => store.completeStep(lease, 'migration')).toThrow('no longer owns');
  expect(() => store.claim(actor, b.id, 'two')).toThrow('Another operation');
});
it('resumes completed step results and conservatively recovers an expired worker', async () => {
  let now = Date.now(); const { store, actor } = await setup(() => now); const op = store.submit(actor, input());
  store.approve(actor, op.id, op.planHash); const lease = store.claim(actor, op.id, 'worker', 1000);
  store.beginStep(lease, 'created'); store.completeStep(lease, 'created', { ref: 'abcdefghijklmnopqrst' });
  expect(store.beginStep(lease, 'created')).toBe(false);
  expect(store.step(op.id, 'created')?.result).toEqual({ ref: 'abcdefghijklmnopqrst' });
  store.beginStep(lease, 'configure'); now += 1001;
  expect(() => store.completeStep(lease, 'configure')).toThrow('no longer owns');
  expect(store.recoverExpired()).toBe(1); expect(store.get(actor, op.id).state).toBe('reconciliation_required');
  const events = store.events(actor, op.id); expect(events.length).toBeGreaterThan(3);
  expect(store.events(actor, op.id, Number(events.at(-1)!.sequence))).toEqual([]);
});
it('requires management permissions for credentials and production authorization', async () => {
  const { store, actor } = await setup();
  expect(() => store.submit({ ...actor, role: 'editor' }, { ...input(), environment: 'production' })).toThrow('cannot perform');
  expect(() => store.putSecret({ ...actor, role: 'editor' }, 'token', 'secret')).toThrow('cannot perform');
  store.putRecord(actor, 'binding', 'project', { value: 'private' });
  expect(store.getRecord({ ...actor, workspaceId: randomUUID() }, 'binding', 'project')).toBe(null);
});

it('restores the private ledger and fences ambiguous provider writes after an empty-cache restart', async () => {
  const records = new Map<string, Uint8Array>();
  const adapter: HomeStatePersistence = {
    async load() { return [...records].map(([key, content]) => ({ key, content })); },
    async write(input) { for (const { key, content } of input.records) { if (content === null) records.delete(key); else records.set(key, content); } },
  };
  const first = await realpath(await mkdtemp(path.join(tmpdir(), 'builder-platform-durable-'))); dirs.push(first);
  const unmount = await mountHomeState(first, adapter);
  let now = Date.now();
  const store = new PlatformStore(path.join(first, 'platform'), new SecretBox('ab'.repeat(32)), () => now);
  const actor: Actor = { id: 'owner', workspaceId: store.identity(), role: 'owner', source: 'local-owner' };
  const op = store.submit(actor, input()); store.approve(actor, op.id, op.planHash);
  const lease = store.claim(actor, op.id, 'before-crash', 1000);
  store.putSecret(actor, 'fixture', 'private-fixture-value'); store.beginStep(lease, 'remote-create');
  await store.flush(); store.close(); await unmount(); await rm(first, { recursive: true });
  const second = await realpath(await mkdtemp(path.join(tmpdir(), 'builder-platform-restored-'))); dirs.push(second);
  const unmount2 = await mountHomeState(second, adapter);
  const restored = new PlatformStore(path.join(second, 'platform'), new SecretBox('ab'.repeat(32)), () => now);
  try {
    expect(restored.identity()).toBe(actor.workspaceId);
    expect(restored.getSecret(actor, 'fixture')).toBe('private-fixture-value');
    expect(restored.step(op.id, 'remote-create')?.state).toBe('in_flight');
    now += 1001; expect(restored.recoverExpired()).toBe(1);
    expect(restored.get(actor, op.id).state).toBe('reconciliation_required');
    expect(() => restored.claim(actor, op.id, 'after-crash')).toThrow();
    await restored.flush();
  } finally { restored.close(); await unmount2(); }
});
