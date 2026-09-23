import { app, BrowserWindow, dialog, Menu, session, shell, clipboard, safeStorage } from 'electron';
import { desktopSecretProtection } from './secret-storage.js';
import { parseArgs } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DesktopHost } from './host.js';
import { downloadAllowed, navigationAllowed, oauthAuthorizationAllowed, rendererPreferences, assistantSignInAllowed, setupLinkAllowed } from './security.js';
import { startupEnvironment, startupVariableNames } from '../../core/src/service-config.js';
import { diagnosticWriter } from './diagnostics.js';
import { PlatformError } from '../../platform/src/contracts.js';
import { BuilderError } from '../../core/src/contracts.js';

const entry = process.argv.indexOf(fileURLToPath(import.meta.url));
const { values } = parseArgs({ args: process.argv.slice(entry >= 0 ? entry + 1 : 2), options: {
  node: { type: 'string' }, workspace: { type: 'string' }, home: { type: 'string' }, 'builder-env-file': { type: 'string' },
  'user-data': { type: 'string' }, 'trust-execution': { type: 'boolean', default: false },
  'assistant-offline-fixture': { type: 'string' },
} });
if (process.platform !== 'darwin') throw new Error('This desktop prototype is macOS-only');
if (!values.node || !values.workspace || !values.home || !values['user-data']) throw new Error('Launch with pnpm desktop');
const environment = values['assistant-offline-fixture'] ? {} : startupEnvironment(process.env);
for (const name of startupVariableNames) delete process.env[name];
const logDiagnostic = diagnosticWriter(process.stderr);
const config = { node: path.resolve(values.node), workspace: path.resolve(values.workspace), home: path.resolve(values.home), trusted: values['trust-execution'], assistantOfflineFixture: values['assistant-offline-fixture'], startupEnvironment: environment, envFile: path.resolve(values['builder-env-file'] ?? '.env') };
// Electron binds macOS Keychain service/account names before ready. Keep the
// existing vault identity during bootstrap; change only the display name after it.
app.setName('Mobile App Builder');
app.setPath('userData', path.resolve(values['user-data']));
app.enableSandbox();

