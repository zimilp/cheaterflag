'use strict';
const { app, BrowserWindow, Tray, Menu, Notification, ipcMain, shell, utilityProcess, nativeImage, clipboard, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { Store } = require('./lib/store');
const { Api } = require('./lib/api');
const steamWindow = require('./lib/steamWindow');
const { LobbyScanner } = require('./lib/lobbyScanner');
const { MatchWatcher } = require('./lib/matchWatcher');
const steamConfig = require('./lib/steamConfig');
const tabStatus = require('./lib/tabStatus');
const retention = require('./lib/retention');
const { GameState, installCfg } = require('./lib/gsi');
const { SCANNER_VERSION } = require('./lib/demoScan');
const STEAM64_BASE = 76561197960265728n;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let defaults = { workerUrl: '' };
try { defaults = { ...defaults, ...require('./config.json') }; } catch (_) {}

if (!app.requestSingleInstanceLock()) app.quit();

let win, tray, store, api, lobby, watcher, scanProc, gsi;
const lobbyState = { players: [], checks: {}, names: [], nameHits: {}, netcon: false, consoleLog: null };
const send = (ch, data) => { if (win && !win.isDestroyed()) win.webContents.send(ch, data); };

// Notifications never pop up mid-match: they wait until you're back in the menu/lobby.
// `prematch` ones (blacklisted player in your lobby) may also show during warmup.
const held = [];
function notify(title, body, onClick, { prematch = false } = {}) {
  if (store && store.get('notifications') === false) return;
  if (gsi && gsi.quietTime(prematch)) {
    if (!held.some((h) => h.title === title && h.body === body)) held.push({ title, body, onClick });
    return;
  }
  const n = new Notification({ title, body, icon: path.join(__dirname, 'assets', 'icon.png') });
  if (onClick) n.on('click', onClick);
  n.show();
}
function flushHeld() {
  while (held.length && !(gsi && gsi.quietTime())) { const h = held.shift(); notify(h.title, h.body, h.onClick); }
}

// ---------- demo scanning in a utility process
let scanSeq = 0; const pending = new Map();
function runScan(demoPath, deep = null, statsOnly = false) {
  if (!scanProc) {
    scanProc = utilityProcess.fork(path.join(__dirname, 'scanWorker.js'));
    scanProc.on('message', (m) => { const p = pending.get(m.id); if (!p) return; pending.delete(m.id); m.ok ? p.resolve(m.scan) : p.reject(new Error(m.error)); });
    scanProc.on('exit', () => { scanProc = null; for (const p of pending.values()) p.reject(new Error('Scanner stopped')); pending.clear(); });
  }
  return new Promise((resolve, reject) => { const id = ++scanSeq; pending.set(id, { resolve, reject }); scanProc.postMessage({ id, demoPath, deep, statsOnly }); });
}

// ---------- window + tray
function createWindow() {
  if (win && !win.isDestroyed()) { win.show(); win.focus(); return; }
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 980, minHeight: 640, backgroundColor: '#0f1115', title: 'CheaterFlag', autoHideMenuBar: true,
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('close', (e) => { if (!app.isQuitting) { e.preventDefault(); win.hide(); } });
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png')).resize({ width: 16, height: 16 }));
  tray.setToolTip('CheaterFlag');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open CheaterFlag', click: createWindow },
    { label: 'Scan lobby now', click: () => lobby && lobby.scanNow() },
    { label: 'Check for new matches now', click: () => watcher && watcher.tick() },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } },
  ]));
  tray.on('click', createWindow);
}

// ---------- lobby scanner
async function onLobbyPlayers(fresh) {
  lobbyState.players = [...new Set([...lobbyState.players, ...fresh])];
  send('lobby', lobbyState);
  if (!store.get('token')) return;
  try {
    const { players } = await api.check(fresh);
    const bad = [];
    for (const p of players) { lobbyState.checks[p.steamid] = p; if (p.tier !== 'approved') bad.push(p); }
    send('lobby', lobbyState);
    const red = bad.filter((p) => p.tier === 'rejected');
    if (red.length) notify('CheaterFlag: flagged player in your match', red.map((p) => `${p.name || p.steamid} — ${p.reasons[0]}`).join('\n'), createWindow, { prematch: true });
  } catch (e) { send('log', 'Lobby check failed: ' + e.message); }
}

