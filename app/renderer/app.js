'use strict';
const $ = (s) => document.querySelector(s);
const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k != null) e.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return e;
};
const log = (m) => { const l = $('#log'); l.textContent = `[${new Date().toLocaleTimeString()}] ${m}\n` + l.textContent.slice(0, 4000); };
const tierBadge = (t) => el('span', { class: 'badge ' + (t || 'unknown') }, { approved: 'Clean', limited: 'Caution', rejected: 'Flagged' }[t] || 'Unknown');
const fail = (e) => log(e.message || e);

let me = null, state = null;

let watchActive = false;
function showWatchBar(on) { if (on !== undefined) watchActive = on; const t = document.querySelector('#tabs button.active')?.dataset.tab; $('#watchBar').classList.toggle('hidden', !(watchActive && (t === 'matches' || t === 'review'))); }
function showTab(name) {
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab').forEach((s) => s.classList.toggle('hidden', s.id !== 'tab-' + name));
  setTimeout(() => showWatchBar(), 0);
  ({ setup: refreshSetup, matches: () => { refreshHistory(); refreshAuto(); }, review: loadFlags, blacklist: loadBlacklist, members: loadMembers })[name]?.();
}
document.querySelectorAll('#tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

function toSteam64(input) {
  const s = String(input).trim();
  const m = s.match(/7656119\d{10}/);
  return m ? m[0] : null;
}

// ---------- lobby
function renderLobby(l) {
  const names = l.names || [];
  const conf = (l.live && l.live.confirmed) || [];
  $('#lobbyStatus').textContent = (l.netcon ? 'Connected to CS2.' : 'Waiting for CS2… (it connects automatically when CS2 is open).')
    + (l.live ? (l.live.serverKnown ? ' Steam shows your game server, so blacklisted players are confirmed by SteamID.' : ' Steam isn\'t sharing your game server right now, so matches are by name + "playing CS2 now".') : '')
    + (conf.filter((b) => !names.some((n) => n.toLowerCase() === (b.name || '').toLowerCase())).length ? ' Also confirmed in your server: ' + conf.map((b) => b.name).join(', ') + '.' : '');
  const rows = $('#lobbyRows'); rows.replaceChildren();
  if (!names.length && !l.players.length) rows.append(el('tr', {}, el('td', { colspan: 3, class: 'muted' }, 'No match right now.')));
  for (const n of names) {
    const hit = (l.nameHits || {})[n.toLowerCase()];
    const badge = !hit ? el('span', { class: 'badge unknown' }, 'Not on blacklist')
      : hit.level === 'confirmed' ? el('span', { class: 'badge rejected' }, 'Blacklisted — confirmed by SteamID')
      : hit.level === 'likely' ? el('span', { class: 'badge rejected' }, 'Blacklisted — very likely')
      : el('span', { class: 'badge limited' }, 'Same name as a blacklisted player');
    rows.append(el('tr', {}, el('td', {}, n),
      el('td', {}, badge),
      el('td', { class: 'muted' }, hit ? `${hit.category}: ${hit.reason}` : ''),
      hit ? el('td', {}, el('button', { onclick: () => cf.openProfile(hit.steamid) }, 'Profile')) : null));
  }
  for (const id of l.players) {
    const c = l.checks[id];
    rows.append(el('tr', {}, el('td', {}, c?.name || id), el('td', {}, tierBadge(c?.tier)), el('td', { class: 'muted' }, c ? c.reasons.join(' · ') : 'checking…')));
  }
}

// ---------- newest match first (Valve match ids grow over time)
function matchIdOf(...texts) {
  for (const t of texts) { const m = String(t || '').match(/(\d{15,})_\d+/); if (m) return BigInt(m[1]); }
  return null;
}
function newestFirst(list, idOf, timeOf) {
  return [...list].sort((a, b) => {
    const ia = idOf(a), ib = idOf(b);
    if (ia != null && ib != null) return ia > ib ? -1 : ia < ib ? 1 : 0;
    return (timeOf(b) || 0) - (timeOf(a) || 0);
  });
}

// ---------- score lines instead of match codes
const prettyMap = (m) => (m || 'Match').replace(/^de_/, '').replace(/^\w/, (c) => c.toUpperCase());
function scoreFor(m, steamid) {
  const teams = m.teams || [];
  const own = teams.find((t) => t.players.includes(steamid)) || teams[0];
  const opp = teams.find((t) => t !== own);
  if (!own || !opp) return '';
  const res = own.score > opp.score ? 'Win' : own.score < opp.score ? 'Loss' : 'Draw';
  return `${own.score}–${opp.score} ${teams.some((t) => t.players.includes(steamid)) ? res : ''}`.trim();
}

// ---------- "Watch in CS2"
function watchButtons(moments, opts) {
  if (!moments || !moments.length || (!opts.demoPath && !opts.demoUrl)) return null;
  return el('div', { class: 'row watch' }, moments.slice(0, 6).map((mo) =>
    el('button', { onclick: () => {
      showWatchBar(true); $('#watchMsg').textContent = 'Opening CS2…';
      cf.watchDemo({ ...opts, tick: mo.tick }).then((r) => {
        if (r && !r.ok && r.manual) $('#watchMsg').textContent = 'Open CS2, press ~ for the console, and run these one at a time: ' + r.manual.join('  →  ');
      }).catch((e) => { $('#watchMsg').textContent = e.message; });
    } }, `▶ Round ${mo.round}: ${mo.what}`)));
}

// ---------- matches + report helper
async function refreshHistory() { try { const st = await cf.state(); state.history = st.history; } catch (_) {} renderMatches(); }
const matchOpen = new Map();
function renderMatches() {
  const list = $('#matchList'); list.replaceChildren();
  const hist = [...(state?.history || [])].sort((a, b) => {
    if (a.playedAt && b.playedAt) return b.playedAt - a.playedAt;
    const ia = matchIdOf(a.demoUrl, a.shareCode, a.keptDemo), ib = matchIdOf(b.demoUrl, b.shareCode, b.keptDemo);
    if (ia != null && ib != null) return ia > ib ? -1 : ia < ib ? 1 : 0;
    return (b.at || 0) - (a.at || 0);
  });
  if (!hist.length) list.append(el('p', { class: 'muted' }, 'No results yet — they appear here as your matches are scanned.'));
  hist.forEach((m, idx) => {
    const flagged = m.results.filter((r) => r.flagged);
    const checks = Object.fromEntries((m.checks || []).map((c) => [c.steamid, c]));
    const key = m.shareCode || String(m.at);
    const open = matchOpen.has(key) ? matchOpen.get(key) : idx === 0;   // newest match open, the rest collapsed
    const cautions = (m.checks || []).filter((c) => c.tier === 'limited').length;
    const banned = (m.checks || []).filter((c) => c.tier === 'rejected').length;
    const chips = el('span', { class: 'chips' },
      flagged.length ? el('span', { class: 'badge rejected' }, `${flagged.length} flagged`) : null,
      banned ? el('span', { class: 'badge rejected' }, `${banned} banned/blacklisted`) : null,
      cautions ? el('span', { class: 'badge limited' }, `${cautions} caution`) : null,
      !flagged.length && !banned && !cautions ? el('span', { class: 'badge approved' }, 'All clean') : null);
    const card = el('div', { class: 'card match' + (flagged.length ? ' alert' : '') + (open ? ' open' : '') });
    const body = el('div', { class: 'mbody' });
    const head = el('div', { class: 'mhead', role: 'button', tabindex: '0', onclick: () => { matchOpen.set(key, !card.classList.contains('open')); card.classList.toggle('open'); } },
      el('span', { class: 'chev' }, '›'),
      el('h3', {}, `${prettyMap(m.map)} · ${scoreFor(m, me?.steamid) || 'score unknown'}`),
      chips,
      el('span', { class: 'muted when' }, m.playedAt ? 'Played ' + new Date(m.playedAt).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'Scanned ' + new Date(m.at).toLocaleString()));
    card.append(head, body);
    if (flagged.length) {
      body.append(el('h4', {}, 'Report these players'));
      for (const r of flagged) {
        body.append(el('div', { class: 'report' },
          el('b', {}, r.name), ` — report for `, el('b', {}, r.category), ` · rounds ${r.rounds.join(', ') || '?'}`,
          el('ul', {}, r.signals.map((s) => el('li', {}, `${s.name}: ${s.value}`))),
          el('p', { class: 'muted' }, 'In CS2: Watch → Your Matches → this match → scoreboard → right-click player → Report → ' + r.category + '.'),
          watchButtons(r.moments, { demoPath: m.keptDemo, demoUrl: m.demoUrl, key: m.shareCode, steamid: r.steamid }),
          el('button', { onclick: () => cf.copy(r.name) }, 'Copy name')));
      }
    }
    // ---- two team columns: your team on the left, opponents on the right
    const playerCard = (r) => {
      const c = checks[r.steamid];
      const acctWhy = !c ? 'Account check unavailable' : c.reasons.join(' · ');
      const strict = r.scrutiny === 'high' ? 'Extra-strict check (banned/blacklisted account): ' : r.scrutiny === 'caution' ? 'Stricter check (Caution account): ' : '';
      const scanWhy = strict + (r.flagged ? r.signals.map((x) => `${x.name}: ${x.value}`).join(' · ')
        : r.signals.length ? 'Below flag threshold: ' + r.signals.map((x) => `${x.name}: ${x.value}`).join(' · ')
        : 'Nothing suspicious found');
      const acct = tierBadge(c?.tier); acct.title = 'Account: ' + acctWhy; acct.classList.add('mini');
      const game = r.flagged ? el('span', { class: 'badge rejected mini' }, r.category)
        : r.signals.length ? el('span', { class: 'badge limited mini' }, 'Weak signals') : el('span', { class: 'badge approved mini' }, 'Clean');
      game.title = 'Gameplay: ' + scanWhy;
      const worst = r.flagged || (c && c.tier === 'rejected') ? 'bad' : (r.signals.length || (c && c.tier === 'limited')) ? 'warn' : 'ok';
      // one line for clean players; a short reason line only when something isn't clean
      const notes = [];
      if (c && c.tier !== 'approved') notes.push(acctWhy);
      if (r.flagged || r.signals.length) notes.push(scanWhy);
      return el('div', { class: 'pline ' + worst + (r.steamid === me?.steamid ? ' me' : '') },
        el('div', { class: 'pmain' },
          el('a', { href: '#', class: 'pname', title: 'Open Steam profile', onclick: (ev) => { ev.preventDefault(); cf.openProfile(r.steamid); } }, r.name),
          r.steamid === me?.steamid ? el('span', { class: 'you' }, 'you') : null,
          el('span', { class: 'pbadges' }, el('span', { class: 'plabel' }, 'Acct'), acct, el('span', { class: 'plabel' }, 'Play'), game),
          el('span', { class: 'pk' }, el('b', {}, r.kills), ' K')),
        el('div', { class: 'pnote' + (notes.length ? '' : ' clean'), title: notes.length ? notes.join(' · ') : acctWhy },
          el('span', { class: 'ptext' }, notes.length ? notes.join(' · ') : acctWhy),
          me?.role === 'admin' && c && c.tier !== 'approved' && r.steamid !== me.steamid
            ? el('button', { class: 'small', title: 'Mark this player as trusted (e.g. a friend)', onclick: (ev) => {
                ev.target.disabled = true;
                cf.setOverride(r.steamid, 'approved', 'Trusted by admin').then(() => { c.tier = 'approved'; c.reasons = ['Trusted by admin']; renderMatches(); log(`${r.name} is now trusted.`); }).catch(fail);
              } }, 'Trust') : null));
    };
    const teams = m.teams || [];
    const ownT = teams.find((t) => t.players.includes(me?.steamid)) || teams[0];
    const oppT = teams.find((t) => t !== ownT);
    const byTeam = (t) => (t ? m.results.filter((r) => t.players.includes(r.steamid)) : []).sort((a, b) => b.kills - a.kills);
    const own = byTeam(ownT), opp = byTeam(oppT);
    const rest = m.results.filter((r) => !own.includes(r) && !opp.includes(r));
    const column = (title, score, rows, cls) => el('div', { class: 'teamcol ' + cls },
      el('div', { class: 'teamhead' }, el('span', {}, title), score != null ? el('span', { class: 'teamscore' }, score) : null),
      rows.map(playerCard));
    if (own.length || opp.length) {
      // one grid, rows paired side by side, so both teams line up row for row at equal height
      const mineSide = ownT && ownT.players.includes(me?.steamid);
      const head = (title, score, cls) => el('div', { class: 'teamhead ' + cls }, el('span', {}, title), score != null ? el('span', { class: 'teamscore' }, score) : null);
      const grid = el('div', { class: 'teams paired' },
        head(mineSide ? 'Your team' : 'Team A', ownT ? ownT.score : null, 'mine'),
        head(mineSide ? 'Opponents' : 'Team B', oppT ? oppT.score : null, 'theirs'));
      for (let i = 0; i < Math.max(own.length, opp.length); i++) {
        grid.append(own[i] ? playerCard(own[i]) : el('div', { class: 'pline empty' }), opp[i] ? playerCard(opp[i]) : el('div', { class: 'pline empty' }));
      }
      body.append(grid);
      if (rest.length) body.append(column('Other players', null, rest, 'rest'));
    } else {
      body.append(el('div', { class: 'teams single' }, column('Players', null, [...m.results].sort((a, b) => b.kills - a.kills), 'mine')));
    }
    list.append(card);
  });
  const withFlag = hist.filter((m) => m.results.some((r) => r.flagged) || (m.checks || []).some((c) => c.tier === 'rejected')).length;
  $('#stats').textContent = hist.length ? `${hist.length} matches scanned · ${withFlag} had a flagged or banned player (${Math.round((withFlag / hist.length) * 100)}%).` : 'No data yet.';
}

// ---------- review queue
async function loadFlags() {
  const box = $('#flagList'); box.replaceChildren(el('p', { class: 'muted' }, 'Loading…'));
  try {
    const flags = newestFirst((await cf.flags('pending')).flags, (f) => matchIdOf(f.extra && f.extra.demoUrl, f.share_code), (f) => f.created_at);
    box.replaceChildren();
    if (flags.length && me?.role === 'admin') box.append(el('div', { class: 'row' }, el('button', { onclick: () => {
      if (confirm('Clear all ' + flags.length + ' pending flags? (Use this after a scanner update.)')) cf.clearAllFlags().then(loadFlags).catch(fail);
    } }, `Clear all ${flags.length}`)));
    if (!flags.length) box.append(el('p', { class: 'muted' }, 'Nothing to review.'));
    for (const f of flags) {
      box.append(el('div', { class: 'card alert' },
        el('div', { class: 'row between' }, el('h3', {}, `${f.name} — ${f.category}`), el('span', { class: 'muted' }, `suspicion ${f.score}`)),
        el('p', {}, `${prettyMap(f.map)}${f.extra && f.extra.score ? ` · ${f.extra.score.own}–${f.extra.score.opp} (their team ${f.extra.score.own > f.extra.score.opp ? 'won' : f.extra.score.own < f.extra.score.opp ? 'lost' : 'drew'})` : ''} · rounds to watch: ${(f.rounds || []).join(', ') || '?'}`),
        el('ul', {}, (f.signals || []).map((s) => el('li', {}, `${s.name}: ${s.value}`))),
        el('p', { class: 'muted' }, `Flagged by ${f.reporter_name || f.reporter}`),
        watchButtons(f.extra && f.extra.moments, { demoUrl: f.extra && f.extra.demoUrl, key: f.share_code, steamid: f.steamid }),
        el('p', { class: 'muted' }, `Votes: ${f.cheater_votes} cheater · ${f.clean_votes} not cheating — decided early if 5+ vote and 2/3 agree, otherwise the majority decides on day 4.${f.my_vote ? ' You voted: ' + (f.my_vote === 'cheater' ? 'cheater' : 'not cheating') + '.' : ''}`),
        el('div', { class: 'row' },
          el('button', { class: 'danger' + (f.my_vote === 'cheater' ? ' picked' : ''), onclick: () => cf.voteFlag(f.id, 'cheater').then(voted).catch(fail) }, 'Vote: cheater'),
          el('button', { class: f.my_vote === 'clean' ? 'picked' : '', onclick: () => cf.voteFlag(f.id, 'clean').then(voted).catch(fail) }, 'Vote: not cheating'),
          el('button', { onclick: () => cf.openProfile(f.steamid) }, 'Profile'),
          me?.role === 'admin' ? el('span', { class: 'muted' }, ' Admin:') : null,
          me?.role === 'admin' ? el('button', { onclick: () => cf.reviewFlag(f.id, 'confirm').then(loadFlags).catch(fail) }, 'Blacklist now') : null,
          me?.role === 'admin' ? el('button', { onclick: () => cf.reviewFlag(f.id, 'clear').then(loadFlags).catch(fail) }, 'Clear now') : null)));
    }
  } catch (e) { box.replaceChildren(el('p', { class: 'muted' }, e.message)); }
}

function voted(r) { if (r && r.outcome) log(r.outcome === 'confirmed' ? 'Vote decided: added to the blacklist.' : r.outcome === 'removed' ? 'Vote decided: removed from the blacklist.' : 'Vote decided: cleared.'); loadFlags(); }

// ---------- blacklist
async function loadBlacklist() {
  const rows = $('#blRows'); rows.replaceChildren();
  try {
    const { entries } = await cf.blacklist();
    for (const b of entries) {
      const vote = (v) => cf.voteBlacklist(b.steamid, v).then((r) => { if (r && r.outcome) log('Vote decided: removed from the blacklist.'); loadBlacklist(); }).catch(fail);
      rows.append(el('tr', {}, el('td', {}, b.name || b.steamid), el('td', {}, b.category), el('td', { class: 'muted' }, b.reason), el('td', {}, b.added_by_name || b.added_by || 'members vote'),
        el('td', {}, el('div', { class: 'muted' }, `${b.keep_votes} keep · ${b.remove_votes} remove`),
          el('div', { class: 'row' },
            el('button', { class: b.my_vote === 'keep' ? 'picked' : '', onclick: () => vote('keep') }, 'Keep'),
            el('button', { class: b.my_vote === 'remove' ? 'picked' : '', onclick: () => vote('remove') }, 'Remove'))),
        el('td', {}, el('div', { class: 'row' },
          el('button', { title: 'Opens their Steam profile — use ··· → Report Player there, once', onclick: () => cf.openProfile(b.steamid) }, 'Report on Steam'),
          me?.role === 'admin' ? el('button', { class: 'danger', onclick: () => cf.removeBlacklist(b.steamid).then(loadBlacklist).catch(fail) }, 'Delete') : null))));
    }
  } catch (e) { fail(e); }
}
$('#blForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const steamid = toSteam64($('#blId').value);
  if (!steamid) return log('Enter a SteamID64 (17 digits starting 7656119) or a /profiles/ URL.');
  cf.addBlacklist({ steamid, category: $('#blCat').value, reason: $('#blReason').value }).then((r) => { e.target.reset(); if (r && r.queued) log('Sent to the Review tab for members to vote on.'); loadBlacklist(); }).catch(fail);
});

