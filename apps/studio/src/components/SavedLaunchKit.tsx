import { useEffect, useState, type ReactNode } from 'react';
import { Download, FileText, Image as ImageIcon, Package } from 'lucide-react';
import type { LaunchKit, LaunchKitFile } from '../../../../packages/core/src/launch-kit-contracts';
import { useStudioClient } from '../api';
import { Button } from './ui/button';
import '../launch-kit.css';

function fileSize(bytes: number) {
  if (bytes < 1024) return `${bytes.toLocaleString()} B`;
  const unit = bytes < 1024 * 1024 ? 'KB' : 'MB';
  return `${(bytes / (unit === 'KB' ? 1024 : 1024 * 1024)).toLocaleString(undefined, { maximumFractionDigits: 1 })} ${unit}`;
}

function dateLabel(value: string) {
  return new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

const documentNames: Record<string, string> = {
  manifest: 'Kit manifest', 'listing-json': 'Listing data', listing: 'Listing draft',
  credits: 'Credits & attribution', readiness: 'Readiness checklist',
};

function fileLabel(kit: LaunchKit, file: LaunchKitFile) {
  const capture = kit.manifest.captures.find(item => file.id === `screenshot-${item.id}`);
  if (capture) return `${capture.route === '/' ? 'Home' : capture.route} · ${capture.width} × ${capture.height}`;
  if (file.id === 'icon') return 'App icon · 1024 × 1024';
  return documentNames[file.id] ?? file.name;
}

function SavedImage({ projectId, kitId, fileId, label }: { projectId: string; kitId: string; fileId: string; label: string }) {
  const { kitDownload } = useStudioClient();
  const [src, setSrc] = useState(''), [failed, setFailed] = useState(false), [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let disposed = false, url = '';
    setSrc(''); setFailed(false);
    void kitDownload(projectId, kitId, fileId).then(value => {
      url = value;
      if (disposed) URL.revokeObjectURL(value); else setSrc(value);
    }).catch(() => { if (!disposed) setFailed(true); });
    return () => { disposed = true; if (url) URL.revokeObjectURL(url); };
  }, [projectId, kitId, fileId, kitDownload, attempt]);
  return <div className="saved-kit-thumbnail">
    {failed ? <Button variant="ghost" aria-label={`Retry preview of ${label}`} onClick={() => setAttempt(value => value + 1)}>Retry preview</Button>
      : src ? <img src={src} alt={`Preview of ${label}`} onError={() => setFailed(true)} />
        : <span role="status">Loading preview…</span>}
  </div>;
}

export function SavedLaunchKit({ kit, projectId, active, busy, onDownload, children }: {
  kit: LaunchKit; projectId: string; active: boolean; busy: boolean;
  onDownload(file: LaunchKitFile): void; children: ReactNode;
}) {
  const [imagesOpen, setImagesOpen] = useState(false);
  const documents = kit.files.filter(file => file.mediaType !== 'image/png');
  const images = kit.files.filter(file => file.mediaType === 'image/png');
  const screenshots = kit.manifest.captures.length;
  function download(file: LaunchKitFile) {
    return <Button variant="ghost" disabled={busy} aria-label={`Download ${fileLabel(kit, file)}`} onClick={() => onDownload(file)}><Download aria-hidden="true" />Download</Button>;
  }
  return <article className="media-card saved-kit" aria-labelledby={`saved-kit-${kit.manifest.id}`}>
    <header className="saved-kit-heading">
      <div className="saved-kit-identity"><span className="saved-kit-mark"><Package aria-hidden="true" /></span><div>
        <h4 id={`saved-kit-${kit.manifest.id}`}>{kit.manifest.listing.name}</h4>
        <p className="saved-kit-meta">Created <time dateTime={kit.manifest.createdAt}>{dateLabel(kit.manifest.createdAt)}</time></p>
      </div></div>
      <span className="saved-kit-badge">Web draft</span>
    </header>
    <p className="saved-kit-meta">{screenshots} screenshot{screenshots === 1 ? '' : 's'}{kit.manifest.icon ? ' · App icon' : ''} · {kit.files.length} files · {fileSize(kit.files.reduce((total, file) => total + file.bytes, 0))}</p>
    <section aria-label="Kit documents"><h5>Documents</h5>
      <ul className="saved-kit-files">{documents.map(file => <li key={file.id} data-kit-file-id={file.id}>
        <FileText className="saved-kit-file-symbol" aria-hidden="true" /><div className="saved-kit-file-info"><strong>{fileLabel(kit, file)}</strong><span>{file.name} · {fileSize(file.bytes)}</span></div>{download(file)}
      </li>)}</ul>
    </section>
    {!!images.length && <details className="saved-kit-images" onToggle={event => setImagesOpen(event.currentTarget.open)}>
      <summary>Screenshots{kit.manifest.icon ? ' & icon' : ''}<span className="saved-kit-count">{images.length}</span></summary>
      <ul className="saved-kit-files saved-kit-image-files">{images.map(file => {
        const capture = kit.manifest.captures.find(item => file.id === `screenshot-${item.id}`);
        const label = fileLabel(kit, file);
        return <li key={file.id} data-kit-file-id={file.id}>
          {active && imagesOpen ? <SavedImage projectId={projectId} kitId={kit.manifest.id} fileId={file.id} label={label} /> : <ImageIcon className="saved-kit-file-symbol" aria-hidden="true" />}
          <div className="saved-kit-file-info"><strong>{label}</strong><span>PNG · {fileSize(file.bytes)}</span>{capture && <time dateTime={capture.createdAt}>{dateLabel(capture.createdAt)}</time>}</div>{download(file)}
        </li>;
      })}</ul>
    </details>}
    <p className="saved-kit-note">React Native Web captures and listing drafts. Native testing and rights review are still required.</p>
    <details className="saved-kit-technical"><summary>Technical details</summary>
      <p>Inside your configured Dunara home:</p><code>{kit.location}</code>
      <p>Original filenames, exact sizes and SHA-256 checksums for verifying downloads.</p>
      <ul>{kit.files.map(file => <li key={file.id}><strong>{file.name}</strong><dl>
        <div><dt>Size</dt><dd>{file.bytes.toLocaleString()} bytes</dd></div>
        <div><dt>SHA-256</dt><dd><code>{file.sha256}</code></dd></div>
      </dl></li>)}</ul>
    </details>
    <footer className="saved-kit-footer">{children}</footer>
  </article>;
}
