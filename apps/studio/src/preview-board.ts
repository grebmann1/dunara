import type { StudioAction, StudioPreferences } from '../../../packages/core/src/studio-contracts';
export type PreviewView = { id: string; label: number; route: string; viewport: 'compact' | 'large'; refresh: number };
export type PreviewBoardState = Omit<StudioPreferences['board'], 'views'> & { views: PreviewView[] };
export type BoardAction = Extract<StudioAction, { type: 'add' | 'remove' | 'activate' | 'update' | 'reload' | 'canvas-mode' | 'compare' | 'focus-screen' | 'screen-list' }>;
export function initialBoard(id: string): PreviewBoardState {
  return { views: [{ id, label: 1, route: '/', viewport: 'compact', refresh: 0 }], activeId: id, mode: 'focus', comparison: 'screens' };
}
export function updateBoard(board: PreviewBoardState, action: BoardAction): PreviewBoardState {
  if (action.type === 'screen-list') return { ...board, screens: action.screens ?? undefined };
  if (action.type === 'canvas-mode') return { ...board, mode: action.mode };
  if (action.type === 'focus-screen') return { ...board, mode: 'focus', views: board.views.map(view => view.id === board.activeId ? { ...view, route: action.route } : view) };
  // The server assigns a second identity atomically when configuring a comparison.
  if (action.type === 'compare') return board;
  if (action.type === 'add') {
    if (board.views.length >= 2 || board.views.some(view => view.id === action.id)) return board;
    const label = board.views[0]!.label === 1 ? 2 : 1;
    return { ...board, mode: 'compare', comparison: 'screens', views: [...board.views, { id: action.id, label, route: '/', viewport: 'compact', refresh: 0 }], activeId: action.id };
  }
  if (!board.views.some(view => view.id === action.id)) return board;
  if (action.type === 'activate') return { ...board, activeId: action.id };
  if (action.type === 'remove') {
    if (board.views.length === 1) return board;
    const views = board.views.filter(view => view.id !== action.id);
    return { ...board, mode: 'focus', views, activeId: board.activeId === action.id ? views[0]!.id : board.activeId };
  }
  return { ...board, views: board.views.map(view => view.id !== action.id ? view : action.type === 'reload' ? { ...view, refresh: view.refresh + 1 } : { ...view, ...action.patch }) };
}
