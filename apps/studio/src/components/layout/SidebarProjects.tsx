import { useId, useState, type KeyboardEvent } from 'react';
import { ChevronDown, Plus, Search } from 'lucide-react';
import type { Project } from '../../../../../packages/core/src/contracts';
import { Button } from '../ui/button';

const colors = ['#4787db', '#9b70d4', '#d58b35', '#4e9a88', '#d26a72'];
function projectColor(id: string) {
  let hash = 0;
  for (const character of id) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return colors[hash % colors.length];
}

export function SidebarProjects({ projects, selected, disabled, onSelect, onCreate }: { projects: Project[]; selected: string; disabled: boolean; onSelect(id: string): void; onCreate(): void }) {
  const [query, setQuery] = useState(''), [expanded, setExpanded] = useState(true);
  const id = useId();
  const visible = projects.filter(project => `${project.name} ${project.slug}`.toLowerCase().includes(query.trim().toLowerCase()));
  const counts = new Map<string, number>();
  for (const project of projects) counts.set(project.name, (counts.get(project.name) ?? 0) + 1);
  function move(event: KeyboardEvent<HTMLUListElement>) {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
    const index = buttons.indexOf(event.target as HTMLButtonElement);
    if (index < 0 || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next]?.focus();
  }
  return <section className="sidebar-projects" aria-label="Projects">
    <div className="sidebar-project-heading">
      <Button variant="ghost" aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded(!expanded)}>Projects<ChevronDown size={14} aria-hidden /></Button>
      <Button variant="ghost" aria-label="Create project" title="Create project" disabled={disabled} onClick={onCreate}><Plus size={17} aria-hidden /></Button>
    </div>
    <div id={id} className="sidebar-project-body" hidden={!expanded}>
      <label className="sidebar-project-search"><Search size={15} aria-hidden /><input type="search" placeholder="Filter projects" aria-label="Filter projects" value={query} onChange={event => setQuery(event.target.value)} /></label>
      <ul className="sidebar-project-list" onKeyDown={move}>
        {visible.map(project => <li key={project.id}><button className="sidebar-project-row" data-project-id={project.id} aria-pressed={selected === project.id} title={`${project.name} · ${project.slug}`} disabled={disabled} onClick={() => { if (selected !== project.id) onSelect(project.id); }}>
          <span className="sidebar-project-dot" style={{ background: projectColor(project.id) }} aria-hidden />
          <span className="sidebar-project-name"><strong>{project.name}</strong>{counts.get(project.name)! > 1 && <small>{project.slug}</small>}</span>
        </button></li>)}
      </ul>
      {!visible.length && <p className="sidebar-project-empty">{projects.length ? 'No matching projects.' : 'No projects yet'}{query && <Button variant="ghost" onClick={() => setQuery('')}>Clear filter</Button>}</p>}
    </div>
  </section>;
}
