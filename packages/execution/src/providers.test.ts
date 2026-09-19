import { Readable } from "node:stream";
import { expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  get: vi.fn(),
  e2bCreate: vi.fn(),
  kill: vi.fn(),
}));
vi.mock("@vercel/sandbox", () => ({
  Sandbox: { create: mocks.create, get: mocks.get },
}));
vi.mock("e2b", () => ({
  Sandbox: { create: mocks.e2bCreate, kill: mocks.kill },
  NotFoundError: class extends Error {},
}));
import { vercelProvider } from "./vercel.js";
import { e2bProvider } from "./e2b.js";
it("Vercel closes ingress, pins placement, bounds lifetime and never uses auto-resuming sandbox helpers", async () => {
  const writeFiles = vi.fn(async () => {}),
    readFile = vi.fn(async () => Readable.from([Buffer.from("artifact")])),
    runCommand = vi.fn(async () => ({
      wait: async () => ({
        exitCode: 0,
        stdout: async () => "ok",
        stderr: async () => "",
      }),
    })),
    remove = vi.fn(async () => {});
  const sandbox = {
    name: "owned",
    currentSession: () => ({ writeFiles, readFile, runCommand }),
    delete: remove,
    runCommand: vi.fn(() => {
      throw Error("Auto-resume forbidden");
    }),
  };
  mocks.create.mockResolvedValue(sandbox);
  mocks.get.mockResolvedValue(sandbox);
  const provider = vercelProvider({
    token: "operator-secret",
    teamId: "team",
    projectId: "project",
    region: "fra1",
    image: "pinned@sha256:" + "a".repeat(64),
  });
  const box = await provider.create({
    id: "owned",
    durationMs: 60_000,
    allowedHosts: ["registry.npmjs.org", "studio.example.com"],
  });
  const input = mocks.create.mock.calls[0]![0];
  expect(input).toMatchObject({
    ports: [],
    persistent: false,
    timeout: 60_000,
    region: "fra1",
    failoverRegions: [],
  });
  expect(input.networkPolicy.subnets.deny).toContain("169.254.0.0/16");
  await box.write([{ path: "app.ts", content: Buffer.from("safe") }]);
  expect(Buffer.from(await box.read("/tmp/artifact")).toString()).toBe(
    "artifact",
  );
  await box.exec({
    command: "node",
    args: ["app.ts"],
    cwd: box.root,
    timeoutMs: 1000,
  });
  expect(sandbox.runCommand).not.toHaveBeenCalled();
  expect(runCommand.mock.calls[0]).not.toContain("operator-secret");
  await provider.destroy("owned");
  expect(mocks.get).toHaveBeenCalledWith(
    expect.objectContaining({ name: "owned", resume: false }),
  );
  expect(remove).toHaveBeenCalledOnce();
});
it("E2B disables public traffic and quotes each command argument", async () => {
  const run = vi.fn(async (_command: string, _options: unknown) => ({
    exitCode: 0,
    stdout: "",
    stderr: "",
  }));
  mocks.e2bCreate.mockResolvedValue({
    sandboxId: "e2b-owned",
    commands: { run },
    files: {},
    kill: vi.fn(),
  });
  const provider = e2bProvider({
    apiKey: "operator-secret",
    template: "pinned-template",
    region: "provider-default",
  });
  const box = await provider.create({
    id: "lease",
    durationMs: 60_000,
    allowedHosts: ["studio.example.com"],
  });
  expect(mocks.e2bCreate).toHaveBeenCalledWith(
    "pinned-template",
    expect.objectContaining({
      network: expect.objectContaining({
        allowPublicTraffic: false,
        allowOut: ["studio.example.com"],
      }),
      timeoutMs: 60_000,
    }),
  );
  await box.exec({
    command: "node",
    args: ["-e", "console.log('safe'); $(bad)"],
    cwd: box.root,
    timeoutMs: 1000,
  });
  expect(run.mock.calls[0]![0]).toBe(
    String.raw`'node' '-e' 'console.log('\''safe'\''); $(bad)'`,
  );
  expect(provider.capabilities.region).toBe("provider-default");
});
