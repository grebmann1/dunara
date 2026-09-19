import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { BuilderError } from '../../core/src/contracts.js';
import { CredentialStore, credentialKeySchema, sharedOpenAIStore, PrivateSettingsStore, type SecretProtection } from '../../core/src/credentials.js';
import { ASSISTANT_LIMITS, startTurnSchema, taskUpdateSchema, type AssistantEvent, type AssistantLimits, type Conversation, type HarnessResult, type HarnessTool, type RunBinding, type RunHarness, type StoredTurn, type TurnState } from './contracts.js';
import type { MediaJobs } from '../../core/src/media-jobs.js';
import { AssistantStore } from './store.js';
import { PiHarness, piAvailable } from './pi.js';
import { ApprovalBroker, toolAllowedInMode } from './permissions.js';
import { resolveImages, validateInspector } from './attachments.js';
import type { AssistantAttachments } from './contracts.js';
import type { GatewayContext } from './mcp-bridge.js';
import { taskTool } from './tasks.js';
import type { SourceChanges } from '../../core/src/source-changes.js';

export interface AssistantGateway {
  tools: HarnessTool[];
  call(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<HarnessResult>;
  close(): Promise<void>;
}
type ActiveRun = {
  binding: RunBinding; conversation: Conversation; turn: StoredTurn; controller: AbortController; attachments?: AssistantAttachments;
  accountContext: string; key: string; raw: string; published: string; calls: number; dispatching: boolean;
  harness?: RunHarness; gateway?: AssistantGateway; finished?: Promise<void>; timer?: ReturnType<typeof setTimeout>;
  sourceToken?: string;
};
type ServiceOptions = {
  home: string;
  startupKey?: string;
  secretProtection?: SecretProtection;
  createHarness?: () => RunHarness;
  createGateway?: (binding: RunBinding, signal: AbortSignal, context: GatewayContext) => Promise<AssistantGateway>;
  limits?: Partial<AssistantLimits>;
};
async function abortable<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort = () => {};
  try {
    return await Promise.race([task, new Promise<never>((_, reject) => {
      abort = () => reject(signal.reason);
      if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
    })]);
  } finally { signal.removeEventListener('abort', abort); }
}
export class AssistantService {
  readonly epoch = randomUUID();
  private accountContext = () => '';
  private accountVersion = 0;
  private sourceChanges?: SourceChanges;
  private sourceSelection?: (projectId: string) => Promise<void>;
  useSourceChanges(changes: SourceChanges, selection: (projectId: string) => Promise<void>) { this.idle(); this.sourceChanges = changes; this.sourceSelection = selection; }
  async interruptAccountWork() { this.accountVersion++; if (this.active) await this.stop(this.active.binding.runId); }
  useAccountContext(context: () => string) { this.accountContext = context; }
  accountChanged() { this.changed(); }
  private localKey = '';
  private shared?: MediaJobs;
  private unsubscribeCredential?: () => void;
  private get key() { return this.closed ? '' : this.shared?.providerCredential().key ?? this.localKey; }
  private set key(value: string) { this.localKey = value; }
  private model = 'gpt-6-astra';
  private models = [{ id: 'gpt-6-astra', label: 'GPT-6 Astra' }];
  private modelSettings: PrivateSettingsStore<{ model: string }>;
  private storePromise?: Promise<AssistantStore>;
  private active?: ActiveRun;
  private starting = false;
  private closed = false;
  private sequence = 0;
  private buffer: AssistantEvent[] = [];
  private bufferBytes = 0;
  private listeners = new Set<() => void>();
  private seenRuns = new Set<string>();
  private limits: AssistantLimits;
  private harnessAvailable: boolean;
  private approvals = new ApprovalBroker(() => { if (this.active) this.publish(this.active, { type: 'approval' }); });
  pendingApprovals() {
    const pending = this.approvals.list();
    if (this.key && JSON.stringify(pending).includes(this.key)) { this.approvals.close(); throw new BuilderError('INVALID_INPUT', 'Review contains a credential and cannot be displayed or approved'); }
    return pending;
  }
  approve(input: unknown) {
    if (!this.active || this.active.controller.signal.aborted) throw new BuilderError('REVISION_CONFLICT', 'No active turn is waiting for approval');
    this.pendingApprovals(); this.approvals.respond(input);
  }
  private credentials: CredentialStore;
  private source: 'environment' | 'saved' | 'session' | 'none' = 'none';
  constructor(private options: ServiceOptions) {
    this.limits = { ...ASSISTANT_LIMITS, ...options.limits }; this.harnessAvailable = !!options.createHarness || piAvailable();
    this.credentials = sharedOpenAIStore(options.home, options.secretProtection);
    this.modelSettings = new PrivateSettingsStore(options.home, 'assistant-model', z.object({ model: z.string().min(1).max(100) }).strict());
    this.model = this.modelSettings.load()?.model ?? this.model;
    let saved: string | undefined, locked = false;
    try { saved = this.credentials.load(); } catch { locked = true; }
    this.key = saved ?? (!locked && options.startupKey ? credentialKeySchema.parse(options.startupKey) : '');
    this.source = saved ? 'saved' : this.key ? 'environment' : 'none';
  }
  status() { return { sourceChanges: !!this.sourceChanges, accountContext: this.accountContext(), available: !!this.options.createGateway && this.harnessAvailable && !this.closed, configured: !!this.key, source: this.key ? this.shared?.providerCredential().source ?? this.source : 'none', environmentAvailable: (this.shared?.providerCredential().environmentAvailable ?? !!this.options.startupKey) && !this.closed, provider: 'OpenAI', model: this.model, models: this.models, epoch: this.epoch, busy: this.starting || !!this.active, active: this.active ? { ...this.active.binding, state: this.active.turn.state, mode: this.active.turn.mode ?? 'build' } : null, limits: this.limits }; }
  async useOpenAI(shared: MediaJobs) {
    this.idle(); this.unsubscribeCredential?.(); this.shared = shared; this.localKey = '';
    this.unsubscribeCredential = shared.subscribeProvider(() => this.changed(), () => { if (!this.closed) this.idle(); });
    if (piAvailable()) {
      const { ModelRuntime } = await import('@earendil-works/pi-coding-agent');
      const runtime = await ModelRuntime.create({ credentials: { async read() {}, async list() { return []; }, async modify() { throw new Error('Credential persistence disabled'); }, async delete() {} }, modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
      this.models = runtime.getModels('openai').filter(model => model.api === 'openai-responses' && model.input.includes('image') && !/chat|realtime/.test(model.id)).map(model => ({ id: model.id, label: model.name }));
    }
  }
  configure(input: unknown) {
    this.idle();
    const value = z.discriminatedUnion('action', [z.object({ action: z.literal('model'), model: z.string().min(1).max(100) }).strict(), z.object({ action: z.literal('connect'), key: credentialKeySchema, remember: z.boolean().default(false) }).strict(), z.object({ action: z.literal('disconnect') }).strict(), z.object({ action: z.literal('environment') }).strict()]).parse(input);
    if (value.action === 'model') {
      if (!this.models.some(model => model.id === value.model)) throw new BuilderError('INVALID_INPUT', 'Choose a supported assistant model.');
      this.modelSettings.save({ model: value.model }); this.model = value.model; this.changed(); return this.status();
    }
    if (this.shared) throw new BuilderError('INVALID_INPUT', 'Manage the shared OpenAI API key in OpenAI setup.');
    if (value.action === 'environment' && !this.options.startupKey) throw new BuilderError('INVALID_INPUT', 'No startup environment key is available.');
    if (value.action === 'connect' && value.remember) this.credentials.save(value.key); else this.credentials.remove();
    this.key = value.action === 'connect' ? value.key : value.action === 'environment' ? this.options.startupKey! : '';
    this.source = value.action === 'connect' ? value.remember ? 'saved' : 'session' : value.action === 'environment' ? 'environment' : 'none';
    this.changed(); return this.status();
  }
  private idle() {
    if (this.closed) throw new BuilderError('PROCESS_FAILED', 'Assistant is closed');
    if (this.starting || this.active) throw new BuilderError('REVISION_CONFLICT', 'One assistant turn is already active. Stop it before making this change.');
  }
  private store() { return this.storePromise ??= AssistantStore.open(this.options.home, this.limits); }
  async createConversation(projectId: string | null) {
    this.idle(); if (projectId !== null) z.uuid().parse(projectId);
    const now = new Date().toISOString();
    const record: Conversation = { version: 1, id: randomUUID(), projectId, title: 'New conversation', createdAt: now, updatedAt: now, turns: [] };
    this.starting = true;
    try { await (await this.store()).create(record); return record; } finally { this.starting = false; }
  }
  async conversations(projectId: string | null, query = '') {
    const search = z.string().max(200).parse(query).trim().toLocaleLowerCase();
    return (await (await this.store()).list(projectId))
      .map(record => this.active?.binding.conversationId === record.id ? this.active.conversation : record)
      .filter(record => !search || [record.title, ...record.turns.flatMap(turn => [turn.prompt, turn.response, ...(turn.tasks?.map(task => task.label) ?? [])])].some(text => text.toLocaleLowerCase().includes(search)))
      .map(({ id, title, projectId: scope, createdAt, updatedAt, turns }) => ({ id, title, projectId: scope, createdAt, updatedAt, turns: turns.length, state: turns.at(-1)?.state ?? null }));
  }
  async conversation(id: string) {
    z.uuid().parse(id);
    if (this.active?.binding.conversationId === id) return structuredClone(this.active.conversation);
    return (await this.store()).read(id);
  }
  async deleteConversation(id: string) {
    this.idle(); this.starting = true;
    try {
      await this.conversation(id);
      await this.sourceChanges?.removeConversation(id);
      await (await this.store()).remove(id);
      this.buffer = this.buffer.filter(event => event.conversationId !== id);
      this.bufferBytes = this.buffer.reduce((bytes, event) => bytes + Buffer.byteLength(JSON.stringify(event)), 0);
    } finally { this.starting = false; }
  }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private async changeScope(conversationId: string, runId: string) {
    if (!this.sourceChanges) throw new BuilderError('INVALID_INPUT', 'Source recovery is unavailable in this runtime');
    const conversation = await this.conversation(conversationId);
    const turn = conversation.turns.find(turn => turn.id === runId), projectId = turn?.projectId ?? conversation.projectId;
    if (!projectId || !turn) throw new BuilderError('INVALID_INPUT', 'This source checkpoint does not belong to the conversation');
    return { conversationId, runId, projectId };
  }
  async reviewChanges(conversationId: string, runId: string) { const scope = await this.changeScope(conversationId, runId); return this.sourceChanges!.inspect(scope); }
  async changeDiff(conversationId: string, runId: string, file: string) { const scope = await this.changeScope(conversationId, runId); return this.sourceChanges!.diff(scope, file); }
  async restoreChanges(conversationId: string, runId: string, expectedRevision: string) {
    this.idle(); this.starting = true; this.changed();
    const context = this.accountContext(), version = this.accountVersion;
    const guard = () => { if (this.closed || context !== this.accountContext() || version !== this.accountVersion) throw new BuilderError('REVISION_CONFLICT', 'Account changed during source restore. Review the checkpoint again.'); };
    try {
      const scope = await this.changeScope(conversationId, runId);
      return await this.sourceChanges!.restore(scope, expectedRevision, async () => { guard(); await this.sourceSelection?.(scope.projectId); guard(); });
    } finally { this.starting = false; this.changed(); }
  }
  events(after: number, epoch: string | null = this.epoch) {
    z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).parse(after);
    if (epoch !== null) z.uuid().parse(epoch);
    const changedEpoch = epoch !== this.epoch;
    return { epoch: this.epoch, sequence: this.sequence, reset: changedEpoch || after > this.sequence || after < (this.buffer[0]?.sequence ?? this.sequence + 1) - 1, events: structuredClone(this.buffer.filter(event => changedEpoch || event.sequence > after)), status: this.status(), approvals: this.pendingApprovals() };
  }
  private changed() {
    for (const listener of this.listeners) { try { listener(); } catch { /* A disconnected consumer does not own the run. */ } }
  }
  private publish(run: ActiveRun, event: Pick<AssistantEvent, 'type' | 'text' | 'state' | 'tool'>) {
    if (this.closed || this.active !== run) return;
    const next = { ...run.binding, ...event, sequence: ++this.sequence };
    this.buffer.push(next); this.bufferBytes += Buffer.byteLength(JSON.stringify(next));
    while (this.buffer.length && (this.buffer.length > this.limits.events || this.bufferBytes > this.limits.eventBytes)) this.bufferBytes -= Buffer.byteLength(JSON.stringify(this.buffer.shift()));
    this.changed();
  }
  async start(input: unknown) {
    this.idle();
    if (!this.options.createGateway || !this.key) throw new BuilderError('INVALID_INPUT', 'Configure the available assistant before sending a message');
    if (!this.models.some(model => model.id === this.model)) throw new BuilderError('INVALID_INPUT', 'The saved assistant model is unavailable. Choose a supported model in Settings.');
    const value = startTurnSchema.parse(input);
    if (Buffer.byteLength(value.prompt) > this.limits.promptBytes) throw new BuilderError('LIMIT_EXCEEDED', 'Assistant prompt is too large');
    if (this.seenRuns.has(value.runId)) throw new BuilderError('REVISION_CONFLICT', 'This turn was already submitted. It will not be resubmitted.');
    if (this.seenRuns.size >= 10_000) throw new BuilderError('LIMIT_EXCEEDED', 'Assistant runtime turn limit reached. Restart before continuing.');
    this.starting = true;
    const accountContext = this.accountContext(), accountVersion = this.accountVersion;
    const accountChanged = () => accountVersion !== this.accountVersion || accountContext !== this.accountContext();
    try {
      const store = await this.store();
      const conversation = await store.read(value.conversationId);
      const attachments = value.attachments;
      if ((attachments?.inspector && attachments.inspector.projectId !== conversation.projectId) || attachments?.images?.some(image => image.projectId !== conversation.projectId)) throw new BuilderError('INVALID_INPUT', 'Attachments must belong to the conversation project');
      if (attachments && JSON.stringify(attachments).includes(this.key)) throw new BuilderError('INVALID_INPUT', 'Credentials cannot be attached');
      if (await store.hasRun(value.runId)) throw new BuilderError('REVISION_CONFLICT', 'This turn was already submitted. It will not be resubmitted.');
      if (this.closed) throw new BuilderError('PROCESS_FAILED', 'Assistant is closed');
      if (accountChanged()) throw new BuilderError('REVISION_CONFLICT', 'Account changed before the turn started. Review your draft before sending again.');
      const turn: StoredTurn = { id: value.runId, epoch: this.epoch, state: 'starting', model: this.model, mode: value.mode, prompt: value.prompt.replaceAll(this.key, '[redacted]'), response: '', startedAt: new Date().toISOString(), tools: [] };
      turn.projectId = conversation.projectId;
      if (attachments?.inspector) turn.inspector = { projectId: attachments.inspector.projectId, viewId: attachments.inspector.viewId, route: attachments.inspector.selection.pathname, timestamp: attachments.inspector.selection.timestamp };
      conversation.turns.push(turn); conversation.updatedAt = turn.startedAt;
      if (conversation.turns.length === 1) conversation.title = turn.prompt.slice(0, 100);
      // Reserve worst-case JSON escaping and bounded tool summaries before authorizing provider work.
      await store.save(conversation, this.limits.responseBytes * 6 + this.limits.tools * 1024 + 4096);
      if (this.closed) throw new BuilderError('PROCESS_FAILED', 'Assistant closed during startup');
      if (accountChanged()) {
        turn.state = 'interrupted'; turn.endedAt = new Date().toISOString(); turn.notice = 'Account changed before the turn started. No provider request was made.';
        await store.save(conversation); throw new BuilderError('REVISION_CONFLICT', turn.notice);
      }
      const run: ActiveRun = { accountContext, binding: { epoch: this.epoch, runId: value.runId, conversationId: conversation.id, projectId: conversation.projectId }, conversation, turn, attachments, controller: new AbortController(), key: this.key, raw: '', published: '', calls: 0, dispatching: false };
      this.seenRuns.add(value.runId); this.active = run;
      this.publish(run, { type: 'state', state: 'starting' });
      run.timer = setTimeout(() => { this.cancel(run, 'limited', 'The turn deadline was reached. Send a new message to continue.'); }, this.limits.turnMs);
      run.finished = this.execute(run);
      return { ...run.binding };
    } finally { this.starting = false; }
  }
  private guard(run: ActiveRun) {
    run.controller.signal.throwIfAborted();
    if (this.closed || run.accountContext !== this.accountContext() || this.active !== run || run.binding.epoch !== this.epoch) throw new Error('Assistant turn is no longer active');
  }
  private safeResponse(run: ActiveRun, final = false) {
    let safe = run.raw.replaceAll(run.key, '[redacted]');
    for (let length = Math.min(run.key.length - 1, safe.length); length > 0; length--) if (safe.endsWith(run.key.slice(0, length))) {
      if (!final || length >= 8) safe = safe.slice(0, -length) + (final ? '[redacted]' : '');
      break;
    }
    return safe;
  }
  private text(run: ActiveRun, text: string, final = false) {
    this.guard(run);
    if (Buffer.byteLength(run.raw) + Buffer.byteLength(text) > this.limits.responseBytes) { this.cancel(run, 'limited', 'The response limit was reached. Send a new message to continue.'); throw new Error('Response limit reached'); }
    run.raw += text;
    const safe = this.safeResponse(run, final);
    run.turn.response = safe;
    const delta = safe.slice(run.published.length); run.published = safe;
    for (let offset = 0; offset < delta.length; offset += 8192) this.publish(run, { type: 'text', text: delta.slice(offset, offset + 8192) });
  }
  private async execute(run: ActiveRun) {
    try {
      const factory = this.options.createGateway;
      if (!factory) throw new Error('No assistant gateway');
      if (run.turn.mode !== 'plan') run.sourceToken = this.sourceChanges?.begin(run.binding, run.controller.signal);
      const gateway = factory(run.binding, run.controller.signal, {
        approvals: this.approvals,
        mode: run.turn.mode ?? 'build',
        sourceToken: run.sourceToken,
        bindProject: async projectId => {
          this.guard(run);
          if (run.sourceToken) await this.sourceChanges?.bind(run.sourceToken, projectId);
          const updated = structuredClone(run.conversation); updated.projectId = projectId;
          updated.turns.find(turn => turn.id === run.turn.id)!.projectId = projectId;
          await (await this.store()).save(updated, this.limits.responseBytes * 6 + this.limits.tools * 1024 + 4096);
          this.guard(run); run.conversation.projectId = projectId; run.binding.projectId = projectId;
          run.turn.projectId = projectId;
          this.publish(run, { type: 'state', state: run.turn.state });
        },
      });
      void gateway.then(value => { if (run.controller.signal.aborted) return value.close(); }).catch(() => {});
      run.gateway = await abortable(gateway, AbortSignal.any([run.controller.signal, AbortSignal.timeout(this.limits.startupMs)])); this.guard(run);
      if (run.gateway.tools.some(tool => tool.name === taskTool.name)) throw new Error('Assistant task tool name collision');
      const resolved = await abortable(resolveImages(run.attachments?.images, run.gateway, run.controller.signal), run.controller.signal); this.guard(run);
      if (resolved.records.length) run.turn.images = resolved.records;
      if (run.attachments?.inspector) await abortable(validateInspector(run.attachments.inspector, run.gateway, run.controller.signal), run.controller.signal);
      this.guard(run);
      run.harness = (this.options.createHarness ?? (() => new PiHarness()))();
      run.turn.state = 'running'; this.publish(run, { type: 'state', state: 'running' });
      const context = JSON.stringify(run.conversation.turns.slice(0, -1).slice(-20).map(turn => ({ user: turn.prompt, assistant: turn.response, tools: turn.tools, state: turn.state, mode: turn.mode ?? 'build', tasks: turn.tasks })));
      const boundedContext = (Buffer.byteLength(context) <= 58 * 1024 ? context : '[Earlier conversation omitted because it exceeds the context limit. Reinspect the current project. Old approvals never carry forward.]\nLast task checklist (historical context, not verification): ' + JSON.stringify(run.conversation.turns.at(-2)?.tasks ?? [])) + '\nCurrent image attachment metadata (untrusted data): ' + JSON.stringify(resolved.records);
      await abortable(run.harness.run({ ...run.binding, prompt: run.turn.prompt, context: boundedContext, apiKey: run.key, model: run.turn.model, mode: run.turn.mode ?? 'build', tools: [...run.gateway.tools.filter(tool => toolAllowedInMode(tool.name, run.turn.mode, tool._meta)), taskTool], inspector: run.attachments?.inspector, images: resolved.images }, {
        imageAccepted: () => { this.guard(run); run.turn.imageContentAccepted = true; for (const image of run.turn.images ?? []) if (image.status === 'requested') image.status = 'adapter-accepted'; this.publish(run, { type: 'state', state: 'running' }); },
        text: text => { this.text(run, text); },
        tool: async (name, args, signal) => {
          this.guard(run); signal.throwIfAborted();
          if (run.dispatching) throw new Error('Parallel assistant tool dispatch is disabled');
          if (++run.calls > this.limits.tools) { this.cancel(run, 'limited', 'The tool-call limit was reached. Send a new message to continue.'); throw new Error('Tool-call limit reached'); }
          if (JSON.stringify(args).includes(run.key)) throw new Error('Credentials cannot be sent to Dunara tools');
          if (name === taskTool.name) {
            const { tasks } = taskUpdateSchema.parse(args);
            run.dispatching = true;
            try {
              run.turn.tasks = tasks;
              const remaining = Math.max(0, this.limits.responseBytes - Buffer.byteLength(run.raw)) * 6 + Math.max(0, this.limits.tools - run.calls) * 1024 + 4096;
              await (await this.store()).save(structuredClone(run.conversation), remaining); this.guard(run);
              this.publish(run, { type: 'state', state: run.turn.state });
              return { content: [{ type: 'text', text: 'Task checklist updated.' }] };
            } finally { run.dispatching = false; }
          }
          if (!toolAllowedInMode(name, run.turn.mode, run.gateway?.tools.find(tool => tool.name === name)?._meta)) throw new Error('Plan mode only permits inspection and proposals. Ask the user to switch to Build mode before making changes.');
          if (!run.gateway?.tools.some(tool => tool.name === name)) throw new Error('Unadvertised tool');
          run.dispatching = true; this.publish(run, { type: 'tool', tool: name });
          try {
            const result = await run.gateway.call(name, args, run.controller.signal); this.guard(run);
            run.turn.tools.push({ name, state: result.isError ? 'failed' : 'completed' });
            return result;
          } catch (error) {
            if (this.active === run && !run.turn.endedAt) run.turn.tools.push({ name, state: run.controller.signal.aborted ? 'cancelled' : 'failed' });
            throw error;
          } finally { run.dispatching = false; }
        },
      }, run.controller.signal), run.controller.signal);
      this.guard(run); this.text(run, '', true); run.turn.state = 'completed';
    } catch {
      if (!run.controller.signal.aborted) { run.turn.state = 'failed'; run.turn.notice = 'The assistant could not complete this turn. Check configuration and diagnostics, then explicitly send a new message. No automatic retry was made.'; }
    } finally {
      clearTimeout(run.timer);
      run.controller.abort();
      try {
        await abortable(Promise.all([run.harness?.close(), run.gateway?.close()]), AbortSignal.timeout(this.limits.shutdownMs));
      } catch {
        run.turn.state = 'failed'; this.closed = true; this.key = '';
        run.turn.notice = 'Assistant cleanup did not complete. Restart the backend before continuing.';
      }
      run.turn.endedAt = new Date().toISOString(); run.conversation.updatedAt = run.turn.endedAt;
      if (run.sourceToken) {
        try { await this.sourceChanges?.finish(run.sourceToken); }
        catch { run.turn.notice = 'Source checkpoint finalization needs attention. Review source changes before continuing; no restore was run.'; }
      }
      run.raw = ''; run.key = '';
      try { await (await this.store()).save(run.conversation); } catch { run.turn.state = 'failed'; run.turn.notice = 'The final response could not be saved. Delete history to free space before continuing.'; }
      this.publish(run, { type: 'state', state: run.turn.state });
      if (this.active === run) this.active = undefined;
      this.changed();
    }
  }
  private cancel(run: ActiveRun, state: TurnState, notice: string) {
    if (this.active !== run || run.controller.signal.aborted) return;
    run.turn.state = state; run.turn.notice = notice; run.controller.abort(); this.publish(run, { type: 'state', state });
    void run.harness?.close().catch(() => {});
  }
  async stop(runId: string) {
    z.uuid().parse(runId);
    const run = this.active;
    if (!run || run.binding.runId !== runId) throw new BuilderError('REVISION_CONFLICT', 'This turn is not active');
    this.cancel(run, 'cancelled', 'Stopped. Completed writes remain visible. Cancellation is not rollback or a guaranteed refund.');
    await run.finished;
  }
  async close() {
    if (this.closed) return;
    const run = this.active;
    if (run) this.cancel(run, 'interrupted', 'The assistant closed. Send a new message to continue; no prompt will be resubmitted.');
    this.closed = true; this.key = ''; this.unsubscribeCredential?.(); this.listeners.clear();
    await run?.finished;
  }
}
