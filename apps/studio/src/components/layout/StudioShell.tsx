import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode, type Ref } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { X, Activity, Database, FolderPlus, Image, LayoutGrid, Puzzle, Settings, Smartphone } from 'lucide-react';
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
  const { capabilities } = useStudioClient();
  const hosted = capabilities.connectionLabel === 'Cloud workspace';
  const shell = useRef<HTMLDivElement>(null), sidebarTrigger = useRef<HTMLButtonElement>(null);
  const [compact, setCompact] = useState(() => typeof matchMedia === 'function' && matchMedia('(max-width: 760px)').matches);
  const [desktopSidebarOpen, setDesktopSidebarOpen] = useState(true), [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const drawer = hosted && compact, sidebarOpen = drawer ? mobileSidebarOpen : desktopSidebarOpen;
  const [sidebarWidth, setSidebarWidth] = useState(248);
  const drag = useRef<{ x: number; width: number } | null>(null);
  const returnFocus = useRef<'trigger' | 'workspace' | 'dialog'>('trigger');
  const resize = (width: number) => setSidebarWidth(Math.max(200, Math.min(360, Math.round(width))));
  const project = projects.find(project => project.id === selected);
  useEffect(() => {
    const element = shell.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setCompact(element.clientWidth <= 760));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => { setMobileSidebarOpen(false); }, [drawer]);
  const toggleSidebar = () => {
    returnFocus.current = 'trigger';
    if (drawer) setMobileSidebarOpen(open => !open);
    else setDesktopSidebarOpen(open => !open);
  };
  const closeDrawer = (focus: typeof returnFocus.current) => {
    returnFocus.current = focus;
    setMobileSidebarOpen(false);
  };
  const navigate = (destination: Workspace) => { closeDrawer('workspace'); onNavigate(destination); };
  const select = (id: string) => { closeDrawer('workspace'); if (id !== selected) onSelect(id); };
  const create = () => { closeDrawer('dialog'); onCreate(); };
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
  const sidebar = <aside id="studio-sidebar" className={drawer ? "sidebar sidebar-drawer" : "sidebar"} hidden={!sidebarOpen}>
        {drawer && <div className="sidebar-drawer-heading"><Dialog.Title>Workspace</Dialog.Title><Dialog.Close asChild><Button variant="ghost" aria-label="Close navigation"><X aria-hidden /></Button></Dialog.Close></div>}
        <Button className="new-project sidebar-action" variant="ghost" aria-label="+ New app" disabled={!usable || busy} onClick={create}><FolderPlus aria-hidden />New app</Button>
        <nav className="workspace-nav" aria-label="Workspace" onKeyDown={navigateWithKeyboard}>
          {destinations.filter(item => !hiddenDestinations.includes(item.id)).map(({ id, label, icon: Icon }) => <Button key={id} disabled={!usable} variant="ghost" className="workspace-nav-item sidebar-action" aria-label={label} aria-describedby={id === 'activity' && pendingReview > 0 ? 'sidebar-review-count' : undefined} aria-pressed={workspace === id} aria-current={workspace === id ? 'page' : undefined} onClick={() => navigate(id)}><Icon aria-hidden /><span className="workspace-nav-label">{label}</span>{id === 'activity' && pendingReview > 0 && <span id="sidebar-review-count" className="sidebar-count" title={`${pendingReview} paid requests awaiting review`} aria-label={`${pendingReview} awaiting review`}>{pendingReview}</span>}</Button>)}
        </nav>
        <SidebarProjects projects={projects} selected={selected} disabled={!usable || busy} onSelect={select} onCreate={create} />
        <div className="sidebar-footer">
          {project && capabilities.localPaths && <ProjectDownload key={project.id} projectId={project.id} name={project.name} disabled={!usable || busy} />}
          <Button disabled={!usable} variant="ghost" className="workspace-nav-item sidebar-action" aria-pressed={workspace === 'settings'} aria-current={workspace === 'settings' ? 'page' : undefined} onClick={() => navigate('settings')}><Settings aria-hidden /><span>Settings</span></Button>
        </div>
        <div className="sidebar-resizer" role="separator" aria-label="Sidebar width" aria-orientation="vertical" aria-valuemin={200} aria-valuemax={360} aria-valuenow={sidebarWidth} tabIndex={0} title="Drag to resize · double-click to reset" onDoubleClick={() => resize(248)} onKeyDown={event => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault(); resize(event.key === 'Home' ? 200 : event.key === 'End' ? 360 : sidebarWidth + (event.key === 'ArrowRight' ? 16 : -16));
        }} onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); drag.current = { x: event.clientX, width: sidebarWidth }; event.currentTarget.setPointerCapture(event.pointerId); }} onPointerMove={event => { if (drag.current) resize(drag.current.width + event.clientX - drag.current.x); }} onPointerUp={event => { drag.current = null; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }} onLostPointerCapture={() => { drag.current = null; }} />
      </aside>;
  return <div ref={shell} className="studio" data-hosted={hosted ? 'true' : undefined}>
    <WorkspaceHeader sidebarTrigger={sidebarTrigger} connectionLabel={connectionLabel} usable={usable} sidebarOpen={sidebarOpen} onToggleSidebar={toggleSidebar} projects={projects} selected={selected} onSelect={select} projectStatus={projectStatus} assistantControl={assistantControl} isPreview={workspace === 'preview'} />
    {banners}
    <div className="workspace" data-sidebar-open={sidebarOpen} data-sidebar-drawer={drawer || undefined} style={{ '--sidebar-width': `${sidebarWidth}px` } as CSSProperties}>
      {drawer ? <Dialog.Root open={mobileSidebarOpen} onOpenChange={setMobileSidebarOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="sidebar-scrim" onClick={() => closeDrawer('trigger')} />
          <Dialog.Content asChild aria-describedby={undefined} onOpenAutoFocus={event => {
            event.preventDefault();
            document.querySelector<HTMLButtonElement>('#studio-sidebar [aria-current="page"]')?.focus();
          }} onCloseAutoFocus={event => {
            event.preventDefault();
            if (returnFocus.current === 'workspace') shell.current?.querySelector<HTMLElement>('#workspace-content')?.focus();
            else if (returnFocus.current === 'trigger') sidebarTrigger.current?.focus();
          }}>{sidebar}</Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root> : sidebar}
      <DockWorkspace><div ref={contentRef} id="workspace-content" className="workspace-content" data-workspace={workspace} tabIndex={-1}>{children}</div></DockWorkspace>
    </div>
    {footer}
    {overlays}
  </div>;
}
