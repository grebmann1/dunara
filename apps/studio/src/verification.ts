import type { StudioState } from './api';

export function webVerification(state: StudioState) {
  const routes = state.screens.map(screen => screen.route);
  const checks = routes.flatMap(route => (['compact', 'large'] as const).map(viewport => {
    const capture = state.captures.filter(item => item.route === route && item.viewport === viewport && item.sourceRevision === state.sourceRevision && !item.changedDuringCapture && item.configurationRevision === state.preview.configurationRevision).at(-1);
    return { route, viewport, captureId: capture?.id, status: !capture ? 'missing' : capture.runtimeErrors === undefined ? 'rendered' : capture.runtimeErrors > 0 ? 'errors' : 'passed' };
  }));
  return { checks, rendered: checks.filter(check => check.captureId).length, passed: checks.length > 0 && checks.every(check => check.status === 'passed') };
}
