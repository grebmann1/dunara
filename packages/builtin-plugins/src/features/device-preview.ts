import { isIP } from 'node:net';
import { stripVTControlCharacters } from 'node:util';

/** Expo output is untrusted. Accept only a LAN address on this owned Metro port. */
export function expoDeviceUrl(output: string, port: number): string | undefined {
  const clean = stripVTControlCharacters(output);
  // Piped Expo processes omit the interactive QR and print the HTTP server address.
  const candidate = clean.match(/exp:\/\/[^\s]+/)?.[0] ?? clean.match(/Waiting on (http:\/\/[^\s]+)/)?.[1]?.replace(/^http:/, 'exp:');
  if (!candidate) return;
  try {
    const url = new URL(candidate), host = url.hostname;
    if (url.protocol !== 'exp:' || Number(url.port) !== port || url.username || url.password || url.search || url.hash || url.pathname && url.pathname !== '/') return;
    if (isIP(host) !== 4) return;
    const [a, b] = host.split('.').map(Number);
    if (!(a === 10 || a === 172 && b! >= 16 && b! <= 31 || a === 192 && b === 168)) return;
    return `exp://${host}:${port}`;
  } catch { return; }
}
