import type { BrowserWindow } from 'electron';
import { app, dialog } from 'electron';
import electronUpdater from 'electron-updater';

/** Manual checks and separate download/restart choices. No work is resumed after an update. */
export function desktopUpdateCheck(window: () => BrowserWindow | undefined, prepareToQuit: () => Promise<void>) {
  const { autoUpdater } = electronUpdater;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowDowngrade = false;
  autoUpdater.allowPrerelease = false;
  autoUpdater.logger = null;
  autoUpdater.on('error', () => {}); // The initiating action handles the safe user-facing error.
  let busy = false, downloaded = false;
  return async () => {
    const parent = window(); if (!parent || busy) return;
    if (!app.isPackaged) { await dialog.showMessageBox(parent, { message: 'Updates are available in the installed app', detail: 'This source checkout is updated through Git and rebuilt locally.' }); return; }
    busy = true;
    try {
      if (!downloaded) {
        const result = await autoUpdater.checkForUpdates();
        if (!result || !result.isUpdateAvailable) { await dialog.showMessageBox(parent, { message: 'Dunara is up to date', detail: `Installed version: ${app.getVersion()}` }); return; }
        const choice = await dialog.showMessageBox(parent, { type: 'question', message: `Dunara ${result.updateInfo.version} is available`, detail: 'Download the signed update now? Your apps and saved settings are retained. Installation requires a separate restart.', buttons: ['Not now', 'Download update'], defaultId: 0, cancelId: 0 });
        if (choice.response !== 1) return;
        await autoUpdater.downloadUpdate(); downloaded = true;
      }
      const choice = await dialog.showMessageBox(parent, { type: 'question', message: 'Restart to install the update?', detail: 'Owned previews and active Assistant work will stop. Wait for active work to finish first. Saved projects and remembered settings are retained; session-only drafts will be lost.', buttons: ['Later', 'Restart and install'], defaultId: 0, cancelId: 0 });
      if (choice.response === 1) { await prepareToQuit(); autoUpdater.quitAndInstall(false, true); }
    } catch { await dialog.showMessageBox(parent, { type: 'warning', message: 'The update could not be completed', detail: 'Check your connection and try again. The installed version and your projects are unchanged. A signed desktop release may not yet be available on this channel.' }); }
    finally { busy = false; }
  };
}
