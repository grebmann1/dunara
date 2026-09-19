import type { ReactElement } from 'react';
export declare const STUDIO_PROTOCOL_VERSION: 1;
export interface StudioCapabilities {
  managePlugins: boolean;
  localPaths: boolean;
  accountSettings: boolean;
  backendOAuth: boolean;
  privatePreview: boolean;
  connectionLabel: string;
  credentialLocation: 'computer' | 'workspace';
}
export declare const localCapabilities: Readonly<StudioCapabilities>;
export interface StudioClientOptions {
  origin?: string;
  auth: { kind: 'launch-ticket'; takeTicket?: () => string } | { kind: 'token'; token: string };
  capabilities?: Readonly<StudioCapabilities>;
  fetch?: typeof fetch;
  webSocket?: typeof WebSocket;
}
declare const studioClientBrand: unique symbol;
/** An opaque, instance-owned transport created by createStudioClient. */
export interface StudioClient {
  readonly [studioClientBrand]: true;
  readonly capabilities: Readonly<StudioCapabilities>;
  readonly origin: string;
  authenticate(): Promise<void>;
  api<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T>;
  dispose(): void;
}
export declare function createStudioClient(options: StudioClientOptions): StudioClient;
export declare function Studio(props: { client: StudioClient }): ReactElement;