// Live check while a match is loading/being played. Confirms blacklisted players by SteamID when Steam
// shows they're on the same game server as you; otherwise falls back to name + "playing CS2 right now".
async function liveCheck() {
  if (!store.get('token')) return;
  try {
    const r = await api.liveCheck(lobbyState.names || []);
    lobbyState.live = r;
    for (const b of r.likely) lobbyState.nameHits[(b.name || '').toLowerCase()] = { ...b, level: 'likely' };
    for (const b of r.confirmed) lobbyState.nameHits[(b.name || '').toLowerCase()] = { ...b, level: 'confirmed' };
    for (const b of r.nameOnly) if (!lobbyState.nameHits[(b.name || '').toLowerCase()]) lobbyState.nameHits[(b.name || '').toLowerCase()] = { ...b, level: 'name' };
    send('lobby', lobbyState);
    const told = lobbyState.told || (lobbyState.told = new Set());
    const fresh = [...r.confirmed.map((b) => ({ ...b, level: 'confirmed' })), ...r.likely.map((b) => ({ ...b, level: 'likely' }))].filter((b) => !told.has(b.steamid));
    for (const b of fresh) told.add(b.steamid);
    if (fresh.length) notify('CheaterFlag: blacklisted player in your match',
      fresh.map((b) => `${b.name} — ${b.category} (${b.level === 'confirmed' ? 'confirmed by SteamID' : 'very likely: same name and playing CS2 now'})`).join('\n'), createWindow, { prematch: true });
  } catch (e) { send('log', 'Live check failed: ' + e.message); }
}
// Squad plan: CheaterFlag members you're queued/playing with, their stats (overall + on this map) for role suggestions
let squadBusy = false;
async function refreshSquad() {
  if (squadBusy || !api || !store.get('token')) return;
  squadBusy = true;
  try {
    const r = await api.squad(lobbyState.names || [], lobbyState.map || null);
    lobbyState.squad = r.squad || [];
    lobbyState.squadMap = r.map || null;
    send('lobby', lobbyState);
  } catch (_) { /* try again later */ } finally { squadBusy = false; }
}
setInterval(refreshSquad, 2 * 60 * 1000);
let liveTimer = null;
function onGameState(next, prev) {
  send('game', next);
  if (next.inMatch && !prev.inMatch) {               // match loading: check now and every minute
    lobbyState.told = new Set();
    setTimeout(liveCheck, 8000);
    clearInterval(liveTimer); liveTimer = setInterval(liveCheck, 60000);
  }
  if (!next.inMatch && prev.inMatch) { clearInterval(liveTimer); liveTimer = null; if (watcher) watcher.afterMatch(); } // scan it as soon as Steam has it
  if (!next.inMatch) { flushHeld(); remindVotes(); }
}

async function onLobbyNames(fresh, all) {
  lobbyState.names = all;
  send('lobby', lobbyState);
  liveCheck();
  clearTimeout(onLobbyNames.t); onLobbyNames.t = setTimeout(refreshSquad, 5000);
}

// Flags waiting for your vote: reminded every 5 minutes, but never while a match is being played.
async function remindVotes() {
  if (!store.get('token') || (gsi && gsi.quietTime())) return;
  if (Date.now() - (store.get('lastVoteReminder') || 0) < 5 * 60 * 1000 - 5000) return;
  try {
    const { flags } = await api.flags('pending');
    const waiting = flags.filter((f) => !f.my_vote);
    if (!waiting.length) return;
    store.set({ lastVoteReminder: Date.now() });
    notify('CheaterFlag: your vote is needed', `${waiting.length} suspected cheater${waiting.length === 1 ? '' : 's'} waiting for your vote in Review.`, () => { createWindow(); send('goto', 'review'); });
  } catch (_) {}
}
setInterval(remindVotes, 5 * 60 * 1000);

// When someone you played with gets blacklisted, ask you to report them in that match (one real report each).
async function remindReports() {
  if (!store.get('token')) return;
  try {
    const { entries } = await api.blacklist();
    const told = new Set(store.get('reportReminders') || []);
    const hist = store.get('history') || [];
    for (const b of entries) {
      if (told.has(b.steamid)) continue;
      const match = hist.find((h) => (h.results || []).some((r) => r.steamid === b.steamid));
      if (!match) continue;
      told.add(b.steamid);
      notify('CheaterFlag: please report this player', `${b.name || b.steamid} (${b.category}) was in your match on ${(match.map || '').replace(/^de_/, '')}. Open the match in CS2 and report them once.`, createWindow);
    }
    store.set({ reportReminders: [...told] });
  } catch (_) {}
}
setInterval(remindReports, 10 * 60 * 1000);

