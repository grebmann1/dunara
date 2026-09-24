import type { Preview } from './contracts.js';
import type { Projects } from './projects.js';
import type { Diagnostics } from './diagnostics.js';
import type { checkDependencies } from './dependency-profiles.js';

/** A host owns execution; the builder owns preview actions and their approval policy. */
export interface PreviewDriver {
  readonly projects: Projects;
  readonly diagnostics: Diagnostics;
  readonly trusted: boolean;
  status(id: string): Preview;
  expoAccount?(id: string): Promise<import('./expo-account.js').ExpoAccountStatus>;
  setTransport(id: string, input: unknown, signal?: AbortSignal): Promise<Preview>;
  recordPhoneTest(id: string, input: unknown): Promise<Preview>;
  configurationRevision(id: string): Promise<string>;
  checkDependencies(root: string): ReturnType<typeof checkDependencies>;
  withStopped<T>(id: string, work: () => Promise<T>): Promise<T>;
  installDependencies(id: string, root: string, signal: AbortSignal): Promise<void>;
  start(id: string, signal?: AbortSignal): Promise<Preview>;
  stop(id: string): Promise<Preview>;
  close(): Promise<void>;
}
