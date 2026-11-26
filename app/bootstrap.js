'use strict';
// CheaterFlag starts here. This file is kept tiny on purpose: if an update ever ships a bug that
// stops the app from starting, this still runs, downloads the fixed version and installs it.
const { app, dialog, shell } = require('electron');

const DOWNLOAD = 'https://github.com/zimilp/cheaterflag/releases/latest/download/CheaterFlag-Setup.exe';
let rescuing = false;

function giveUp(err) {
  const choice = dialog.showMessageBoxSync({
    type: 'error', title: 'CheaterFlag',
    message: "CheaterFlag couldn't start and couldn't fix itself.",
    detail: 'Click "Download fix" to get the latest version, run it, and you are done — your settings are kept.\n\n' + String(err && err.message || err).slice(0, 300),
    buttons: ['Download fix', 'Close'], defaultId: 0,
  });
  if (choice === 0) shell.openExternal(DOWNLOAD);
  app.exit(1);
}

function rescue(err) {
  if (rescuing) return;
  rescuing = true;
  console.error('CheaterFlag failed to start:', err);
  const run = () => {
    let au = null;
    try { au = require('electron-updater').autoUpdater; } catch (_) { /* not packaged */ }
    if (!au || !app.isPackaged) return giveUp(err);
    au.autoDownload = true;
    au.on('update-downloaded', () => au.quitAndInstall(true, true));   // silent install, then reopen
    au.on('update-not-available', () => giveUp(err));
    au.on('error', () => giveUp(err));
    au.checkForUpdates().catch(() => giveUp(err));
  };
  if (app.isReady()) run(); else app.whenReady().then(run);
}

// Only a failure to LOAD the app triggers the rescue (that is what a broken update looks like);
// ordinary errors later on (network hiccups etc.) never do.
try {
  require('./main');
} catch (e) {
  rescue(e);
}
