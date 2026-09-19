import { useState, type KeyboardEvent, type ReactNode, type Ref } from 'react';
import { Activity, ArrowRight, Database, Image, LayoutGrid, Plus, Puzzle, Settings, Smartphone } from 'lucide-react';
import type { Project } from '../../../../../packages/core/src/contracts';
import { ProjectPicker } from '../ProjectPicker';
import { Button } from '../ui/button';
import { WorkspaceHeader } from './WorkspaceHeader';
import { DockWorkspace } from './WorkspaceDock';
import { ProjectDownload } from '../ProjectDownload';
import { useStudioClient } from '../../api';

export type Workspace = 'preview' | 'assets' | 'icons' | 'backend' | 'activity' | 'settings' | 'plugins';
const destinations = [
  { id: 'preview', label: 'Preview', icon: Smartphone },
  { id: 'assets', label: 'Assets', icon: Image },
  { id: 'icons', label: 'App Icons', icon: LayoutGrid },
  { id: 'backend', label: 'Backend', icon: Database },
  { id: 'activity', label: 'Activity', icon: Activity },
  { id: 'settings', label: 'Settings', icon: Settings },
  { id: 'plugins', label: 'Plugins', icon: Puzzle },
] as const;

type Props = {
  children: ReactNode; banners: ReactNode; overlays: ReactNode; footer?: ReactNode; contentRef: Ref<HTMLDivElement>;
  projects: Project[]; selected: string; workspace: Workspace; usable: boolean; busy: boolean;
  connectionLabel: string; pendingReview: number; projectStatus: ReactNode; assistantControl?: ReactNode;
  hiddenDestinations?: string[];
  onSelect: (id: string) => void; onNavigate: (workspace: Workspace) => void; onCreate: () => void;
};

export function StudioShell({ children, banners, overlays, footer, contentRef, projects, selected, workspace, usable, busy, connectionLabel, pendingReview, projectStatus, assistantControl, hiddenDestinations = [], onSelect, onNavigate, onCreate }: Props) {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const { capabilities } = useStudioClient();
  const project = projects.find(project => project.id === selected);
  function navigateWithKeyboard(event: KeyboardEvent<HTMLElement>) {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled):not([aria-disabled="true"])'));
    const index = buttons.indexOf(event.target as HTMLButtonElement);
    if (index < 0) return;
    let next: number;
    switch (event.key) {
      case 'ArrowDown': next = (index + 1) % buttons.length; break;
      case 'ArrowUp': next = (index - 1 + buttons.length) % buttons.length; break;
      case 'Home': next = 0; break;
      case 'End': next = buttons.length - 1; break;
      default: return;
    }
    event.preventDefault();
    buttons[next]?.focus();
  }
  return <div className="studio">
    <WorkspaceHeader connectionLabel={connectionLabel} usable={usable} sidebarOpen={sidebarOpen} onToggleSidebar={() => setSidebarOpen(open => !open)} projectName={projects.find(project => project.id === selected)?.name} projectStatus={projectStatus} assistantControl={assistantControl} isPreview={workspace === 'preview'} />
    {banners}
    <div className="workspace" data-sidebar-open={sidebarOpen}>
      <aside id="studio-sidebar" className="sidebar" hidden={!sidebarOpen}>
        <div className="workspace-label">Project</div>
        {projects.length ? <ProjectPicker projects={projects} selected={selected} onSelect={onSelect} /> : <p className="project-empty">{usable ? 'No projects yet' : 'No project selected'}</p>}
        <Button className="new-project w-full" variant="outline" aria-label="+ New app" disabled={!usable || busy} onClick={onCreate}><Plus aria-hidden />New app</Button>
        {project && capabilities.localPaths && <ProjectDownload key={project.id} projectId={project.id} name={project.name} disabled={!usable || busy} />}
        <nav className="workspace-nav" aria-label="Workspace" onKeyDown={navigateWithKeyboard}>
          {destinations.filter(item => !hiddenDestinations.includes(item.id)).map(({ id, label, icon: Icon }) => <Button key={id} disabled={!usable} variant="ghost" className="workspace-nav-item justify-start aria-pressed:bg-primary-soft aria-pressed:text-primary-ink aria-pressed:font-semibold" aria-pressed={workspace === id} aria-current={workspace === id ? 'page' : undefined} onClick={() => onNavigate(id)}><Icon aria-hidden /><span className="workspace-nav-label">{label}</span></Button>)}
        </nav>
        {selected && pendingReview > 0 && <p className="review-notice" role="status"><Button className="review-notice-action" variant="ghost" onClick={() => onNavigate('activity')}><span>{pendingReview} paid {pendingReview === 1 ? 'request' : 'requests'} awaiting review in Activity</span><ArrowRight aria-hidden /></Button></p>}
      </aside>
      <DockWorkspace><div ref={contentRef} id="workspace-content" className="workspace-content" data-workspace={workspace} tabIndex={-1}>{children}</div></DockWorkspace>
    </div>
    {footer}
    {overlays}
  </div>;
}
