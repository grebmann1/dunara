import { useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Check, Download, FileArchive, FolderCode, LoaderCircle, X } from 'lucide-react';
import { Button } from './ui/button';
import { useStudioClient } from '../api';
import '../project-download.css';

export function ProjectDownload({ projectId, name, disabled }: { projectId: string; name: string; disabled: boolean }) {
  const { projectDownload } = useStudioClient();
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  const download = async () => {
    if (request.current) return;
    const controller = new AbortController(); request.current = controller;
    setBusy(true); setError(''); setNotice('');
    try {
      const archive = await projectDownload(projectId, controller.signal);
      if (controller.signal.aborted) return;
      const url = URL.createObjectURL(archive.blob), link = document.createElement('a');
      link.href = url; link.download = archive.filename; document.body.append(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      setNotice(`${archive.filename} is ready. Your browser or save dialog handles the download.`);
    } catch (cause) { if (!controller.signal.aborted) setError((cause as Error).message); }
    finally { if (!controller.signal.aborted) { request.current = null; setBusy(false); } }
  };
  const close = () => { request.current?.abort(); request.current = null; setBusy(false); setOpen(false); };
  return <Dialog.Root open={open} onOpenChange={value => { if (value) { setOpen(true); setError(''); setNotice(''); } else close(); }}>
    <Dialog.Trigger asChild><Button className="project-download-trigger w-full" variant="ghost" disabled={disabled}><Download aria-hidden />Download project</Button></Dialog.Trigger>
    <Dialog.Portal>
      <Dialog.Overlay className="project-download-overlay" />
      <Dialog.Content className="project-download-dialog" onInteractOutside={event => event.preventDefault()}>
        <header><span className="project-download-icon" aria-hidden><FolderCode size={24} /></span><Dialog.Close asChild><Button variant="ghost" aria-label="Close project download"><X aria-hidden /></Button></Dialog.Close></header>
        <Dialog.Title>Take your app with you</Dialog.Title>
        <Dialog.Description>Download <strong>{name}</strong> as a complete source project. Keep building in your own editor, without Dunara.</Dialog.Description>
        <section aria-label="Download contents"><h3><FileArchive size={18} aria-hidden />One ZIP, ready to unpack</h3><ul><li>App source, screens, and components</li><li>Images, icons, fonts, and other assets</li><li>Dependency lockfile and app configuration</li><li>Backend code, migrations, and documentation</li></ul><p>Private environment files, credentials, Git history, installed dependencies, and build output stay out of the ZIP.</p></section>
        <p className="project-download-help">Unzip the project, then follow the included export guide to install dependencies and run it. The guide lists any omitted files and setup to recreate.</p>
        {error && <p className="project-download-error" role="alert">{error}</p>}
        {notice && <p className="project-download-notice" role="status"><Check size={16} aria-hidden />{notice}</p>}
        <footer><small>Source code · ZIP</small><Button disabled={disabled || busy} onClick={() => void download()}>{busy ? <LoaderCircle className="assistant-spinner" aria-hidden /> : <Download aria-hidden />}{busy ? 'Preparing ZIP…' : 'Download ZIP'}</Button></footer>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
