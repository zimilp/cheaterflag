'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const call = (name) => (...args) => ipcRenderer.invoke(name, ...args).then((r) => { if (!r.ok) throw new Error(r.error); return r.data; });
const names = ['state', 'signIn', 'signOut', 'me', 'saveSettings', 'check', 'blacklist', 'addBlacklist', 'removeBlacklist',
  'flags', 'reviewFlag', 'members', 'setMember', 'setOverride', 'checkMatches', 'scanShareCode', 'scanFile', 'setupStatus', 'applyLaunchOptions', 'openCs2Properties', 'openAuthPage', 'pasteCodes', 'connectMatchHistory', 'watchDemo', 'clearAllFlags', 'voteFlag', 'voteBlacklist', 'gameState', 'updateStatus', 'checkUpdates', 'demoUsage', 'openDemos', 'prefs', 'setPrefs', 'autoStatus', 'openProfile', 'openExternal', 'copy', 'scanLobby'];

contextBridge.exposeInMainWorld('cf', {
  ...Object.fromEntries(names.map((n) => [n, call(n)])),
  on: (ch, fn) => { if (['lobby', 'match', 'progress', 'log', 'backfill', 'steamSetup', 'watch', 'game', 'goto', 'update'].includes(ch)) ipcRenderer.on(ch, (_e, d) => fn(d)); },
});
