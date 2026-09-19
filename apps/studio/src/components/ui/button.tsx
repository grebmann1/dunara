import type { ComponentProps } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/utils';

const buttonVariants = cva('inline-flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center gap-2 rounded-lg border border-solid px-3 py-2 text-sm font-medium leading-5 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0', {
  variants: {
    variant: {
      default: 'border-primary bg-primary text-primary-foreground hover:bg-primary/90',
      outline: 'border-border bg-card text-foreground hover:bg-muted',
      ghost: 'border-transparent bg-transparent text-foreground hover:bg-muted',
      destructive: 'border-destructive bg-destructive text-white hover:bg-destructive/90',
    },
  },
  defaultVariants: { variant: 'default' },
});

export function Button({ className, variant, type = 'button', ...props }: ComponentProps<'button'> & VariantProps<typeof buttonVariants>) {
  return <button data-slot="button" type={type} className={cn(buttonVariants({ variant }), className)} {...props} />;
}
