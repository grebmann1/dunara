import { createRoot } from 'react-dom/client';
import { Studio, createStudioClient } from './Studio';
import './theme.css';
const client = createStudioClient({ auth: { kind: 'launch-ticket' } });
createRoot(document.getElementById('root')!).render(<Studio client={client} />);
