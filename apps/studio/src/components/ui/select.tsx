import type { ComponentProps } from 'react';
import * as SelectPrimitive from '@radix-ui/react-select';
import { Check, ChevronDown, ChevronUp } from 'lucide-react';
import { cn } from '../../lib/utils';

export const Select = SelectPrimitive.Root;
export const SelectValue = SelectPrimitive.Value;

export function SelectTrigger({ children, className, ...props }: ComponentProps<typeof SelectPrimitive.Trigger>) {
  return <SelectPrimitive.Trigger className={cn('flex min-h-[44px] w-full min-w-0 items-center justify-between gap-2 rounded-lg border border-solid border-border bg-card px-3 py-2 text-left text-sm text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50 [&>span]:truncate', className)} {...props}>
    {children}<SelectPrimitive.Icon asChild><ChevronDown aria-hidden className="size-4 shrink-0 text-muted-foreground" /></SelectPrimitive.Icon>
  </SelectPrimitive.Trigger>;
}

export function SelectContent({ children, className, ...props }: ComponentProps<typeof SelectPrimitive.Content>) {
  return <SelectPrimitive.Portal><div className="select-layer">
    <SelectPrimitive.Content position="popper" align="start" sideOffset={8} collisionPadding={12} className={cn('pointer-events-auto z-50 max-h-[min(320px,var(--radix-select-content-available-height))] w-[max(280px,var(--radix-select-trigger-width))] max-w-[var(--radix-select-content-available-width)] overflow-hidden rounded-lg border border-solid border-border bg-card text-foreground shadow-lg', className)} {...props}>
      <SelectPrimitive.ScrollUpButton className="flex h-[44px] items-center justify-center"><ChevronUp aria-hidden className="size-4" /></SelectPrimitive.ScrollUpButton>
      <SelectPrimitive.Viewport className="p-[4px]">{children}</SelectPrimitive.Viewport>
      <SelectPrimitive.ScrollDownButton className="flex h-[44px] items-center justify-center"><ChevronDown aria-hidden className="size-4" /></SelectPrimitive.ScrollDownButton>
    </SelectPrimitive.Content>
  </div></SelectPrimitive.Portal>;
}

export function SelectItem({ children, className, ...props }: ComponentProps<typeof SelectPrimitive.Item>) {
  return <SelectPrimitive.Item className={cn('relative flex min-h-[44px] cursor-default items-center rounded-md py-2 pr-8 pl-3 text-sm wrap-anywhere outline-none data-[highlighted]:bg-muted data-[highlighted]:ring-1 data-[highlighted]:ring-inset data-[highlighted]:ring-ring data-[disabled]:opacity-50', className)} {...props}>
    <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    <SelectPrimitive.ItemIndicator className="absolute right-2 flex items-center"><Check className="size-4" /></SelectPrimitive.ItemIndicator>
  </SelectPrimitive.Item>;
}
