import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { z } from 'zod';
import { Engine } from '../../core/src/engine.js';
import { BuilderError, captureRouteSchema, createSchema, errorResult, routeSchema, viewportSchema } from '../../core/src/contracts.js';
import { designUpdateSchema } from '../../core/src/design.js';
import { presets, recipes } from '../../templates/src/catalog.js';
import { approveAssetSchema, briefUpdateSchema, importSchema, jobIdSchema, MEDIA_BYTES, transformSchema } from '../../core/src/media-contracts.js';
import { jobRequestSchema } from '../../core/src/media-job-contracts.js';
import { paidApprovalSchema } from '../../core/src/provider-contracts.js';
import { iconApplySchema, iconCheckSchema, iconPrepareSchema, iconPreviewSchema } from '../../core/src/icon-contracts.js';
import { applyInspectorSetup, previewInspectorSetup } from '../../core/src/preview-inspector.js';
import { AssistantDrafts, draftScopeSchema, revalidateDraft } from '../../assistant/src/drafts.js';
import type { AssistantService } from '../../assistant/src/service.js';
import { environmentName, PlatformError, publicError } from '../../platform/src/contracts.js';
import { logicalSecret } from '../../platform/src/configuration.js';
import { nativeBuildConfiguration } from '../../core/src/native-builds.js';
import { workspaceSelection } from '../../core/src/native-workspace-contracts.js';
import { routeOwner } from '../../builtin-plugins/src/catalog.js';
import { pluginId } from '../../plugin-runtime/src/contracts.js';
import { ProjectJourney } from '../../core/src/journey.js';
import { ProjectExports } from '../../core/src/project-export.js';

