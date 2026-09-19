import type { ComponentProps } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { cn } from '../../lib/utils';
import { Button } from './button';

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogTitle = DialogPrimitive.Title;
export const DialogDescription = DialogPrimitive.Description;

export function DialogContent({ className, children, placement = 'center', ...props }: ComponentProps<typeof DialogPrimitive.Content> & { placement?: 'center' | 'drawer' }) {
  return <DialogPrimitive.Portal>
    <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-black/35" />
    <DialogPrimitive.Content className={cn('fixed z-50 overscroll-contain rounded-xl border border-solid border-border bg-card text-foreground shadow-xl', placement === 'center' && 'top-1/2 left-1/2 max-h-[calc(100%-32px)] w-[calc(100%-32px)] max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-y-auto p-6', className)} {...props}>
      {children}
      <DialogPrimitive.Close asChild><Button variant="ghost" aria-label="Close dialog" className="absolute top-2 right-2"><X aria-hidden /></Button></DialogPrimitive.Close>
    </DialogPrimitive.Content>
  </DialogPrimitive.Portal>;
}
