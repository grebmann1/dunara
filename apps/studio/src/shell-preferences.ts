const key = 'builder.shell-preferences.v1';
export type ShellPreferences = { sidebarOpen: boolean; sidebarWidth: number; assistantWidth: number };
const defaults: ShellPreferences = { sidebarOpen: true, sidebarWidth: 248, assistantWidth: 0 };
export function readShellPreferences(): ShellPreferences {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? 'null');
    if (value && typeof value.sidebarOpen === 'boolean' && Number.isFinite(value.sidebarWidth) && Number.isFinite(value.assistantWidth)) return {
      sidebarOpen: value.sidebarOpen,
      sidebarWidth: Math.max(200, Math.min(360, Math.round(value.sidebarWidth))),
      assistantWidth: value.assistantWidth === 0 ? 0 : Math.max(320, Math.min(2000, Math.round(value.assistantWidth))),
    };
  } catch { /* An unavailable preference must not prevent opening Studio. */ }
  return { ...defaults };
}
export function saveShellPreferences(value: ShellPreferences) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* Keep the current layout usable. */ }
}
