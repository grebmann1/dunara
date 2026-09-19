import type { ComponentProps } from 'react';
import { cn } from '../../lib/utils';

export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return <textarea className={cn('min-h-[44px] w-full min-w-0 rounded-lg border border-solid border-input bg-card px-3 py-2 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50', className)} {...props} />;
}
