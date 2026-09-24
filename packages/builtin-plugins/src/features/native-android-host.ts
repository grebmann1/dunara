import { access, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { androidDeviceId, type AndroidPreflight } from '../../../core/src/android-delivery-contracts.js';
import { LocalIOSHost, type NativeCommand } from './native-ios-host.js';

export interface AndroidHost {
  inspect(): Promise<AndroidPreflight>;
  run(spec: NativeCommand, signal: AbortSignal): Promise<{ stdout: string; stderr: string }>;
  verify(file: string, packageName: string, signal: AbortSignal): Promise<void>;
  installed(deviceId: string, packageName: string, signal: AbortSignal): Promise<boolean>;
  install(deviceId: string, file: string, signal: AbortSignal): Promise<void>;
}
export class LocalAndroidHost implements AndroidHost {
  private runner = new LocalIOSHost();
  private async tools() {
    if (process.platform === 'win32') throw new Error('Use macOS or Linux for local Android builds.');
    const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ?? path.join(os.homedir(), process.platform === 'darwin' ? 'Library/Android/sdk' : 'Android/Sdk');
    if (!path.isAbsolute(sdk)) throw new Error('Configure an absolute Android SDK location.');
    const versions = (await readdir(path.join(sdk, 'build-tools'))).filter(name => /^\d+\.\d+\.\d+$/.test(name)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    if (!versions.length) throw new Error('Install Android SDK Build Tools.');
    const build = path.join(sdk, 'build-tools', versions[0]!), adb = path.join(sdk, 'platform-tools/adb');
    const javaHome = process.env.JAVA_HOME && path.isAbsolute(process.env.JAVA_HOME) ? process.env.JAVA_HOME : undefined;
    for (const file of [adb, path.join(build, 'apksigner'), path.join(build, 'aapt')]) await access(file);
    return { sdk, build, adb, javaHome };
  }
  async run(spec: NativeCommand, signal: AbortSignal) {
    const tools = await this.tools();
    return this.runner.run({ ...spec, androidSdk: tools.sdk, javaHome: tools.javaHome }, signal);
  }
  private async adb(args: string[], signal: AbortSignal) { const tools = await this.tools(); return this.run({ command: tools.adb, args, cwd: os.tmpdir(), timeout: 120_000 }, signal); }
  async inspect(): Promise<AndroidPreflight> {
    try {
      const tools = await this.tools(), signal = AbortSignal.timeout(20_000);
      await this.run({ command: tools.javaHome ? path.join(tools.javaHome, 'bin/java') : 'java', args: ['-version'], cwd: os.tmpdir() }, signal);
      const output = await this.adb(['devices', '-l'], signal);
      const devices = output.stdout.split('\n').flatMap(line => {
        const match = line.match(/^(\S+)\s+device\s+(.*)$/); if (!match || !androidDeviceId.safeParse(match[1]).success) return [];
        return [{ id: match[1]!, name: match[2]!.match(/model:(\S+)/)?.[1]?.replaceAll('_', ' ') ?? 'Android device' }];
      });
      return { available: true, devices, issues: devices.length ? [] : ['Connect an Android device with USB debugging enabled and accept its authorization prompt, or start an Android emulator.'] };
    } catch { return { available: false, devices: [], issues: ['Install Android Studio, its SDK Build Tools and Platform Tools, and the JDK required by your Expo app. Set ANDROID_HOME and JAVA_HOME, then restart Dunara.'] }; }
  }
  async verify(file: string, packageName: string, signal: AbortSignal) {
    const tools = await this.tools(), cwd = path.dirname(file);
    await this.run({ command: path.join(tools.build, 'apksigner'), args: ['verify', file], cwd }, signal);
    const manifest = await this.run({ command: path.join(tools.build, 'aapt'), args: ['dump', 'badging', file], cwd }, signal);
    if (!manifest.stdout.startsWith(`package: name='${packageName}' `)) throw new Error('APK application identity differs from the review.');
    const contents = await this.run({ command: path.join(tools.build, 'aapt'), args: ['list', file], cwd }, signal);
    if (!contents.stdout.split('\n').includes('assets/index.android.bundle')) throw new Error('APK has no bundled JavaScript.');
  }
  async installed(deviceId: string, packageName: string, signal: AbortSignal) {
    androidDeviceId.parse(deviceId);
    const result = await this.adb(['-s', deviceId, 'shell', 'pm', 'list', 'packages', packageName], signal);
    return result.stdout.split(/\r?\n/).includes(`package:${packageName}`);
  }
  async install(deviceId: string, file: string, signal: AbortSignal) {
    androidDeviceId.parse(deviceId);
    const result = await this.adb(['-s', deviceId, 'install', '-r', file], signal);
    if (!result.stdout.split(/\r?\n/).includes('Success')) throw new Error('Android did not confirm installation.');
  }
}
