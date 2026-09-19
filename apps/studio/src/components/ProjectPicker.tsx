import type { Project } from '../../../../packages/core/src/contracts';
import { Smartphone } from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';

export function ProjectPicker({ projects, selected, onSelect }: { projects: Project[]; selected: string; onSelect: (id: string) => void }) {
  if (!projects.length) return <p className="project-empty">No projects yet</p>;
  const current = projects.find(project => project.id === selected);
  const nameCounts = new Map<string, number>();
  for (const project of projects) nameCounts.set(project.name, (nameCounts.get(project.name) ?? 0) + 1);
  return <div className="project-picker">
    <Select value={selected} onValueChange={id => { if (id !== selected) onSelect(id); }}>
      <SelectTrigger className="project-picker-trigger" aria-label="Project" title={current ? `${current.name} · ${current.slug}` : 'Choose project'}>
        <Smartphone className="project-picker-icon" aria-hidden />
        <SelectValue placeholder="Choose project">{current?.name}</SelectValue>
      </SelectTrigger>
      <SelectContent aria-label="Projects">
        {projects.map(project => {
          const duplicate = nameCounts.get(project.name)! > 1;
          return <SelectItem key={project.id} value={project.id} data-project-id={project.id} textValue={project.name} title={`${project.name} · ${project.slug}`}>
            <span className="project-picker-name">{project.name}</span>
            {duplicate && <span className="project-picker-slug">{project.slug}</span>}
          </SelectItem>;
        })}
      </SelectContent>
    </Select>
  </div>;
}