// ---------- members (admin)
async function loadMembers() {
  const rows = $('#memberRows'); rows.replaceChildren();
  try {
    const { members } = await cf.members();
    for (const m of members) {
      const act = (patch) => cf.setMember(m.steamid, patch).then(loadMembers).catch(fail);
      rows.append(el('tr', {}, el('td', {}, m.name || m.steamid), el('td', {}, m.status), el('td', {}, m.role),
        el('td', { class: 'row' },
          m.status !== 'approved' ? el('button', { class: 'primary', onclick: () => act({ status: 'approved' }) }, 'Approve') : null,
          m.status !== 'suspended' && m.role !== 'admin' ? el('button', { class: 'danger', onclick: () => act({ status: 'suspended' }) }, 'Suspend') : null,
          el('button', { onclick: () => cf.openProfile(m.steamid) }, 'Profile'))));
    }
  } catch (e) { fail(e); }
}
$('#ovForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const id = toSteam64($('#ovId').value);
  if (!id) return log('Enter a valid SteamID64.');
  cf.setOverride(id, $('#ovTier').value, $('#ovNote').value).then(() => { e.target.reset(); log('Override saved.'); }).catch(fail);
});

// ---------- settings + sign-in
$('#btnSignOut').addEventListener('click', () => cf.signOut().then(init));
$('#pLogin').addEventListener('change', (e) => cf.setPrefs({ openAtLogin: e.target.checked }));
$('#pNotify').addEventListener('change', (e) => cf.setPrefs({ notifications: e.target.checked }));
$('#pKeep').addEventListener('change', (e) => cf.setPrefs({ keepCleanDays: Number(e.target.value) }).then(refreshDemoUse));
$('#btnOpenDemos').addEventListener('click', () => cf.openDemos());
function refreshDemoUse() { cf.demoUsage().then((u) => { $('#demoUse').textContent = `${u.count} demo${u.count === 1 ? '' : 's'} stored · ${(u.bytes / 1073741824).toFixed(1)} GB`; }).catch(() => {}); }
$('#btnReconnect').addEventListener('click', () => { $('#steamWho').textContent = 'Reconnecting… if a Steam window opens, sign in there.'; cf.connectMatchHistory().then(init).catch((e) => { $('#steamWho').textContent = e.message; }); });
async function refreshAuto() {
  try {
    const a = await cf.autoStatus();
    const parts = [];
    parts.push(a.connected ? 'Each match is scanned as soon as it ends and Steam has the demo' + (a.lastCheck ? ` (last check ${new Date(a.lastCheck).toLocaleTimeString()})` : '') + '.' : 'Finish Setup step 3 to check your matches automatically.');
    if (a.backfill && !a.backfill.finished) parts.push(`Scanning your older matches: ${a.backfill.current} of ${a.backfill.total}.`);
    $('#autoStatus').textContent = parts.join(' ');
  } catch (_) {}
}
setInterval(refreshAuto, 10000);
// ---------- guided setup
const tick = (id, state) => { $(id).className = 'tick' + (state ? ' ' + state : ''); };
async function refreshSetup() {
  const st = await cf.setupStatus();
  const c0 = st.codes;
  // 1
  tick('#t1', st.approved ? 'ok' : st.signedIn ? 'wait' : '');
  $('#step1').classList.toggle('complete', st.signedIn);
  $('#s1text').textContent = st.approved ? 'Signed in and approved.' :
    st.memberStatus === 'pending' ? 'Signed in. Setting up your membership…' :
    st.memberStatus === 'suspended' ? 'Your access is suspended. Contact cfab.' : "A Steam window opens — sign in there. You type your password on Steam's own page; CheaterFlag never sees it.";
  // 2
  tick('#t2', st.launch.ok ? 'ok' : '');
  $('#step2').classList.toggle('complete', st.launch.ok);
  $('#step3').classList.toggle('complete', c0.auth && c0.share);
  $('#s2text').textContent = st.launch.ok ? 'On. Restart CS2 if it was open.' :
    !st.signedIn ? 'Do step 1 first.' :
    st.steamRunning ? 'Close Steam first: in Steam click the Steam menu (top-left) → Exit. Then press "Turn it on".' :
    'Steam is closed — press "Turn it on".';
  const lb = $('#btnLaunch');
  lb.disabled = st.launch.ok || !st.signedIn || st.steamRunning;
  lb.textContent = st.launch.ok ? '✓ Turned on' : st.steamRunning && st.signedIn ? 'Waiting for Steam to close…' : 'Turn it on';
  // 3
  const c = st.codes;
  tick('#t3', c.auth && c.share ? 'ok' : (c.auth || c.share) ? 'wait' : '');
  $('#s3text').textContent = c.auth && c.share ? 'On. New matches are scanned automatically.' :
    c.auth ? 'Connected. Steam will show your match token after your next match — scanning starts then.' :
    !st.signedIn ? 'Do step 1 first.' : '';
  const done = st.approved && st.launch.ok && c.auth && c.share;
  $('#allDone').classList.toggle('hidden', !done);
  return done;
}
$('#btnSignIn').addEventListener('click', () => {
  $('#s1text').textContent = 'Sign in in the Steam window that just opened…';
  cf.signIn().then(init).catch((e) => { $('#s1text').textContent = e.message; });
});
$('#btnLaunch').addEventListener('click', () => cf.applyLaunchOptions().then((r) => {
  if (!r.ok) $('#s2text').textContent = r.reason === 'steam-running'
    ? 'Steam is still open. Click the Steam menu (top-left) → Exit, wait a few seconds, then press "Turn it on" again.'
    : 'Could not find your Steam settings. Use "Do it myself instead" below.';
  else refreshSetup();
}).catch(fail));
$('#btnCopyFlags').addEventListener('click', () => cf.copy('-condebug -netconport 2121'));
$('#btnOpenProps').addEventListener('click', () => cf.openCs2Properties());
$('#btnAuthPage').addEventListener('click', () => cf.openAuthPage());
$('#btnConnect').addEventListener('click', () => {
  $('#connectMsg').textContent = 'Working… if a Steam window opens, sign in there.';
  cf.connectMatchHistory().then(() => refreshSetup()).catch((e) => { $('#connectMsg').textContent = e.message; });
});
cf.on('steamSetup', (m) => { $('#connectMsg').textContent = m.msg; if (m.step === 'done') refreshSetup(); });
$('#btnPaste').addEventListener('click', () => cf.pasteCodes().then((r) => {
  $('#pasteMsg').textContent = r.auth && r.share ? '✓ Got both codes!' : r.auth ? 'Got 1 of 2 codes — see below.' : r.share ? 'Got 1 of 2 codes — see below.' : "No codes found. Open the Steam page, press Ctrl+A then Ctrl+C, and try again.";
  refreshSetup(); init();
}).catch(fail));
setInterval(() => { if (!$('#tab-setup').classList.contains('hidden')) refreshSetup().catch(() => {}); }, 5000);