function startServices() {
  lobby && lobby.stop(); watcher && watcher.stop();
  lobby = new LobbyScanner({ cs2Dir: store.get('cs2Dir'), netconPort: Number(store.get('netconPort') || 2121), ownSteamId: store.get('steamid'), ownName: store.get('name') });
  lobby.on('status', (s) => { lobbyState.consoleLog = s.consoleLog; send('lobby', lobbyState); });
  lobby.on('netcon', (on) => { lobbyState.netcon = on; send('lobby', lobbyState); });
  lobby.on('matchStart', () => { lobbyState.players = []; lobbyState.checks = {}; lobbyState.names = []; lobbyState.nameHits = {}; send('lobby', lobbyState); });
  lobby.on('names', onLobbyNames);
  lobby.on('map', (m) => { lobbyState.map = m; send('lobby', lobbyState); refreshSquad(); });
  lobby.on('matchEnd', () => { lobbyState.players = []; lobbyState.checks = {}; lobbyState.names = []; lobbyState.nameHits = {}; lobbyState.live = null; lobbyState.lastStatus = null; lobbyState.map = null; clearInterval(liveTimer); send('lobby', lobbyState); refreshSquad(); });
  lobby.on('statusSeen', (x) => { lobbyState.lastStatus = x; send('lobby', lobbyState); });
  lobby.on('players', onLobbyPlayers);
  lobby.start();

  watcher = new MatchWatcher({ api, store, dataDir: app.getPath('userData'), runScan, watchDir: watchDir() });
  watcher.on('progress', (p) => send('progress', p));
  watcher.on('backfill', (b) => { backfillStatus = b; send('backfill', b); });
  watcher.on('error', (e) => send('log', e.message));
  watcher.on('match', (m) => {
    send('match', m);
    const flagged = m.results.filter((r) => r.flagged);
    const red = (m.checks || []).filter((c) => c.tier === 'rejected');
    if (flagged.length) {
      // Report helper: tells you exactly what to report; you click Report on the scoreboard / in Your Matches.
      notify('CheaterFlag: report these players',
        flagged.map((r) => `${r.name}: report for ${r.category} — rounds ${r.rounds.join(', ') || '?'}`).join('\n'), createWindow);
    } else if (red.length) {
      notify('CheaterFlag: match checked', `${red.length} player(s) with bans or on the blacklist.`, createWindow);
    }
  });
  watcher.start();
}

// Silent setup: find CS2, and add launch options whenever Steam happens to be closed.
function autoConfigure() {
  try {
    if (!store.get('cs2Dir')) { const d = steamConfig.findCs2Dir(); if (d) store.set({ cs2Dir: d }); }
    try { tabStatus.apply(store.get('cs2Dir'), store.get('tabStatus') === true, false); } catch (_) {}
    const id = store.get('steamid');
    if (id && !steamConfig.launchOptionsStatus(id).ok) steamConfig.applyLaunchOptions(id); // no-op while Steam runs
    if (gsi && installCfg(store.get('cs2Dir'), gsi.token)) send('log', 'Game-state link installed — it starts working next time CS2 opens.');
  } catch (e) { send('log', 'Auto-setup: ' + e.message); }
}

// ---------- first run: import codes/older-match links, then scan older matches once
function firstRunImport() {
  for (const f of [path.join(__dirname, '..', 'first-run.json'), path.join(app.getPath('userData'), 'first-run.json')]) {
    if (!fs.existsSync(f)) continue;
    try {
      const d = JSON.parse(fs.readFileSync(f, 'utf8'));
      const patch = {};
      if (d.authCode && !store.get('authCode')) patch.authCode = String(d.authCode).trim();
      if (d.lastShareCode && !store.get('lastShareCode')) patch.lastShareCode = String(d.lastShareCode).trim();
      if (Array.isArray(d.backfillUrls)) patch.backfillUrls = [...new Set([...(store.get('backfillUrls') || []), ...d.backfillUrls])];
      store.set(patch);
      fs.renameSync(f, f + '.imported');
    } catch (e) { send('log', 'Could not import ' + f + ': ' + e.message); }
  }
}

function localDemoFiles() {
  const dir = store.get('cs2Dir') || steamConfig.findCs2Dir();
  if (!dir) return [];
  const out = [];
  for (const d of [dir, path.join(dir, 'replays')]) {
    try { for (const f of fs.readdirSync(d)) if (/\.dem$/i.test(f)) out.push(path.join(d, f)); } catch (_) {}
  }
  return out;
}

