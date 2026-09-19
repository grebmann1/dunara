import { useRef, useState } from 'react';
import { ArrowDown, ArrowUp, ChevronDown, Plus, RotateCcw, X } from 'lucide-react';
import { boardScreensSchema } from '../../../../packages/core/src/studio-contracts';
import { routeSchema } from '../../../../packages/core/src/contracts';
import type { Screen } from '../../../../packages/core/src/screen-catalog';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog';
import { Button } from './ui/button';
import { Input } from './ui/input';

export function ScreenManager({ screens, candidates, onClose, onSave, restoreFocus }: { screens: Screen[]; candidates: string[]; onClose: () => void; restoreFocus: () => void; onSave: (screens: Screen[] | null) => Promise<boolean> }) {
  const [draft, setDraft] = useState(screens), [route, setRoute] = useState(''), [error, setError] = useState(''), [saving, setSaving] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const available = candidates.filter(path => !draft.some(screen => screen.route === path));
  function add(value: string) {
    const parsed = routeSchema.safeParse(value);
    if (!parsed.success) { setError('Enter a concrete path, such as /settings. Replace dynamic parameters with actual values.'); return; }
    if (draft.some(screen => screen.route === value)) { setError('That screen is already included.'); return; }
    if (draft.length >= 24) { setError('The overview supports up to 24 screens.'); return; }
    setDraft(current => [...current, { route: value, name: value === '/' ? 'Home' : value.slice(1).replace(/[-_]/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase()) }]); setRoute(''); setError('');
  }
  function move(index: number, offset: number) { const next = [...draft]; [next[index], next[index + offset]] = [next[index + offset]!, next[index]!]; setDraft(next); }
  async function save(value: Screen[] | null) {
    const parsed = value && boardScreensSchema.safeParse(value);
    if (parsed && !parsed.success) { setError('Include 1–24 unique screens, each with a name of 1–80 characters.'); return; }
    setSaving(true); setError('');
    try { if (await onSave(parsed ? parsed.data! : null)) onClose(); else setError('Studio changed or could not save. Your list is retained; review the current workspace and try again.'); }
    finally { setSaving(false); }
  }
  return <Dialog open onOpenChange={open => { if (!open && !saving) onClose(); }}>
    <DialogContent placement="drawer" className="screen-manager-dialog" onOpenAutoFocus={event => { event.preventDefault(); heading.current?.focus(); }} onCloseAutoFocus={event => { event.preventDefault(); restoreFocus(); }}>
      <header className="screen-manager-heading">
        <DialogTitle ref={heading} tabIndex={-1}>Manage screens</DialogTitle>
        <DialogDescription>Name and arrange the screens shown on your canvas.</DialogDescription>
      </header>
      <div className="screen-manager-body">
        <fieldset className="screen-manager-fields" disabled={saving}>
          <legend className="sr-only">Overview screens</legend>
          <div className="screen-manager-list-heading"><h3>In your overview</h3><span>{draft.length} of 24</span></div>
          <ol className="managed-screen-list">
            {draft.map((screen, index) => <li className="managed-screen" key={screen.route}>
              <span className="managed-screen-number" aria-hidden>{String(index + 1).padStart(2, '0')}</span>
              <label><Input aria-label={`Name for ${screen.route}`} maxLength={80} value={screen.name} onChange={event => setDraft(current => current.map((item, i) => i === index ? { ...item, name: event.target.value } : item))} /><span title={screen.route}>{screen.route}</span></label>
              <div className="managed-screen-row-actions">
                <Button variant="ghost" aria-label={`Move ${screen.name} up`} title="Move up" disabled={index === 0} onClick={() => move(index, -1)}><ArrowUp aria-hidden /></Button>
                <Button variant="ghost" aria-label={`Move ${screen.name} down`} title="Move down" disabled={index === draft.length - 1} onClick={() => move(index, 1)}><ArrowDown aria-hidden /></Button>
                <Button variant="ghost" aria-label={`Hide ${screen.name}`} title="Remove from overview" onClick={() => setDraft(current => current.filter(item => item.route !== screen.route))}><X aria-hidden /></Button>
              </div>
            </li>)}
          </ol>
          {!draft.length && <p className="screen-manager-empty">Add a screen below to start your overview.</p>}
          <details className="screen-manager-add">
            <summary><Plus aria-hidden />Add a screen<ChevronDown aria-hidden /></summary>
            <div>
              {available.length > 0 && <label className="screen-candidate-picker">Discovered route<select aria-label="Add discovered route" value="" onChange={event => add(event.target.value)}><option value="">Choose a route</option>{available.map(path => <option key={path} value={path}>{path}</option>)}</select></label>}
              <form className="screen-manual-path" onSubmit={event => { event.preventDefault(); add(route); }}><label htmlFor="board-manual-path">Add a manual path</label><div><Input id="board-manual-path" value={route} placeholder="/settings" onChange={event => setRoute(event.target.value)} /><Button variant="outline" type="submit" aria-label="Add screen" disabled={!route.trim()}><Plus aria-hidden /></Button></div></form>
            </div>
          </details>
          <Button className="screen-manager-reset" variant="ghost" onClick={() => void save(null)}><RotateCcw aria-hidden />Use discovered screens</Button>
        </fieldset>
      </div>
      <footer className="screen-manager-footer">
        {error && <p className="screen-capture-error" role="alert">{error}</p>}
        <div><Button variant="outline" disabled={saving} onClick={onClose}>Cancel</Button><Button disabled={saving} onClick={() => void save(draft)}>{saving ? 'Saving…' : 'Save screens'}</Button></div>
      </footer>
    </DialogContent>
  </Dialog>;
}
