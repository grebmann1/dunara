import { DatabaseSync } from 'node:sqlite';
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { authorize, operationSchema, PlatformError, uuid, environmentName, type Actor, type Operation, type OperationState } from './contracts.js';
import { canonical, hash, SecretBox } from './crypto.js';

type Row = Record<string, unknown>;
type Submission = { projectId: string; environment: Operation['environment']; kind: string; idempotencyKey: string; plan: Record<string, unknown> };
export type Lease = { operationId: string; owner: string; fence: number };
export type Step = { name: string; state: 'in_flight' | 'completed' | 'rejected' | 'failed'; result: Record<string, unknown> | null };

/** Single-host durable adapter. Hosted multi-worker deployments use the Postgres schema. */
export class PlatformStore {
  private readonly db: DatabaseSync;
  constructor(directory: string, private readonly box?: SecretBox, private readonly now = Date.now) {
    if (!path.isAbsolute(directory)) throw new PlatformError('INVALID_PATH', 'Platform storage requires an absolute directory.');
    let current = path.parse(directory).root;
    for (const part of directory.slice(current.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new PlatformError('INVALID_PATH', 'Platform storage cannot contain symlinks.');
    }
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || (process.getuid && stat.uid !== process.getuid())) throw new PlatformError('INVALID_PATH', 'Platform storage must be owned by this user.');
    chmodSync(directory, 0o700);
    const filename = path.join(directory, 'platform.sqlite');
    if (existsSync(filename)) {
      const file = lstatSync(filename);
      if (!file.isFile() || file.nlink !== 1 || (process.getuid && file.uid !== process.getuid())) throw new PlatformError('INVALID_PATH', 'Unsafe platform database file.');
    } else closeSync(openSync(filename, 'wx', 0o600));
    for (const suffix of ['-wal', '-shm', '-journal']) if (existsSync(filename + suffix) && !lstatSync(filename + suffix).isFile()) throw new PlatformError('INVALID_PATH', 'Unsafe platform database companion file.');
    chmodSync(filename, 0o600);
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS operations (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, project_id TEXT NOT NULL, environment TEXT NOT NULL,
        actor_id TEXT NOT NULL, kind TEXT NOT NULL, idempotency_key TEXT NOT NULL, plan_hash TEXT NOT NULL, plan TEXT NOT NULL,
        state TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, lease_owner TEXT, lease_until INTEGER,
        fence INTEGER NOT NULL DEFAULT 0, error TEXT, result TEXT, UNIQUE(workspace_id, actor_id, idempotency_key));
      CREATE INDEX IF NOT EXISTS operations_target ON operations(workspace_id, project_id, environment, state);
      CREATE TABLE IF NOT EXISTS operation_steps (operation_id TEXT NOT NULL REFERENCES operations(id), name TEXT NOT NULL,
        state TEXT NOT NULL, result TEXT, PRIMARY KEY(operation_id, name));
      CREATE TABLE IF NOT EXISTS operation_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, operation_id TEXT NOT NULL REFERENCES operations(id),
        state TEXT NOT NULL, detail TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS records (workspace_id TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL,
        PRIMARY KEY(workspace_id, kind, id));
      CREATE TABLE IF NOT EXISTS secrets (workspace_id TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL,
        PRIMARY KEY(workspace_id, id));`);
  }
  close() { this.db.close(); }
  identity() {
    const key = 'local_workspace';
    this.db.prepare('INSERT OR IGNORE INTO metadata(key,value) VALUES (?,?)').run(key, randomUUID());
    return String(this.db.prepare('SELECT value FROM metadata WHERE key=?').get(key)!.value);
  }
  private transaction<T>(fn: () => T) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private date() { return new Date(this.now()).toISOString(); }
  private row(row: Row): Operation {
    return operationSchema.parse({ id: row.id, workspaceId: row.workspace_id, projectId: row.project_id, environment: row.environment,
      actorId: row.actor_id, kind: row.kind, idempotencyKey: row.idempotency_key, planHash: row.plan_hash, plan: JSON.parse(String(row.plan)),
      state: row.state, createdAt: row.created_at, updatedAt: row.updated_at, leaseOwner: row.lease_owner, leaseUntil: row.lease_until,
      fence: row.fence, error: row.error, result: row.result === null ? null : JSON.parse(String(row.result)) });
  }
  private raw(id: string) { const row = this.db.prepare('SELECT * FROM operations WHERE id=?').get(id); if (!row) throw new PlatformError('NOT_FOUND', 'Operation not found.', 404); return this.row(row); }
  private event(id: string, state: OperationState, detail: string) {
    this.db.prepare('INSERT INTO operation_events(operation_id,state,detail,created_at) VALUES (?,?,?,?)').run(id, state, detail.slice(0, 500), this.date());
  }
  submit(actor: Actor, input: Submission) {
    authorize(actor, actor.workspaceId, input.environment === 'production' ? 'production' : 'write');
    uuid.parse(input.projectId); uuid.parse(input.idempotencyKey); environmentName.parse(input.environment);
    if (!/^[a-z_]{1,80}$/.test(input.kind) || Buffer.byteLength(canonical(input.plan)) > 512_000) throw new PlatformError('INVALID_INPUT', 'Invalid or oversized operation plan.');
    const planHash = hash({ projectId: input.projectId, environment: input.environment, kind: input.kind, plan: input.plan });
    return this.transaction(() => {
      const old = this.db.prepare('SELECT * FROM operations WHERE workspace_id=? AND actor_id=? AND idempotency_key=?').get(actor.workspaceId, actor.id, input.idempotencyKey);
      if (old) { if (old.plan_hash !== planHash) throw new PlatformError('REVISION_CONFLICT', 'The idempotency key already belongs to a different operation.', 409); return this.row(old); }
      const id = randomUUID(), date = this.date();
      this.db.prepare('INSERT INTO operations(id,workspace_id,project_id,environment,actor_id,kind,idempotency_key,plan_hash,plan,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, actor.workspaceId, input.projectId, input.environment, actor.id, input.kind, input.idempotencyKey, planHash, canonical(input.plan), 'awaiting_approval', date, date);
      this.event(id, 'awaiting_approval', 'Review the exact target and changes.'); return this.raw(id);
    });
  }
  get(actor: Actor, id: string) {
    uuid.parse(id);
    const row = this.db.prepare('SELECT * FROM operations WHERE id=? AND workspace_id=?').get(id, actor.workspaceId);
    if (!row) throw new PlatformError('NOT_FOUND', 'Operation not found.', 404);
    authorize(actor, String(row.workspace_id), 'read'); return this.row(row);
  }
  list(actor: Actor, projectId: string) {
    authorize(actor, actor.workspaceId, 'read'); uuid.parse(projectId);
    return this.readableRows(this.db.prepare('SELECT * FROM operations WHERE workspace_id=? AND project_id=? ORDER BY created_at DESC LIMIT 100').all(actor.workspaceId, projectId));
  }
  queued(actor: Actor) {
    authorize(actor, actor.workspaceId, 'read');
    return this.readableRows(this.db.prepare("SELECT * FROM operations WHERE workspace_id=? AND state='queued' ORDER BY created_at LIMIT 100").all(actor.workspaceId));
  }
  private readableRows(rows: Row[]) {
    return rows.flatMap(row => {
      try { return [this.row(row)]; }
      catch { this.db.prepare("UPDATE operations SET state='failed',error=?,lease_owner=NULL,lease_until=NULL WHERE id=? AND state IN ('queued','awaiting_approval')").run('This stored operation is malformed. Its original record was retained; prepare a new supported plan.', String(row.id)); return []; }
    });
  }
  rejectUnsupported(actor: Actor, id: string) {
    authorize(actor, actor.workspaceId, 'write');
    this.db.prepare("UPDATE operations SET state='failed',error=?,updated_at=? WHERE id=? AND workspace_id=? AND state='queued'").run('This operation version or kind is unsupported. Update Dunara or prepare a new supported plan. No change was executed.', this.date(), id, actor.workspaceId);
  }
  steps(actor: Actor, id: string) {
    this.get(actor, id);
    return this.db.prepare('SELECT name,state,result FROM operation_steps WHERE operation_id=? ORDER BY rowid LIMIT 200').all(id).map(row => ({ name: String(row.name), state: String(row.state), result: row.result ? JSON.parse(String(row.result)) as Record<string, unknown> : null }));
  }
  submitted(actor: Actor, input: Submission) {
    authorize(actor, actor.workspaceId, 'read');
    uuid.parse(input.idempotencyKey);
    const row = this.db.prepare('SELECT * FROM operations WHERE workspace_id=? AND actor_id=? AND idempotency_key=?').get(actor.workspaceId, actor.id, input.idempotencyKey);
    if (!row) return null;
    const expected = hash({ projectId: input.projectId, environment: input.environment, kind: input.kind, plan: input.plan });
    if (row.plan_hash !== expected) throw new PlatformError('REVISION_CONFLICT', 'The idempotency key already belongs to a different operation.', 409);
    return this.row(row);
  }
  approve(actor: Actor, id: string, expectedHash: string) {
    return this.transaction(() => {
      const op = this.get(actor, id); authorize(actor, op.workspaceId, op.environment === 'production' ? 'production' : 'write');
      if (op.state !== 'awaiting_approval' || op.planHash !== expectedHash) throw new PlatformError('REVISION_CONFLICT', 'The reviewed operation changed or is no longer awaiting approval.', 409);
      this.db.prepare('UPDATE operations SET state=?, updated_at=? WHERE id=?').run('queued', this.date(), id);
      this.event(id, 'queued', 'The exact plan was approved.'); return this.raw(id);
    });
  }
  claim(actor: Actor, id: string, owner: string, ttl = 60_000): Lease {
    return this.transaction(() => {
      const op = this.get(actor, id); authorize(actor, op.workspaceId, 'write');
      if (op.state !== 'queued' || !owner || ttl < 1000 || ttl > 300_000) throw new PlatformError('OPERATION_BUSY', 'The operation cannot be claimed in its current state.', 409);
      const busy = this.db.prepare("SELECT id FROM operations WHERE workspace_id=? AND project_id=? AND environment=? AND state IN ('running','reconciliation_required') LIMIT 1").get(op.workspaceId, op.projectId, op.environment);
      if (busy) throw new PlatformError('OPERATION_BUSY', 'Another operation on this environment needs completion or reconciliation.', 409);
      this.db.prepare('UPDATE operations SET state=?, lease_owner=?, lease_until=?, fence=fence+1, updated_at=? WHERE id=?').run('running', owner, this.now() + ttl, this.date(), id);
      this.event(id, 'running', 'Execution started.'); return { operationId: id, owner, fence: op.fence + 1 };
    });
  }
  claimRecovery(actor: Actor, id: string, owner: string, expectedHash: string, expectedFence: number): Lease {
    return this.transaction(() => {
      const op = this.get(actor, id);
      authorize(actor, op.workspaceId, op.environment === 'production' ? 'production' : 'write');
      if (!owner || op.state !== 'reconciliation_required' || op.planHash !== expectedHash || op.fence !== expectedFence) throw new PlatformError('REVISION_CONFLICT', 'The operation changed. Refresh its recovery status.', 409);
      const busy = this.db.prepare("SELECT id FROM operations WHERE workspace_id=? AND project_id=? AND environment=? AND id<>? AND state IN ('running','reconciliation_required') LIMIT 1").get(op.workspaceId, op.projectId, op.environment, id);
      if (busy) throw new PlatformError('OPERATION_BUSY', 'Another operation on this environment needs completion or reconciliation.', 409);
      this.db.prepare("UPDATE operations SET state='running',lease_owner=?,lease_until=?,fence=fence+1,error=NULL,updated_at=? WHERE id=?").run(owner, this.now() + 60_000, this.date(), id);
      this.event(id, 'running', 'Checking provider evidence without repeating external changes.');
      return { operationId: id, owner, fence: op.fence + 1 };
    });
  }
  resolveStep(lease: Lease, name: string, result: Record<string, unknown>) {
    if (!/^[a-zA-Z0-9_.-]{1,120}$/.test(name) || Buffer.byteLength(canonical(result)) > 512_000) throw new PlatformError('INVALID_INPUT', 'Invalid reconciliation evidence.');
    this.transaction(() => {
      this.requireLease(lease);
      this.db.prepare("INSERT INTO operation_steps(operation_id,name,state,result) VALUES (?,?,'completed',?) ON CONFLICT(operation_id,name) DO UPDATE SET state='completed',result=excluded.result").run(lease.operationId, name, canonical(result));
      this.event(lease.operationId, 'running', `Verified ${name} against provider evidence.`);
    });
  }
  putLeasedRecord(lease: Lease, kind: string, id: string, value: unknown) {
    this.transaction(() => {
      const op = this.requireLease(lease);
      this.db.prepare('INSERT INTO records(workspace_id,kind,id,value) VALUES (?,?,?,?) ON CONFLICT(workspace_id,kind,id) DO UPDATE SET value=excluded.value').run(op.workspaceId, kind, id, canonical(value));
    });
  }
  private requireLease(lease: Lease) {
    const op = this.raw(lease.operationId);
    if (op.state !== 'running' || op.leaseOwner !== lease.owner || op.fence !== lease.fence || (op.leaseUntil ?? 0) <= this.now()) throw new PlatformError('LEASE_EXPIRED', 'This worker no longer owns the operation.', 409);
    return op;
  }
  heartbeat(lease: Lease) {
    this.transaction(() => { this.requireLease(lease); this.db.prepare('UPDATE operations SET lease_until=? WHERE id=?').run(this.now() + 60_000, lease.operationId); });
  }
  beginStep(lease: Lease, name: string) {
    if (!/^[a-zA-Z0-9_.-]{1,120}$/.test(name)) throw new PlatformError('INVALID_INPUT', 'Invalid operation step.');
    return this.transaction(() => {
      this.requireLease(lease);
      const existing = this.step(lease.operationId, name);
      if (existing?.state === 'completed') return false;
      if (existing) throw new PlatformError('RECONCILIATION_REQUIRED', 'A previous request may already have changed the provider. Inspect its result before retrying.', 409);
      this.db.prepare('INSERT INTO operation_steps(operation_id,name,state) VALUES (?,?,?)').run(lease.operationId, name, 'in_flight');
      this.event(lease.operationId, 'running', `Started ${name}.`); return true;
    });
  }
  completeStep(lease: Lease, name: string, result: Record<string, unknown> = {}) {
    if (Buffer.byteLength(canonical(result)) > 512_000) throw new PlatformError('LIMIT_EXCEEDED', 'Step result exceeds the storage limit.');
    this.transaction(() => {
      this.requireLease(lease);
      const change = this.db.prepare("UPDATE operation_steps SET state='completed',result=? WHERE operation_id=? AND name=? AND state='in_flight'").run(canonical(result), lease.operationId, name);
      if (change.changes !== 1) throw new PlatformError('REVISION_CONFLICT', 'The step is not in flight.', 409);
      this.event(lease.operationId, 'running', `Completed ${name}.`);
    });
  }
  rejectStep(lease: Lease, name: string) {
    this.transaction(() => { this.requireLease(lease); this.db.prepare("UPDATE operation_steps SET state='rejected',result=? WHERE operation_id=? AND name=? AND state='in_flight'").run(canonical({ evidence: 'provider_rejected_write', applied: false }), lease.operationId, name); });
  }
  failStep(lease: Lease, name: string, result: Record<string, unknown>) {
    if (Buffer.byteLength(canonical(result)) > 512_000) throw new PlatformError('LIMIT_EXCEEDED', 'Step result exceeds the storage limit.');
    this.transaction(() => {
      this.requireLease(lease);
      const changed = this.db.prepare("UPDATE operation_steps SET state='failed',result=? WHERE operation_id=? AND name=? AND state='in_flight'").run(canonical(result), lease.operationId, name);
      if (changed.changes !== 1) throw new PlatformError('REVISION_CONFLICT', 'The step is not in flight.', 409);
      this.event(lease.operationId, 'running', `Failed ${name}; inspect its recorded fixture evidence.`);
    });
  }
  step(id: string, name: string): Step | null {
    const row = this.db.prepare('SELECT * FROM operation_steps WHERE operation_id=? AND name=?').get(id, name);
    return row ? { name, state: row.state as Step['state'], result: row.result ? JSON.parse(String(row.result)) : null } : null;
  }
  finish(lease: Lease, state: 'succeeded' | 'failed' | 'reconciliation_required', result: Record<string, unknown> | null = null, error: string | null = null) {
    return this.transaction(() => {
      this.requireLease(lease);
      if (state === 'succeeded' && this.db.prepare("SELECT 1 FROM operation_steps WHERE operation_id=? AND state='in_flight'").get(lease.operationId)) throw new PlatformError('RECONCILIATION_REQUIRED', 'A provider step still has an unknown outcome.');
      this.db.prepare('UPDATE operations SET state=?,result=?,error=?,lease_owner=NULL,lease_until=NULL,updated_at=? WHERE id=?').run(state, result ? canonical(result) : null, error?.slice(0, 500) ?? null, this.date(), lease.operationId);
      this.event(lease.operationId, state, error ?? 'Execution completed.'); return this.raw(lease.operationId);
    });
  }
  cancel(actor: Actor, id: string) {
    return this.transaction(() => {
      const op = this.get(actor, id); authorize(actor, op.workspaceId, op.environment === 'production' ? 'production' : 'write');
      if (!['awaiting_approval', 'queued', 'running'].includes(op.state)) return op;
      const state = op.state === 'running' ? 'reconciliation_required' : 'cancelled';
      this.db.prepare('UPDATE operations SET state=?,fence=fence+1,lease_owner=NULL,lease_until=NULL,updated_at=? WHERE id=?').run(state, this.date(), id);
      this.event(id, state, state === 'cancelled' ? 'Cancelled before execution.' : 'Further execution stopped; an external request may have completed.'); return this.raw(id);
    });
  }
  recoverExpired() {
    return this.transaction(() => {
      const expired = this.db.prepare("SELECT id FROM operations WHERE state='running' AND lease_until<=?").all(this.now());
      for (const row of expired) {
        const id = String(row.id);
        this.db.prepare("UPDATE operations SET state='reconciliation_required',fence=fence+1,lease_owner=NULL,lease_until=NULL,updated_at=? WHERE id=?").run(this.date(), id);
        this.event(id, 'reconciliation_required', 'The worker lease expired. Inspect remote state before retrying.');
      }
      return expired.length;
    });
  }
  events(actor: Actor, id: string, after = 0) {
    this.get(actor, id);
    if (!Number.isSafeInteger(after) || after < 0) throw new PlatformError('INVALID_INPUT', 'Invalid event cursor.');
    return this.db.prepare('SELECT sequence,state,detail,created_at AS createdAt FROM operation_events WHERE operation_id=? AND sequence>? ORDER BY sequence LIMIT 200').all(id, after);
  }
  putRecord(actor: Actor, kind: string, id: string, value: unknown) {
    authorize(actor, actor.workspaceId, 'write');
    this.db.prepare('INSERT INTO records(workspace_id,kind,id,value) VALUES (?,?,?,?) ON CONFLICT(workspace_id,kind,id) DO UPDATE SET value=excluded.value').run(actor.workspaceId, kind, id, canonical(value));
  }
  getRecord<T>(actor: Actor, kind: string, id: string): T | null {
    authorize(actor, actor.workspaceId, 'read'); const row = this.db.prepare('SELECT value FROM records WHERE workspace_id=? AND kind=? AND id=?').get(actor.workspaceId, kind, id);
    return row ? JSON.parse(String(row.value)) : null;
  }
  takeRecord<T>(actor: Actor, kind: string, id: string): T | null {
    authorize(actor, actor.workspaceId, 'write');
    return this.transaction(() => {
      const value = this.getRecord<T>(actor, kind, id);
      this.db.prepare('DELETE FROM records WHERE workspace_id=? AND kind=? AND id=?').run(actor.workspaceId, kind, id);
      return value;
    });
  }
  recordEntries<T>(actor: Actor, kind: string) {
    authorize(actor, actor.workspaceId, 'read');
    return this.db.prepare('SELECT id,value FROM records WHERE workspace_id=? AND kind=? LIMIT 1000').all(actor.workspaceId, kind).map(row => ({ id: String(row.id), value: JSON.parse(String(row.value)) as T }));
  }
  putSecret(actor: Actor, id: string, value: string) {
    authorize(actor, actor.workspaceId, 'manage');
    if (!this.box) throw new PlatformError('CONFIGURATION_REQUIRED', 'Persistent secrets require a configured encryption key. Use session-only connection otherwise.');
    this.assertSecretStorage(actor);
    this.db.prepare('INSERT INTO secrets(workspace_id,id,value) VALUES (?,?,?) ON CONFLICT(workspace_id,id) DO UPDATE SET value=excluded.value').run(actor.workspaceId, id, this.box.seal(value, `${actor.workspaceId}:${id}`));
  }
  getSecret(actor: Actor, id: string) {
    authorize(actor, actor.workspaceId, 'manage'); const row = this.db.prepare('SELECT value FROM secrets WHERE workspace_id=? AND id=?').get(actor.workspaceId, id);
    if (!row) return null;
    if (!this.box) throw new PlatformError('CREDENTIAL_UNAVAILABLE', 'The encryption key is required to restore this connection.');
    return this.box.open(String(row.value), `${actor.workspaceId}:${id}`);
  }
  assertSecretStorage(actor: Actor) {
    authorize(actor, actor.workspaceId, 'manage');
    // Check existing ciphertext before any replacement, deletion, or new encrypted write.
    for (const row of this.db.prepare('SELECT id,value FROM secrets WHERE workspace_id=?').iterate(actor.workspaceId)) {
      if (!this.box) throw new PlatformError('CREDENTIAL_UNAVAILABLE', 'Restore the original encryption key to access saved backend configuration. Saved data was retained.');
      this.box.open(String(row.value), `${actor.workspaceId}:${String(row.id)}`);
    }
  }
  deleteSecret(actor: Actor, id: string) { this.assertSecretStorage(actor); this.db.prepare('DELETE FROM secrets WHERE workspace_id=? AND id=?').run(actor.workspaceId, id); }
}
