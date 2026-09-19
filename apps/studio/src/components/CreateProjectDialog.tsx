import { useRef, type FormEvent, type ReactNode } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';

type Props = { open: boolean; onOpenChange: (open: boolean) => void; busy: boolean; name: string; slug: string; onName: (value: string) => void; onSlug: (value: string) => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void; error: ReactNode };
export function CreateProjectDialog({ open, onOpenChange, busy, name, slug, onName, onSlug, onSubmit, error }: Props) {
  const returnFocus = useRef<HTMLElement | null>(null);
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent onOpenAutoFocus={() => { returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; }} onCloseAutoFocus={event => { event.preventDefault(); if (returnFocus.current?.isConnected) returnFocus.current.focus(); }}>
      <DialogTitle className="m-0 pr-10 text-xl font-semibold tracking-tight">Create an app</DialogTitle>
      <DialogDescription className="mt-2 text-sm leading-6 text-muted-foreground">Start with the Expo wellness recipe: three working screens and editable design tokens. Your agent can replace the content and add routes.</DialogDescription>
      <form onSubmit={onSubmit} className="mt-6">
        {error}
        <fieldset disabled={busy} className="m-0 grid min-w-0 gap-4 border-0 p-0">
          <div className="grid gap-2"><Label htmlFor="app-name">App name</Label><Input id="app-name" required maxLength={60} value={name} onChange={event => onName(event.target.value)} /></div>
          <div className="grid gap-2"><Label htmlFor="app-slug">Directory slug</Label><Input id="app-slug" required pattern="[a-z][a-z0-9]*(-[a-z0-9]+)*" maxLength={48} value={slug} onChange={event => onSlug(event.target.value)} /></div>
          <p className="text-sm text-muted-foreground">Creates source only. Installing and running it requires explicit execution trust.</p>
          <div className="flex flex-wrap justify-end gap-2"><Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button><Button type="submit">Create app</Button></div>
        </fieldset>
      </form>
    </DialogContent>
  </Dialog>;
}
