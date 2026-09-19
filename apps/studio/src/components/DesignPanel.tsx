import { useState, type RefObject } from 'react';
import { Check, Moon, Sun } from 'lucide-react';
import type { StudioState } from '../api';
import type { Tokens } from '../../../../packages/core/src/contracts';
import { DesignSurface } from './DesignSurface';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';

export type DesignDraft = { tokens: Partial<Tokens>; revision: string };
export function DesignPanel({ design, disabled, onApply, savedDraft, onDraft, open, onOpenChange, trigger }: { design: StudioState['design']; disabled: boolean; onApply: (update: unknown) => Promise<boolean>; savedDraft?: DesignDraft; onDraft: (draft: DesignDraft) => void; open: boolean; onOpenChange: (open: boolean) => void; trigger: RefObject<HTMLButtonElement | null> }) {
  // Keep the draft owner mounted when the presentation moves between panel and sheet.
  const [draft, setDraft] = useState<Partial<Tokens>>(savedDraft?.tokens ?? {});
  const [baseRevision, setBaseRevision] = useState(savedDraft?.revision ?? '');
  function remember(tokens: Partial<Tokens>, revision = baseRevision) { setDraft(tokens); setBaseRevision(revision); onDraft({ tokens, revision }); }
  if ('error' in design) return <DesignSurface open={open} onOpenChange={onOpenChange} trigger={trigger}><aside className="inspector"><h2>Design needs attention</h2><p role="alert">{design.error.message}</p><p>Repair src/theme/design.json through your harness. Unsaved edits are retained for this project during this Studio session.</p></aside></DesignSurface>;
  const dirty = Object.keys(draft).length > 0;
  const conflict = dirty && baseRevision !== design.revision;
  const edit = (key: keyof Tokens, value: string | number) => {
    const next = { ...draft, [key]: value };
    if (value === design.tokens[key]) delete next[key];
    remember(next, dirty ? baseRevision : design.revision);
  };
  async function apply(update: unknown) { if (await onApply(update)) remember({}); }
  const colors = ['background', 'surface', 'text', 'muted', 'accent', 'onAccent', 'border'] as const;
  return <DesignSurface open={open} onOpenChange={onOpenChange} trigger={trigger}><aside className="inspector">
    <h2 className="text-lg tracking-tight">Design tokens</h2>
    <p className="text-sm text-muted-foreground">Preset and app appearance changes reset custom tokens. Apply or discard your draft first.</p>
    {conflict && <div className="design-conflict"><p role="alert">Design changed outside this draft. Review your values against the latest design before reapplying. Nothing has been overwritten.</p><Button variant="outline" disabled={disabled} onClick={() => remember(draft, design.revision)}>Review against latest revision</Button></div>}
    <fieldset disabled={disabled} className="mt-5 grid gap-5">
      <legend className="sr-only">App theme</legend>
      <div><h3 className="mb-3 text-sm font-medium">Collection</h3><div className="presets">
        {(['sage', 'clay', 'midnight'] as const).map(p => <Button variant="outline" key={p} aria-label={p} disabled={dirty || design.preset === p} aria-pressed={design.preset === p} className={`preset ${p} ${design.preset === p ? 'bg-primary/5 border-primary/30 text-primary disabled:opacity-100' : ''}`} onClick={() => void apply({ preset: p, expectedRevision: design.revision })}><span aria-hidden className="swatches"><i /><i /><i /></span><span>{p}</span>{design.preset === p && <Check aria-hidden className="ml-auto" />}</Button>)}
      </div></div>
      <div><h3 className="mb-3 text-sm font-medium">App appearance</h3><div className="flex gap-2">
        {(['light', 'dark'] as const).map(mode => <Button variant="outline" key={mode} disabled={dirty || design.mode === mode} aria-pressed={design.mode === mode} className={design.mode === mode ? 'bg-primary/5 border-primary/30 text-primary disabled:opacity-100' : ''} onClick={() => void apply({ mode, expectedRevision: design.revision })}>{mode === 'light' ? <Sun aria-hidden /> : <Moon aria-hidden />}{mode === 'light' ? 'Light' : 'Dark'}</Button>)}
      </div></div>
      <div><h3 className="mb-2 text-sm font-medium">Semantic colors</h3><div className="color-list">
        {colors.map(name => <Label key={name}><span>{name.replace(/([A-Z])/g, ' $1')}</span><code>{draft[name] ?? design.tokens[name]}</code><Input className="size-11 shrink-0 p-0.5" type="color" aria-label={name} value={draft[name] ?? design.tokens[name]} onChange={e => edit(name, e.target.value)} /></Label>)}
      </div></div>
      <div><h3 className="mb-3 text-sm font-medium">Shape & rhythm</h3>
        {([{ key: 'radius', label: 'Corner radius', min: 0, max: 32 }, { key: 'spacing', label: 'Base spacing', min: 4, max: 12 }, { key: 'bodySize', label: 'Body type', min: 14, max: 20 }] as const).map(({ key, label, min, max }) => <Label className="range" key={key}><span>{label}<b>{draft[key] ?? design.tokens[key]} px</b></span><Input aria-label={label} type="range" min={min} max={max} value={draft[key] ?? design.tokens[key]} onChange={e => edit(key, Number(e.target.value))} /></Label>)}
      </div>
      <div className="grid gap-2"><Button disabled={!dirty || conflict} onClick={() => void apply({ tokens: draft, expectedRevision: baseRevision })}>Apply changes</Button>
      {dirty && <Button variant="outline" onClick={() => remember({})}>Discard draft</Button>}</div>
    </fieldset><div className="design-note"><p>Changes update your app’s theme file. Theme editing works offline.</p></div>
  </aside></DesignSurface>;
}