// Basic stats for ALL past matches (years back) from Steam's match history page: K / A / D, MVPs,
// HS %, score and win/loss for everyone in each match. The service keeps members' rows only.
let historySyncRunning = false;
async function syncHistoryStats() {
  if (historySyncRunning || connecting || !store.get('token') || !store.get('steamid')) return;
  historySyncRunning = true;
  try {
    const since = store.get('historyStatsAt') || 0;
    const rows = await steamWindow.getMatchHistoryStats(win, store.get('steamid'), { untilMs: since ? since - 86400000 : 0 });
    if (!rows.length) return;
    const BASE = 76561197960265728n;
    const matches = rows.map((m) => {
      const [s0, s1] = String(m.score || '').split(':').map(Number);
      const id = (String(m.link || '').match(/(\d{15,30})_\d{6,12}/) || [])[1] || String(Math.floor(m.playedAt / 1000));
      return {
        matchId: id, playedAt: m.playedAt, map: String(m.map || '').replace(/^(Premier|Competitive)\s+/i, ''),
        players: m.players.filter((p) => /^\d+$/.test(p.account)).map((p) => {
          const own = p.team === 0 ? s0 : s1, opp = p.team === 0 ? s1 : s0;
          const res = Number.isFinite(own) && Number.isFinite(opp) ? { wins: +(own > opp), losses: +(own < opp), ties: +(own === opp) } : {};
          return { steamid: (BASE + BigInt(p.account)).toString(), name: p.name,
            stats: { basic: 1, kills: p.k, assists: p.a, deaths: p.d, mvps: p.mvp, mvpRounds: (s0 + s1) || 0, headshots: Math.round(p.k * p.hsp / 100), score: p.score, ...res } };
        }),
      };
    }).filter((m) => m.players.length);
    for (let i = 0; i < matches.length; i += 8) {
      await api.uploadStatsBatch(matches.slice(i, i + 8));
      await new Promise((r) => setTimeout(r, 300));
    }
    store.set({ historyStatsAt: Math.max(since, ...rows.map((r) => r.playedAt)) });
    send('log', `Stats: added ${matches.length} past match${matches.length === 1 ? '' : 'es'} from your Steam match history.`);
  } catch (e) { send('log', 'Stats from Steam match history: ' + e.message); }
  finally { historySyncRunning = false; }
}

// Fun stats for matches scanned before the Stats tab existed: use demos still on this PC, or
// download ones Valve still has (about 5 days). Runs once per match, quietly, between other scans.
let statsFillRunning = false;
async function backfillStats() {
  if (statsFillRunning || !watcher || !store.get('token')) return;
  statsFillRunning = true;
  try {
    // award rules changed: recalculate saved matches (no download needed) and share the new awards
    const { AWARDS_VERSION } = require('./lib/matchWatcher');
    const hist0 = store.get('history') || [];
    const redo = hist0.filter((m) => m.statsV && m.awardsV !== AWARDS_VERSION && (m.results || []).some((r) => r.stats));
    for (const m of redo) { watcher.addAwards(m); watcher.shareStats(m); }
    if (redo.length) { store.set({ history: hist0 }); send('match', redo[0]); }

    const { STATS_VERSION } = require('./lib/matchWatcher');
    const todo = (store.get('history') || []).filter((m) => (m.statsV || 0) < STATS_VERSION && m.statsTried !== STATS_VERSION && m.results && m.results.length
      && ((m.keptDemo && fs.existsSync(m.keptDemo)) || (m.demoUrl && Date.now() - (m.playedAt || m.at) < 5 * 86400000)));
    for (const item of todo) {
      while (watcher.busy) await new Promise((r) => setTimeout(r, 5000));
      watcher.busy = true;
      let demo = item.keptDemo && fs.existsSync(item.keptDemo) ? item.keptDemo : null, temp = false;
      try {
        if (!demo) { demo = await watcher.download(item.demoUrl, 'stats_' + item.shareCode); temp = true; }
        const stats = await runScan(demo, null, true);
        const key = item.shareCode || String(item.at);
        const hist = store.get('history') || [];
        const m = hist.find((x) => (x.shareCode || String(x.at)) === key);
        if (m) {
          const got = stats.stats || stats;   // { stats, highlights } (older builds: just stats)
          for (const r of m.results) if (got[r.steamid]) { r.stats = got[r.steamid]; r.highlights = (stats.highlights || {})[r.steamid] || []; }
          watcher.addAwards(m);
          store.set({ history: hist });
          watcher.shareStats(m);
          send('match', m);
        }
      } catch (e) {
        const hist = store.get('history') || [];
        const m = hist.find((x) => x.shareCode === item.shareCode && x.at === item.at);
        if (m) { m.statsTried = require('./lib/matchWatcher').STATS_VERSION; store.set({ history: hist }); }
      } finally {
        if (temp && demo) { try { fs.unlinkSync(demo); } catch (_) {} }
        watcher.busy = false;
      }
    }
  } finally { statsFillRunning = false; }
}

