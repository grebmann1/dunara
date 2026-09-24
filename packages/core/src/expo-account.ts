import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { runtimeEnvironment } from './runtime-environment.js';

export type ExpoAccountStatus = { state: 'signed-in' | 'signed-out' | 'unknown' | 'not-installed'; message: string };
export async function expoAccountStatus(root: string): Promise<ExpoAccountStatus> {
  const cli = path.join(root, 'node_modules/expo/bin/cli');
  try { await access(cli); } catch { return { state: 'not-installed', message: 'Start the app preview to install its Expo tools, then check sign-in.' }; }
  try {
    const { stdout } = await promisify(execFile)(process.execPath, [cli, 'whoami'], { cwd: root, timeout: 15_000, maxBuffer: 16_384, env: { ...runtimeEnvironment(process.env), EXPO_OFFLINE: '0', FORCE_COLOR: '0', CI: '1' } });
    const text = stdout.trim();
    if (text === 'Not logged in') return { state: 'signed-out', message: 'Sign in to Expo on this computer, then use the same account in Expo Go.' };
    if (/^[\w.@-]{1,100}$/.test(text)) return { state: 'signed-in', message: 'Expo sign-in verified on this computer. Use the same account in Expo Go.' };
  } catch (cause) {
    // Expo versions can use a nonzero exit for the same signed-out answer.
    if (cause && typeof cause === 'object' && 'stdout' in cause && String(cause.stdout).trim() === 'Not logged in') return { state: 'signed-out', message: 'Sign in to Expo on this computer, then use the same account in Expo Go.' };
    // Never return CLI output: it can contain private account details.
  }
  return { state: 'unknown', message: 'Could not verify Expo sign-in. Check your internet connection and try again.' };
}
