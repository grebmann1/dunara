import { useLayoutEffect, useRef, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog';
import { Button } from './ui/button';
import { X } from 'lucide-react';
import { DockGrip, DockMenu, useDock } from './layout/WorkspaceDock';

export function DesignSurface({ open, onOpenChange, trigger, children }: { open: boolean; onOpenChange: (open: boolean) => void; trigger: RefObject<HTMLButtonElement | null>; children: ReactNode }) {
  const dock = useDock(), title = useRef<HTMLHeadingElement>(null);
  useLayoutEffect(() => { if (open && dock.desktop) title.current?.focus({ preventScroll: true }); }, [open, dock.desktop]);
  const close = () => { onOpenChange(false); trigger.current?.focus({ preventScroll: true }); };
  if (dock.desktop) return dock.hosts.design && createPortal(<section id="design-tools" className="dock-design" hidden={!open} aria-label="App design" onKeyDown={event => {
    if (event.key === 'Escape' && !(event.target instanceof Element && event.target.closest('[role="dialog"], [role="listbox"]'))) { event.preventDefault(); close(); }
  }}><header className="dock-design-header"><DockGrip id="design" /><h2 ref={title} tabIndex={-1}>App design</h2><DockMenu id="design" /><Button variant="ghost" aria-label="Close Design" title="Close Design" onClick={close}><X aria-hidden /></Button></header><div className="dock-design-body">{children}</div></section>, dock.hosts.design);
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="design-sheet top-0 right-0 left-auto h-full max-h-full w-[min(100%,360px)] max-w-none translate-x-0 translate-y-0 rounded-none p-0" onCloseAutoFocus={event => { event.preventDefault(); trigger.current?.focus(); }}>
      <div className="border-0 border-b border-solid border-border px-6 pt-6 pb-4"><DialogTitle className="m-0 pr-10 text-lg">App design</DialogTitle><DialogDescription className="mt-2 text-sm text-muted-foreground">Edit your app’s theme, not Studio’s appearance.</DialogDescription></div>
      {children}
    </DialogContent>
  </Dialog>;
}