let backfillRunning = false;
let backfillStatus = null;
function startBackfill() {
  if (backfillRunning || !store.get('token') || !watcher) return;
  const items = [];
  const keptIds = new Set();
  // after a scanner update, scan all older matches again with the new version
  if (store.get('backfillVersion') !== SCANNER_VERSION) {
    // scanner update: replace undecided flags from the old version, and re-scan every match we still can
    // (decisions people already made carry over automatically on the server)
    api.supersede(SCANNER_VERSION).catch((e) => send('log', 'Could not refresh old flags: ' + e.message));
    const fromHistory = (store.get('history') || []).map((h) => h.demoUrl).filter(Boolean);
    store.set({ backfillDone: [], backfillVersion: SCANNER_VERSION, backfillUrls: [...new Set([...(store.get('backfillUrls') || []), ...fromHistory])] });
  }
  // ...and re-check demos the old version flagged that aren't in that list (keeps or deletes them)
  if (store.get('scannerVersion') !== SCANNER_VERSION) {
    const prevFor = (p) => (store.get('history') || []).find((h) => h.keptDemo === p) || {};
    const urlFor = (p) => prevFor(p).demoUrl || null;
    try {
      // demos still on this PC (flagged or kept clean) are re-scanned locally instead of downloaded again
      for (const dir of [watcher.flaggedDir, watcher.cleanDir]) {
        if (!fs.existsSync(dir)) continue;
        for (const f of fs.readdirSync(dir)) {
          if (!/\.dem$/i.test(f)) continue;
          const p = path.join(dir, f);
          const id = (f.match(/(\d+_\d+)/) || [])[1];
          if (id) keptIds.add(id);
          items.push({ type: 'kept', path: p, demoUrl: urlFor(p), playedAt: prevFor(p).playedAt || null });
        }
      }
    } catch (_) {}
    store.set({ scannerVersion: SCANNER_VERSION });   // keep history: re-scanned matches replace their old entry, older ones stay as they were
  }
  items.push(
    ...(store.get('backfillUrls') || []).filter((url) => ![...keptIds].some((id) => url.includes(id))).map((url) => ({ type: 'url', url })),
    ...localDemoFiles().map((p) => ({ type: 'file', path: p })),
  );
  if (!items.length) return;
  // newest matches first (Valve match ids grow over time); own demo files by date
  const idOf = (it) => { const m = String(it.url || it.path || '').match(/(\d{15,})_\d+/); return m ? BigInt(m[1]) : null; };
  const timeOf = (it) => { try { return fs.statSync(it.path).mtimeMs; } catch (_) { return 0; } };
  items.sort((a, b) => {
    const ia = idOf(a), ib = idOf(b);
    if (ia != null && ib != null) return ia > ib ? -1 : ia < ib ? 1 : 0;
    if (ia != null) return -1;
    if (ib != null) return 1;
    return timeOf(b) - timeOf(a);
  });
  backfillRunning = true;
  watcher.backfill(items).catch((e) => send('log', e.message)).finally(() => { backfillRunning = false; });
}

// Reads the match-history codes and older-match links through the built-in Steam window.
let connecting = null;
function connectMatchHistory() {
  if (connecting) return connecting;
  connecting = (async () => {
    send('steamSetup', { step: 'codes', msg: 'Getting your match-history codes from Steam…' });
    const { authCode, shareCode } = await steamWindow.getMatchCodes(win);
    if (!authCode) throw new Error('Could not get the Authentication Code from Steam. Use "Do it myself" below.');
    const patch = { authCode };
    if (shareCode && !store.get('lastShareCode')) patch.lastShareCode = shareCode;
    store.set(patch);
    startServices();
    send('steamSetup', { step: 'older', msg: 'Finding your older matches…' });
    try {
      const urls = await steamWindow.getOlderMatchLinks(win, store.get('steamid'));
      store.set({ backfillUrls: [...new Set([...(store.get('backfillUrls') || []), ...urls])] });
      send('steamSetup', { step: 'done', msg: `Connected. Found ${urls.length} older match${urls.length === 1 ? '' : 'es'} to scan.` });
    } catch (e) {
      send('steamSetup', { step: 'done', msg: 'Connected. (Older matches could not be read: ' + e.message + ')' });
    }
    setTimeout(startBackfill, 3000);
    setTimeout(syncHistoryStats, 10000);
    return { authCode: !!authCode, shareCode: !!(shareCode || store.get('lastShareCode')) };
  })().finally(() => { connecting = null; });
  return connecting;
}

