import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { ApprovalBroker, fingerprint } from './permissions.js';
const binding = () => ({ epoch: randomUUID(), runId: randomUUID(), conversationId: randomUUID(), projectId: randomUUID() });
it('binds one-use human approval to the exact turn and immutable arguments, not model confirmation', async () => {
  const broker = new ApprovalBroker(), scope = binding(), controller = new AbortController();
  const args = { confirmed: true, revision: 'original' };
  const waiting = broker.request(scope, 'icon_apply', args, { before: 'old', after: 'new' }, 'Review the exact diff', controller.signal);
  args.revision = 'changed'; const approval = broker.list()[0]!;
  expect(approval.args.revision).toBe('original');
  expect(() => broker.respond({ ...scope, id: approval.id, runId: randomUUID(), approve: true })).toThrow('stale');
  expect(() => broker.respond({ ...scope, id: approval.id, confirmed: true })).toThrow();
  expect(broker.list()).toHaveLength(1);
  broker.respond({ ...scope, id: approval.id, approve: true }); await waiting;
  expect(() => broker.respond({ ...scope, id: approval.id, approve: true })).toThrow('stale');
  expect(broker.list()).toHaveLength(0);
});
it('expires and cancels without leaving reusable approvals', async () => {
  const broker = new ApprovalBroker(() => {}, 10), scope = binding(), controller = new AbortController();
  await expect(broker.request(scope, 'media_approve', {}, {}, 'Review', controller.signal)).rejects.toThrow('expired');
  const cancelled = broker.request(scope, 'media_approve', {}, {}, 'Review', controller.signal);
  controller.abort(); await expect(cancelled).rejects.toThrow('cancelled'); expect(broker.list()).toHaveLength(0);
});
it('fails closed on decline and shutdown, and compares revisions independent of property order', async () => {
  const broker = new ApprovalBroker(), scope = binding(), controller = new AbortController();
  const declined = broker.request(scope, 'launch_kit_remove', {}, {}, 'Delete permanently', controller.signal);
  broker.respond({ ...scope, id: broker.list()[0]!.id, approve: false }); await expect(declined).rejects.toThrow('declined');
  const closed = broker.request(scope, 'launch_kit_remove', {}, {}, 'Delete permanently', controller.signal);
  broker.close(); await expect(closed).rejects.toThrow('cancelled');
  expect(fingerprint({ a: 1, b: { c: 2, d: 3 } })).toBe(fingerprint({ b: { d: 3, c: 2 }, a: 1 }));
  expect(fingerprint({ a: 1 })).not.toBe(fingerprint({ a: 2 }));
});
