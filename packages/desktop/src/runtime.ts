import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { Projects } from '../../core/src/projects.js';
import { Engine } from '../../core/src/engine.js';
import { credentialKeySchema } from '../../core/src/credentials.js';
import { localPort } from '../../core/src/local-ports.js';
import { serviceConfigSchema, secretProtection } from '../../core/src/service-config.js';
import { startStudio } from '../../cli/src/studio-server.js';
import { startDesktopMcp } from '../../mcp/src/socket.js';
import { AssistantService } from '../../assistant/src/service.js';
import { McpGateway } from '../../assistant/src/mcp-bridge.js';
import { PiHarness } from '../../assistant/src/pi.js';

if (!process.send) throw new Error('Desktop runtime requires its owning parent process');
const configSchema = z.object({ type: z.literal('start'), workspace: z.string(), home: z.string(), trusted: z.boolean(), services: serviceConfigSchema.default({}), credentials: z.object({ imageKey: credentialKeySchema.optional(), assistantKey: credentialKeySchema.optional() }).strict().optional(), assistantOfflineFixture: z.string().regex(/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/v1$/).optional() }).strict();
let engine: Engine | undefined;
let studio: Awaited<ReturnType<typeof startStudio>> | undefined;
let mcp: Awaited<ReturnType<typeof startDesktopMcp>> | undefined;
let assistant: AssistantService | undefined;
let starting: Promise<void> | undefined;
let closing = false;
const send = (message: unknown) => { if (process.connected) process.send?.(message); };
const origins = async () => {
  if (!engine || closing) return;
  const urls = (await engine.projects.list()).map(project => engine?.previews.status(project.id).url).filter(Boolean);
  send({ type: 'origins', urls });
};
async function close(code = 0) {
  if (closing) return; closing = true;
  const deadline = setTimeout(() => process.exit(1), 12_000); deadline.unref();
  try {
    await starting?.catch(() => {});
    await assistant?.close(); await mcp?.close(); await studio?.close(); await engine?.close();
  } finally { process.exit(code); }
}
process.on('message', (message: unknown) => {
  if (closing) return;
  const parsed = configSchema.safeParse(message);
  if (parsed.success && !starting) {
    starting = (async () => {
      const config = parsed.data;
      const keys = config.assistantOfflineFixture ? {} : config.credentials ?? {};
      engine = new Engine(await Projects.open(config.workspace, config.home), config.trusted, false, undefined, { startupKey: keys.imageKey ?? keys.assistantKey }, {}, undefined, config.services);
      mcp = await startDesktopMcp(engine);
      const socketPath = mcp.socketPath, fixtureUrl = config.assistantOfflineFixture;
      assistant = new AssistantService({ home: config.home, secretProtection: secretProtection(config.services),
        createHarness: fixtureUrl ? () => new PiHarness({ fixture: { baseUrl: fixtureUrl, model: 'fixture' } }) : undefined,
        createGateway: (binding, signal, context) => McpGateway.open(socketPath, binding, signal, context),
      });
      studio = await startStudio(engine, fileURLToPath(new URL('../../../studio/', import.meta.url)), assistant, { port: await localPort(config.home, 'studio') });
      engine.diagnostics.on('change', () => { void origins().catch(() => {}); });
      send({ type: 'ready', origin: studio.origin, launchUrl: studio.launchUrl, socketPath: mcp.socketPath });
    })();
    void starting.catch(() => { send({ type: 'failed' }); void close(1); });
  } else if (message && typeof message === 'object' && 'type' in message) {
    if (message.type === 'launch' && studio) send({ type: 'launch', launchUrl: studio.issueLaunchUrl() });
    if (message.type === 'stop') void close();
  }
});
process.once('disconnect', () => { void close(); });
process.once('SIGTERM', () => { void close(); });
process.once('SIGINT', () => { void close(); });
process.once('uncaughtException', () => { send({ type: 'failed' }); void close(1); });
process.once('unhandledRejection', () => { send({ type: 'failed' }); void close(1); });
