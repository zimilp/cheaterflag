'use strict';
// Built-in Steam window. Friends sign in to Steam once (on Steam's own pages, inside this
// window); the app then reads, on their behalf:
//   - the Steam sign-in (OpenID) for CheaterFlag,
//   - their match-history Authentication Code + latest match token (creating the code if needed),
//   - download links of their older matches still kept by Valve.
// The Steam session is stored only in this app's own browser profile ("persist:steam").
const { app, BrowserWindow, session } = require('electron');

const PARTITION = 'persist:steam';
const AUTH_PAGE = 'https://help.steampowered.com/en/wizard/HelpWithGameIssue/?appid=730&issueid=128';
const CALLBACK = 'http://127.0.0.1:1/cheaterflag-callback';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let win = null;
function steamWin(parent) {
  if (win && !win.isDestroyed()) return win;
  win = new BrowserWindow({
    width: 980, height: 760, show: false, parent, title: 'Sign in to Steam — CheaterFlag',
    autoHideMenuBar: true, backgroundColor: '#1b2838',
    webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.webContents.setWindowOpenHandler(({ url }) => { win.loadURL(url); return { action: 'deny' }; });
  win.on('close', (e) => { if (!win.allowClose && !app.isQuitting) { e.preventDefault(); win.hide(); win.emit('user-closed'); } });
  return win;
}

function load(w, url) {
  return new Promise((resolve) => {
    const done = () => { w.webContents.off('did-finish-load', done); w.webContents.off('did-fail-load', done); resolve(); };
    w.webContents.on('did-finish-load', done); w.webContents.on('did-fail-load', done);
    w.loadURL(url);
  });
}

const js = (w, code) => w.webContents.executeJavaScript(code, true);

/** Waits until `check()` is true, showing the window so the person can sign in. Rejects if they close it. */
async function waitForUser(w, check, { timeoutMs = 10 * 60 * 1000, title } = {}) {
  if (await check().catch(() => false)) return;
  if (title) w.setTitle(title);
  w.show(); w.focus();
  let closed = false; const onClose = () => { closed = true; };
  w.once('user-closed', onClose);
  const end = Date.now() + timeoutMs;
  try {
    while (Date.now() < end) {
      if (closed) throw new Error('The Steam window was closed before signing in.');
      if (await check().catch(() => false)) return;
      await sleep(1000);
    }
    throw new Error('Steam sign-in timed out.');
  } finally { w.off('user-closed', onClose); w.hide(); }
}

/** 1) "Sign in through Steam" — returns the OpenID response for the CheaterFlag service to verify. */
function openIdSignIn(parent) {
  const w = steamWin(parent);
  return new Promise((resolve, reject) => {
    const q = new URLSearchParams({
      'openid.ns': 'http://specs.openid.net/auth/2.0', 'openid.mode': 'checkid_setup',
      'openid.return_to': CALLBACK, 'openid.realm': 'http://127.0.0.1:1',
      'openid.identity': 'http://specs.openid.net/auth/2.0/identifier_select',
      'openid.claimed_id': 'http://specs.openid.net/auth/2.0/identifier_select',
    });
    const catchCallback = (e, url) => {
      if (!url.startsWith(CALLBACK)) return;
      e.preventDefault(); cleanup(); w.hide();
      const params = Object.fromEntries(new URL(url).searchParams.entries());
      params['openid.mode'] === 'id_res' ? resolve(params) : reject(new Error('Steam sign-in was cancelled.'));
    };
    const onClosed = () => { cleanup(); reject(new Error('The Steam window was closed before signing in.')); };
    const cleanup = () => {
      w.webContents.off('will-redirect', catchCallback); w.webContents.off('will-navigate', catchCallback); w.off('user-closed', onClosed);
    };
    w.webContents.on('will-redirect', catchCallback); w.webContents.on('will-navigate', catchCallback);
    w.once('user-closed', onClosed);
    w.setTitle('Sign in to Steam — CheaterFlag');
    w.loadURL('https://steamcommunity.com/openid/login?' + q.toString());
    w.show(); w.focus();
  });
}

const PAGE_TEXT = `document.body ? document.body.innerText : ''`;
const SIGNED_IN_HELP = `!!document.body && /Access to Your Match History/.test(document.body.innerText)`;

/** 2) Reads the match-history Authentication Code and latest match token, creating the code if needed. */
async function getMatchCodes(parent) {
  const w = steamWin(parent);
  await load(w, AUTH_PAGE);
  await waitForUser(w, async () => {
    const u = w.webContents.getURL();
    if (/issueid=128/.test(u)) return js(w, SIGNED_IN_HELP);
    if (/help\.steampowered\.com/.test(u) && !/login/i.test(u)) await load(w, AUTH_PAGE); // back to the right page after signing in
    return false;
  }, { title: 'Sign in to Steam to turn on after-game scanning — CheaterFlag' });

  let text = await js(w, PAGE_TEXT);
  if (!/Authentication Code:\s*[A-Za-z0-9]{4}-/.test(text)) {
    // Click "Create Authentication Code" in the "Access to Your Match History" section only
    const clicked = await js(w, `(() => {
      const all = [...document.querySelectorAll('a, button, .btn_medium, [onclick]')];
      const head = [...document.querySelectorAll('*')].find(e => e.children.length === 0 && /Access to Your Match History/.test(e.textContent));
      const btn = all.find(b => /Create Authentication Code/i.test(b.textContent) && head && (head.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING));
      if (!btn) return false; btn.click(); return true; })()`);
    if (clicked) {
      for (let i = 0; i < 20; i++) {
        await sleep(1000);
        text = await js(w, PAGE_TEXT).catch(() => '');
        if (/Authentication Code:\s*[A-Za-z0-9]{4}-/.test(text)) break;
      }
    }
  }
  const auth = (text.match(/Authentication Code:\s*([A-Za-z0-9]{4}-[A-Za-z0-9]{5}-[A-Za-z0-9]{4})\b/) || [])[1] || null;
  const share = (text.match(/CSGO(-[A-Za-z0-9]{5}){5}/) || [])[0] || null;
  return { authCode: auth, shareCode: share };
}

/** 3) Collects download links for older Premier/Competitive matches that Valve still keeps. */
async function getOlderMatchLinks(parent, steamid) {
  const w = steamWin(parent);
  const urls = new Set();
  for (const tab of ['matchhistorypremier', 'matchhistorycompetitive']) {
    const page = `https://steamcommunity.com/profiles/${steamid}/gcpd/730?tab=${tab}`;
    await load(w, page);
    await waitForUser(w, async () => {
      const u = w.webContents.getURL();
      if (/\/gcpd\/730/.test(u)) return js(w, `!!document.querySelector('#personaldata_elements_container, .generic_kv_table, #load_more_clickable')`);
      if (!/login|openid/i.test(u)) await load(w, page); // landed somewhere else after signing in
      return false;
    }, { title: 'Sign in to Steam to scan your older matches — CheaterFlag' });
    const links = await js(w, `(async () => {
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      const count = () => document.querySelectorAll('a[href*=".dem"]').length;
      let stale = 0, last = count();
      for (let i = 0; i < 40 && stale < 3; i++) {
        const b = document.querySelector('#load_more_clickable');
        if (!b || b.offsetParent === null) break;
        b.click(); await sleep(2500);
        const c = count(); stale = c === last ? stale + 1 : 0; last = c;
      }
      return [...document.querySelectorAll('a[href*=".dem"]')].map(a => a.href);
    })()`);
    for (const l of links) if (/^https?:\/\/replay\d+\.valve\.net\/730\/\d+_\d+\.dem(\.bz2)?$/.test(l)) urls.add(l);
  }
  return [...urls].reverse(); // oldest first
}

/**
 * 4) Scoreboards of past Premier/Competitive matches from Steam's match history page (years back,
 * no demos needed): map, date, final score and each player's K / A / D / MVPs / HS% / score.
 * Never asks to sign in: returns [] if the Steam window isn't signed in. Stops at `untilMs`.
 */
async function getMatchHistoryStats(parent, steamid, { untilMs = 0, maxPages = 150 } = {}) {
  const w = steamWin(parent);
  const out = [];
  for (const tab of ['matchhistorypremier', 'matchhistorycompetitive']) {
    await load(w, `https://steamcommunity.com/profiles/${steamid}/gcpd/730?tab=${tab}`);
    const ok = await js(w, `!!document.querySelector('table.csgo_scoreboard_root, #personaldata_elements_container')`).catch(() => false);
    if (!ok) continue;                         // not signed in (or Steam is down): try again another time
    const rows = await js(w, `(async () => {
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      const dateOf = (t) => { const m = t.match(/(\\d{4}-\\d\\d-\\d\\d) (\\d\\d:\\d\\d:\\d\\d) GMT/); return m ? Date.parse(m[1] + 'T' + m[2] + 'Z') : null; };
      const oldest = () => { const ds = [...document.querySelectorAll('.csgo_scoreboard_inner_left')].map(e => dateOf(e.textContent)).filter(Boolean); return ds.length ? Math.min(...ds) : Infinity; };
      let stale = 0, last = 0;
      for (let i = 0; i < ${Number(maxPages) || 150} && stale < 3 && oldest() > ${Number(untilMs) || 0}; i++) {
        const b = document.querySelector('#load_more_clickable');
        if (!b || b.offsetParent === null) break;
        b.click(); await sleep(2000);
        const c = document.querySelectorAll('.csgo_scoreboard_inner_left').length; stale = c === last ? stale + 1 : 0; last = c;
      }
      const res = [];
      for (const left of document.querySelectorAll('.csgo_scoreboard_inner_left')) {
        const row = left.closest('tr'); const right = row && row.querySelector('.csgo_scoreboard_inner_right');
        if (!right) continue;
        const cells = [...left.querySelectorAll('td')].map(td => td.textContent.trim());
        const playedAt = dateOf(left.textContent);
        if (!playedAt) continue;
        const link = (left.querySelector('a[href*=".dem"]') || {}).href || null;
        let head = null, team = 0, score = null; const players = [];
        for (const tr of right.querySelectorAll('tr')) {
          const sc = tr.querySelector('.csgo_scoreboard_score');
          if (sc) { score = sc.textContent.replace(/\\s/g, ''); team = 1; continue; }
          const ths = [...tr.querySelectorAll('th')];
          if (ths.length) { head = ths.map(t => t.textContent.trim()); continue; }
          const a = tr.querySelector('a.linkTitle[data-miniprofile]');
          if (!a || !head) continue;
          const td = [...tr.children].map(t => t.textContent.trim());
          const col = (name) => { const i = head.findIndex(h => h === name); return i >= 0 ? td[i] : ''; };
          const mvp = col('★'); 
          players.push({ account: a.dataset.miniprofile, name: a.textContent.trim(), team,
            k: +col('K') || 0, a: +col('A') || 0, d: +col('D') || 0, mvp: mvp ? (parseInt(mvp.replace(/\\D/g, ''), 10) || 1) : 0,
            hsp: parseInt(col('HSP'), 10) || 0, score: +col('Score') || 0 });
        }
        res.push({ map: cells[0] || '', playedAt, link, score, players });
      }
      return res;
    })()`).catch(() => []);
    out.push(...rows.map((r) => ({ ...r, mode: tab.includes('premier') ? 'premier' : 'competitive' })));
  }
  return out;
}

function signOutOfSteamWindow() { return session.fromPartition(PARTITION).clearStorageData(); }
function destroy() { if (win && !win.isDestroyed()) { win.allowClose = true; win.close(); } win = null; }

module.exports = { getMatchHistoryStats, openIdSignIn, getMatchCodes, getOlderMatchLinks, signOutOfSteamWindow, destroy };
