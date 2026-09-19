import type { FileChange } from './server.js';
/** A deliberately bounded source recipe. Dependency/provider mutations use their reviewed provider workflows. */
export interface PluginRecipe {
  id: string; title: string; version: string; description: string;
  files: Array<Pick<FileChange, 'path' | 'content'>>;
}
export function defineRecipe(recipe: PluginRecipe): PluginRecipe { return recipe; }
