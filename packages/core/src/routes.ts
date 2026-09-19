import { routeSchema } from './contracts.js';

export interface RouteCandidate {
  path: string;
  kind: 'static' | 'dynamic';
  files: string[];
  ambiguous: boolean;
}
export interface RouteCandidates {
  candidates: RouteCandidate[];
  roots: string[];
  truncated: boolean;
  warnings: string[];
}
export function discoverRoutes(tree: { files: string[]; truncated: boolean }): RouteCandidates {
  const roots = ['app/', 'src/app/'].filter(root => tree.files.some(file => file.startsWith(root)));
  const warnings = ['File-based candidates only, not runtime discovery. Custom router configuration, special/API files and platform variants are not resolved. Manual paths remain available.'];
  if (tree.truncated) warnings.push('The safe file listing was truncated; additional routes may be missing.');
  if (roots.length > 1) warnings.push('Both app/ and src/app/ are present. The active runtime root is ambiguous; verify a candidate before capturing.');
  const candidates = new Map<string, RouteCandidate>();
  let unsupported = false;
  for (const file of tree.files) {
    const root = roots.find(value => file.startsWith(value));
    if (!root || !/\.(tsx?|jsx?)$/.test(file)) continue;
    const parts = file.slice(root.length).replace(/\.(tsx?|jsx?)$/, '').split('/');
    if (parts.some(part => part.startsWith('_') || part.startsWith('+') || /\+(api)$/.test(part))) continue;
    if (parts.some(part => /\.(ios|android|native|web)$/.test(part))) { unsupported = true; continue; }
    if (parts.some(part => !( /^\([\w-]+\)$/.test(part) || /^\[(?:\.\.\.)?[\w-]+\]$/.test(part) || /^[\w-]+$/.test(part)))) { unsupported = true; continue; }
    const segments = parts.filter(part => !part.startsWith('('));
    if (segments.at(-1) === 'index') segments.pop();
    const candidatePath = '/' + segments.join('/');
    const kind = segments.some(part => part.startsWith('[')) ? 'dynamic' : 'static';
    if (kind === 'static' && !routeSchema.safeParse(candidatePath).success) { unsupported = true; continue; }
    const previous = candidates.get(candidatePath);
    if (previous) { previous.files.push(file); previous.ambiguous = true; }
    else candidates.set(candidatePath, { path: candidatePath, kind, files: [file], ambiguous: roots.length > 1 });
  }
  if (unsupported) warnings.push('Unsupported route conventions or platform variants were omitted rather than turned into invented URLs.');
  return { roots, truncated: tree.truncated, warnings, candidates: [...candidates.values()].map(candidate => ({ ...candidate, files: candidate.files.sort() })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0) };
}
