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
import { bridgeDesktop } from '../../mcp/src/socket.js';
import { runCommand } from './commands.js';
import { runPluginCommand } from './plugin-commands.js';

const { values, positionals } = parseArgs({ allowPositionals: true, options: { input: { type: 'string' }, 'input-file': { type: 'string' }, 'desktop-connect': { type: 'string' }, workspace: { type: 'string' }, home: { type: 'string' }, 'builder-env-file': { type: 'string' }, 'trust-execution': { type: 'boolean', default: false }, lan: { type: 'boolean', default: false }, studio: { type: 'boolean' }, 'studio-only': { type: 'boolean' }, help: { type: 'boolean' } } });
if (values.help) {
  process.stderr.write('mobile-builder --workspace <directory> [--home <directory>] [--builder-env-file <file>] [--studio | --studio-only] [--trust-execution] [--lan]\nmobile-builder --desktop-connect <absolute-socket-path>\nmobile-builder tools --desktop-connect <socket>\nmobile-builder call <tool-name> --desktop-connect <socket> [--input JSON | --input-file file.json]\nmobile-builder resource <builder-uri> --desktop-connect <socket>\nCommands emit JSON; nonzero exit indicates failure. tools lists schemas for project, Studio, files, design, preview, media, icons, Activity and Launch Kit operations. Paid approvals and credentials remain Studio-only.\nConnect to a running desktop backend without creating another runtime. Copy its socket path from the Studio menu; do not combine with runtime options.\nPlugin authoring: mobile-builder plugin new|validate|pack|dev <path>. Install reviewed packages in Dunara → Plugins.\nStarts a stdio MCP server. --studio opens the companion UI in the same runtime; --studio-only disables MCP. Execution trust authorizes dependency installation and generated code; not a sandbox. LAN explicitly exposes Expo to your local network.\n');
} else if (positionals[0] === 'plugin') {
  try {
    if (values['desktop-connect'] || values.workspace || values.home || values.studio || values['studio-only']) throw new Error('Authoring commands do not create or modify a running Dunara profile. Install packages through Plugins.');
    process.stdout.write(JSON.stringify(await runPluginCommand(positionals.slice(1), values.input, values['input-file'])) + '\n');
  } catch (error) { process.stdout.write(JSON.stringify({ error: { message: error instanceof Error ? error.message : 'Plugin command failed' } }) + '\n'); process.exitCode = 1; }
} else if (positionals.length) {
  try {
    if (!values['desktop-connect'] || values.workspace || values.home || values['builder-env-file'] || values.studio || values['studio-only'] || values['trust-execution'] || values.lan) throw new Error('Commands require --desktop-connect and cannot create a competing runtime');
    const result = await runCommand(values['desktop-connect'], positionals, values.input, values['input-file']);
    process.stdout.write(JSON.stringify(result.value) + '\n');
    if (result.failed) process.exitCode = 1;
  } catch (error) {
    process.stdout.write(JSON.stringify({ error: { message: error instanceof Error ? error.message : 'Command failed' } }) + '\n'); process.exitCode = 1;
  }
} else if (values.input !== undefined || values['input-file'] !== undefined) {
  throw new Error('--input and --input-file require call <tool-name>');
} else if (values['desktop-connect']) {
  if (values.workspace || values.home || values['builder-env-file'] || values.studio || values['studio-only'] || values['trust-execution'] || values.lan) throw new Error('--desktop-connect cannot be combined with runtime creation options');
  await bridgeDesktop(values['desktop-connect']);
} else {
  if (!values.workspace) throw new Error('--workspace is required; choose a dedicated generated-app directory');
  if (values.lan && !values['trust-execution']) throw new Error('--lan requires --trust-execution');
  const projects = await Projects.open(path.resolve(values.workspace), path.resolve(values.home ?? path.join(os.homedir(), '.mobile-builder')));
  const keys = startupCredentials(path.resolve(values['builder-env-file'] ?? '.env'));
  delete process.env.OPENAI_API_KEY; delete process.env.BUILDER_ASSISTANT_API_KEY;
  const engine = new Engine(projects, values['trust-execution'], values.lan, undefined, { startupKey: keys.imageKey ?? keys.assistantKey });
  const server = createMcpServer(engine);
  let studio: Awaited<ReturnType<typeof startStudio>> | undefined;
  if (values.studio || values['studio-only']) {
    const built = import.meta.url.endsWith('.js');
    const assets = fileURLToPath(new URL(built ? '../../../studio/' : '../../../dist/studio/', import.meta.url));
    studio = await startStudio(engine, assets);
    process.stderr.write(`Studio: ${studio.origin}\nOpening a single-use authenticated browser session. Link expires in 60 seconds.\n`);
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer.exe' : 'xdg-open';
    const child = spawn(opener, [studio.launchUrl], { stdio: 'ignore' });
    child.on('error', () => process.stderr.write('Could not open browser. Use this CLI in a local desktop session.\n')); child.unref();
  }
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => { await studio?.close(); await engine.close(); await server.close(); })();
  process.once('SIGINT', () => { void close(); }); process.once('SIGTERM', () => { void close(); });
  if (!values['studio-only']) { process.stdin.once('end', () => { void close(); }); await server.connect(new StdioServerTransport()); }
}
