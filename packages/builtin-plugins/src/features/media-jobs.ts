import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { z } from 'zod';
import { Assets } from "../../../core/src/assets.js";
import { BuilderError } from "../../../core/src/contracts.js";
import { IMAGE_MODEL, mediaModelLabel, jobGuidance, jobRequestSchema, jobSchema, type MediaJob } from "../../../core/src/media-job-contracts.js";
import { type ImageProvider, ProviderFailure } from "../../../core/src/openai-images.js";
import { ProviderSettings, type ProviderOptions, type ChatGPTImageConnection } from "../../../core/src/provider-settings.js";
import { atomicWrite, exists, noSymlinks, readText, SerialQueue } from "../../../core/src/storage.js";

const pending = (j: MediaJob) => ['awaiting-approval', 'queued', 'running'].includes(j.state);
const ledgerSchema = z.array(jobSchema).max(100);
export class MediaJobs {
  private jobs: MediaJob[] = [];
  private queue = new SerialQueue();
  private loaded = false;
  private closed = false;
  private worker?: Promise<void>;
  private controller?: AbortController;
  private storageFailed = false;
  #settings: ProviderSettings;
  #inFlight = false;
  constructor(readonly assets: Assets, provider?: ImageProvider, private timeoutMs = 180_000, options: ProviderOptions = {}) { this.#settings = new ProviderSettings(provider, options); }
  providerCredential() { return this.#settings.credential(); }
  useChatGPT(connection: ChatGPTImageConnection) { this.#settings.useChatGPT(connection); }
  subscribeProvider(changed: () => void, beforeChange: () => void) { return this.#settings.subscribe(changed, beforeChange); }
  providerStatus() { return this.#settings.status(this.#inFlight || this.jobs.some(job => job.state === 'queued' || job.state === 'running')); }
  async configureProvider(input: unknown) {
    return this.queue.run(async () => { this.active(); await this.load(); this.active(); const result = this.#settings.update(input, this.providerStatus().busy); await this.assets.projects.flushState(); return result; });
  }
  capabilities() {
    const provider = this.providerStatus(), models = this.#settings.models();
    return { provider, available: provider.configured && models.length > 0 && !this.storageFailed && !this.closed, model: models[0]?.id ?? IMAGE_MODEL, models, qualities: ['low', 'medium', 'high'], sizes: ['1024x1024', '1536x1024', '1024x1536'], maxCandidates: provider.source === 'chatgpt' ? 1 : 2, approval: 'Explicit Studio approval per request', cost: provider.source === 'chatgpt' ? 'Uses your ChatGPT/Codex allowance. No automatic retries or API fallback.' : 'Billable; exact cost unknown. No automatic retries.', reason: this.storageFailed ? 'Job storage unavailable; generation disabled' : !models.length ? 'No image models are available with the selected connection. Choose a personal image key in Settings.' : provider.configured ? null : provider.chatgpt?.selected ? provider.chatgpt.reason : 'Choose an image connection in Settings → Image generation; offline assets remain available.' };
  }
  private file() { return path.join(this.assets.projects.home, 'media-jobs.json'); }
  private async load() {
    if (this.loaded) return;
    await noSymlinks(this.assets.projects.home, this.file());
    if (await exists(this.file())) {
      this.jobs = ledgerSchema.parse(JSON.parse(await readText(this.file(), 2_000_000)));
      for (const job of this.jobs) if (job.state === 'running' || job.state === 'queued') { job.state = 'interrupted'; job.error = 'Dunara restarted. Request was not resubmitted; provider-side work or charges may have occurred.'; }
      await this.persist();
    }
    this.loaded = true;
  }
  private async persist() {
    await noSymlinks(this.assets.projects.home, this.file());
    await atomicWrite(this.file(), JSON.stringify(ledgerSchema.parse(this.jobs)));
  }
  private active() { if (this.closed || this.storageFailed) throw new BuilderError('INVALID_INPUT', 'Media jobs are closed or storage is unavailable'); }
  private async identity(projectId: string) {
    const project = await this.assets.projects.get(projectId); const info = await stat(project.root);
    return { projectRoot: project.root, rootIdentity: `${info.dev}:${info.ino}` };
  }
  private async validate(job: MediaJob) {
    const identity = await this.identity(job.projectId);
    if (identity.projectRoot !== job.projectRoot || identity.rootIdentity !== job.rootIdentity) throw new BuilderError('INVALID_PATH', 'Project identity changed');
    const library = await this.assets.list(job.projectId);
    if (library.revision !== job.request.expectedRevision) throw new BuilderError('REVISION_CONFLICT', 'Media library changed; create and approve a new request');
    if (library.assets.length + job.request.count > 100) throw new BuilderError('LIMIT_EXCEEDED', 'Media version quota reached');
    const references: Buffer[] = [];
    for (const id of job.request.referenceIds) {
      const image = await this.assets.read(job.projectId, id);
      if (image.asset.status !== 'approved') throw new BuilderError('INVALID_INPUT', 'Only approved reference images may be sent');
      references.push(image.bytes);
    }
    return references;
  }
  private result(job: MediaJob) { return { ...structuredClone(job), guidance: jobGuidance(job), creditEstimate: this.#settings.estimate(job.request) }; }
  async list(projectId: string) {
    return this.queue.run(async () => { await this.load(); await this.assets.projects.get(projectId); return { capabilities: this.capabilities(), jobs: this.jobs.filter(j => j.projectId === projectId).map(j => this.result(j)) }; });
  }
  async get(projectId: string, jobId: string) {
    const result = await this.list(projectId); const job = result.jobs.find(j => j.id === jobId);
    if (!job) throw new BuilderError('INVALID_INPUT', 'Job not found in this project'); return job;
  }
  async request(projectId: string, input: unknown) {
    const request = jobRequestSchema.parse(input);
    return this.queue.run(async () => {
      this.active(); await this.load();
      const duplicate = this.jobs.find(j => j.projectId === projectId && j.request.requestId === request.requestId);
      if (duplicate) {
        if (JSON.stringify(duplicate.request) !== JSON.stringify(request)) throw new BuilderError('INVALID_INPUT', 'Request ID already used with different settings');
        return this.result(duplicate);
      }
      this.#settings.assertModel(request.model);
      if (this.jobs.filter(pending).length >= 10) throw new BuilderError('LIMIT_EXCEEDED', 'At most ten pending media requests are allowed');
      const job: MediaJob = { id: randomUUID(), projectId, ...await this.identity(projectId), request, model: request.model, state: 'awaiting-approval', createdAt: new Date().toISOString(), resultIds: [] };
      await this.validate(job); this.active();
      const previous = this.jobs;
      this.jobs = [...this.jobs.filter(j => pending(j)), ...this.jobs.filter(j => !pending(j)).slice(-89), job];
      try { await this.persist(); } catch (error) { this.jobs = previous; throw error; }
      return this.result(job);
    });
  }
  // Deliberately not exposed as an MCP tool: only authenticated Studio can authorize spending.
  async approve(projectId: string, jobId: string, expectedConfigurationRevision?: unknown) {
    const result = await this.queue.run(async () => {
      this.active(); await this.load();
      this.#settings.assertRevision(expectedConfigurationRevision);
      const job = this.jobs.find(j => j.id === jobId && j.projectId === projectId);
      if (!job || job.state !== 'awaiting-approval') throw new BuilderError('INVALID_INPUT', 'Job is not awaiting approval');
      this.#settings.assertModel(job.request.model);
      if (!this.providerStatus().configured) throw new BuilderError('INVALID_INPUT', this.capabilities().reason ?? 'Choose an image connection in Settings. No provider call was made.');
      await this.validate(job); this.active(); job.state = 'queued'; job.approvedAt = new Date().toISOString();
      try { await this.persist(); } catch (error) { job.state = 'awaiting-approval'; delete job.approvedAt; throw error; }
      return this.result(job);
    });
    this.pump(); return result;
  }
  async cancel(projectId: string, jobId: string) {
    return this.queue.run(async () => {
      await this.load(); await this.assets.projects.get(projectId);
      const job = this.jobs.find(j => j.id === jobId && j.projectId === projectId);
      if (!job) throw new BuilderError('INVALID_INPUT', 'Job not found in this project');
      if (pending(job)) {
        if (job.state === 'running') this.controller?.abort();
        job.state = 'cancelled'; job.error = 'Local cancellation requested. Provider-side work may continue and charges are not refunded automatically.'; await this.persist();
      }
      return this.result(job);
    });
  }
  private pump() {
    if (this.worker || this.closed || this.storageFailed) return;
    this.worker = this.run().catch(() => { this.storageFailed = true; this.controller?.abort(); }).finally(() => { this.worker = undefined; if (this.jobs.some(j => j.state === 'queued')) this.pump(); });
  }
  private async run() {
    while (!this.closed) {
      const job = await this.queue.run(async () => {
        const next = this.jobs.find(j => j.state === 'queued'); if (!next) return;
        next.state = 'running'; this.#inFlight = true; this.controller = new AbortController(); await this.persist(); return next;
      });
      if (!job) return;
      const controller = this.controller!;
      const timer = setTimeout(() => controller.abort(), this.timeoutMs); timer.unref();
      try {
        const references = await this.validate(job); this.active(); controller.signal.throwIfAborted();
        const outputs = await this.#settings.run(structuredClone(job.request), references, controller.signal);
        await this.queue.run(async () => {
          if (job.state !== 'running' || this.closed || controller.signal.aborted) return;
          await this.validate(job); this.active(); controller.signal.throwIfAborted();
          if (outputs.length !== job.request.count) throw new ProviderFailure('Provider returned an unexpected number of images');
          const library = await this.assets.add(job.projectId, { expectedRevision: job.request.expectedRevision, label: job.request.label, role: job.request.role, rightsNote: job.request.rightsNote, mediaType: 'image/png' }, outputs.map(bytes => ({ bytes, provenance: job.request.operation === 'edit' ? 'edited' : 'generated', parentId: job.request.operation === 'edit' ? job.request.referenceIds[0] : undefined, provider: 'openai', model: mediaModelLabel(job.model) })), controller.signal);
          job.resultIds = library.assets.slice(-outputs.length).map(a => a.id); job.state = 'succeeded'; await this.persist();
        });
      } catch (error) {
        await this.queue.run(async () => {
          if (job.state !== 'running') return;
          job.state = this.closed ? 'interrupted' : 'failed';
          job.error = controller.signal.aborted ? 'Request timed out or was interrupted. Provider work or charges may have occurred; no automatic retry.' : error instanceof BuilderError ? 'Project, reference, revision, or image validation failed. Review the library; no automatic retry.' : error instanceof ProviderFailure ? error.message.slice(0, 300) : 'Image request failed. Provider work or charges may have occurred; no automatic retry.';
          await this.persist();
        });
      } finally {
        clearTimeout(timer);
        await this.queue.run(async () => {
          this.#inFlight = false;
          if (job.state === 'running') { job.state = 'failed'; job.error = 'Request timed out; late output was discarded. Charges may have occurred.'; await this.persist(); }
        });
      }
    }
  }
  async close() {
    this.closed = true; this.controller?.abort();
    await this.queue.run(async () => {
      this.#settings.close();
      if (!this.loaded) return;
      for (const job of this.jobs) if (job.state === 'queued' || job.state === 'running') { job.state = 'interrupted'; job.error = 'Dunara closed. Provider-side work or charges may have occurred; no resubmission.'; }
      await this.persist();
    });
  }
}
