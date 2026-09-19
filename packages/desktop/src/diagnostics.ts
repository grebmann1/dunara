import type { Writable } from 'node:stream';

/** A detached launcher can close its pipe while Electron remains alive. Logging must not crash Studio. */
export function diagnosticWriter(stream: Writable) {
  let unavailable = false;
  stream.on('error', () => { unavailable = true; });
  return (message: string) => {
    if (unavailable || stream.destroyed) return;
    try { stream.write(message, error => { if (error) unavailable = true; }); }
    catch { unavailable = true; }
  };
}
