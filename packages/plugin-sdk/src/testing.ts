import type { Json, PluginAction, PluginFactory, PluginServer, PluginSetting } from './server.js';
import type { PluginRecipe } from './recipes.js';
/** Registration/lifecycle harness; runtime integration tests must still validate authorization. */
export async function testPlugin(factory: PluginFactory, id = 'example.test') {
  const actions = new Map<string, PluginAction>(), recipes = new Map<string, PluginRecipe>(), data = new Map<string, Json>();
  const disposers: Array<() => void | Promise<void>> = [], settings: PluginSetting[] = [];
  const services = new Map<string, unknown>();
  const api: PluginServer = {
    id, actions: { register(action) { if (actions.has(action.id)) throw Error('Duplicate action'); actions.set(action.id, action); } },
    recipes: { register(recipe) { if (recipes.has(recipe.id)) throw Error('Duplicate recipe'); recipes.set(recipe.id, recipe); } },
    settings: { define(items) { settings.push(...items); } },
    storage: { async get(key) { return structuredClone(data.get(key)); }, async set(key, value) { data.set(key, structuredClone(value)); }, async delete(key) { data.delete(key); } },
    credentials: { async get() { return undefined; } },
    services: { provide(name, version, service) { services.set(`${id}:${name}:${version}`, service); }, use<T>(provider: string, name: string, version: string) { const key = `${provider}:${name}:${version}`; if (!services.has(key)) throw Error('Service unavailable'); return services.get(key) as T; } },
    onDispose(dispose) { disposers.push(dispose); },
  };
  try { await factory(api); } catch (error) { for (const dispose of disposers.reverse()) await dispose(); throw error; }
  return { actions, recipes, settings, data, async close() { for (const dispose of disposers.splice(0).reverse()) await dispose(); } };
}
