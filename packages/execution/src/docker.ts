import { spawn } from "node:child_process";
import type {
  ExecutionProvider,
  ExecutionSandbox,
} from "../../plugin-sdk/src/execution.js";
/** Development qualification only. No host mounts, published ports, or provider credentials. */
export function dockerProvider(image: string): ExecutionProvider {
  async function run(args: string[], input = "", signal?: AbortSignal) {
    return new Promise<{ exitCode: number; stdout: string; stderr: string }>(
      (resolve, reject) => {
        const child = spawn("docker", args, {
          env: { PATH: process.env.PATH, HOME: process.env.HOME },
          signal,
          stdio: ["pipe", "pipe", "pipe"],
        });
        let stdout = "",
          stderr = "",
          bytes = 0;
        child.on("error", reject);
        child.stdout.on("data", (chunk) => {
          bytes += chunk.length;
          if (bytes > 12_000_000) {
            child.kill();
            reject(Error("Execution output limit exceeded"));
          } else stdout += chunk;
        });
        child.stderr.on("data", (chunk) => {
          stderr = (stderr + chunk).slice(-4000);
        });
        child.on("close", (code) =>
          resolve({ exitCode: code ?? 1, stdout, stderr }),
        );
        child.stdin.on("error", () => {});
        child.stdin.end(input);
      },
    );
  }
  const destroy = async (id: string) => {
    if (!/^dunara-[a-f0-9-]{36}$/.test(id)) throw Error("Invalid container ID");
    const result = await run(["rm", "-f", id]);
    if (result.exitCode && !result.stderr.includes("No such container"))
      throw Error("Container cleanup failed");
  };
  return {
    id: "docker",
    capabilities: {
      isolation: "local-container",
      privateIngress: true,
      region: "local",
      image,
      maxDurationMs: 3_600_000,
    },
    destroy,
    async create(input, signal) {
      const id = `dunara-${input.id}`;
      const created = await run(
        [
          "run",
          "--detach",
          "--name",
          id,
          "--label",
          "dunara.execution=development",
          "--user",
          "node",
          "--cap-drop=ALL",
          "--security-opt=no-new-privileges",
          "--pids-limit=256",
          "--memory=3g",
          "--cpus=2",
          "--init",
          image,
          "sleep",
          String(Math.ceil(input.durationMs / 1000)),
        ],
        "",
        signal,
      );
      if (created.exitCode)
        throw Error("Development container creation failed");
      const box: ExecutionSandbox = {
        id,
        root: "/tmp/dunara-project",
        destroy: () => destroy(id),
        async write(files, signal) {
          const script = `let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',async()=>{const fs=await import('node:fs/promises');const p=await import('node:path');for(const f of JSON.parse(s)){const t=p.join('/tmp/dunara-project',f.path);await fs.mkdir(p.dirname(t),{recursive:true});await fs.writeFile(t,Buffer.from(f.content,'base64'));}});`;
          const result = await run(
            ["exec", "-i", id, "node", "-e", script],
            JSON.stringify(
              files.map((f) => ({
                path: f.path,
                content: Buffer.from(f.content).toString("base64"),
              })),
            ),
            signal,
          );
          if (result.exitCode) throw Error("Container upload failed");
        },
        async read(path, signal) {
          const r = await run(
            [
              "exec",
              id,
              "node",
              "-e",
              "process.stdout.write(require('node:fs').readFileSync(process.argv[1]).toString('base64'))",
              path,
            ],
            "",
            signal,
          );
          if (r.exitCode) throw Error("Artifact read failed");
          const output = Buffer.from(r.stdout, "base64");
          if (output.length > 8_000_000)
            throw Error("Execution artifact exceeds 8 MB");
          return output;
        },
        async exec(command, signal) {
          const result = await run(
            [
              "exec",
              ...(command.background ? ["--detach"] : []),
              ...Object.entries(command.env ?? {}).flatMap(([k, v]) => [
                "--env",
                `${k}=${v}`,
              ]),
              "--workdir",
              command.cwd,
              id,
              command.command,
              ...command.args,
            ],
            "",
            AbortSignal.any([
              ...(signal ? [signal] : []),
              AbortSignal.timeout(command.timeoutMs),
            ]),
          );
          return {
            ...result,
            exitCode:
              command.background && !result.exitCode ? null : result.exitCode,
          };
        },
      };
      return box;
    },
  };
}
