import { useState } from 'react';
import type { UnavailableProject } from '../../../../packages/core/src/projects';
import { Button } from './ui/button';

export function UnavailableProjects({ entries, localPaths, disabled, onRetry, onRemove }: { entries: UnavailableProject[]; localPaths: boolean; disabled: boolean; onRetry(): void; onRemove(entry: UnavailableProject): Promise<boolean> }) {
  const [confirm, setConfirm] = useState('');
  if (!entries.length) return null;
  return <details className="unavailable-projects"><summary>{entries.length} unavailable {entries.length === 1 ? 'app' : 'apps'} · Recovery</summary>
    <p>Your other apps are ready to use. These registrations are kept so you can recover them.</p>
    <ul>{entries.map(entry => <li key={entry.project.id}><strong>{entry.project.name}</strong><p>{entry.reason === 'missing' ? 'The app folder or its files could not be found.' : entry.reason === 'unreadable' ? 'The app folder could not be read. Check its access permissions.' : 'The app folder or its saved identity needs repair.'}</p>
      {localPaths && <p>Restore the original app folder at <code>{entry.project.root}</code>, then check again. Keep its saved identity file.</p>}
      {!localPaths && <p>Ask your workspace administrator to restore the app folder, then check again.</p>}
      <div><Button variant="outline" disabled={disabled} onClick={onRetry}>Check again</Button><Button variant="ghost" disabled={disabled} onClick={() => setConfirm(entry.project.id)}>Remove from list</Button></div>
      {confirm === entry.project.id && <div role="group" aria-label={`Remove ${entry.project.name} from list`}><p>Remove this registration? This does not delete any app files. You can register the original folder again after restoring it.</p><Button variant="outline" disabled={disabled} onClick={() => setConfirm('')}>Cancel</Button><Button disabled={disabled} onClick={() => { void onRemove(entry).then(removed => { if (removed) setConfirm(''); }); }}>Confirm removal</Button></div>}
    </li>)}</ul>
  </details>;
}
