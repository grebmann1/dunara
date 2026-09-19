/** Operator-installed execution providers. Guest code never receives provider credentials. */
export type ExecutionCommand = {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  background?: boolean;
  timeoutMs: number;
};
export type ExecutionResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
};
export type ExecutionFile = { path: string; content: Uint8Array };
export interface ExecutionSandbox {
  readonly id: string;
  readonly root: string;
  write(files: ExecutionFile[], signal?: AbortSignal): Promise<void>;
  read(path: string, signal?: AbortSignal): Promise<Uint8Array>;
  exec(
    command: ExecutionCommand,
    signal?: AbortSignal,
  ): Promise<ExecutionResult>;
  destroy(): Promise<void>;
}
export interface ExecutionProvider {
  readonly id: string;
  readonly capabilities: {
    isolation: "microvm" | "local-container";
    privateIngress: boolean;
    region: string;
    image: string;
    maxDurationMs: number;
  };
  create(
    input: { id: string; durationMs: number; allowedHosts: string[] },
    signal?: AbortSignal,
  ): Promise<ExecutionSandbox>;
  destroy(id: string): Promise<void>;
}
/** Providers are registered by the deployment operator, never by generated app code. */
export class ExecutionProviders {
  private providers = new Map<string, ExecutionProvider>();
  register(provider: ExecutionProvider) {
    if (
      !/^[a-z][a-z0-9-]{0,47}$/.test(provider.id) ||
      this.providers.has(provider.id)
    )
      throw new Error("Duplicate or invalid execution provider");
    this.providers.set(provider.id, provider);
  }
  get(id: string) {
    const provider = this.providers.get(id);
    if (!provider) throw new Error("Execution provider is not configured");
    return provider;
  }
  list() {
    return [...this.providers.values()].map(({ id, capabilities }) => ({
      id,
      ...capabilities,
    }));
  }
}
