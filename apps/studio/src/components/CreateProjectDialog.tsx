import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, Check, ChevronDown, Database, SlidersHorizontal, Smartphone, Sparkles } from 'lucide-react';
import type { Backends } from '../../../../packages/core/src/backends';
import { useStudioClient } from '../api';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { SupabaseSettings } from './BackendPanel';
import '../project-creation.css';

export type CreationSetup = { brief: string; backend: 'supabase' | 'none'; build: boolean };
type Props = { open: boolean; onOpenChange: (open: boolean) => void; busy: boolean; backendEnabled: boolean; assistantEnabled: boolean; name: string; slug: string; onName: (value: string) => void; onSlug: (value: string) => void; onImport(): void; onSubmit: (setup: CreationSetup) => Promise<boolean>; error: ReactNode };
export function CreateProjectDialog({ open, onOpenChange, busy, backendEnabled, assistantEnabled, name, slug, onName, onSlug, onSubmit, onImport, error }: Props) {
  const { api } = useStudioClient();
  const returnFocus = useRef<HTMLElement | null>(null), heading = useRef<HTMLHeadingElement>(null);
  const [step, setStep] = useState<'idea' | 'backend'>('idea'), [brief, setBrief] = useState('');
  const [backend, setBackend] = useState<CreationSetup['backend']>('none');
  const [build, setBuild] = useState(true);
  const buildNow = assistantEnabled && build && !!brief.trim();
  const [connection, setConnection] = useState<ReturnType<Backends['status']>>();
  const [connectionError, setConnectionError] = useState(''), [checking, setChecking] = useState(false);
  const alive = useRef(false), submitting = useRef(false), connectionVersion = useRef(0);
  const locked = busy || checking;
  useEffect(() => { alive.current = open; return () => { alive.current = false; }; }, [open]);
  useEffect(() => { if (open) { setStep('idea'); setBackend('none'); setConnection(undefined); setConnectionError(''); setChecking(false); } }, [open]);
  useEffect(() => { if (open && step === 'backend') heading.current?.focus(); }, [open, step]);
  useEffect(() => {
    if (!open || step !== 'backend' || backend !== 'supabase' || !backendEnabled) return;
    let mounted = true; const version = ++connectionVersion.current;
    void api<ReturnType<Backends['status']>>('/backend/connection').then(value => { if (mounted && version === connectionVersion.current) setConnection(value); }).catch(() => { if (mounted && version === connectionVersion.current) setConnectionError('Connection unavailable. Try connecting again.'); });
    return () => { mounted = false; };
  }, [open, step, backend, backendEnabled, api]);
  async function create() {
    if (locked || submitting.current || !backend) return;
    submitting.current = true; setChecking(true); setConnectionError('');
    try {
      if (backend === 'supabase') {
        connectionVersion.current++;
        const current = await api<ReturnType<Backends['status']>>('/backend/connection');
        if (!alive.current) return;
        setConnection(current);
        if (!current.configured || !backendEnabled) throw new Error('Connect your Supabase account before creating this app, or choose No backend for now.');
      }
      if (await onSubmit({ brief: brief.trim(), backend, build: buildNow })) setBrief('');
    } catch (cause) { if (alive.current) setConnectionError(cause instanceof Error ? cause.message : 'App creation failed. Try again.'); }
    finally { submitting.current = false; if (alive.current) setChecking(false); }
  }
  return <Dialog open={open} onOpenChange={value => { if (!locked) onOpenChange(value); }}>
    <DialogContent className="project-creation-dialog" onOpenAutoFocus={() => { returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; }} onCloseAutoFocus={event => { event.preventDefault(); if (returnFocus.current?.isConnected) returnFocus.current.focus(); }}>
      <div className="project-creation-progress" aria-label="Creation steps"><Sparkles size={14} aria-hidden /><span>Describe · Build · Refine</span></div>
      <DialogTitle ref={heading} tabIndex={-1}>{step === 'idea' ? 'What are you making?' : 'Choose your backend'}</DialogTitle>
      <DialogDescription>{step === 'idea' ? 'A little idea. An app that feels like you.' : 'Set up accounts and shared data before building your app’s features.'}</DialogDescription>
      {error}
      {step === 'idea' ? <form onSubmit={event => { event.preventDefault(); void create(); }}>
        <fieldset disabled={locked}>
          <div className="creation-field"><Label htmlFor="app-name">App name</Label><Input id="app-name" required maxLength={60} value={name} onChange={event => onName(event.target.value)} /></div>
          <div className="creation-field"><Label htmlFor="new-app-brief">The idea <span className="optional-label">optional</span></Label><textarea id="new-app-brief" rows={4} maxLength={2000} value={brief} onChange={event => setBrief(event.target.value)} placeholder="What does your app do? Who is it for? Describe the screens and the look you love." /><small>Tell us the purpose, the main screens, and the visual style. Leave out private information.</small></div>
          <details className="creation-folder"><summary><SlidersHorizontal size={14} aria-hidden /><span>App settings</span>{backend === 'supabase' && <small>Supabase</small>}<ChevronDown size={14} aria-hidden /></summary>
            <div className="creation-options-body">
              <div className="creation-field"><Label htmlFor="app-slug">Project folder</Label><Input id="app-slug" required pattern="[a-z][a-z0-9]*(-[a-z0-9]+)*" maxLength={48} value={slug} onChange={event => onSlug(event.target.value)} onInvalid={event => { const details = event.currentTarget.closest('details'); if (details) details.open = true; }} /><small>Lowercase letters, numbers, and hyphens.</small></div>
              {backendEnabled && <Button variant="ghost" className="creation-backend-link" onClick={() => setStep('backend')}><Database size={16} aria-hidden /><span><strong>Accounts &amp; shared data</strong><small>{backend === 'supabase' ? 'Supabase selected · change setup' : 'Optional · you can connect this later'}</small></span><ArrowRight size={16} aria-hidden /></Button>}
            </div>
          </details>
          {assistantEnabled && <label className="creation-build-choice"><input type="checkbox" checked={build} onChange={event => setBuild(event.target.checked)} />Build my idea with the Assistant</label>}
          <p className="creation-next-note">{buildNow ? 'Create and build sends this idea to your connected Assistant and starts the first version.' : 'Create an editable workspace. You can ask the Assistant to build it later.'}</p>
          {connectionError && <p role="alert">{connectionError}</p>}
          <footer><Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button><Button type="submit">{locked ? 'Creating…' : buildNow ? 'Create and build' : 'Create app'}<ArrowRight size={14} aria-hidden /></Button></footer>
          <Button variant="ghost" type="button" disabled={locked} onClick={onImport}>Import an existing app</Button>
        </fieldset>
      </form> : <>
        <fieldset className="creation-backend-options" disabled={locked}>
          <legend className="sr-only">Backend choice</legend>
          {backendEnabled && <label data-selected={backend === 'supabase'}><input type="radio" name="creation-backend" value="supabase" checked={backend === 'supabase'} onChange={() => { setBackend('supabase'); setConnectionError(''); }} /><Database size={18} aria-hidden /><span><strong>Supabase</strong><small>Sign-in, shared data, and file uploads</small></span></label>}
          <label data-selected={backend === 'none'}><input type="radio" name="creation-backend" value="none" checked={backend === 'none'} onChange={() => { setBackend('none'); setConnectionError(''); }} /><Smartphone size={18} aria-hidden /><span><strong>No backend for now</strong><small>Start locally. Connect one later if you need it.</small></span></label>
        </fieldset>
        {backend === 'supabase' && (connection?.configured ? <div className="creation-account-ready" role="status"><Check size={16} aria-hidden /><div><strong>Account connection saved</strong><p>After creation, choose a Supabase project and review the connection in Backend.</p></div></div> : <SupabaseSettings compact disabled={locked} onConnected={async () => { const version = ++connectionVersion.current; const value = await api<ReturnType<Backends['status']>>('/backend/connection'); if (alive.current && version === connectionVersion.current) { setConnection(value); setConnectionError(''); } }} />)}
        {connectionError && <p role="alert">{connectionError}</p>}
        <p className="creation-recipe-note">You can change this setup later in Backend.</p>
        <footer><Button variant="ghost" disabled={locked} onClick={() => setStep('idea')}><ArrowLeft size={14} aria-hidden />Back</Button><Button disabled={locked || !backend || (backend === 'supabase' && (!connection?.configured || !backendEnabled))} onClick={() => void create()}>{locked ? 'Creating…' : buildNow ? 'Create and build' : 'Create app'}</Button></footer>
      </>}
    </DialogContent>
  </Dialog>;
}
