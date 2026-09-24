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
import { readDesktopProfile, saveDesktopProfile } from './profile.js';
import { desktopUpdateCheck } from './updates.js';

const entry = process.argv.indexOf(fileURLToPath(import.meta.url));
const { values } = parseArgs({ args: process.argv.slice(entry >= 0 ? entry + 1 : app.isPackaged ? 1 : 2), options: {
  node: { type: 'string' }, workspace: { type: 'string' }, home: { type: 'string' }, 'builder-env-file': { type: 'string' },
  'user-data': { type: 'string' }, 'trust-execution': { type: 'boolean', default: false },
  'assistant-offline-fixture': { type: 'string' },
} });
if (process.platform !== 'darwin') throw new Error('This desktop prototype is macOS-only');
if (!app.isPackaged && (!values.node || !values.workspace || !values.home || !values['user-data'])) throw new Error('Launch with pnpm desktop');
const environment = values['assistant-offline-fixture'] ? {} : startupEnvironment(process.env);
for (const name of startupVariableNames) delete process.env[name];
const logDiagnostic = diagnosticWriter(process.stderr);
// Electron binds macOS Keychain service/account names before ready. Keep the
// existing vault identity during bootstrap; change only the display name after it.
app.setName('Mobile App Builder');
const userData = path.resolve(values['user-data'] ?? path.join(app.getPath('appData'), 'Mobile App Builder'));
app.setPath('userData', userData);
const config = { node: path.resolve(values.node ?? path.join(process.resourcesPath, 'runtime/bin/node')), workspace: path.resolve(values.workspace ?? path.join(app.getPath('documents'), 'Dunara Apps')), home: path.resolve(values.home ?? path.join(userData, 'builder-home')), trusted: values['trust-execution'], assistantOfflineFixture: values['assistant-offline-fixture'], startupEnvironment: environment, envFile: values['builder-env-file'] ? path.resolve(values['builder-env-file']) : app.isPackaged ? path.join(userData, 'startup.env') : path.resolve('.env'), browserPath: app.isPackaged ? path.join(process.resourcesPath, 'browsers') : undefined };
if (app.isPackaged) process.env.PATH = [path.dirname(config.node), path.join(app.getAppPath(), 'node_modules/.bin'), '/opt/homebrew/bin', '/usr/local/bin', process.env.PATH ?? '/usr/bin:/bin'].join(path.delimiter);
app.enableSandbox();

let window: BrowserWindow | undefined;
let host: DesktopHost | undefined;
let quitting = false;
let finished = false;
let reconnecting = false;
const checkUpdates = desktopUpdateCheck(() => window, async () => { quitting = true; await host?.stop(); finished = true; });
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
  if (app.isPackaged && !values.workspace && !values.home && !values['user-data']) {
    const filename = path.join(userData, 'desktop-profile.json');
    let profile;
    try { profile = await readDesktopProfile(filename); }
    catch { dialog.showErrorBox('Saved desktop setup needs attention', 'Dunara could not read its desktop profile. Existing apps and settings have not been changed. Restore desktop-profile.json from your backup.'); app.quit(); return; }
    if (!profile) {
      const folder = await dialog.showOpenDialog({ title: 'Choose a folder for your Dunara apps', defaultPath: config.workspace, properties: ['openDirectory', 'createDirectory'], buttonLabel: 'Use this folder' });
      if (folder.canceled || !folder.filePaths[0]) { app.quit(); return; }
      const choice = await dialog.showMessageBox({ type: 'question', message: 'Allow this desktop workspace to build apps?', detail: 'Preview and build tools run project code on this Mac with your user permissions. Choose a folder containing projects you trust. Existing profiles are not moved or imported.', buttons: ['Cancel', 'Allow local builds'], defaultId: 0, cancelId: 0 });
      if (choice.response !== 1) { app.quit(); return; }
      profile = { version: 1 as const, workspace: folder.filePaths[0], home: config.home, trusted: true }; await saveDesktopProfile(filename, profile);
    }
    Object.assign(config, { workspace: profile.workspace, home: profile.home, trusted: profile.trusted });
  }
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
    { label: 'Dunara', submenu: [{ role: 'about' }, { label: 'Check for updates…', click: () => { void checkUpdates(); } }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] },
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
