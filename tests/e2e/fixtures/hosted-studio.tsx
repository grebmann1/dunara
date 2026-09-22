import { createRoot } from 'react-dom/client';
import { Studio, createStudioClient, localCapabilities } from '../../../apps/studio/src/Studio';
import '../../../apps/studio/src/theme.css';

const client = createStudioClient({
  auth: { kind: 'launch-ticket' },
  capabilities: { ...localCapabilities, connectionLabel: 'Cloud workspace', localPaths: false, accountSettings: false, credentialLocation: 'workspace' },
});
createRoot(document.getElementById('root')!).render(<Studio client={client} />);
