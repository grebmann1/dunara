import { App } from './App';
import { StudioClientContext, type StudioClient } from './api';

/** The host owns the client lifetime; dispose it when its authenticated session ends. */
export function Studio({ client }: { client: StudioClient }) {
  return <StudioClientContext.Provider value={client}><App /></StudioClientContext.Provider>;
}
export { createStudioClient, localCapabilities, STUDIO_PROTOCOL_VERSION } from './api';
export type { StudioClient, StudioClientOptions, StudioCapabilities } from './api';
