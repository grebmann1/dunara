import { useEffect, useRef, useState } from 'react';
import { Plus } from 'lucide-react';
import { useStudioClient } from '../api';
import { Button } from '../components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from '../components/ui/dialog';

type Inspection = { package: { version: string; builder: { id: string; name: string; description: string; capabilities: string[] } }; digest: string; files: string[] };

export function PluginInstaller({ disabled, refresh, onInstalled }: { disabled: boolean; refresh(): Promise<void>; onInstalled(id: string): void }) {
  const { api } = useStudioClient();
  const [open, setOpen] = useState(false), [source, setSource] = useState('');
  const [inspection, setInspection] = useState<Inspection>(), [trust, setTrust] = useState(false), [development, setDevelopment] = useState(false);
  const [phase, setPhase] = useState<'inspect' | 'install' | ''>(''), [error, setError] = useState('');
  const request = useRef(0), pending = useRef<AbortController | null>(null), installed = useRef<string | undefined>(undefined);
  useEffect(() => () => { request.current++; pending.current?.abort(); }, []);
  function changeOpen(next: boolean) {
    if (phase === 'install') return;
    if (!next) { request.current++; pending.current?.abort(); pending.current = null; setPhase(''); }
    setInspection(undefined); setTrust(false); setError(''); setOpen(next);
  }
  async function run(action: 'inspect' | 'install') {
    if (pending.current || disabled || (action === 'install' && (!inspection || !trust))) return;
    const controller = new AbortController(), version = ++request.current;
    pending.current = controller; setPhase(action); setError('');
    try {
      if (action === 'inspect') {
        setInspection(undefined); setTrust(false);
        const result = await api<Inspection>('/plugins/inspect', { source }, controller.signal);
        if (version === request.current) setInspection(result);
      } else {
        await api('/plugins/install', { source, digest: inspection!.digest, trust: true, development }, controller.signal);
        await refresh();
        if (version === request.current) { installed.current = inspection!.package.builder.id; setOpen(false); setInspection(undefined); setTrust(false); }
      }
    } catch (cause) { if (version === request.current && !controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Plugin operation failed.'); }
    finally { if (version === request.current) { pending.current = null; setPhase(''); } }
  }
  return <Dialog open={open} onOpenChange={changeOpen}>
    <DialogTrigger asChild><Button variant="outline" disabled={disabled}><Plus size={15} aria-hidden />Install plugin</Button></DialogTrigger>
    <DialogContent className="plugin-install-dialog" onCloseAutoFocus={event => {
      if (installed.current) { event.preventDefault(); const id = installed.current; installed.current = undefined; onInstalled(id); }
    }}>
      <DialogTitle>Install a local plugin</DialogTitle>
      <DialogDescription>Choose a plugin folder or .builder-plugin.json package on this computer.</DialogDescription>
      {error && <p role="alert" className="plugin-error">{error}</p>}
      <form onSubmit={event => { event.preventDefault(); void run('inspect'); }}>
        <fieldset disabled={!!phase}>
          <label>Package path<input placeholder="/absolute/path/my-plugin" value={source} onChange={event => { setSource(event.target.value); setInspection(undefined); setTrust(false); }} required /></label>
          <Button variant="outline" type="submit">{phase === 'inspect' ? 'Inspecting…' : 'Inspect package'}</Button>
        </fieldset>
      </form>
      {inspection && <section className="plugin-install-review" aria-label="Package review">
        <h3>{inspection.package.builder.name} <small>v{inspection.package.version}</small></h3><p>{inspection.package.builder.description}</p>
        <p className="plugin-muted">Capabilities: {inspection.package.builder.capabilities.join(', ') || 'No host capabilities declared'}</p>
        <details><summary>{inspection.files.length} package files</summary><pre tabIndex={0}>{inspection.digest}{'\n\n'}{inspection.files.join('\n')}</pre></details>
        <fieldset disabled={!!phase}>
          <label className="plugin-check"><input type="checkbox" checked={trust} onChange={event => setTrust(event.target.checked)} />I trust this plugin. Its code can access my computer and data.</label>
          <label className="plugin-check"><input type="checkbox" checked={development} onChange={event => setDevelopment(event.target.checked)} />Remember as a development package</label>
        </fieldset>
      </section>}
      <footer><Button variant="ghost" disabled={phase === 'install'} onClick={() => changeOpen(false)}>Cancel</Button>{inspection && <Button disabled={!!phase || !trust || disabled} onClick={() => void run('install')}>{phase === 'install' ? 'Installing…' : 'Install and enable'}</Button>}</footer>
    </DialogContent>
  </Dialog>;
}
