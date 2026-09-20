import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdtemp, open, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { runtimeEnvironment } from '../../../core/src/runtime-environment.js';
import { noSymlinks, readText } from '../../../core/src/storage.js';
import { revision } from '../../../core/src/files.js';
import { iosDevice, signingTeam, type DeliveryPreflight, type NativeDevice } from '../../../core/src/native-delivery-contracts.js';

export type NativeCommand = { command: string; args: string[]; cwd: string; timeout?: number };
export interface IOSHost {
  inspect(): Promise<DeliveryPreflight>;
  run(command: NativeCommand, signal: AbortSignal): Promise<{ stdout: string; stderr: string }>;
  device(deviceId: string, signal: AbortSignal): Promise<NativeDevice>;
  installed(deviceId: string, bundleIdentifier: string, signal: AbortSignal): Promise<boolean>;
  install(deviceId: string, app: string, signal: AbortSignal): Promise<void>;
  launch(deviceId: string, bundleIdentifier: string, signal: AbortSignal): Promise<number>;
}
const object = z.record(z.string(), z.any());
/** Only expose the selected device's public name/model; discard serials, network and account data. */
export function parseIOSDevice(raw: unknown): NativeDevice | undefined {
  const value = object.parse(raw), hardware = value.properties?.hardware ?? value.hardwareProperties;
  if (hardware?.reality !== 'physical' || hardware.platform !== 'iOS') return;
  const state = value.properties?.state ?? value.deviceProperties;
  return iosDevice.parse({ id: hardware.udid, name: state?.name ?? 'iPhone', model: hardware.marketingName ?? 'iPhone', developerMode: !!state?.developerModeStatus?.enabled || value.deviceProperties?.developerModeStatus === 'enabled' });
}
export class LocalIOSHost implements IOSHost {
  async run(spec: NativeCommand, signal: AbortSignal) {
    signal.throwIfAborted();
    const env = { ...runtimeEnvironment(process.env), PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}`, CI: '1', EXPO_OFFLINE: '0' };
    const child = spawn(spec.command, spec.args, { cwd: spec.cwd, env, shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', exited = false, timedOut = false;
    // Bounded private diagnostic output; never returned by the service's tools or HTTP routes.
    child.stdout.on('data', data => { stdout = (stdout + String(data)).slice(-4_000_000); });
    child.stderr.on('data', data => { stderr = (stderr + String(data)).slice(-1_000_000); });
    const kill = (process: ChildProcess, sig: NodeJS.Signals) => { if (!exited && process.pid) try { globalThis.process.kill(-process.pid, sig); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; } };
    let escalation: NodeJS.Timeout | undefined;
    const stop = () => { kill(child, 'SIGTERM'); escalation ??= setTimeout(() => kill(child, 'SIGKILL'), 1500); };
    const deadline = setTimeout(() => { timedOut = true; stop(); }, spec.timeout ?? 30_000);
    signal.addEventListener('abort', stop, { once: true });
    try {
      const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', code => { kill(child, 'SIGKILL'); exited = true; resolve(code); }); });
      signal.throwIfAborted();
      if (code !== 0 || timedOut) throw Object.assign(new Error(timedOut ? 'Native command timed out' : `Native command exited with ${code}`), { diagnostic: stdout + '\n' + stderr });
      return { stdout, stderr };
    } finally { clearTimeout(deadline); clearTimeout(escalation); signal.removeEventListener('abort', stop); kill(child, 'SIGKILL'); }
  }
  private async devicectl(args: string[], signal: AbortSignal, timeout = 30_000) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'dunara-device-'));
    try {
      const output = path.join(root, 'result.json');
      await this.run({ command: '/usr/bin/xcrun', args: ['devicectl', ...args, '--quiet', '--timeout', String(Math.ceil(timeout / 1000)), '--json-output', output], cwd: root, timeout: timeout + 5000 }, signal);
      const result = object.parse(JSON.parse(await readText(output, 4_000_000)));
      if (result.info?.outcome !== 'success') throw new Error('Device command did not report success');
      return object.parse(result.result);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
  async inspect(): Promise<DeliveryPreflight> {
    if (process.platform !== 'darwin') return { supported: false, devices: [], teams: [], issues: ['Local iPhone installation requires macOS with Xcode. Android delivery is not available here yet.'] };
    const result: DeliveryPreflight = { supported: true, devices: [], teams: [], issues: [] }, signal = AbortSignal.timeout(60_000);
    const checks = await Promise.allSettled([
      this.run({ command: '/usr/bin/xcrun', args: ['xcodebuild', '-version'], cwd: os.tmpdir() }, signal),
      this.run({ command: 'pod', args: ['--version'], cwd: os.tmpdir() }, signal),
      this.devicectl(['list', 'devices'], signal),
      this.run({ command: '/usr/bin/security', args: ['find-identity', '-v', '-p', 'codesigning'], cwd: os.tmpdir() }, signal),
      this.run({ command: '/usr/bin/security', args: ['find-certificate', '-a', '-p'], cwd: os.tmpdir() }, signal),
    ]);
    const [xcode, pods, devices, identities, certificates] = checks;
    if (xcode.status === 'fulfilled') result.xcode = xcode.value.stdout.trim().split('\n')[0]; else result.issues.push('Install Xcode, open it once to complete setup, and select it in Xcode → Settings → Locations.');
    if (pods.status === 'fulfilled') result.cocoaPods = pods.value.stdout.trim(); else result.issues.push('Install CocoaPods and make the pod command available to Dunara.');
    if (devices.status === 'fulfilled') result.devices = z.array(z.unknown()).parse(devices.value.devices).map(parseIOSDevice).filter((device): device is NativeDevice => !!device);
    else result.issues.push('Xcode could not list devices. Connect and unlock your iPhone, then trust this Mac.');
    if (identities.status === 'fulfilled' && certificates.status === 'fulfilled') {
      for (const pem of certificates.value.stdout.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? []) {
        const cert = new X509Certificate(pem), name = cert.subject.match(/(?:^|\n)CN=(Apple Development:[^\n]+)/)?.[1], team = cert.subject.match(/(?:^|\n)OU=([A-Z0-9]{10})(?:\n|$)/)?.[1];
        if (name && team && identities.value.stdout.includes(cert.fingerprint.replaceAll(':', '')) && !result.teams.some(value => value.id === team)) result.teams.push(signingTeam.parse({ id: team, name }));
      }
    }
    if (!result.teams.length) result.issues.push('Add your Apple account in Xcode → Settings → Accounts and create an Apple Development signing certificate.');
    if (!result.devices.length) result.issues.push('Connect and unlock your iPhone, trust this Mac, and enable Developer Mode in iPhone Settings → Privacy & Security.');
    return result;
  }
  async device(deviceId: string, signal: AbortSignal) {
    iosDevice.shape.id.parse(deviceId);
    const details = await this.devicectl(['device', 'info', 'details', '--device', deviceId], signal), device = parseIOSDevice(details);
    if (!device || device.id !== deviceId || !device.developerMode) throw new Error('Connect and unlock the selected iPhone and enable Developer Mode.');
    return device;
  }
  async installed(deviceId: string, bundleIdentifier: string, signal: AbortSignal) {
    const result = await this.devicectl(['device', 'info', 'apps', '--device', deviceId, '--filter', `bundleIdentifier == '${bundleIdentifier}'`], signal);
    return z.array(object).parse(result.apps).some(app => app.bundleIdentifier === bundleIdentifier);
  }
  async install(deviceId: string, app: string, signal: AbortSignal) { await this.devicectl(['device', 'install', 'app', '--device', deviceId, app], signal, 180_000); }
  async launch(deviceId: string, bundleIdentifier: string, signal: AbortSignal) {
    const result = await this.devicectl(['device', 'process', 'launch', '--device', deviceId, '--terminate-existing', bundleIdentifier], signal);
    return z.number().int().positive().parse(result.process?.processIdentifier);
  }
}

/** Hash the entire signed bundle before review and again before installation. */
export async function nativeArtifact(root: string) {
  const files: { path: string; bytes: number; sha256: string }[] = []; let bytes = 0, visited = 0;
  const walk = async (relative: string, depth: number) => {
    if (depth > 20 || ++visited > 15_000 || files.length > 10_000) throw new Error('Native app exceeds file limits');
    const target = path.join(root, relative); await noSymlinks(root, target); const stat = await lstat(target);
    if (stat.isDirectory()) { for (const name of (await readdir(target)).sort()) await walk(relative ? `${relative}/${name}` : name, depth + 1); }
    else {
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 512_000_000 || (bytes += stat.size) > 1_000_000_000) throw new Error('Unsupported native app output');
      const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const before = await handle.stat(); if (!before.isFile() || before.ino !== stat.ino || before.dev !== stat.dev || before.nlink !== 1) throw new Error('Native artifact changed');
        const hash = createHash('sha256'); let size = 0;
        for await (const chunk of handle.createReadStream({ autoClose: false })) { size += chunk.length; if (size > stat.size) throw new Error('Native artifact changed'); hash.update(chunk); }
        const after = await handle.stat(); if (size !== stat.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('Native artifact changed');
        files.push({ path: relative, bytes: size, sha256: hash.digest('hex') });
      } finally { await handle.close(); }
    }
  };
  await walk('', 0);
  if (!files.some(file => file.path === 'main.jsbundle' && file.bytes > 0) || !files.some(file => file.path === 'embedded.mobileprovision')) throw new Error('The native app must contain bundled JavaScript and an iPhone provisioning profile');
  return { fingerprint: revision(JSON.stringify(files)), bytes };
}
