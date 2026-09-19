import { describe, expect, it } from 'vitest';
import { initialBoard, updateBoard } from './preview-board';

describe('project-local two-view state', () => {
  it('caps views at two, targets changes and preserves the sibling identity', () => {
    const one = initialBoard('a');
    const two = updateBoard(one, { type: 'add', id: 'b' });
    expect(two.views[0]).toBe(one.views[0]);
    expect(updateBoard(two, { type: 'add', id: 'c' })).toBe(two);
    const routed = updateBoard(two, { type: 'update', id: 'b', patch: { route: '/wiki', viewport: 'large' } });
    const reloaded = updateBoard(routed, { type: 'reload', id: 'b' });
    expect(reloaded.views[0]).toBe(one.views[0]);
    expect(reloaded.views[1]).toMatchObject({ route: '/wiki', viewport: 'large', refresh: 1 });
    expect(updateBoard(reloaded, { type: 'reload', id: 'old-project-view' })).toBe(reloaded);
  });
  it('keeps one view, stable labels and a valid active view after removing either sibling', () => {
    const one = initialBoard('a');
    expect(updateBoard(one, { type: 'remove', id: 'a' })).toBe(one);
    const two = updateBoard(one, { type: 'add', id: 'b' });
    const remaining = updateBoard(two, { type: 'remove', id: 'a' });
    expect(remaining).toEqual({ views: [two.views[1]], activeId: 'b', mode: 'focus', comparison: 'screens' });
    expect(updateBoard(remaining, { type: 'add', id: 'c' }).views.map(view => view.label)).toEqual([2, 1]);
    expect(updateBoard(two, { type: 'remove', id: 'b' }).activeId).toBe('a');
  });
  it('keeps page-memory project states and delayed reload targets separate', () => {
    const alpha = updateBoard(initialBoard('a'), { type: 'add', id: 'b' });
    const beta = initialBoard('c');
    const boards = new Map([['alpha', alpha], ['beta', beta]]);
    boards.set('alpha', updateBoard(boards.get('alpha')!, { type: 'reload', id: 'a' }));
    expect(boards.get('beta')).toBe(beta);
    expect(boards.get('alpha')!.views[1]).toBe(alpha.views[1]);
  });
});