cf.on('lobby', (l) => { if (state) state.lobby = l; renderLobby(l); });
cf.on('progress', (p) => { $('#progress').textContent = `${p.shareCode}: ${p.step}…`; });
cf.on('match', () => refreshHistory());
cf.on('log', log);
cf.on('goto', (t) => showTab(t));
cf.on('update', (t) => { $('#updStatus').textContent = '· ' + t; });
$('#btnCheckUpd').addEventListener('click', () => { $('#updStatus').textContent = '· Checking…'; cf.checkUpdates().then((r) => { if (r !== true) $('#updStatus').textContent = '· ' + r; }).catch(fail); });
cf.updateStatus().then((t) => { if (t) $('#updStatus').textContent = '· ' + t; }).catch(() => {});
cf.on('watch', (m) => { showWatchBar(true); $('#watchMsg').textContent = m; });
cf.on('backfill', (b) => { $('#progress').textContent = b.finished ? 'Older matches: all scanned.' : `Scanning your older matches: ${b.current} of ${b.total}… (runs in the background)`; });

async function init() {
  state = await cf.state();
  const s = state.settings;
  $('#version').textContent = 'Version ' + state.version;
  renderLobby(state.lobby);
  me = null;
  if (state.signedIn) { try { me = (await cf.me()).member; } catch (e) { log(e.message); } }
  document.querySelectorAll('.admin-only').forEach((x) => x.classList.toggle('hidden', me?.role !== 'admin'));
  $('#who').textContent = me ? `${me.name || me.steamid} · ${me.role}` : 'Not signed in';
  const done = await refreshSetup().catch(() => false);
  const pr = await cf.prefs(); $('#pLogin').checked = pr.openAtLogin; $('#pNotify').checked = pr.notifications;
  $('#pKeep').value = String(pr.keepCleanDays); refreshDemoUse();
  $('#steamWho').textContent = me ? `Signed in as ${me.name || me.steamid}.` : 'Not signed in.';
  showTab(done ? 'matches' : 'setup');
}
init().catch(fail);
