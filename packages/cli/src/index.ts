#!/usr/bin/env node
import { parseArgs } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Projects } from '../../core/src/projects.js';
import { Engine } from '../../core/src/engine.js';
import { startupCredentials } from '../../core/src/credentials.js';
import { createMcpServer } from '../../mcp/src/server.js';
import { startStudio } from './studio-server.js';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { bridgeDesktop, startDesktopMcp, MAX_MESSAGE } from '../../mcp/src/socket.js';
import { discoverRuntimes, resolveRuntimeHome } from '../../mcp/src/discovery.js';
import { runCommand, saveCommandOutput } from './commands.js';
import { runPluginCommand } from './plugin-commands.js';

const { values, positionals } = parseArgs({ allowPositionals: true, options: { output: { type: 'string' }, 'connect-home': { type: 'string' }, input: { type: 'string' }, 'input-file': { type: 'string' }, 'desktop-connect': { type: 'string' }, workspace: { type: 'string' }, home: { type: 'string' }, 'builder-env-file': { type: 'string' }, 'trust-execution': { type: 'boolean', default: false }, lan: { type: 'boolean', default: false }, studio: { type: 'boolean' }, 'studio-only': { type: 'boolean' }, help: { type: 'boolean' } } });
const connected = values['desktop-connect'] || values['connect-home'];
const runtimeOptions = values.workspace || values.home || values['builder-env-file'] || values.studio || values['studio-only'] || values['trust-execution'] || values.lan;
async function socket() {
  if (values['desktop-connect'] && values['connect-home']) throw new Error('Choose --desktop-connect or --connect-home');
  if (!connected || runtimeOptions) throw new Error('Commands require --desktop-connect or --connect-home and cannot create a competing runtime');
  return values['desktop-connect'] ?? resolveRuntimeHome(values['connect-home']!);
}
if (values.help) {
  process.stderr.write(`mobile-builder --workspace <directory> [--home <directory>] [--builder-env-file <file>] [--studio | --studio-only] [--trust-execution] [--lan]
mobile-builder runtimes
mobile-builder --connect-home <running-runtime-home>
mobile-builder tools|resources|resource-templates|prompts --connect-home <home>
mobile-builder call <tool-name> --connect-home <home> [--input JSON | --input-file file.json] [--output file]
mobile-builder resource <builder-uri> --connect-home <home> [--output file]
mobile-builder prompt <name> --connect-home <home> [--input JSON]
Use --desktop-connect <absolute-socket-path> instead of --connect-home to select an exact runtime.
Commands emit JSON; nonzero exit indicates failure. --output saves one binary artifact or ordinary JSON to a new file. Existing files are never overwritten.
Connect to a running desktop/Studio backend without creating another runtime. runtimes discovers private endpoints owned by this user. Without a command, the connection serves stdio MCP for any compatible agent.
Plugin authoring: mobile-builder plugin new|validate|pack|dev <path>. Install reviewed packages in Dunara → Plugins.
Starts a stdio MCP server. --studio opens the companion UI in the same runtime; --studio-only disables stdio. Both expose the same runtime to connected agents. Execution trust authorizes dependency installation and generated code; not a sandbox. LAN explicitly exposes Expo to your local network. Paid approvals and credentials remain human operations.
`);
} else if (positionals[0] === 'runtimes') {
  try {
    if (positionals.length !== 1 || connected || runtimeOptions || values.input !== undefined || values['input-file'] !== undefined) throw new Error('runtimes accepts only --output');
    const result = { runtimes: await discoverRuntimes() };
    process.stdout.write(JSON.stringify(values.output ? await saveCommandOutput(values.output, result) : result) + '\n');
  } catch (error) { process.stdout.write(JSON.stringify({ error: { message: error instanceof Error ? error.message : 'Discovery failed' } }) + '\n'); process.exitCode = 1; }
} else if (positionals[0] === 'plugin') {
  try {
    if (connected || runtimeOptions || values.output) throw new Error('Authoring commands do not create or modify a running Dunara profile. Install packages through Plugins.');
    process.stdout.write(JSON.stringify(await runPluginCommand(positionals.slice(1), values.input, values['input-file'])) + '\n');
  } catch (error) { process.stdout.write(JSON.stringify({ error: { message: error instanceof Error ? error.message : 'Plugin command failed' } }) + '\n'); process.exitCode = 1; }
} else if (positionals.length) {
  try {
    const result = await runCommand(await socket(), positionals, values.input, values['input-file'], values.output);
    process.stdout.write(JSON.stringify(result.value) + '\n');
    if (result.failed) process.exitCode = 1;
  } catch (error) {
    process.stdout.write(JSON.stringify({ error: { message: error instanceof Error ? error.message : 'Command failed' } }) + '\n'); process.exitCode = 1;
  }
} else if (values.input !== undefined || values['input-file'] !== undefined || values.output !== undefined) {
  throw new Error('--input, --input-file and --output require a command');
} else if (connected) {
  await bridgeDesktop(await socket());
} else {
  if (!values.workspace) throw new Error('--workspace is required; choose a dedicated generated-app directory');
  if (values.lan && !values['trust-execution']) throw new Error('--lan requires --trust-execution');
  const projects = await Projects.open(path.resolve(values.workspace), path.resolve(values.home ?? path.join(os.homedir(), '.mobile-builder')));
  const keys = startupCredentials(path.resolve(values['builder-env-file'] ?? '.env'));
  delete process.env.OPENAI_API_KEY; delete process.env.BUILDER_ASSISTANT_API_KEY;
  const engine = new Engine(projects, values['trust-execution'], values.lan, undefined, { startupKey: keys.imageKey ?? keys.assistantKey });
  const server = createMcpServer(engine);
  let endpoint: Awaited<ReturnType<typeof startDesktopMcp>> | undefined;
  let studio: Awaited<ReturnType<typeof startStudio>> | undefined;
  if (values.studio || values['studio-only']) {
    const built = import.meta.url.endsWith('.js');
    const assets = fileURLToPath(new URL(built ? '../../../studio/' : '../../../dist/studio/', import.meta.url));
    studio = await startStudio(engine, assets);
    if (process.platform !== 'win32') endpoint = await startDesktopMcp(engine);
    process.stderr.write(`Studio: ${studio.origin}\nOpening a single-use authenticated browser session. Link expires in 60 seconds.\n`);
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer.exe' : 'xdg-open';
    const child = spawn(opener, [studio.launchUrl], { stdio: 'ignore' });
    child.on('error', () => process.stderr.write('Could not open browser. Use this CLI in a local desktop session.\n')); child.unref();
  }
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => { await endpoint?.close(); await studio?.close(); await engine.close(); await server.close(); })();
  process.once('SIGINT', () => { void close(); }); process.once('SIGTERM', () => { void close(); });
  if (!values['studio-only']) { process.stdin.once('end', () => { void close(); }); await server.connect(new StdioServerTransport(undefined, undefined, { maxBufferSize: MAX_MESSAGE })); }
}
