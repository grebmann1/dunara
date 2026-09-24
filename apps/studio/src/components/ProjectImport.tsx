import { useRef, useState } from 'react';
import type { ImportReview } from '../../../../packages/core/src/project-import';
import type { Project } from '../../../../packages/core/src/contracts';
import { useStudioClient } from '../api';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog';
import { Button } from './ui/button';
import { Input } from './ui/input';

export function ProjectImport({ open, onOpenChange, onImported }: { open: boolean; onOpenChange(value: boolean): void; onImported(project: Project): Promise<void> }) {
  const { api } = useStudioClient();
  const [review, setReview] = useState<ImportReview>(), [name, setName] = useState('Imported app'), [slug, setSlug] = useState('imported-app');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const operating = useRef(false);
  async function inspect(file?: File) {
    if (!file || operating.current) return;
    if (file.size > 32 * 1024 * 1024) { setError('Choose a project ZIP up to 32 MiB.'); return; }
    operating.current = true; setBusy(true); setError(''); setReview(undefined);
    try {
      const encoded = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onerror = () => reject(new Error('Could not read this ZIP.')); reader.onload = () => resolve(String(reader.result).split(',')[1]!); reader.readAsDataURL(file); });
      setReview(await api<ImportReview>('/project-imports/review', { zip: encoded }));
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not review this ZIP.'); }
    finally { operating.current = false; setBusy(false); }
  }
  async function apply() {
    if (!review || operating.current) return;
    operating.current = true; setBusy(true); setError('');
    try { const project = await api<Project>('/project-imports/apply', { id: review.id, revision: review.revision, name, slug, confirmed: true }); await onImported(project); onOpenChange(false); setReview(undefined); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Import could not finish. Your reviewed ZIP is retained for retry.'); }
    finally { operating.current = false; setBusy(false); }
  }
  return <Dialog open={open} onOpenChange={value => { if (!busy) onOpenChange(value); }}><DialogContent className="project-creation-dialog">
    <DialogTitle>Bring your app back</DialogTitle><DialogDescription>Review an exported Dunara Expo project, then import it into a new folder.</DialogDescription>
    <label>Project ZIP<input type="file" accept=".zip,application/zip" disabled={busy} onChange={event => void inspect(event.target.files?.[0])} /></label>
    {review && <form onSubmit={event => { event.preventDefault(); void apply(); }}><fieldset disabled={busy}>
      <label>App name<Input value={name} required maxLength={60} onChange={event => setName(event.target.value)} /></label>
      <label>New project folder<Input value={slug} required maxLength={48} pattern="[a-z][a-z0-9]*(-[a-z0-9]+)*" onChange={event => setSlug(event.target.value)} /></label>
      <p>{review.files.length} source files · {Math.ceil(review.files.reduce((total, file) => total + file.bytes, 0) / 1024)} KB. Existing apps are never overwritten. Dependencies are installed only when you start a preview.</p>
      <details><summary>Review included files and project scripts</summary><ul>{review.files.map(file => <li key={file.path}><code>{file.path}</code></li>)}</ul><pre>{JSON.stringify(review.scripts, null, 2)}</pre></details>
      {!!review.skipped.length && <details><summary>{review.skipped.length} files excluded</summary><ul>{review.skipped.map(name => <li key={name}>{name}</li>)}</ul></details>}
      <p>Review the source before running it. Imported apps receive a new Dunara project identity; their mobile app identifiers and public backend settings remain in their source.</p>
      <Button type="submit">Import reviewed project</Button>
    </fieldset></form>}
    {busy && <p role="status">Preparing your import…</p>}{error && <p role="alert">{error}</p>}
    <Button variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>Cancel</Button>
  </DialogContent></Dialog>;
}
