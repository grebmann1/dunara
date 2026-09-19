import { randomUUID } from 'node:crypto';
import { PlatformStore } from "../../../platform/src/store.js";
import { PlatformError, type Actor, type EnvironmentName } from "../../../platform/src/contracts.js";
import { secretInput, type SecretVersion } from "../../../platform/src/configuration.js";

type Metadata = Omit<SecretVersion, 'available'>;
/** Private values never cross the Studio response, operation, or model boundary. */
export class BackendSecrets {
  private readonly session = new Map<string, { revision: string; value: string }>();
  constructor(private readonly store: PlatformStore, private readonly actor: Actor) {}
  private id(projectId: string, environment: EnvironmentName, name: string) { return `input:${projectId}:${environment}:${name}`; }
  declare(projectId: string, environment: EnvironmentName, requirements: { name: string; purpose: SecretVersion['purpose']; label: string }[]) {
    for (const requirement of requirements) {
      const id = this.id(projectId, environment, requirement.name), old = this.store.getRecord<Metadata>(this.actor, 'backend-input', id);
      if (old && old.purpose !== requirement.purpose) throw new PlatformError('REVISION_CONFLICT', 'A secret name already has a different purpose. Choose a new logical name.', 409);
      if (!old) this.store.putRecord(this.actor, 'backend-input', id, { ...requirement, revision: null, persistence: 'missing' });
    }
    return requirements.map(r => this.status(projectId, environment, r.name));
  }
  status(projectId: string, environment: EnvironmentName, name: string): SecretVersion {
    const id = this.id(projectId, environment, name), metadata = this.store.getRecord<Metadata>(this.actor, 'backend-input', id);
    if (!metadata) throw new PlatformError('INPUT_NOT_REQUESTED', 'Declare this credential in backend/configuration.json before entering it.');
    let available = false;
    try { available = metadata.persistence === 'saved' ? !!this.store.getSecret(this.actor, id) : metadata.persistence === 'session' && this.session.get(id)?.revision === metadata.revision; } catch { /* Locked ciphertext is unavailable, never overwritten. */ }
    return { ...metadata, available };
  }
  supply(projectId: string, input: unknown) {
    const value = secretInput.parse(input), old = this.status(projectId, value.environment, value.name);
    if (old.revision !== value.expectedRevision) throw new PlatformError('REVISION_CONFLICT', 'The credential changed. Refresh before replacing it.', 409);
    if (old.purpose === 'storage_server' && !/^sb_secret_[A-Za-z0-9_-]{16,}$/.test(value.value)) throw new PlatformError('INVALID_INPUT', 'Use this project’s server secret API key from Supabase Settings.');
    if (old.purpose === 'app_user_session' && !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value.value)) throw new PlatformError('INVALID_INPUT', 'Use an isolated development app-user access token.');
    const id = this.id(projectId, value.environment, value.name), revision = randomUUID();
    if (value.remember) { this.store.putSecret(this.actor, id, value.value); this.session.delete(id); }
    else { this.store.deleteSecret(this.actor, id); this.session.set(id, { value: value.value, revision }); }
    this.store.putRecord(this.actor, 'backend-input', id, { name: old.name, purpose: old.purpose, label: old.label, revision, persistence: value.remember ? 'saved' : 'session' });
    return this.status(projectId, value.environment, value.name);
  }
  remove(projectId: string, environment: EnvironmentName, name: string, expectedRevision: string | null) {
    const old = this.status(projectId, environment, name);
    if (old.revision !== expectedRevision) throw new PlatformError('REVISION_CONFLICT', 'The credential changed. Refresh before removing it.', 409);
    const id = this.id(projectId, environment, name); this.store.deleteSecret(this.actor, id); this.session.delete(id);
    this.store.putRecord(this.actor, 'backend-input', id, { name: old.name, purpose: old.purpose, label: old.label, revision: randomUUID(), persistence: 'missing' });
    return this.status(projectId, environment, name);
  }
  resolve(projectId: string, environment: EnvironmentName, expected: SecretVersion) {
    const current = this.status(projectId, environment, expected.name);
    if (!expected.available || !current.available || current.revision !== expected.revision || current.purpose !== expected.purpose) throw new PlatformError('SECRET_REQUIRED', 'A required credential is missing, expired, or replaced. Enter it in Backend and prepare a new review.', 409);
    const id = this.id(projectId, environment, expected.name);
    return current.persistence === 'saved' ? this.store.getSecret(this.actor, id)! : this.session.get(id)!.value;
  }
  clear() { this.session.clear(); }
}
