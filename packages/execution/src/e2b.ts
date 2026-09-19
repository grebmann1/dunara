import { boundedArtifact, webChunks, outputBudget } from "./bounds.js";
import { Sandbox, NotFoundError } from "e2b";
import type {
  ExecutionProvider,
  ExecutionSandbox,
  ExecutionCommand,
} from "../../plugin-sdk/src/execution.js";
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
export function e2bProvider(config: {
  apiKey: string;
  template: string;
  region: string;
}): ExecutionProvider {
  const wrap = (sandbox: Sandbox): ExecutionSandbox => ({
    id: sandbox.sandboxId,
    root: "/tmp/dunara-project",
    async write(files, signal) {
      for (const file of files)
        await sandbox.files.write(
          `/tmp/dunara-project/${file.path}`,
          new Uint8Array(file.content).buffer,
          { signal },
        );
    },
    async read(path, signal) {
      const result = await sandbox.files.read(path, {
        format: "stream",
        signal: AbortSignal.any([
          AbortSignal.timeout(15_000),
          ...(signal ? [signal] : []),
        ]),
      });
      return boundedArtifact(webChunks(result));
    },
    async exec(command: ExecutionCommand, signal) {
      const budget = outputBudget(command.timeoutMs, signal);
      const result = await sandbox.commands.run(
        [command.command, ...command.args].map(quote).join(" "),
        {
          cwd: command.cwd,
          envs: command.env,
          background: !!command.background,
          timeoutMs: command.background ? 0 : command.timeoutMs,
          signal: budget.signal,
          onStdout: budget.count,
          onStderr: budget.count,
        },
      );
      if (command.background) return { exitCode: null, stdout: "", stderr: "" };
      const done = "wait" in result ? await result.wait() : result;
      budget.signal.throwIfAborted();
      return {
        exitCode: done.exitCode,
        stdout: done.stdout.slice(-6_000_000),
        stderr: done.stderr.slice(-4000),
      };
    },
    async destroy() {
      await sandbox.kill();
    },
  });
  return {
    id: "e2b",
    capabilities: {
      isolation: "microvm",
      privateIngress: true,
      region: "provider-default",
      image: config.template,
      maxDurationMs: 3_600_000,
    },
    async create(input, signal) {
      return wrap(
        await Sandbox.create(config.template, {
          apiKey: config.apiKey,
          timeoutMs: input.durationMs,
          metadata: { dunaraSession: input.id },
          network: {
            allowPublicTraffic: false,
            allowOut: input.allowedHosts,
            denyOut: [
              "10.0.0.0/8",
              "172.16.0.0/12",
              "192.168.0.0/16",
              "169.254.0.0/16",
              "100.64.0.0/10",
            ],
          },
          signal,
        }),
      );
    },
    async destroy(id) {
      try {
        await Sandbox.kill(id, {
          apiKey: config.apiKey,
          signal: AbortSignal.timeout(15_000),
        });
      } catch (error) {
        if (!(error instanceof NotFoundError)) throw error;
      }
    },
  };
}