let window: BrowserWindow | undefined;
let host: DesktopHost | undefined;
let quitting = false;
let finished = false;
let reconnecting = false;
const show = () => { window?.show(); window?.focus(); };
const failure = () => {
  if (!quitting) dialog.showErrorBox('Dunara is unavailable', 'The backend or Studio could not load. Use Studio → Restart backend to recover. Project files are retained; unsaved drafts and transient captures may be lost. No automatic retry was attempted.');
};
async function reconnect() {
  if (reconnecting || quitting || !window || !host?.running) return;
  reconnecting = true;
  try {
    const launchUrl = await host.launchUrl();
    // A ticket changes only the fragment. Leave the document so Studio authenticates again.
    await window.loadURL('about:blank');
    await window.loadURL(launchUrl); show();
  }
  catch { failure(); }
  finally { reconnecting = false; }
}
async function confirmReconnect() {
  if (!window) return;
  const result = await dialog.showMessageBox(window, { type: 'question', message: 'Reconnect Studio?', detail: 'Session-only drafts will be discarded; saved drafts will be restored without sending. The same backend and running previews are kept.', buttons: ['Cancel', 'Reconnect'], defaultId: 0, cancelId: 0 });
  if (result.response === 1) await reconnect();
}
async function start() {
  host = new DesktopHost({ ...config, protectSecrets: () => desktopSecretProtection(config.home, safeStorage) });
  host.on('stopped', (expected: boolean) => { if (!expected) failure(); });
  try {
    const launchUrl = await host.start();
    logDiagnostic(`Desktop MCP socket: ${host.socketPath}\n`);
    // The remembered origin is unchanged; a fragment-only ticket must still create a fresh document.
    await window?.loadURL('about:blank');
    await window?.loadURL(launchUrl); show();
  } catch (error) {
    if (error instanceof PlatformError && error.code === 'CONFIGURATION_REQUIRED' || error instanceof BuilderError && error.code === 'INVALID_INPUT') dialog.showErrorBox('Dunara configuration needs attention', error.message);
    else failure();
  }
}
async function restart() {
  if (!window || reconnecting || quitting) return;
  const result = await dialog.showMessageBox(window, { type: 'warning', message: 'Restart Dunara backend?', detail: 'This stops owned previews and disconnects agents. Unsaved drafts, runtime captures and session-only credentials will be lost. Saved keys, opted-in accounts and saved drafts will be restored without sending messages. Startup keys will reload. Pending provider work may already be charged and will not be retried.', buttons: ['Cancel', 'Restart'], defaultId: 0, cancelId: 0 });
  if (result.response !== 1) return;
  reconnecting = true;
  try { await host?.stop(); await start(); }
  finally { reconnecting = false; }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', show);
  app.on('activate', show);
  app.on('before-quit', event => {
    if (finished) return;
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    void (async () => { await host?.stop(); finished = true; app.quit(); })();
  });
  process.once('SIGINT', () => app.quit()); process.once('SIGTERM', () => app.quit());
  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(details => {
      if (window && contents === window.webContents && host && new URL(contents.getURL()).origin === host.origin && (oauthAuthorizationAllowed(details.url) || assistantSignInAllowed(details.url) || setupLinkAllowed(details.url))) void shell.openExternal(details.url).catch(() => { dialog.showErrorBox('Could not open your browser', 'Try the link again from Dunara.'); });
      return { action: 'deny' };
    });
    contents.on('will-attach-webview', event => event.preventDefault());
    contents.on('will-navigate', (event, url) => { if (!host || !navigationAllowed(url, true, host.origin, host.previews)) event.preventDefault(); });
    contents.on('will-frame-navigate', event => { if (!host || !navigationAllowed(event.url, event.isMainFrame, host.origin, host.previews)) event.preventDefault(); });
    contents.on('will-redirect', (event, url, _inPlace, isMainFrame) => { if (!host || !navigationAllowed(url, isMainFrame, host.origin, host.previews)) event.preventDefault(); });
    contents.on('render-process-gone', () => failure());
  });
  void app.whenReady().then(async () => {
  app.setName('Dunara');
  const appIcon = fileURLToPath(new URL('../assets/app-icon.png', import.meta.url));
  app.dock?.setIcon(appIcon);
  app.setAboutPanelOptions({ applicationName: 'Dunara', iconPath: appIcon });
  // Retain Studio layout and generated-app browser data across full desktop quits.
  // Assistant provider credentials remain in the backend's encrypted stores.
  const browserSession = session.fromPartition('persist:builder-desktop');
  browserSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  browserSession.setPermissionCheckHandler(() => false);
  browserSession.setDevicePermissionHandler(() => false);
  window = new BrowserWindow({ width: 1440, height: 1000, minWidth: 375, minHeight: 640, title: 'Dunara', backgroundColor: '#f7f8fa', show: false, webPreferences: { ...rendererPreferences, session: browserSession } });
  window.on('close', event => { if (!quitting) { event.preventDefault(); window?.hide(); } });
  browserSession.on('will-download', (event, item, contents, frame) => {
    const owned = !!window && contents === window.webContents && !!frame && frame === contents.mainFrame;
    if (!host || !downloadAllowed(item.getURL(), item.getInitiatorOrigin(), host.origin, owned)) { event.preventDefault(); return; }
    // Keep Electron's native save dialog: the user chooses the destination and confirms overwrite.
    item.setSaveDialogOptions({ title: 'Save Dunara file', defaultPath: path.basename(item.getFilename()) });
    item.once('done', (_event, state) => { if (state === 'interrupted' && !quitting) dialog.showErrorBox('Download interrupted', 'The file could not be saved. Try the download again from Studio.'); });
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Dunara', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] },
    { label: 'Studio', submenu: [
      { label: 'Show Studio', click: show },
      { label: 'Reconnect Studio…', accelerator: 'CmdOrCtrl+R', click: () => { void confirmReconnect(); } },
      { label: 'Restart backend…', click: () => { void restart(); } },
      { type: 'separator' },
      { label: 'Open app workspace in Finder', click: () => { void shell.openPath(config.workspace); } },
      { label: 'Copy MCP socket path', click: () => { if (host?.running) clipboard.writeText(host.socketPath); } },
      { label: 'Runtime status', click: () => { if (window) void dialog.showMessageBox(window, { message: host?.running ? 'Dunara is running' : 'Dunara is stopped', detail: `One desktop-owned backend. Execution ${config.trusted ? 'authorized (not sandboxed)' : 'disabled'}.\nWorkspace: ${config.workspace}\nMCP socket: ${host?.running ? host.socketPath : 'unavailable'}\nClosing the window keeps Dunara running. Quit stops owned previews.` }); } },
    ] },
    { role: 'editMenu' },
    { label: 'View', submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
    { role: 'windowMenu' },
  ]));
  await start();
  }).catch(failure);
}
