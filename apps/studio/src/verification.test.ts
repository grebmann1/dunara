import { expect, it } from 'vitest';
import type { StudioState } from './api';
import { webVerification } from './verification';

it('requires both sizes of every current route and never treats unmeasured or stale rendering as verified', () => {
  const state = { screens: [{ route: '/' }, { route: '/garden' }], sourceRevision: 'source-a', preview: { configurationRevision: 'config-a' }, captures: [] } as unknown as StudioState;
  const capture = (route: string, viewport: string) => ({ id: `${route}:${viewport}`, route, viewport, sourceRevision: 'source-a', configurationRevision: 'config-a', runtimeErrors: 0 });
  expect(webVerification(state).passed).toBe(false);
  state.captures = ['/', '/garden'].flatMap(route => ['compact', 'large'].map(viewport => capture(route, viewport))) as StudioState['captures'];
  expect(webVerification(state).passed).toBe(true);
  state.captures[0]!.runtimeErrors = undefined; expect(webVerification(state).passed).toBe(false);
  state.captures[0]!.runtimeErrors = 1; expect(webVerification(state).checks[0]!.status).toBe('errors');
  state.captures[0]!.runtimeErrors = 0; state.captures[0]!.changedDuringCapture = true; expect(webVerification(state).passed).toBe(false);
  state.captures[0]!.changedDuringCapture = false; state.sourceRevision = 'source-b'; expect(webVerification(state).rendered).toBe(0);
  state.sourceRevision = 'source-a'; state.preview.configurationRevision = 'config-b'; expect(webVerification(state).rendered).toBe(0);
});
