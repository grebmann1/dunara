import type { ReactNode } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog';

export function WorkspaceDrawer({ open, onOpenChange, title, description, children, restoreFocus, className = '' }: { open: boolean; onOpenChange(open: boolean): void; title: string; description: string; children: ReactNode; restoreFocus?(): void; className?: string }) {
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent placement="drawer" className={`workspace-drawer ${className}`} onCloseAutoFocus={event => { if (restoreFocus) { event.preventDefault(); restoreFocus(); } }}>
      <header className="workspace-drawer-heading"><DialogTitle>{title}</DialogTitle><DialogDescription>{description}</DialogDescription></header>
      <div className="workspace-drawer-content">{children}</div>
    </DialogContent>
  </Dialog>;
}
