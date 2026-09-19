import { useId } from 'react';
import { Label } from './label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './select';

export function FieldSelect({ label, value, onValueChange, options, disabled }: { label: string; value: string; onValueChange: (value: string) => void; options: { value: string; label: string }[]; disabled?: boolean }) {
  const id = useId();
  return <div className="field-select"><Label htmlFor={id}>{label}</Label><Select value={value} onValueChange={next => {
    // Radix's form bridge can emit an empty value when a controlled draft changes.
    if (options.some(option => option.value === next)) onValueChange(next);
  }} disabled={disabled}>
    <SelectTrigger id={id}><SelectValue /></SelectTrigger>
    <SelectContent>{options.map(option => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
  </Select></div>;
}