// ---------- "Watch in CS2": opens the demo at the right moment, spectating the flagged player
function watchDir() {
  const cs2 = store.get('cs2Dir') || steamConfig.findCs2Dir();
  return cs2 ? path.join(cs2, 'cheaterflag') : null;
}
let watching = false;
async function watchDemo({ demoPath, demoUrl, key, tick, steamid }) {
  if (watching) throw new Error('Already opening a demo — give it a few seconds.');
  watching = true;
  try {
    const dir = watchDir();
    if (!dir) throw new Error('Could not find your CS2 folder.');
    let src = demoPath && fs.existsSync(demoPath) ? demoPath : null;
    if (!src && demoUrl) {
      send('watch', 'Downloading the demo (about a minute)…');
      src = await watcher.download(demoUrl, key || 'demo');
      fs.mkdirSync(watcher.flaggedDir, { recursive: true });
      const kept = path.join(watcher.flaggedDir, path.basename(src));
      fs.renameSync(src, kept); src = kept;
    }
    if (!src) throw new Error('This demo is no longer on this PC or on Valve\'s servers.');
    fs.mkdirSync(dir, { recursive: true });
    const name = path.basename(src, '.dem').replace(/[^A-Za-z0-9_-]/g, '');
    const dest = path.join(dir, name + '.dem');
    if (!fs.existsSync(dest)) { send('watch', 'Preparing the demo…'); fs.copyFileSync(src, dest); }
    const cmds = [`playdemo cheaterflag/${name}`, `demo_gototick ${Math.max(0, Math.floor(tick || 0))}`];
    if (steamid) cmds.push(`spec_player_by_accountid ${(BigInt(steamid) - STEAM64_BASE).toString()}`);

    const wasOpen = !!lobby.sock;
    if (!wasOpen) { send('watch', 'Starting CS2…'); shell.openExternal('steam://run/730'); }
    try { await lobby.ensureNetcon(wasOpen ? 5000 : 180000); }
    catch (_) { return { manual: cmds }; }
    if (!wasOpen) await sleep(10000);          // let CS2 finish loading the main menu
    send('watch', 'Loading the demo in CS2…');
    await lobby.send(cmds[0]);
    await sleep(15000);                        // demo load time
    for (const c of cmds.slice(1)) { await lobby.send(c); await sleep(1500); }
    send('watch', 'Playing in CS2. If it didn\'t jump to the right moment, open the console (~) and type: ' + cmds.slice(1).join('; '));
    return { ok: true, manual: cmds };
  } finally { watching = false; }
}

// ---------- automatic updates: check at start and every hour; install as soon as it's downloaded,
// unless a match is being played (then right after it ends). The app restarts itself in the background.
let updateStatus = '';
let updateReady = null;   // version downloaded and waiting to install
let installNow = null;
function setupAutoUpdate() {
  if (!app.isPackaged) return;
  let au;
  try { au = require('electron-updater').autoUpdater; } catch (_) { return; }
  au.autoDownload = true;
  au.autoInstallOnAppQuit = true;
  let ready = false;
  const install = () => {
    if (!ready || (gsi && gsi.quietTime())) return;
    app.isQuitting = true;
    au.quitAndInstall(true, true);   // silent install, then reopen
  };
  const status = (text) => { updateStatus = text; send('update', text); };
  au.on('checking-for-update', () => status('Checking for updates…'));
  au.on('update-not-available', () => status('Up to date.'));
  au.on('update-available', (i) => status(`Downloading version ${i.version}…`));
  au.on('download-progress', (p) => status(`Downloading update… ${Math.round(p.percent)}%`));
  installNow = () => { app.isQuitting = true; au.quitAndInstall(true, true); };
  au.on('update-downloaded', (i) => { ready = true; updateReady = i.version; send('updateReady', i.version); status(`Version ${i.version} downloaded — installing${gsi && gsi.quietTime() ? ' after your match' : ''}.`); install(); });
  au.on('error', (e) => status('Update problem: ' + (e && e.message ? e.message.split('\n')[0] : e) + ' — you can always install the latest version from the download link.'));
  if (gsi) gsi.on('change', (next) => { if (!next.inMatch) install(); });
  const check = () => au.checkForUpdates().catch(() => {});
  check();
  setInterval(check, 60 * 60 * 1000);
}

