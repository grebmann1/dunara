import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode, type Ref } from 'react';
import { Activity, Database, FolderPlus, Image, LayoutGrid, Puzzle, Settings, Smartphone } from 'lucide-react';
import type { Project } from '../../../../../packages/core/src/contracts';
import { SidebarProjects } from './SidebarProjects';
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
  const compactQuery = '(max-width: 760px)';
  const [sidebarOpen, setSidebarOpen] = useState(true), [sidebarWidth, setSidebarWidth] = useState(248);
  const drag = useRef<{ x: number; width: number } | null>(null);
  const sidebarTouched = useRef(false);
  const resize = (width: number) => setSidebarWidth(Math.max(200, Math.min(360, Math.round(width))));
  const { capabilities } = useStudioClient();
  const project = projects.find(project => project.id === selected);
  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const media = matchMedia(compactQuery);
    const sync = () => {
      if (sidebarTouched.current) return;
      setSidebarOpen(!(media.matches && connectionLabel === 'Cloud workspace'));
    };
    sync();
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, [connectionLabel]);
  const toggleSidebar = () => { sidebarTouched.current = true; setSidebarOpen(open => !open); };
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
  return <div className="studio" data-hosted={connectionLabel === 'Cloud workspace' ? 'true' : undefined}>
    <WorkspaceHeader connectionLabel={connectionLabel} usable={usable} sidebarOpen={sidebarOpen} onToggleSidebar={toggleSidebar} projects={projects} selected={selected} onSelect={onSelect} projectStatus={projectStatus} assistantControl={assistantControl} isPreview={workspace === 'preview'} />
    {banners}
    <div className="workspace" data-sidebar-open={sidebarOpen} style={{ '--sidebar-width': `${sidebarWidth}px` } as CSSProperties}>
      <aside id="studio-sidebar" className="sidebar" hidden={!sidebarOpen}>
        <Button className="new-project sidebar-action" variant="ghost" aria-label="+ New app" disabled={!usable || busy} onClick={onCreate}><FolderPlus aria-hidden />New app</Button>
        <nav className="workspace-nav" aria-label="Workspace" onKeyDown={navigateWithKeyboard}>
          {destinations.filter(item => !hiddenDestinations.includes(item.id)).map(({ id, label, icon: Icon }) => <Button key={id} disabled={!usable} variant="ghost" className="workspace-nav-item sidebar-action" aria-label={label} aria-describedby={id === 'activity' && pendingReview > 0 ? 'sidebar-review-count' : undefined} aria-pressed={workspace === id} aria-current={workspace === id ? 'page' : undefined} onClick={() => onNavigate(id)}><Icon aria-hidden /><span className="workspace-nav-label">{label}</span>{id === 'activity' && pendingReview > 0 && <span id="sidebar-review-count" className="sidebar-count" title={`${pendingReview} paid requests awaiting review`} aria-label={`${pendingReview} awaiting review`}>{pendingReview}</span>}</Button>)}
        </nav>
        <SidebarProjects projects={projects} selected={selected} disabled={!usable || busy} onSelect={onSelect} onCreate={onCreate} />
        <div className="sidebar-footer">
          {project && capabilities.localPaths && <ProjectDownload key={project.id} projectId={project.id} name={project.name} disabled={!usable || busy} />}
          <Button disabled={!usable} variant="ghost" className="workspace-nav-item sidebar-action" aria-pressed={workspace === 'settings'} aria-current={workspace === 'settings' ? 'page' : undefined} onClick={() => onNavigate('settings')}><Settings aria-hidden /><span>Settings</span></Button>
        </div>
        <div className="sidebar-resizer" role="separator" aria-label="Sidebar width" aria-orientation="vertical" aria-valuemin={200} aria-valuemax={360} aria-valuenow={sidebarWidth} tabIndex={0} title="Drag to resize · double-click to reset" onDoubleClick={() => resize(248)} onKeyDown={event => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault(); resize(event.key === 'Home' ? 200 : event.key === 'End' ? 360 : sidebarWidth + (event.key === 'ArrowRight' ? 16 : -16));
        }} onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); drag.current = { x: event.clientX, width: sidebarWidth }; event.currentTarget.setPointerCapture(event.pointerId); }} onPointerMove={event => { if (drag.current) resize(drag.current.width + event.clientX - drag.current.x); }} onPointerUp={event => { drag.current = null; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }} onLostPointerCapture={() => { drag.current = null; }} />
      </aside>
      <DockWorkspace><div ref={contentRef} id="workspace-content" className="workspace-content" data-workspace={workspace} tabIndex={-1}>{children}</div></DockWorkspace>
    </div>
    {footer}
    {overlays}
  </div>;
}
