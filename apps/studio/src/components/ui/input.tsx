import type { ComponentProps } from 'react';
import { cn } from '../../lib/utils';

export function Input({ className, ...props }: ComponentProps<'input'>) {
  return <input data-slot="input" className={cn('min-h-[var(--control-size)] w-full min-w-0 rounded-lg border border-solid border-input bg-card px-3 py-1.5 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50', className)} {...props} />;
}
