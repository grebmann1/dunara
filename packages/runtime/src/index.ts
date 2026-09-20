import { Engine } from '../../core/src/engine.js';
import { Projects } from '../../core/src/projects.js';
import type { ProjectWorkspacePersistence } from '../../core/src/durable-projects.js';
import type { HomeStatePersistence } from '../../core/src/durable-state.js';
export type { HomeStatePersistence, DurableStateRecord } from '../../core/src/durable-state.js';
export type { ProjectWorkspacePersistence, ProjectWorkspaceSnapshot, ProjectWorkspaceHead, DurableProject } from '../../core/src/durable-projects.js';
export { Engine, Projects };
export { Diagnostics } from '../../core/src/diagnostics.js';
export type { PreviewDriver } from '../../core/src/preview-driver.js';
export type { AppEnvironment } from '../../core/src/runtime-environment.js';
export type RuntimeHost = NonNullable<ConstructorParameters<typeof Engine>[8]>;
export interface RuntimeOptions {
  workspace: string;
  home: string;
  trustExecution?: boolean;
  lan?: boolean;
  services?: ConstructorParameters<typeof Engine>[7];
  host?: RuntimeHost;
  projectPersistence?: ProjectWorkspacePersistence;
  statePersistence?: HomeStatePersistence;
}
/** Construct one builder with a host-owned execution driver. Importing this module starts nothing. */
export async function createBuilderRuntime(options: RuntimeOptions): Promise<Engine> {
  const projects = await Projects.open(options.workspace, options.home, options.projectPersistence, options.statePersistence);
  let engine: Engine | undefined;
  try {
    engine = new Engine(projects, options.trustExecution ?? false, options.lan ?? false, undefined, {}, {}, undefined, options.services, options.host);
    await engine.plugins.ready; await projects.flushState(); return engine;
  } catch (error) {
    if (engine) await engine.close().catch(() => {}); else await projects.closeState().catch(() => {});
    throw error;
  }
}
