import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseArgs } from 'node:util';

const root = fileURLToPath(new URL('../', import.meta.url));
const { values } = parseArgs({ options: { workspace: { type: 'string' }, home: { type: 'string' }, 'builder-env-file': { type: 'string' }, 'user-data': { type: 'string' }, 'trust-execution': { type: 'boolean', default: false }, help: { type: 'boolean', default: false } } });
if (values.help) {
  console.log('pnpm desktop [--workspace <apps>] [--home <state>] [--user-data <chromium-state>] [--builder-env-file <file>] [--trust-execution]\nmacOS source launch; run pnpm build first. Defaults are isolated under .builder/desktop. Execution is disabled unless explicitly trusted. Use pnpm desktop:package for an installable candidate; signed release qualification is separate.');
} else {
  if (process.platform !== 'darwin') throw new Error('Desktop is currently macOS-only');
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node 24 or newer is required');
  await access(path.join(root, 'dist/packages/desktop/src/main.js'));
  await access(path.join(root, 'dist/studio/index.html'));
  const { default: electron } = await import('electron');
  const { desktopEnvironment } = await import('../dist/packages/desktop/src/security.js');
  const { startupEnvironment } = await import('../dist/packages/core/src/service-config.js');
  const child = spawn(electron, [path.join(root, 'dist/packages/desktop/src/main.js'), '--node', process.execPath,
    '--workspace', path.resolve(values.workspace ?? path.join(root, '.builder/desktop/apps')),
    '--home', path.resolve(values.home ?? path.join(root, '.builder/desktop/home')),
    '--user-data', path.resolve(values['user-data'] ?? path.join(root, '.builder/desktop/chromium')),
    '--builder-env-file', path.resolve(values['builder-env-file'] ?? path.join(root, '.env')),
    ...(values['trust-execution'] ? ['--trust-execution'] : []),
  ], { cwd: root, env: { ...desktopEnvironment(process.env), ...startupEnvironment(process.env) }, stdio: 'inherit' });
  process.once('SIGINT', () => child.kill('SIGINT'));
  process.once('SIGTERM', () => child.kill('SIGTERM'));
  child.once('error', () => { console.error('Electron could not start. Run pnpm install and pnpm rebuild electron.'); process.exitCode = 1; });
  child.once('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
}
