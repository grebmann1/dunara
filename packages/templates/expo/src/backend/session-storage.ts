// Web previews keep auth in memory. Refreshing the page requires signing in again.
const values = new Map<string, string>();
export const sessionStorage = {
  async getItem(key: string) { return values.get(key) ?? null; },
  async setItem(key: string, value: string) { values.set(key, value); },
  async removeItem(key: string) { values.delete(key); },
};
