import type { Json } from './server.js';
/** Version 1 provider contracts. Implementations remain behind the selected plugin. */
export interface BackendEnvironmentProvider {
  inspect(projectId: string): Promise<Json>;
  publicEnvironment(projectId: string): Promise<Record<string, string>>;
}
export interface CaptureProvider {
  list(projectId: string): Json;
  read(projectId: string, captureId: string): { bytes: Uint8Array; metadata: Json };
}
export interface AssetProvider {
  list(projectId: string): Promise<Json>;
  read(projectId: string, assetId: string): Promise<{ bytes: Uint8Array }>;
}
