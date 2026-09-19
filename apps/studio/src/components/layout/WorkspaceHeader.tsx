import type { ReactNode } from 'react';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { Button } from '../ui/button';
import mark from '../../../../../packages/catalog/assets/brand-mark.svg';
import '../../header-polish.css';

type Props = {
  connectionLabel: string; usable: boolean; sidebarOpen: boolean; onToggleSidebar: () => void;
  projectName?: string; projectStatus: ReactNode; isPreview: boolean; assistantControl?: ReactNode;
};

export function WorkspaceHeader({ connectionLabel, usable, sidebarOpen, onToggleSidebar, projectName, projectStatus, isPreview, assistantControl }: Props) {
  const Title = isPreview ? 'h1' : 'p';
  const SidebarIcon = sidebarOpen ? PanelLeftClose : PanelLeftOpen;
  const local = connectionLabel === 'Local workspace';
  return <header className="topbar" data-project={!!projectName} data-sidebar-open={sidebarOpen}>
    <a className="skip-link" href="#workspace-content">Skip to workspace</a>
    <div className="header-identity">
      <Button variant="ghost" className="w-11 shrink-0 p-2" aria-label={sidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'} title={sidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'} aria-expanded={sidebarOpen} aria-controls="studio-sidebar" onClick={onToggleSidebar}><SidebarIcon aria-hidden /></Button>
      <span className="studio-brand" title="Dunara Studio"><img src={mark} alt="Dunara" width="28" height="28" />{!projectName && <span>Dunara</span>}</span>
      {projectName && <Title className="header-project" title={projectName}>{projectName}</Title>}
    </div>
    <div className="header-status" data-connection-state={local ? 'local' : 'attention'}>
      {projectStatus}
      <span role="status" className={`connection ${usable ? 'online' : ''}`} data-local={local} data-quiet={local && !!projectStatus} title={connectionLabel}><i aria-hidden />{connectionLabel}</span>
      {assistantControl}
    </div>
  </header>;
}
