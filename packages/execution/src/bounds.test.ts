import { Readable } from "node:stream";
import { expect, it } from "vitest";
import { boundedArtifact, outputBudget, webChunks } from "./bounds.js";
it("bounds and cancels untrusted artifact streams before buffering an entire oversized file", async () => {
  const cancelled = { value: false };
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new Uint8Array(1_000_000));
    },
    cancel() {
      cancelled.value = true;
    },
  });
  await expect(boundedArtifact(webChunks(stream))).rejects.toThrow(/8 MB/);
  expect(cancelled.value).toBe(true);
  expect(
    (await boundedArtifact(Readable.from([Buffer.from("valid")]))).toString(),
  ).toBe("valid");
});
it("aborts stdout and stderr collection under one shared output limit", () => {
  const budget = outputBudget(5000);
  budget.stdout.write(Buffer.alloc(4_000_000));
  expect(budget.signal.aborted).toBe(false);
  budget.stderr.write(Buffer.alloc(4_000_001));
  expect(budget.signal.aborted).toBe(true);
});
