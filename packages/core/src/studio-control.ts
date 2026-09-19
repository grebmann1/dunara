import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { BuilderError } from './contracts.js';
import type { Projects } from './projects.js';
import { atomicWrite, exists, readText } from './storage.js';
import { studioControlSchema, type StudioPreferences } from './studio-contracts.js';

export class StudioControl {
  private epoch = randomUUID();
  private selected: string | undefined;
  private refresh = new Map<string, number>();
  constructor(private projects: Projects, private changed: () => void) {}
  private get selectionFile() { return path.join(this.projects.home, 'studio-selection.json'); }
  async snapshot() {
    const projects = await this.projects.list();
    if (this.selected === undefined) {
      const saved = await exists(this.selectionFile) ? z.object({ projectId: z.uuid() }).strict().parse(JSON.parse(await readText(this.selectionFile, 1024))).projectId : '';
      this.selected = projects.some(p => p.id === saved) ? saved : projects[0]?.id ?? '';
    }
    if (!this.selected && projects.length) this.selected = projects[0]!.id;
    const project = projects.find(p => p.id === this.selected);
    const metadata = project ? await this.projects.metadata(project) : undefined;
    const studio = metadata ? { ...metadata.studio, board: { ...metadata.studio.board, views: metadata.studio.board.views.map(v => ({ ...v, refresh: this.refresh.get(`${project!.id}:${v.id}`) ?? 0 })) } } : null;
    const state = { projectId: project?.id ?? null, studio };
    return { ...state, revision: createHash('sha256').update(this.epoch + JSON.stringify(state)).digest('hex') };
  }
  async control(input: unknown) {
    const { expectedRevision, action } = studioControlSchema.parse(input);
    return this.projects.mutations.run(async () => {
      const current = await this.snapshot();
      if (current.revision !== expectedRevision) throw new BuilderError('REVISION_CONFLICT', 'Studio changed; inspect the session again before applying this action');
      if (action.type === 'select-project') {
        const project = await this.projects.get(action.projectId);
        const metadata = await this.projects.metadata(project);
        await this.projects.writeMetadata(project, metadata.studio);
        await atomicWrite(this.selectionFile, JSON.stringify({ projectId: project.id }) + '\n');
        this.selected = project.id;
      } else {
        if (!current.projectId || !current.studio) throw new BuilderError('PROJECT_NOT_FOUND', 'Select or create a project first');
        const project = await this.projects.get(current.projectId);
        const studio: StudioPreferences = (await this.projects.metadata(project)).studio;
        if (action.type === 'navigate') studio.workspace = action.workspace;
        else if (action.type === 'design') studio.designOpen = action.open;
        else if (action.type === 'assets-tab') { studio.assetsTab = action.tab; studio.workspace = 'assets'; }
        else if (action.type === 'screen-list') { if (action.screens) studio.board.screens = action.screens; else delete studio.board.screens; }
        else if (action.type === 'canvas-mode') {
          studio.board.mode = action.mode;
          if (action.mode === 'compare' && studio.board.views.length === 1) {
            studio.board.views.push({ ...studio.board.views[0]!, id: randomUUID(), label: studio.board.views[0]!.label === 1 ? 2 : 1 });
          }
          if (action.mode === 'compare' && studio.board.comparison === 'sizes') {
            const route = studio.board.views.find(view => view.id === studio.board.activeId)!.route;
            studio.board.views.forEach((view, index) => { view.route = route; view.viewport = index === 0 ? 'compact' : 'large'; });
          }
        } else if (action.type === 'focus-screen') {
          studio.board.views.find(view => view.id === studio.board.activeId)!.route = action.route;
          studio.board.mode = 'focus';
        } else if (action.type === 'compare') {
          const first = studio.board.views[0]!;
          if (studio.board.views.length === 1) studio.board.views.push({ ...first, id: randomUUID(), label: first.label === 1 ? 2 : 1 });
          first.route = action.route;
          studio.board.views[1]!.route = action.comparison === 'sizes' ? action.route : action.otherRoute ?? studio.board.views[1]!.route;
          if (action.comparison === 'sizes') { first.viewport = 'compact'; studio.board.views[1]!.viewport = 'large'; }
          studio.board.mode = 'compare'; studio.board.comparison = action.comparison;
        }
        else if (action.type === 'add') {
          if (studio.board.views.length >= 2 || studio.board.views.some(v => v.id === action.id)) throw new BuilderError('LIMIT_EXCEEDED', 'A shared canvas supports at most two distinct views');
          studio.board.views.push({ id: action.id, label: studio.board.views[0]!.label === 1 ? 2 : 1, route: '/', viewport: 'compact' });
          studio.board.activeId = action.id;
          studio.board.mode = 'compare'; studio.board.comparison = 'screens';
        } else {
          const view = studio.board.views.find(v => v.id === action.id);
          if (!view) throw new BuilderError('INVALID_INPUT', 'View does not belong to the selected project');
          if (action.type === 'remove') {
            if (studio.board.views.length === 1) throw new BuilderError('INVALID_INPUT', 'Keep at least one view');
            studio.board.views = studio.board.views.filter(v => v.id !== action.id);
            if (studio.board.activeId === action.id) studio.board.activeId = studio.board.views[0]!.id;
            studio.board.mode = 'focus';
          } else if (action.type === 'activate') studio.board.activeId = action.id;
          else if (action.type === 'update') {
            Object.assign(view, action.patch);
            if (studio.board.mode === 'compare' && studio.board.comparison === 'sizes') {
              if (action.patch.route) studio.board.views.forEach(sibling => { sibling.route = action.patch.route!; });
              if (action.patch.viewport) studio.board.comparison = 'screens';
            }
          }
          else if (action.type === 'reload') {
            const key = `${project.id}:${view.id}`;
            this.refresh.set(key, (this.refresh.get(key) ?? 0) + 1);
          }
        }
        if (action.type !== 'reload') {
          await this.projects.writeMetadata(project, studio);
          if (action.type === 'remove') this.refresh.delete(`${project.id}:${action.id}`);
        }
      }
      this.epoch = randomUUID();
      this.changed();
      return this.snapshot();
    });
  }
}
