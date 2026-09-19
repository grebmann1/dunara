import { boundedArtifact, outputBudget } from "./bounds.js";
import { Sandbox, type SandboxRegion } from "@vercel/sandbox";
import type {
  ExecutionProvider,
  ExecutionSandbox,
  ExecutionCommand,
} from "../../plugin-sdk/src/execution.js";
export function vercelProvider(config: {
  token: string;
  teamId: string;
  projectId: string;
  region: string;
  image: string;
}): ExecutionProvider {
  const credentials = {
    token: config.token,
    teamId: config.teamId,
    projectId: config.projectId,
  };
  const wrap = (sandbox: Sandbox): ExecutionSandbox => {
    // Bind to the original VM. Sandbox helpers auto-resume and could create an unbudgeted session.
    const session = sandbox.currentSession();
    return {
      id: sandbox.name,
      root: "/tmp/dunara-project",
      write: (files, signal) =>
        session.writeFiles(
          files.map((file) => ({
            ...file,
            path: `/tmp/dunara-project/${file.path}`,
          })),
          { signal },
        ),
      async read(path, signal) {
        const result = await session.readFile(
          { path },
          {
            signal: AbortSignal.any([
              AbortSignal.timeout(15_000),
              ...(signal ? [signal] : []),
            ]),
          },
        );
        if (!result) throw Error("Missing execution artifact");
        return boundedArtifact(result);
      },
      async exec(command: ExecutionCommand, signal) {
        const budget = outputBudget(command.timeoutMs, signal);
        const result = await session.runCommand({
          cmd: command.command,
          args: command.args,
          cwd: command.cwd,
          env: command.env,
          detached: !!command.background,
          signal: budget.signal,
          ...(!command.background
            ? { stdout: budget.stdout, stderr: budget.stderr }
            : {}),
        });
        if (command.background)
          return { exitCode: null, stdout: "", stderr: "" };
        const done = await result.wait();
        budget.signal.throwIfAborted();
        return {
          exitCode: done.exitCode,
          stdout: (await done.stdout()).slice(-6_000_000),
          stderr: (await done.stderr()).slice(-4000),
        };
      },
      async destroy() {
        await sandbox.delete({
          deleteOrphanSnapshots: true,
          signal: AbortSignal.timeout(15_000),
        });
      },
    };
  };
  return {
    id: "vercel",
    capabilities: {
      isolation: "microvm",
      privateIngress: true,
      region: config.region,
      image: config.image,
      maxDurationMs: 3_600_000,
    },
    async create(input, signal) {
      // No public routes, no snapshots with transient credentials, no cross-region fallback.
      return wrap(
        await Sandbox.create({
          ...credentials,
          name: input.id,
          image: config.image,
          region: config.region as SandboxRegion,
          failoverRegions: [],
          ports: [],
          persistent: false,
          timeout: input.durationMs,
          resources: { vcpus: 2 },
          networkPolicy: {
            allow: input.allowedHosts,
            subnets: {
              deny: [
                "10.0.0.0/8",
                "172.16.0.0/12",
                "192.168.0.0/16",
                "169.254.0.0/16",
                "100.64.0.0/10",
                "::1/128",
                "fc00::/7",
                "fe80::/10",
              ],
            },
          },
          signal,
        }),
      );
    },
    async destroy(id) {
      try {
        const signal = AbortSignal.timeout(15_000);
        const sandbox = await Sandbox.get({
          ...credentials,
          name: id,
          resume: false,
          signal,
        });
        await sandbox.delete({ deleteOrphanSnapshots: true, signal });
      } catch (error) {
        if (
          !error ||
          typeof error !== "object" ||
          !("response" in error) ||
          (error.response as Response).status !== 404
        )
          throw error;
      }
    },
  };
}
