import { Writable } from "node:stream";
export async function boundedArtifact(
  stream: AsyncIterable<Uint8Array | string>,
) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const part of stream) {
    const chunk = Buffer.from(part);
    size += chunk.length;
    if (size > 8_000_000) throw Error("Execution artifact exceeds 8 MB");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
export async function* webChunks(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) return;
      yield next.value;
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
export function outputBudget(timeoutMs: number, signal?: AbortSignal) {
  const overflow = new AbortController();
  let bytes = 0;
  const count = (chunk: string | Uint8Array) => {
    bytes += Buffer.byteLength(chunk);
    if (bytes > 8_000_000)
      overflow.abort(Error("Execution output limit exceeded"));
  };
  const stream = () =>
    new Writable({
      write(chunk, _encoding, done) {
        count(chunk);
        done();
      },
    });
  return {
    signal: AbortSignal.any([
      overflow.signal,
      AbortSignal.timeout(timeoutMs),
      ...(signal ? [signal] : []),
    ]),
    count,
    stdout: stream(),
    stderr: stream(),
  };
}