const equal = (actual: string | undefined, expected: string) => !!actual && Buffer.byteLength(actual) === Buffer.byteLength(expected) && timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
async function body(req: IncomingMessage, limit = 1_000_000): Promise<unknown> {
  if (req.headers['content-type'] !== 'application/json') throw new BuilderError('INVALID_INPUT', 'Use application/json');
  if (req.headers['content-encoding']) throw new BuilderError('INVALID_INPUT', 'Compressed request bodies are not supported');
  if (Number(req.headers['content-length']) > limit) throw new BuilderError('LIMIT_EXCEEDED', 'Request body exceeds the allowed size');
  let bytes = 0; const chunks: Buffer[] = [];
  for await (const chunk of req) { bytes += chunk.length; if (bytes > limit) throw new BuilderError('LIMIT_EXCEEDED', 'Request body exceeds the allowed size'); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new BuilderError('INVALID_INPUT', 'Malformed JSON request. Check the form and submit again.'); }
}
function sendJson(res: ServerResponse, value: unknown, status = 200) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); }
export async function startStudio(engine: Engine, assets: string, assistant?: AssistantService, options: { port?: number } = {}) {
  const port = z.number().int().min(0).max(65535).parse(options.port ?? 0);
  // Async stores commit at the write. Legacy synchronous settings stage immutable records;
  // their acknowledgment barrier must finish before a successful transport response.
  async function json(res: ServerResponse, value: unknown, status = 200) {
    if (status < 400) await engine.projects.flushState();
    sendJson(res, value, status);
  }
  assistant?.useSourceChanges(engine.sourceChanges, async projectId => {
    if ((await engine.studio.snapshot()).projectId !== projectId) throw new BuilderError('REVISION_CONFLICT', 'Select the conversation’s app before restoring its source.');
  });
  const journey = new ProjectJourney(engine.projects, id => engine.boardCaptures.sourceRevision(id));
  const projectExports = new ProjectExports(engine.projects);
  await engine.plugins.ready;
  if (engine.plugins.isEnabled('builder.account')) await engine.account.restore();
  const drafts = new AssistantDrafts(engine.projects.home, assistant?.epoch ?? randomUUID(), () => engine.account.context());
  assistant?.useAccountContext(() => engine.account.context().revision);
  let accountChanging = false;
  async function changeAccount<T>(work: () => Promise<T>) {
    if (accountChanging) throw new PlatformError('REVISION_CONFLICT', 'An account change is already in progress.', 409);
    accountChanging = true;
    try { await assistant?.interruptAccountWork(); engine.plugins.interrupt(); engine.backendOAuth.clear(); return await work(); }
    finally { accountChanging = false; assistant?.accountChanged(); }
  }
  await assistant?.useOpenAI(engine.mediaJobs);
  const token = randomBytes(32).toString('hex'); let ticket = '', expires = 0;
  const issueLaunchUrl = () => { ticket = randomBytes(32).toString('hex'); expires = Date.now() + 60_000; return `${origin}/#${ticket}`; };
  let origin = '', host = '';
  const assistantStreams = new Set<ServerResponse>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024, perMessageDeflate: false, handleProtocols: () => 'builder' });
  const server = createServer((req, res) => { void handle(req, res).catch(error => {
    const failure = req.url?.startsWith('/api/assistant/') && !(error instanceof BuilderError) ? { error: { message: 'Invalid assistant request or stale approval. Refresh the conversation and review the input before retrying.' } } : errorResult(error);
    if (!res.headersSent) json(res, failure, 400); else res.end();
  }); });
  server.requestTimeout = 15_000; server.headersTimeout = 10_000; server.maxConnections = 40;
  async function handle(req: IncomingMessage, res: ServerResponse) {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob:; connect-src 'self'; frame-src http://localhost:*; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    if (req.headers.host !== host || (req.headers.origin && req.headers.origin !== origin)) return json(res, { error: { message: 'Forbidden origin or host' } }, 403);
    const url = new URL(req.url ?? '/', origin);
    if (url.search || /[%\\]/.test(req.url ?? '')) return json(res, { error: { message: 'Invalid path' } }, 400);
    if (req.method === 'POST' && req.headers.origin !== origin) return json(res, { error: { message: 'Origin required' } }, 403);
    const pluginAsset = url.pathname.match(/^\/plugin-assets\/([a-z0-9.-]+)\/([a-f0-9]{64})\/([a-f0-9-]{36})\/(.+)$/);
    if (pluginAsset && req.method === 'GET') {
      const content = await engine.plugins.asset(pluginAsset[1]!, pluginAsset[2]!, pluginAsset[3]!, pluginAsset[4]!);
      res.writeHead(200, { 'Content-Type': pluginAsset[4]!.endsWith('.css') ? 'text/css' : pluginAsset[4]!.endsWith('.svg') ? 'image/svg+xml' : 'text/javascript' }); return res.end(content);
    }
    if (req.method === 'POST' && url.pathname === '/api/bootstrap') {
      const input = z.object({ ticket: z.string().max(100) }).strict().parse(await body(req));
      if (!ticket || Date.now() > expires || !equal(input.ticket, ticket)) return json(res, { error: { message: 'Launch link expired. Restart the studio to open a fresh session.' } }, 401);
      ticket = ''; return json(res, { token });
    }
    if (url.pathname.startsWith('/api/')) {
      if (!equal(req.headers.authorization, `Bearer ${token}`)) return json(res, { error: { message: 'Studio authentication required' } }, 401);
      if (url.pathname === '/api/protocol' && req.method === 'GET') return json(res, { version: 1, sdkApi: 1 });
      const projectDownload = url.pathname.match(/^\/api\/projects\/([a-f0-9-]+)\/download$/);
      if (projectDownload) {
        if (req.method !== 'GET') return json(res, { error: { message: 'Method not allowed' } }, 405);
        const controller = new AbortController();
        const disconnect = () => { if (!res.writableEnded) controller.abort(); }; res.on('close', disconnect);
        try {
          const archive = await projectExports.download(z.uuid().parse(projectDownload[1]), controller.signal);
          if (controller.signal.aborted) return;
          res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': archive.bytes.length, 'Content-Disposition': `attachment; filename="${archive.filename}"` });
          return res.end(archive.bytes);
        } finally { res.off('close', disconnect); }
      }
      if (url.pathname === '/api/plugins' && req.method === 'GET') return json(res, { plugins: engine.plugins.snapshot(), reviews: engine.plugins.reviewsFor(), operations: engine.plugins.operationList(), recovery: engine.plugins.recovery });
      if (url.pathname.startsWith('/api/plugins/') && req.method === 'POST') {
        const operation = url.pathname.slice('/api/plugins/'.length), input = await body(req);
        if (operation === 'inspect') { const value = z.object({ source: z.string().min(1).max(4096) }).strict().parse(input); return json(res, await engine.plugins.inspect(value.source)); }
        if (operation === 'install') { const value = z.object({ source: z.string().max(4096), digest: z.string().regex(/^[a-f0-9]{64}$/), trust: z.literal(true), development: z.boolean().default(false) }).strict().parse(input); await assistant?.interruptAccountWork(); return json(res, await engine.plugins.install(value.source, value.digest, value.trust, value.development)); }
        if (operation === 'change') { const value = z.object({ id: pluginId, operation: z.enum(['enable', 'disable', 'uninstall', 'reload', 'rollback']) }).strict().parse(input); await assistant?.interruptAccountWork(); return json(res, await engine.plugins.change(value.id, value.operation)); }
        if (operation === 'restore') { z.object({ confirm: z.literal(true) }).strict().parse(input); return json(res, await engine.plugins.restoreDefaults()); }
        if (operation === 'invoke') { const value = z.object({ id: pluginId, action: z.string().max(64), input: z.json().default({}), projectId: z.uuid().nullable().default(null) }).strict().parse(input); return json(res, await engine.plugins.invoke(value.id, value.action, value.input, value.projectId)); }
        if (operation === 'review') { const value = z.object({ id: z.uuid(), approve: z.boolean() }).strict().parse(input); return json(res, await engine.plugins.answerReview(value.id, value.approve)); }
        if (operation === 'guide') { const value = z.object({ id: pluginId, name: z.string().max(240) }).strict().parse(input); return json(res, { content: await engine.plugins.guide(value.id, value.name) }); }
        if (operation === 'settings') { const value = z.object({ id: pluginId }).strict().parse(input); return json(res, await engine.plugins.settings(value.id)); }
        if (operation === 'setting') { const value = z.object({ id: pluginId, key: z.string().max(48), value: z.json() }).strict().parse(input); await engine.plugins.setSetting(value.id, value.key, value.value); return json(res, { saved: true }); }
        if (operation === 'credential') { const value = z.object({ id: pluginId, name: z.string().max(48), value: z.string().max(8192).nullable() }).strict().parse(input); await engine.plugins.setCredential(value.id, value.name, value.value); return json(res, { saved: true }); }
        if (operation === 'cancel') { const value = z.object({ id: pluginId }).strict().parse(input); engine.plugins.cancel(value.id); return json(res, { cancellationRequested: true }); }
        return json(res, { error: { message: 'Unknown plugin operation' } }, 404);
      }
      const owner = routeOwner(url.pathname); if (owner) engine.plugins.assertEnabled(owner);
      if (url.pathname.startsWith('/api/account/')) {
        try {
          const action = url.pathname.slice('/api/account/'.length);
          if (action === 'status' && req.method === 'GET') return json(res, engine.account.status());
          if (action === 'workspaces' && req.method === 'GET') return json(res, await engine.account.workspaces());
          if (req.method !== 'POST') return json(res, { error: { message: 'Method not allowed' } }, 405);
          const input = await body(req, 8192);
          if (action === 'request-code') { const value = z.object({ email: z.email().max(254) }).strict().parse(input); return json(res, await engine.account.requestCode(value.email)); }
          if (action === 'verify-code') { const value = z.object({ email: z.email().max(254), code: z.string().regex(/^\d{6,10}$/), remember: z.boolean().default(false) }).strict().parse(input); return json(res, await changeAccount(() => engine.account.verify(value.email, value.code, value.remember))); }
          if (action === 'sign-out') { z.object({}).strict().parse(input); return json(res, await changeAccount(() => engine.account.signOut())); }
          if (action === 'create-workspace') { const value = z.object({ name: z.string().min(1).max(100) }).strict().parse(input); return json(res, { id: await engine.account.createWorkspace(value.name) }); }
          if (action === 'register-app') {
            const value = z.object({ projectId: z.uuid(), workspaceId: z.uuid() }).strict().parse(input);
            const project = await engine.projects.get(value.projectId);
            return json(res, await engine.account.registerApp({ id: project.id, workspaceId: value.workspaceId, name: project.name, slug: project.slug }));
          }
          return json(res, { error: { message: 'Account endpoint not found' } }, 404);
        } catch (error) { return json(res, { error: publicError(error) }, error instanceof PlatformError ? error.status : 400); }
      }
      const servicesRecipe = url.pathname.match(/^\/api\/projects\/([a-f0-9-]+)\/service-recipe$/);
      if (servicesRecipe) {
        const id = z.uuid().parse(servicesRecipe[1]);
        if (req.method === 'GET') return json(res, await engine.serviceRecipe.preview(id));
        if (req.method === 'POST') return json(res, await engine.serviceRecipe.apply(id, await body(req, 8192)));
        return json(res, { error: { message: 'Method not allowed' } }, 405);
      }
      const deliveryRoute = url.pathname.match(/^\/api\/projects\/([a-f0-9-]+)\/native-deliveries(?:\/(preflight|plan|build|install-plan|install|launch|cancel|remove))?$/);
      if (deliveryRoute) {
        const id = z.uuid().parse(deliveryRoute[1]), action = deliveryRoute[2];
        if (req.method === 'GET' && !action) return json(res, await engine.actions.value('native_delivery_list', { projectId: id }));
        if (req.method === 'POST' && action) {
          const input = await body(req, 8192);
          return json(res, await engine.actions.value(`native_delivery_${action.replace('-', '_')}`, { projectId: id, ...(action === 'plan' ? { selection: input } : action === 'preflight' ? {} : { input }) }));
        }
        return json(res, { error: { message: 'Method not allowed' } }, 405);
      }
      const workspaceRoute = url.pathname.match(/^\/api\/projects\/([a-f0-9-]+)\/native-workspaces(?:\/(plan|prepare|cancel|remove))?$/);
      if (workspaceRoute) {
        const id = z.uuid().parse(workspaceRoute[1]), action = workspaceRoute[2];
        if (req.method === 'GET' && !action) return json(res, { workspaces: await engine.nativeWorkspaces.list(id) });
        if (req.method === 'POST') {
          const input = await body(req, 8192);
          if (action === 'plan') return json(res, await engine.actions.value('native_workspace_plan', { projectId: id, selection: workspaceSelection.parse(input) }));
          if (action === 'prepare') return json(res, await engine.actions.value('native_workspace_prepare', { projectId: id, input }));
          if (action === 'cancel') return json(res, await engine.actions.value('native_workspace_cancel', { projectId: id, input }));
          if (action === 'remove') return json(res, await engine.actions.value('native_workspace_remove', { projectId: id, input }));
        }
        return json(res, { error: { message: 'Method not allowed' } }, 405);
      }
      const nativeBuild = url.pathname.match(/^\/api\/projects\/([a-f0-9-]+)\/native-build(?:\/(plan|apply))?$/);
      if (nativeBuild) {
        const id = z.uuid().parse(nativeBuild[1]);
        if (req.method === 'GET' && !nativeBuild[2]) return json(res, await engine.actions.value('native_build_inspect', { projectId: id }));
        if (req.method === 'POST' && nativeBuild[2] === 'plan') {
          const input = z.object({ configuration: nativeBuildConfiguration.optional() }).strict().parse(await body(req, 8192));
          return json(res, await engine.actions.value('native_build_plan', { projectId: id, configuration: input.configuration }));
        }
        if (req.method === 'POST' && nativeBuild[2] === 'apply') return json(res, await engine.actions.value('native_build_apply', { projectId: id, input: await body(req, 8192) }));
        return json(res, { error: { message: 'Method not allowed' } }, 405);
      }
      const upgrade = url.pathname.match(/^\/api\/projects\/([a-f0-9-]+)\/recipe-upgrade(?:\/(apply))?$/);
      if (upgrade) {
        const id = z.uuid().parse(upgrade[1]);
        if (req.method === 'GET' && !upgrade[2]) return json(res, await engine.recipeUpgrades.preview(id));
        if (req.method === 'POST' && upgrade[2] === 'apply') return json(res, await engine.recipeUpgrades.apply(id, await body(req, 8192)));
        return json(res, { error: { message: 'Method not allowed' } }, 405);
      }
      const oauthRoute = url.pathname.match(/^\/api\/backend\/oauth\/(status|start|poll|disconnect)$/);
      if (oauthRoute) {
        try {
          if (oauthRoute[1] === 'status' && req.method === 'GET') return json(res, engine.backendOAuth.status());
          if (req.method !== 'POST') return json(res, { error: { message: 'Method not allowed' } }, 405);
          if (engine.backends.status().busy) throw new PlatformError('OPERATION_BUSY', 'Wait for backend operations to finish before changing connections.', 409);
          const input = await body(req, 8192);
          if (oauthRoute[1] === 'start') return json(res, await engine.backendOAuth.start(input));
          z.object({}).strict().parse(input);
          if (oauthRoute[1] === 'disconnect') return json(res, await engine.backendOAuth.disconnect());
          const status = await engine.backendOAuth.poll(); if (status.connected) engine.backends.activateOAuth(); return json(res, status);
        } catch (error) { return json(res, { error: publicError(error) }, error instanceof PlatformError ? error.status : 400); }
      }
      const backend = url.pathname.match(/^\/api\/projects\/([a-f0-9-]+)\/backend(?:\/(catalog|capabilities|plan|apply|approve|cancel|reconcile|environment|types|export|validate|requirements|input|remove-input|setup|function-environment|function-environment-list))?$/);
      if (url.pathname === '/api/backend/connection' || backend) {
        try {
          if (url.pathname === '/api/backend/connection') {
            if (req.method === 'GET') return json(res, engine.backends.status());
            if (req.method !== 'POST') return json(res, { error: { message: 'Method not allowed' } }, 405);
            const input = z.discriminatedUnion('action', [z.object({ action: z.literal('connect'), token: z.string().max(4096), remember: z.boolean().default(false) }).strict(), z.object({ action: z.literal('disconnect') }).strict()]).parse(await body(req, 8192));
            return json(res, input.action === 'disconnect' ? engine.backends.disconnect() : engine.backends.configure({ token: input.token, remember: input.remember }));
          }
          const id = z.uuid().parse(backend![1]), action = backend![2];
          if (req.method === 'GET' && !action) return json(res, await engine.backends.inspect(id));
          if (req.method === 'GET' && action === 'catalog') return json(res, await engine.backends.catalog(id));
          if (req.method === 'GET' && action === 'capabilities') return json(res, await engine.backends.capabilities(id));
          if (req.method !== 'POST' || !action) return json(res, { error: { message: 'Method not allowed' } }, 405);
          await engine.projects.get(id);
          const input = await body(req, action === 'apply' ? 600_000 : action === 'input' ? 24_000 : 8192);
          if (action === 'function-environment-list') { const value = z.object({ environment: environmentName }).strict().parse(input); return json(res, await engine.backends.configuration.functionEnvironment(id, value.environment, true)); }
          if (action === 'function-environment') return json(res, await engine.backends.configuration.declareFunctionEnvironment(id, input));
          if (action === 'validate') return json(res, await engine.backends.configuration.validate(id, input));
          if (action === 'setup') return json(res, await engine.backends.configuration.setup(id, input));
          if (action === 'requirements') { const value = z.object({ environment: environmentName }).strict().parse(input); return json(res, await engine.backends.configuration.requirements(id, value.environment)); }
          if (action === 'input') return json(res, engine.backends.configuration.secrets.supply(id, input));
          if (action === 'remove-input') { const value = z.object({ environment: environmentName, name: logicalSecret, expectedRevision: z.uuid().nullable() }).strict().parse(input); return json(res, engine.backends.configuration.secrets.remove(id, value.environment, value.name, value.expectedRevision)); }
          if (action === 'catalog') return json(res, await engine.backends.catalog(id, input));
          if (action === 'capabilities') { const value = z.object({ environment: environmentName.optional() }).strict().parse(input); return json(res, await engine.backends.capabilities(id, value.environment)); }
          if (action === 'plan') return json(res, await engine.backends.plan(id, input));
          if (action === 'apply') return json(res, await engine.backends.submit(id, input));
          if (action === 'approve') return json(res, await engine.backends.approve(id, input));
          if (action === 'reconcile') return json(res, await engine.backends.reconcile(id, input));
          if (action === 'cancel') { const value = z.object({ operationId: z.uuid() }).strict().parse(input); return json(res, await engine.backends.cancel(id, value.operationId)); }
          if (action === 'environment') return json(res, await engine.selectBackendEnvironment(id, input));
          const value = z.object({ environment: environmentName, expectedRevision: z.string().regex(/^[a-f0-9]{64}$/).nullable() }).strict().parse(input);
          return json(res, action === 'types' ? await engine.backends.generateTypes(id, value.environment, value.expectedRevision) : await engine.backends.exportConfiguration(id, value.environment, value.expectedRevision));
        } catch (error) { return json(res, error instanceof BuilderError ? errorResult(error) : { error: publicError(error) }, error instanceof PlatformError ? error.status : error instanceof BuilderError && error.code === 'REVISION_CONFLICT' ? 409 : 400); }
      }
      if (url.pathname === '/api/assistant/status') {
        if (req.method !== 'GET') return json(res, { error: { message: 'Method not allowed' } }, 405);
        return json(res, assistant?.status() ?? { available: false, configured: false, busy: false, active: null });
      }
      if (url.pathname.startsWith('/api/assistant/')) {
        if (!assistant || !assistant.status().available) return json(res, { error: { message: 'The assistant is unavailable in this runtime. Use the desktop app with its optional harness installed.' } }, 503);
        if (req.method !== 'POST') return json(res, { error: { message: 'Method not allowed' } }, 405);
        const action = url.pathname.slice('/api/assistant/'.length);
        if (!['connections/update', 'connections/sign-in', 'connections/answer', 'connections/cancel', 'drafts/read', 'drafts/save', 'drafts/configure', 'configure', 'conversations/list', 'conversations/create', 'conversations/read', 'conversations/delete', 'turns/start', 'turns/stop', 'approvals', 'events', 'changes/review', 'changes/file', 'changes/restore'].includes(action)) return json(res, { error: { message: 'Unknown assistant action' } }, 404);
        const input = await body(req, action === 'turns/start' || action === 'drafts/save' ? 256 * 1024 : 8192);
        if (action.startsWith('changes/')) {
          if (action === 'changes/review') {
            const value = z.object({ conversationId: z.uuid(), runId: z.uuid() }).strict().parse(input);
            return json(res, await assistant.reviewChanges(value.conversationId, value.runId));
          }
          if (action === 'changes/file') {
            const value = z.object({ conversationId: z.uuid(), runId: z.uuid(), path: z.string().max(240) }).strict().parse(input);
            return json(res, await assistant.changeDiff(value.conversationId, value.runId, value.path));
          }
          const value = z.object({ conversationId: z.uuid(), runId: z.uuid(), expectedRevision: z.string().regex(/^[a-f0-9]{64}$/), epoch: z.uuid(), accountContext: z.string(), confirmed: z.literal(true) }).strict().parse(input);
          if (accountChanging || value.epoch !== assistant.epoch || value.accountContext !== engine.account.context().revision) throw new BuilderError('REVISION_CONFLICT', 'The session or account changed. Review source changes again.');
          const result = await assistant.restoreChanges(value.conversationId, value.runId, value.expectedRevision);
          engine.diagnostics.emit('change', result.projectId); return json(res, result);
        }
        if (action.startsWith('drafts/')) {
          const { scope, update } = z.object({ scope: draftScopeSchema, update: z.unknown().optional() }).strict().parse(input);
          const context = engine.account.context().revision;
          if (scope.projectId) await engine.projects.get(scope.projectId);
          if (scope.conversationId && (await assistant.conversation(scope.conversationId)).projectId !== scope.projectId) throw new BuilderError('INVALID_INPUT', 'Draft conversation belongs to another project.');
          if (context !== engine.account.context().revision) throw new BuilderError('REVISION_CONFLICT', 'Account changed while loading the draft.');
          if (action === 'drafts/save') return json(res, drafts.save(scope, update));
          if (action === 'drafts/configure') return json(res, drafts.configure(scope, update));
          const snapshot = await revalidateDraft(drafts.read(scope), async reference => {
            try {
              if (reference.kind === 'media') { await engine.assets.read(reference.projectId, reference.id); return true; }
              if (reference.kind === 'board') return (await engine.boardCaptures.list(reference.projectId)).some(item => item.id === reference.id && !item.stale);
              return engine.captures.list(reference.projectId).some(item => item.id === reference.id);
            } catch { return false; }
          });
          if (context !== engine.account.context().revision) throw new BuilderError('REVISION_CONFLICT', 'Account changed while loading the draft.');
          return json(res, snapshot);
        }
        if (action === 'connections/update') return json(res, assistant.connectionUpdate(input));
        if (action === 'connections/sign-in') return json(res, await assistant.signIn(input));
        if (action === 'connections/answer') return json(res, assistant.signInAnswer(input));
        if (action === 'connections/cancel') return json(res, assistant.signInCancel(input));
        if (action === 'configure') return json(res, assistant.configure(input));
        if (action === 'conversations/list') {
          const { projectId, query } = z.object({ projectId: z.uuid().nullable(), query: z.string().max(200).optional() }).strict().parse(input);
          return json(res, await assistant.conversations(projectId, query));
        }
        if (action === 'conversations/create') {
          const { projectId } = z.object({ projectId: z.uuid().nullable() }).strict().parse(input);
          if (projectId) await engine.projects.get(projectId);
          return json(res, await assistant.createConversation(projectId));
        }
        if (action === 'conversations/read') { const { conversationId } = z.object({ conversationId: z.uuid() }).strict().parse(input); return json(res, await assistant.conversation(conversationId)); }
        if (action === 'conversations/delete') { const { conversationId } = z.object({ conversationId: z.uuid(), confirmed: z.literal(true) }).strict().parse(input); await assistant.deleteConversation(conversationId); drafts.removeConversation(conversationId); return json(res, { removed: true }); }
        if (action === 'turns/start') {
          const { epoch, turn, accountContext } = z.object({ epoch: z.uuid(), accountContext: z.string().optional(), turn: z.unknown() }).strict().parse(input);
          if (accountChanging || ((accountContext !== undefined || engine.account.status().available) && accountContext !== engine.account.context().revision)) throw new BuilderError('REVISION_CONFLICT', 'The Dunara account changed. Review the conversation before sending.');
          if (epoch !== assistant.epoch) throw new BuilderError('REVISION_CONFLICT', 'The backend restarted. Review the conversation before sending a new turn.');
          return json(res, await assistant.start(turn));
        }
        if (action === 'turns/stop') {
          const { epoch, conversationId, runId } = z.object({ epoch: z.uuid(), conversationId: z.uuid(), runId: z.uuid() }).strict().parse(input);
          const active = assistant.status().active;
          if (epoch !== assistant.epoch || active?.conversationId !== conversationId || active.runId !== runId) throw new BuilderError('REVISION_CONFLICT', 'This turn is no longer active');
          await assistant.stop(runId); return json(res, assistant.status());
        }
        if (action === 'approvals') { assistant.approve(input); return json(res, { accepted: true }); }
        const cursor = z.object({ after: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), epoch: z.uuid().nullable(), stream: z.boolean().default(false) }).strict().parse(input);
        if (!cursor.stream) return json(res, assistant.events(cursor.after, cursor.epoch));
        if (assistantStreams.size >= 4) return json(res, { error: { message: 'Assistant event connection limit reached. Use polling or close another Studio connection.' } }, 429);
        // Authenticated fetch, never a URL token. Slow clients reconnect from their last sequence.
        const initial = assistant.events(cursor.after, cursor.epoch);
        assistantStreams.add(res); res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'X-Accel-Buffering': 'no' });
        let after = initial.sequence; const epoch = initial.epoch;
        let ended = false, unsubscribe = () => {};
        const cleanup = () => { if (ended) return; ended = true; clearTimeout(deadline); unsubscribe(); assistantStreams.delete(res); };
        const end = () => { cleanup(); if (!res.writableEnded && !res.destroyed) res.end(); };
        const write = (packet: ReturnType<AssistantService['events']>) => {
          if (ended || res.writableEnded || res.destroyed) { cleanup(); return; }
          try { if (!res.write(JSON.stringify(packet) + '\n')) end(); }
          catch { end(); }
        };
        unsubscribe = assistant.subscribe(() => {
          try { const packet = assistant.events(after, epoch); after = packet.sequence; write(packet); }
          catch { end(); }
        });
        res.once('error', () => { cleanup(); res.destroy(); });
        res.once('close', cleanup);
        const deadline = setTimeout(end, 25_000);
        write(initial);
        return;
      }
      if (url.pathname === '/api/studio') {
        if (req.method === 'GET') return json(res, await engine.studio.snapshot());
        if (req.method === 'POST') return json(res, await engine.studio.control(await body(req, 8192)));
        return json(res, { error: { message: 'Method not allowed' } }, 405);
      }
      if (url.pathname === '/api/settings') {
        if (req.method === 'GET') return json(res, engine.mediaJobs.providerStatus());
        if (req.method !== 'POST') return json(res, { error: { message: 'Method not allowed' } }, 405);
        const result = await engine.mediaJobs.configureProvider(await body(req, 8192));
        engine.diagnostics.emit('change'); return json(res, result);
      }
      if (url.pathname === '/api/projects' && req.method === 'GET') return json(res, { ...await engine.projects.catalog(), recipes, presets, trusted: engine.previews.trusted });
      if (url.pathname === '/api/projects' && req.method === 'POST') { const result = await engine.actions.value('project_create', createSchema.parse(await body(req))); engine.diagnostics.emit('change'); return json(res, result?.project); }
      const recovery = url.pathname.match(/^\/api\/projects\/([a-f0-9-]+)\/remove-unavailable$/);
      if (recovery) {
        if (req.method !== 'POST') return json(res, { error: { message: 'Method not allowed' } }, 405);
        const input = z.object({ expectedRoot: z.string().max(4096) }).strict().parse(await body(req, 8192));
        const result = await engine.projects.removeUnavailable(z.uuid().parse(recovery[1]), input.expectedRoot);
        engine.diagnostics.emit('change'); return json(res, result);
      }
      const progress = url.pathname.match(/^\/api\/projects\/([a-f0-9-]+)\/journey$/);
      if (progress) {
        const id = z.uuid().parse(progress[1]);
        if (req.method === 'GET') return json(res, await journey.read(id));
        if (req.method !== 'POST') return json(res, { error: { message: 'Method not allowed' } }, 405);
        const result = await journey.update(id, await body(req, 16_384));
        engine.diagnostics.emit('change', id); return json(res, result);
      }
      const inspector = url.pathname.match(/^\/api\/projects\/([a-f0-9-]+)\/inspector\/(setup-preview|setup-apply)$/);
      if (inspector) {
        if (req.method !== 'POST') return json(res, { error: { message: 'Method not allowed' } }, 405);
        const id = z.uuid().parse(inspector[1]);
        const input = await body(req);
        if (inspector[2] === 'setup-preview') { z.object({}).strict().parse(input); return json(res, await previewInspectorSetup(engine, id)); }
        const result = await applyInspectorSetup(engine, id, input); engine.diagnostics.emit('change', id); return json(res, result);
      }
      const kits = url.pathname.match(/^\/api\/projects\/([a-f0-9-]+)\/launch-kits(?:\/(create|remove|[a-f0-9-]+)(?:\/files\/([a-z0-9-]+))?)?$/);
      if (kits) {
        const id = z.uuid().parse(kits[1]), action = kits[2];
        if (req.method === 'GET' && !action) return json(res, await engine.actions.value('launch_kit_list', { projectId: id }));
        if (req.method === 'POST' && (action === 'create' || action === 'remove') && !kits[3]) {
          const input = await body(req, 64 * 1024);
          const result = await engine.actions.value(action === 'create' ? 'launch_kit_create' : 'launch_kit_remove', { projectId: id, input });
          engine.diagnostics.emit('change', id); return json(res, result);
        }
        if (req.method === 'GET' && action && action !== 'create' && action !== 'remove') {
          const bundleId = z.uuid().parse(action);
          if (!kits[3]) return json(res, await engine.actions.value('launch_kit_read', { projectId: id, bundleId }));
          const { file, bytes } = await engine.launchKits.readFile(id, bundleId, kits[3]);
          res.writeHead(200, { 'Content-Type': file.mediaType, 'Content-Length': bytes.length, 'Content-Disposition': `attachment; filename="${path.basename(file.name)}"` });
          return res.end(bytes);
        }
        return json(res, { error: { message: 'Method not allowed' } }, 405);
      }
      const media = url.pathname.match(/^\/api\/projects\/([a-f0-9-]+)\/media(?:\/(import|brief|approve|transform|job-request|job-approve|job-cancel|images|icon-check|icon-prepare|icon-preview|icon-apply)(?:\/([a-f0-9-]+))?)?$/);
      if (media) {
        const id = z.uuid().parse(media[1]); await engine.projects.get(id);
        const action = media[2];
        if (req.method === 'GET' && !action) {
          // Completed jobs must never be paired with a library read before their outputs were saved.
          const jobs = await engine.mediaJobs.list(id);
          return json(res, { ...await engine.assets.list(id), ...jobs });
        }
        if (req.method === 'GET' && action === 'images') {
          const { bytes } = await engine.assets.read(id, z.uuid().parse(media[3])); res.writeHead(200, { 'Content-Type': 'image/png' }); return res.end(bytes);
        }
        if (req.method !== 'POST' || media[3]) return json(res, { error: { message: 'Method not allowed' } }, 405);
        if (action === 'import') {
          if (req.headers['content-encoding']) throw new BuilderError('INVALID_INPUT', 'Compressed upload bodies are not supported');
          const header = req.headers['x-builder-media'];
          if (typeof header !== 'string' || header.length > 12000) throw new BuilderError('INVALID_INPUT', 'Bounded media metadata header required');
          const input = importSchema.parse(JSON.parse(decodeURIComponent(header)));
          if (input.mediaType !== req.headers['content-type']) throw new BuilderError('INVALID_INPUT', 'Upload MIME mismatch');
          if (Number(req.headers['content-length']) > MEDIA_BYTES) throw new BuilderError('LIMIT_EXCEEDED', 'Upload exceeds 10 MiB');
          const chunks: Buffer[] = []; let length = 0;
          for await (const chunk of req) { length += chunk.length; if (length > MEDIA_BYTES) throw new BuilderError('LIMIT_EXCEEDED', 'Upload exceeds 10 MiB'); chunks.push(chunk); }
          const result = await engine.assets.import(id, input, Buffer.concat(chunks)); engine.diagnostics.emit('change', id); return json(res, result);
        }
        const input = await body(req); let result: unknown;
        if (action === 'brief') { const value = briefUpdateSchema.parse(input); result = await engine.actions.value('media_brief', { projectId: id, input: value }); }
        else if (action === 'approve') { const value = approveAssetSchema.parse(input); result = await engine.actions.value('media_approve', { projectId: id, input: value }); }
        else if (action === 'transform') result = await engine.actions.value('media_transform', { projectId: id, input: transformSchema.parse(input) });
        else if (action === 'icon-check') result = await engine.actions.value('icon_check', { projectId: id, input: iconCheckSchema.parse(input) });
        else if (action === 'icon-prepare') result = await engine.actions.value('icon_prepare', { projectId: id, input: iconPrepareSchema.parse(input) });
        else if (action === 'icon-preview') result = await engine.actions.value('icon_preview', { projectId: id, input: iconPreviewSchema.parse(input) });
        else if (action === 'icon-apply') result = await engine.actions.value('icon_apply', { projectId: id, input: iconApplySchema.parse(input) });
        else if (action === 'job-request') result = await engine.actions.value('media_request', { projectId: id, input: jobRequestSchema.parse(input) });
        else if (action === 'job-approve') { const value = paidApprovalSchema.parse(input); result = await engine.mediaJobs.approve(id, value.jobId, value.expectedConfigurationRevision); }
        else if (action === 'job-cancel') result = await engine.actions.value('media_cancel', { projectId: id, jobId: jobIdSchema.parse(input).jobId });
        else return json(res, { error: { message: 'Not found' } }, 404);
        engine.diagnostics.emit('change', id); return json(res, result);
      }
      const match = url.pathname.match(/^\/api\/projects\/([a-f0-9-]+)(?:\/(design|start|stop|transport|phone-test|capture|artifacts|board-captures)(?:\/([a-f0-9-]+))?)?$/);
      if (!match) return json(res, { error: { message: 'Not found' } }, 404);
      const id = z.uuid().parse(match[1]); await engine.projects.get(id);
      const action = match[2];
      if (req.method === 'GET' && !action) return json(res, { ...await engine.inspect(id), diagnostics: engine.diagnostics.read(id) });
      if (req.method === 'GET' && action === 'artifacts') { const { png } = engine.captures.get(id, z.uuid().parse(match[3])); res.writeHead(200, { 'Content-Type': 'image/png' }); return res.end(png); }
      if (req.method === 'GET' && action === 'board-captures') {
        if (!match[3]) return json(res, await engine.boardCaptures.list(id));
        const png = await engine.boardCaptures.get(id, z.uuid().parse(match[3])); res.writeHead(200, { 'Content-Type': 'image/png' }); return res.end(png);
      }
      if (req.method !== 'POST' || match[3]) return json(res, { error: { message: 'Method not allowed' } }, 405);
      const input = await body(req);
      const controller = new AbortController(); res.on('close', () => { if (!res.writableEnded) controller.abort(); });
      if (action === 'design') { const design = await engine.designs.apply(id, designUpdateSchema.parse(input)); engine.diagnostics.emit('change', id); return json(res, design); }
      if (action === 'transport') return json(res, await engine.setPreviewTransport(id, input, controller.signal));
      if (action === 'phone-test') return json(res, await engine.projects.mutations.run(() => engine.previews.recordPhoneTest(id, input)));
      if (action === 'start') { z.object({}).strict().parse(input); return json(res, await engine.previews.start(id, controller.signal)); }
      if (action === 'stop') { z.object({}).strict().parse(input); await engine.previews.stop(id); return json(res, engine.previews.status(id)); }
      if (action === 'capture') { const value = z.object({ route: captureRouteSchema, viewport: viewportSchema }).strict().parse(input); const result = await engine.captures.capture(id, value.route, value.viewport, controller.signal); engine.diagnostics.emit('change', id); return json(res, result.meta); }
      if (action === 'board-captures') { const value = z.object({ route: routeSchema }).strict().parse(input); const result = await engine.boardCaptures.capture(id, value.route, controller.signal); engine.diagnostics.emit('change', id); return json(res, result); }
      return json(res, { error: { message: 'Not found' } }, 404);
    }
    if (req.method !== 'GET') return json(res, { error: { message: 'Method not allowed' } }, 405);
    const relative = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    if (!/^(index\.html|assets\/[\w.-]+\.(js|css|svg))$/.test(relative)) return json(res, { error: { message: 'Not found' } }, 404);
    try {
      const data = await readFile(path.join(assets, relative));
      res.writeHead(200, { 'Content-Type': relative.endsWith('.js') ? 'text/javascript' : relative.endsWith('.css') ? 'text/css' : relative.endsWith('.svg') ? 'image/svg+xml' : 'text/html' }); res.end(data);
    } catch { json(res, { error: { message: 'Studio assets missing. Run pnpm build first.' } }, 404); }
  }
  server.on('upgrade', (req, socket, head) => {
    const protocols = req.headers['sec-websocket-protocol']?.split(',').map(p => p.trim());
    if (req.url !== '/events' || req.headers.host !== host || req.headers.origin !== origin || protocols?.[0] !== 'builder' || !equal(protocols[1], token) || wss.clients.size >= 8) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
    wss.handleUpgrade(req, socket, head, ws => { ws.on('error', () => {}); ws.send(JSON.stringify({ type: 'reconcile' })); });
  });
  let dirty = false;
  const changed = () => { dirty = true; }; engine.diagnostics.on('change', changed);
  const interval = setInterval(() => {
    if (!dirty) return; dirty = false;
    for (const socket of wss.clients) { if (socket.bufferedAmount > 64_000) socket.terminate(); else if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'reconcile' })); }
  }, 250);
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  } catch (error) {
    clearInterval(interval); engine.diagnostics.off('change', changed); wss.close(); throw error;
  }
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Studio did not bind');
  host = `127.0.0.1:${address.port}`; origin = `http://${host}`;
  return { origin, launchUrl: issueLaunchUrl(), issueLaunchUrl, async close() {
    clearInterval(interval); engine.diagnostics.off('change', changed); for (const response of assistantStreams) response.end(); for (const socket of wss.clients) socket.terminate(); wss.close(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  } };
}
