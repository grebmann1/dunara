import type { ComponentProps } from 'react';
import { Button } from './button';
import { cn } from '../../lib/utils';
import '../../section-tabs.css';

/** Shared appearance for section navigation, including plugin workspaces. */
export function SectionTab({ selected, className, ...props }: Omit<ComponentProps<typeof Button>, 'variant'> & { selected: boolean }) {
  return <Button variant="ghost" className={cn('section-tab', className)} data-selected={selected} {...props} />;
}
