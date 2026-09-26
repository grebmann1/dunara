import { useId, type KeyboardEvent, type ReactNode } from 'react';
import { SectionTab } from './ui/section-tab';

export function BackendTabs<T extends string>({ label, tabs, active, onChange, children }: {
  label: string; tabs: readonly { id: T; label: string; count?: number }[]; active: T;
  onChange(tab: T): void; children(tab: T): ReactNode;
}) {
  const id = useId();
  function navigate(event: KeyboardEvent<HTMLDivElement>) {
    if (event.altKey || event.ctrlKey || event.metaKey || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const index = tabs.findIndex(tab => tab.id === active);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    event.preventDefault();
    onChange(tabs[next]!.id);
    event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
  }
  return <>
    <div className="backend-tabs section-tabs" role="tablist" aria-label={label} onKeyDown={navigate}>{tabs.map(tab => <SectionTab key={tab.id} id={`${id}-${tab.id}`} role="tab" selected={active === tab.id} aria-selected={active === tab.id} aria-controls={`${id}-${tab.id}-panel`} tabIndex={active === tab.id ? 0 : -1} onClick={() => onChange(tab.id)}>{tab.label}{!!tab.count && <span className="backend-tab-count">{tab.count}<span className="sr-only"> awaiting review</span></span>}</SectionTab>)}</div>
    {tabs.map(tab => <div key={tab.id} id={`${id}-${tab.id}-panel`} role="tabpanel" aria-labelledby={`${id}-${tab.id}`} tabIndex={0} hidden={active !== tab.id} className="backend-tab-panel">{children(tab.id)}</div>)}
  </>;
}