// ---------- IPC
function registerIpc() {
  const h = (name, fn) => ipcMain.handle(name, async (_e, ...a) => {
    try { return { ok: true, data: await fn(...a) }; } catch (e) { return { ok: false, error: e.message }; }
  });
  h('state', async () => ({ settings: { ...store.all(), token: undefined, history: undefined }, signedIn: !!store.get('token'), lobby: lobbyState, history: store.get('history') || [], version: app.getVersion() }));
  h('signIn', async () => {
    const params = await steamWindow.openIdSignIn(win);
    const r = await api.signIn(params);
    store.set({ token: r.token, steamid: r.member.steamid, name: r.member.name });
    autoConfigure();
    startServices();
    connectMatchHistory().catch((e) => send('log', e.message)); // same Steam session: usually no second sign-in
    return r.member;
  });
  h('prefs', async () => ({ openAtLogin: store.get('openAtLogin') !== false, notifications: store.get('notifications') !== false,
    keepCleanDays: store.get('keepCleanDays') == null ? 7 : Number(store.get('keepCleanDays')), tabStatus: store.get('tabStatus') === true }));
  h('demoUsage', async () => watcher ? retention.usage([watcher.cleanDir, watcher.flaggedDir]) : { bytes: 0, count: 0 });
  h('openDemos', async () => { if (watcher) { fs.mkdirSync(watcher.demoDir, { recursive: true }); shell.openPath(watcher.demoDir); } });
  h('setPrefs', async (p) => {
    const patch = {};
    if (typeof p.openAtLogin === 'boolean') { patch.openAtLogin = p.openAtLogin; if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: p.openAtLogin, args: ['--hidden'] }); }
    if (typeof p.notifications === 'boolean') patch.notifications = p.notifications;
    if ([0, 3, 7, 14].includes(Number(p.keepCleanDays))) patch.keepCleanDays = Number(p.keepCleanDays);
    if (typeof p.tabStatus === 'boolean') {
      const was = store.get('tabStatus') === true;
      patch.tabStatus = p.tabStatus;
      try { tabStatus.apply(store.get('cs2Dir') || steamConfig.findCs2Dir(), p.tabStatus, was); } catch (e) { throw new Error("Couldn't write CS2's config: " + e.message); }
    }
    store.set(patch); return true;
  });
  h('updateStatus', async () => updateStatus);
  h('updateReady', async () => updateReady);
  h('installUpdate', async () => { if (!installNow || !updateReady) throw new Error('No update is waiting.'); installNow(); return true; });
  h('checkUpdates', async () => { try { await require('electron-updater').autoUpdater.checkForUpdates(); } catch (e) { return e.message; } return true; });
  h('gameState', async () => (gsi ? gsi.state : null));
  h('autoStatus', async () => ({ backfill: backfillStatus, lastCheck: store.get('lastMatchCheck') || null, connected: !!(store.get('authCode') && store.get('lastShareCode')) }));
  h('signOut', async () => { store.set({ token: null }); await steamWindow.signOutOfSteamWindow(); return true; });
  h('connectMatchHistory', () => connectMatchHistory());
  h('me', () => api.me());
  h('saveSettings', async (patch) => {
    const allowed = ['workerUrl', 'authCode', 'lastShareCode', 'cs2Dir', 'netconPort'];
    const clean = Object.fromEntries(Object.entries(patch).filter(([k]) => allowed.includes(k)).map(([k, v]) => [k, String(v || '').trim()]));
    store.set(clean); startServices(); return true;
  });
  h('check', (ids) => api.check(ids));
  h('blacklist', () => api.blacklist());
  h('addBlacklist', (e) => api.addBlacklist(e));
  h('removeBlacklist', (id) => api.removeBlacklist(id));
  h('flags', (s) => api.flags(s));
  h('stats', (days) => api.stats(days));
  h('reviewFlag', (id, action) => api.reviewFlag(id, action));
  h('members', () => api.members());
  h('setMember', (id, patch) => api.setMember(id, patch));
  // Scrutinize: deeper check of one player in one match; anything suspicious goes to Review
  const scrutinizing = new Set();
  h('scrutinize', async (key, steamid) => {
    const job = key + '|' + steamid;
    if (scrutinizing.has(job)) throw new Error('Already checking this player.');
    scrutinizing.add(job);
    try {
      const m = (store.get('history') || []).find((x) => (x.shareCode || String(x.at)) === key);
      if (!m) throw new Error('Match not found.');
      let demo = m.keptDemo && fs.existsSync(m.keptDemo) ? m.keptDemo : null;
      let downloaded = false;
      if (!demo) {
        if (!m.demoUrl) throw new Error("This match's demo is no longer on this PC.");
        demo = await watcher.download(m.demoUrl, 'scrutiny_' + key);
        downloaded = true;
      }
      const r = await runScan(demo, String(steamid));
      let sent = null;
      const prev = m.results.find((x) => x.steamid === r.steamid) || {};
      if (r.flagged) {
        sent = await api.submitFlag({
          shareCode: key, steamid: r.steamid, name: r.name, category: r.category, score: r.score, rounds: r.rounds, signals: r.signals, map: m.map,
          extra: { scannerVersion: SCANNER_VERSION, scrutinized: true, moments: r.moments, demoUrl: m.demoUrl,
            score: prev.teamScore != null ? { own: prev.teamScore, opp: prev.oppScore } : null },
        });
      }
      let kept = m.keptDemo;
      if (!m.local && (downloaded || r.flagged)) {
        // keep the demo with the other flagged ones, or under the clean-demo setting
        kept = retention.afterScan(demo, watcher.flaggedDir, r.flagged, watcher.keepCleanDays() > 0 ? watcher.cleanDir : null);
      }
      const deep = { flagged: r.flagged, signals: r.signals, category: r.category, moments: r.moments, at: Date.now(), carriedOver: sent && sent.carriedOver || null };
      const hist = (store.get('history') || []).map((x) => ((x.shareCode || String(x.at)) !== key ? x
        : { ...x, keptDemo: kept, results: x.results.map((p) => (p.steamid === r.steamid ? { ...p, deep } : p)) }));
      store.set({ history: hist });
      send('match', hist.find((x) => (x.shareCode || String(x.at)) === key));
      return deep;
    } finally { scrutinizing.delete(job); }
  });
  h('setOverride', async (id, tier, note) => {
    const r = await api.setOverride(id, tier, note);
    if (tier === 'approved') {   // update already-scanned matches too
      const hist = (store.get('history') || []).map((h) => ({ ...h, checks: (h.checks || []).map((c) => (c.steamid === id ? { ...c, tier: 'approved', reasons: [note || 'Trusted by admin'] } : c)) }));
      store.set({ history: hist });
    }
    return r;
  });
  h('checkMatches', () => watcher.tick());
  // ---------- guided setup for friends
  h('setupStatus', async () => {
    const steamid = store.get('steamid');
    let member = null;
    if (store.get('token')) { try { member = (await api.me()).member; } catch (_) {} }
    return {
      signedIn: !!member, approved: member?.status === 'approved', memberStatus: member?.status || null,
      launch: steamid ? steamConfig.launchOptionsStatus(steamid) : { found: false, ok: false },
      steamRunning: steamConfig.isSteamRunning(),
      cs2Found: !!(store.get('cs2Dir') || steamConfig.findCs2Dir()),
      codes: { auth: !!store.get('authCode'), share: !!store.get('lastShareCode') },
    };
  });
  h('applyLaunchOptions', async () => {
    const r = steamConfig.applyLaunchOptions(store.get('steamid'));
    if (r.ok) { const d = steamConfig.findCs2Dir(); if (d) store.set({ cs2Dir: d }); startServices(); }
    return r;
  });
  h('openCs2Properties', () => shell.openExternal('steam://gameproperties/730'));
  h('openAuthPage', () => shell.openExternal('https://help.steampowered.com/en/wizard/HelpWithGameIssue/?appid=730&issueid=128'));
  h('pasteCodes', async () => {
    const text = clipboard.readText() || '';
    const share = text.match(/CSGO(-[A-Za-z0-9]{5}){5}/);
    // Whole-page copies work: prefer the first "Authentication Code: XXXX-XXXXX-XXXX" (the match-history one)
    const labeled = text.match(/Authentication Code:\s*([A-Za-z0-9]{4}-[A-Za-z0-9]{5}-[A-Za-z0-9]{4})\b/);
    const bare = text.replace(/CSGO(-[A-Za-z0-9]{5}){5}/g, '').match(/\b[A-Za-z0-9]{4}-[A-Za-z0-9]{5}-[A-Za-z0-9]{4}\b/);
    const auth = labeled ? [labeled[1]] : bare;
    const patch = {};
    if (auth) patch.authCode = auth[0].toUpperCase();
    if (share) patch.lastShareCode = share[0];
    if (Object.keys(patch).length) { store.set(patch); startServices(); }
    return { auth: !!auth, share: !!share };
  });
  h('watchDemo', (opts) => watchDemo(opts || {}));
  h('clearAllFlags', () => api.clearAllFlags());
  h('voteFlag', (id, vote) => api.voteFlag(id, vote));
  h('voteBlacklist', (id, vote) => api.voteBlacklist(id, vote));
  h('scanShareCode', (code) => watcher.scanShareCode(String(code || '').trim()));
  h('scanFile', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Choose a CS2 demo', filters: [{ name: 'CS2 demo', extensions: ['dem'] }], properties: ['openFile'] });
    if (r.canceled || !r.filePaths[0]) return null;
    return watcher.scanFile(r.filePaths[0]);
  });
  h('openProfile', (id) => shell.openExternal('https://steamcommunity.com/profiles/' + id));
  h('openExternal', (u) => { if (/^https:\/\/(help\.steampowered\.com|steamcommunity\.com)\//.test(u)) shell.openExternal(u); });
  h('copy', (t) => clipboard.writeText(String(t)));
  h('scanLobby', () => lobby.scanNow());
}

app.whenReady().then(() => {
  app.setAppUserModelId('com.ehbaah.cheaterflag');
  store = new Store(app.getPath('userData'), defaults);
  if (!store.get('workerUrl') && defaults.workerUrl) store.set({ workerUrl: defaults.workerUrl });
  api = new Api(() => store.get('workerUrl'), () => store.get('token'));
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: store.get('openAtLogin') !== false, args: ['--hidden'] });
  registerIpc();
  createTray();
  if (!process.argv.includes('--hidden')) createWindow();
  if (!store.get('gsiToken')) store.set({ gsiToken: require('crypto').randomBytes(12).toString('hex') });
  gsi = new GameState(store.get('gsiToken'));
  gsi.on('change', onGameState);
  gsi.start();
  firstRunImport();
  autoConfigure();
  setInterval(autoConfigure, 60 * 1000); // retries until Steam is closed once
  startServices();
  setTimeout(startBackfill, 20000);
  setTimeout(backfillStats, 90000);
  setTimeout(refreshSquad, 15000);
  setTimeout(syncHistoryStats, 3 * 60000);
  setInterval(syncHistoryStats, 12 * 3600000);
  setTimeout(remindReports, 30000);
  setTimeout(remindVotes, 60000);
  setupAutoUpdate();
});

app.on('second-instance', createWindow);
app.on('window-all-closed', () => { /* keep running in the tray */ });
