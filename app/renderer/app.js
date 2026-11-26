'use strict';
const $ = (s) => document.querySelector(s);
const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
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
  ({ setup: refreshSetup, matches: () => { refreshHistory(); refreshAuto(); }, review: loadFlags, blacklist: loadBlacklist, members: loadMembers, stats: loadStats })[name]?.();
}
document.querySelectorAll('#tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

function toSteam64(input) {
  const s = String(input).trim();
  const m = s.match(/7656119\d{10}/);
  return m ? m[0] : null;
}

// ---------- lobby
// ---------- squad plan (members you're queued / playing with)
const HOW = { you: 'you', party: 'in your party', server: 'in this match', name: 'name in this lobby' };
function renderSquad(l) {
  const card = $('#squadCard');
  const squad = l.squad || [];
  if (!squad.length) { card.classList.add('hidden'); return; }
  card.classList.remove('hidden');
  const mapName = (l.map || '').replace(/^(de|cs)_/, '');
  const pretty = mapName ? mapName[0].toUpperCase() + mapName.slice(1) : '';
  // use stats on this map when there's enough of it, otherwise all maps
  const rows = squad.map((p) => {
    const onMap = p.onMap && p.onMap.demo && (p.onMap.demo.rounds || 0) >= Roles.MIN_ROUNDS ? p.onMap.demo : null;
    return { steamid: p.steamid, name: p.name, how: p.how, demo: onMap || p.demo || {}, mapBased: !!onMap };
  });
  const plan = Roles.squadPlan(rows);
  $('#squadTitle').textContent = pretty ? `Squad plan · ${pretty}` : 'Squad plan';
  $('#squadNote').textContent = 'Roles from each player’s own demo stats' + (pretty ? ` (on ${pretty} when they have 20+ rounds there)` : '') + ' — hover a role for the numbers.';
  const fitText = (s, role) => {
    if (!s || !s.enough) return 'Not enough demo data yet';
    const pctOf = (v, ref) => Math.round(v * ref * 100) + '%';
    return ({ awp: `${pctOf(s.awp, 0.3)} of kills with the AWP`, entry: `takes the first fight in ${pctOf(s.entry, 0.2)} of rounds`,
      lurk: `away from the team in ${pctOf(s.lurk, 0.35)} of T rounds`, support: `utility score ${(s.support * 0.6).toFixed(2)} per round`,
      anchorA: `holds A in ${pctOf(s.anchorA, 0.5)} of CT rounds`, anchorB: `holds B in ${pctOf(s.anchorB, 0.5)} of CT rounds`,
      rotator: `plays between sites in ${pctOf(s.rotator, 0.5)} of CT rounds`, rifler: 'no stand-out T role — plays as a rifler' })[role] || '';
  };
  const tag = (role, s) => (role ? el('span', { class: 'role role-' + role, title: fitText(s, role) }, Roles.LABEL[role]) : el('span', { class: 'muted' }, '—'));
  $('#squadTable').replaceChildren(el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, 'Player'), el('th', {}, 'T side'), el('th', {}, 'CT side'))),
    el('tbody', {}, rows.map((r) => {
      const p = plan.get(r.steamid);
      return el('tr', { class: r.how === 'you' ? 'me' : '' },
        el('td', {}, r.name, el('div', { class: 'muted small' }, HOW[r.how] + (r.mapBased ? ` · ${pretty} stats` : ' · all maps'))),
        el('td', {}, tag(p.t, p.fit)), el('td', {}, tag(p.ct, p.fit)));
    }))));
  // map: bombsites and each player's own usual CT spot for their role (from their demos on this map)
  const box = $('#squadMap');
  const mapRows = squad.map((p) => (p.onMap && p.onMap.demo) || null).filter(Boolean);
  const sites = Roles.siteCentres(mapRows);
  const dots = rows.map((r) => { const p = plan.get(r.steamid); const d = (squad.find((x) => x.steamid === r.steamid).onMap || {}).demo; const at = d && Roles.holdSpot(d, p.ct); return at && p.ct ? { ...at, name: r.name, role: p.ct } : null; }).filter(Boolean);
  if (!pretty || (!sites.A && !sites.B) || !dots.length) {
    box.replaceChildren(el('p', { class: 'muted small' }, pretty ? `The map plan appears once your squad has demos on ${pretty}.` : 'The map plan appears when the match loads.'));
    return;
  }
  const pts = [...dots, ...[sites.A, sites.B].filter(Boolean)];
  const minX = Math.min(...pts.map((p) => p.x)) - 600, maxX = Math.max(...pts.map((p) => p.x)) + 600;
  const minY = Math.min(...pts.map((p) => p.y)) - 600, maxY = Math.max(...pts.map((p) => p.y)) + 600;
  const W = 360, H = Math.round(W * (maxY - minY) / Math.max(1, maxX - minX)) || 260;
  const sx = (x) => ((x - minX) / (maxX - minX)) * W, sy = (y) => H - ((y - minY) / (maxY - minY)) * H;   // game Y points up
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${Math.min(Math.max(H, 180), 420)}`); svg.setAttribute('class', 'squadsvg');
  const add = (tag, attrs, text) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); if (text) e.textContent = text; svg.append(e); return e; };
  for (const [k, c] of Object.entries(sites)) if (c) { add('circle', { cx: sx(c.x), cy: sy(c.y), r: 34, class: 'site' }); add('text', { x: sx(c.x), y: sy(c.y) + 8, class: 'sitelabel' }, k); }
  for (const d of dots) {
    add('circle', { cx: sx(d.x), cy: sy(d.y), r: 7, class: 'dot role-' + d.role });
    const right = sx(d.x) > W * 0.55;
    add('text', { x: sx(d.x) + (right ? -10 : 10), y: sy(d.y) + 4, class: 'dotlabel', 'text-anchor': right ? 'end' : 'start' }, `${d.name} · ${Roles.LABEL[d.role]}`);
  }
  box.replaceChildren(svg, el('p', { class: 'muted small' }, `CT setup on ${pretty}: where each player usually stands 20 s into a CT round, from their own demos. Sites from the same demos.`));
}

function renderLobby(l) {
  const names = l.names || [];
  const conf = (l.live && l.live.confirmed) || [];
  $('#lobbyStatus').textContent = (l.netcon ? 'Connected to CS2.' : names.length ? "Reading players from CS2's console log." : 'Waiting for CS2… (players appear as soon as a match loads).')
    + (l.lastStatus ? ` Last player list: ${new Date(l.lastStatus.at).toLocaleTimeString()} (${l.lastStatus.count} player${l.lastStatus.count === 1 ? '' : 's'}).` : '')
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
      const game = r.flagged || r.deep?.flagged ? el('span', { class: 'badge rejected mini' }, r.flagged ? r.category : r.deep.category)
        : r.signals.length ? el('span', { class: 'badge limited mini' }, 'Weak signals') : el('span', { class: 'badge approved mini' }, 'Clean');
      game.title = 'Gameplay: ' + scanWhy;
      const deep = r.deep;
      const worst = r.flagged || (deep && deep.flagged) || (c && c.tier === 'rejected') ? 'bad' : (r.signals.length || (c && c.tier === 'limited')) ? 'warn' : 'ok';
      // one line for clean players; a short reason line only when something isn't clean
      const notes = [];
      if (c && c.tier !== 'approved') notes.push(acctWhy);
      if (r.flagged || r.signals.length) notes.push(scanWhy);
      if (deep && deep.flagged) notes.push('Scrutinized: ' + deep.signals.map((x) => `${x.name}: ${x.value}`).join(' · '));
      return el('div', { class: 'pline ' + worst + (r.steamid === me?.steamid ? ' me' : '') },
        el('div', { class: 'pmain' },
          el('a', { href: '#', class: 'pname', title: 'Open Steam profile', onclick: (ev) => { ev.preventDefault(); cf.openProfile(r.steamid); } }, r.name),
          r.steamid === me?.steamid ? el('span', { class: 'you' }, 'you') : null,
          (r.awards || []).some((k) => AWARD_LABEL[k]) ? el('span', { class: 'pawards', title: r.awards.filter((k) => AWARD_LABEL[k]).map((k) => AWARD_LABEL[k]).join(' · ') }, r.awards.filter((k) => AWARD_LABEL[k]).map((k) => AWARD_LABEL[k].split(' ')[0]).join('')) : null,
          el('span', { class: 'pbadges' }, el('span', { class: 'plabel' }, 'Acct'), acct, el('span', { class: 'plabel' }, 'Play'), game),
          el('span', { class: 'pk' }, el('b', {}, r.kills), ' K')),
        el('div', { class: 'pnote' + (notes.length ? '' : ' clean'), title: notes.length ? notes.join(' · ') : acctWhy },
          el('span', { class: 'ptext' }, notes.length ? notes.join(' · ') : acctWhy),
          me?.role === 'admin' && c && c.tier !== 'approved' && r.steamid !== me.steamid
            ? el('button', { class: 'small', title: 'Mark this player as trusted (e.g. a friend)', onclick: (ev) => {
                ev.target.disabled = true;
                cf.setOverride(r.steamid, 'approved', 'Trusted by admin').then(() => { c.tier = 'approved'; c.reasons = ['Trusted by admin']; renderMatches(); log(`${r.name} is now trusted.`); }).catch(fail);
              } }, 'Trust') : null,
          scrutinizeButton(r, key, c)));
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

// ---------- Stats tab (members only)
const AWARD_LABEL = { support: '🧠 Support', clutcher: '🦾 Clutcher', entry: '🚪 Entry fragger',
  firstdeath: '💀 First to die', trader: '🤝 Trader', teamflash: '😎 Team flasher', bomb: '💣 Bomb boy', headshot: '🎯 Headshot machine',
  awp: '🔭 AWP god', ace: '🔥 Ace', marathon: '🏃 Marathon runner', topfrag: '🏆 Top fragger', assists: '🤲 Assist king', winner: '🏅 Winner', mvp: '⭐ MVP machine',
  damage: '💥 Damage dealer', survivor: '🛡️ Survivor', wallbang: '🧱 Wallbanger', teamplayer: '🎖️ Team player' };
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
const per = (a, b, d = 1) => (b ? Math.round((a / b) * 10 ** d) / 10 ** d : 0);
const z = (o, k) => (o && o[k]) || 0;
// Each column: `rate` (default view: % or per-match) and `total`. Sources: p.all = every match,
// p.full = matches with per-round data (demo + FACEIT), p.demo = matches with a demo.
const STAT_COLS = [
  { key: 'name', label: 'Member', rate: (p) => p.name || p.steamid, text: true },
  { key: 'award', label: 'Top award', rate: (p) => topAward(p).n, fmt: (v, p) => { const t = topAward(p); return t.k ? `${AWARD_LABEL[t.k] || t.k}${t.n ? ` ×${t.n}` : ''}` : '—'; } },
  { key: 'role', label: 'Best roles', text: true, rate: (p) => { const r = Roles.naturalRoles(p.demo); return r ? `${Roles.LABEL[r.t]}${r.ct !== r.t ? ' · ' + Roles.LABEL[r.ct] : ''}` : '—'; }, tip: 'T-side · CT-side role from their own demo stats (20+ rounds needed)' },
  { key: 'matches', label: 'Matches', rate: (p) => p.matches, tip: 'Every Premier/Competitive match from Steam history, FACEIT matches, and scanned demos' },
  { key: 'win', label: 'Win %', rate: (p) => pct(z(p.all, 'wins'), z(p.all, 'wins') + z(p.all, 'losses') + z(p.all, 'ties')), total: (p) => z(p.all, 'wins'), totalLabel: 'Wins' },
  { key: 'kd', label: 'K/D', rate: (p) => per(z(p.all, 'kills'), Math.max(1, z(p.all, 'deaths')), 2), total: (p) => z(p.all, 'kills'), totalLabel: 'Kills' },
  { key: 'hs', label: 'HS %', rate: (p) => pct(z(p.all, 'headshots'), z(p.all, 'kills')), total: (p) => z(p.all, 'headshots'), totalLabel: 'Headshots' },
  { key: 'mvp', label: 'MVP %', rate: (p) => pct(z(p.all, 'mvps'), z(p.all, 'mvpRounds')), total: (p) => z(p.all, 'mvps'), totalLabel: 'MVPs', tip: 'Share of rounds where they were MVP' },
  { key: 'adr', src: 'full', label: 'ADR', rate: (p) => per(z(p.full, 'damage'), z(p.full, 'rounds')), total: (p) => z(p.full, 'damage'), totalLabel: 'Damage', tip: 'Average damage per round' },
  { key: 'open', src: 'demo', label: 'Opening duels %', rate: (p) => pct(z(p.demo, 'entryKills'), z(p.demo, 'entryKills') + z(p.demo, 'firstDeaths')), total: (p) => z(p.demo, 'entryKills'), totalLabel: 'Entry kills', tip: 'Won the first fight of the round (first kill vs first death)' },
  { key: 'clutch', src: 'demo', label: 'Clutch %', rate: (p) => pct(z(p.demo, 'clutchWins'), z(p.demo, 'clutchAttempts')), total: (p) => z(p.demo, 'clutchWins'), totalLabel: 'Clutches won',
    fmt: (v, p, totals) => (totals ? `${v}${p.bestClutch ? ` (best 1v${p.bestClutch})` : ''}` : `${v}% (${z(p.demo, 'clutchWins')}/${z(p.demo, 'clutchAttempts')})`), tip: 'Rounds won as the last one alive' },
  { key: 'trade', src: 'demo', label: 'Trade %', rate: (p) => pct(z(p.demo, 'trades'), z(p.demo, 'rounds')), total: (p) => z(p.demo, 'trades'), totalLabel: 'Trades', tip: 'Rounds where they avenged a teammate within 5 s' },
  { key: 'flash', src: 'demo', label: 'Flash assists / match', rate: (p) => per(z(p.demo, 'flashAssists'), p.demoMatches), total: (p) => z(p.demo, 'flashAssists'), totalLabel: 'Flash assists' },
  { key: 'util', src: 'full', label: 'Utility ADR', rate: (p) => per(z(p.full, 'utilDamage'), z(p.full, 'rounds')), total: (p) => z(p.full, 'utilDamage'), totalLabel: 'Util dmg', tip: 'HE + molotov damage per round' },
  { key: 'teamflash', src: 'demo', label: 'Team flash s / match', rate: (p) => per(z(p.demo, 'teamFlashSecs'), p.demoMatches), total: (p) => Math.round(z(p.demo, 'teamFlashSecs')), totalLabel: 'Team flash (s)', tip: 'Seconds of teammates flashed' },
  { key: 'bomb', src: 'demo', label: 'Plant %', rate: (p) => pct(z(p.demo, 'plants'), z(p.demo, 'rounds')), total: (p) => z(p.demo, 'plants') + z(p.demo, 'defuses'), totalLabel: 'Plants / defuses',
    fmt: (v, p, totals) => (totals ? `${z(p.demo, 'plants')} / ${z(p.demo, 'defuses')}` : `${v}%`) },
  { key: 'multi', src: 'full', label: '3K+ %', rate: (p) => pct(z(p.full, 'k3') + z(p.full, 'k4') + z(p.full, 'aces'), z(p.full, 'rounds')), total: (p) => z(p.full, 'k3') + z(p.full, 'k4') + z(p.full, 'aces'), totalLabel: '3K+',
    fmt: (v, p, totals) => `${v}${totals ? '' : '%'}${z(p.full, 'aces') ? ` · ${z(p.full, 'aces')} ace` : ''}`, tip: 'Rounds with 3 or more kills' },
  { key: 'awp', src: 'full', label: 'AWP %', rate: (p) => pct(z(p.full, 'awpKills'), z(p.full, 'kills')), total: (p) => z(p.full, 'awpKills'), totalLabel: 'AWP kills', tip: 'Share of kills with the AWP' },
  { key: 'wallbang', src: 'demo', label: 'Wallbang %', rate: (p) => pct(z(p.demo, 'wallbangs'), z(p.demo, 'kills')), total: (p) => z(p.demo, 'wallbangs'), totalLabel: 'Wallbangs' },
  { key: 'save', src: 'demo', label: 'Save %', rate: (p) => pct(z(p.demo, 'saves'), z(p.demo, 'rounds')), total: (p) => z(p.demo, 'saves'), totalLabel: 'Saves', tip: 'Rounds where they survived a lost round' },
  { key: 'knife', src: 'full', label: 'Knife kills', rate: (p) => z(p.full, 'knifeKills') },
  { key: 'km', src: 'demo', label: 'Km / match', rate: (p) => per(z(p.demo, 'distance') * 0.0254 / 1000, p.demoMatches), total: (p) => Math.round(z(p.demo, 'distance') * 0.0254 / 100) / 10, totalLabel: 'Km run', tip: '1 unit ≈ 1 inch' },
];
const PCT_KEYS = new Set(['win', 'hs', 'mvp', 'open', 'trade', 'bomb', 'multi', 'awp', 'wallbang', 'save']);
function topAward(p) {
  let k = null, n = 0;
  for (const [a, c] of Object.entries(p.awards || {})) if (AWARD_LABEL[a] && c > n) { k = a; n = c; }
  return k ? { k, n } : (p._overall || { k: null, n: 0 });
}
// Members without match awards yet (e.g. only Steam-history matches) still get one: the overall stat
// where they come closest to the best member in the table.
const OVERALL = [
  { k: 'winner', v: (p) => (z(p.all, 'wins') + z(p.all, 'losses') ? z(p.all, 'wins') / (z(p.all, 'wins') + z(p.all, 'losses') + z(p.all, 'ties')) : 0) },
  { k: 'topfrag', v: (p) => z(p.all, 'kills') / Math.max(1, z(p.all, 'deaths')) },
  { k: 'headshot', v: (p) => (z(p.all, 'kills') ? z(p.all, 'headshots') / z(p.all, 'kills') : 0) },
  { k: 'mvp', v: (p) => (z(p.all, 'mvpRounds') ? z(p.all, 'mvps') / z(p.all, 'mvpRounds') : 0) },
  { k: 'assists', v: (p) => (p.matches ? z(p.all, 'assists') / p.matches : 0) },
];
function giveOverallAwards(rows) {
  for (const p of rows) {
    delete p._overall;
    if (Object.keys(p.awards || {}).some((a) => AWARD_LABEL[a])) continue;
    let best = null, ratio = 0;
    for (const o of OVERALL) {
      const top = Math.max(...rows.map(o.v)), v = o.v(p);
      if (v > 0 && top > 0 && v / top > ratio) { ratio = v / top; best = o.k; }
    }
    p._overall = { k: best || 'teamplayer', n: 0, overall: true };
  }
}
let statRows = [], statSort = { key: 'win', dir: -1 };
async function loadStats() {
  const box = $('#statTable');
  box.textContent = 'Loading…';
  try {
    statRows = (await cf.stats(Number($('#statDays').value))).players || [];
    giveOverallAwards(statRows);
    renderStats();
  } catch (e) { box.textContent = e.message; }
}
function renderStats() {
  const box = $('#statTable');
  if (!statRows.length) { box.replaceChildren(el('p', { class: 'muted' }, 'No stats yet. They fill in as members play — every match a member plays counts once, even if several of you were in it.')); return; }
  const totals = $('#statTotals').checked;
  const val = (c, p) => (totals && c.total ? c.total(p) : c.rate(p));
  const col = STAT_COLS.find((c) => c.key === statSort.key) || STAT_COLS[4];
  const rows = [...statRows].sort((a, b) => {
    const x = val(col, a), y = val(col, b);
    return (col.text ? String(x).localeCompare(String(y)) : (x - y)) * statSort.dir;
  });
  const head = el('tr', {}, STAT_COLS.map((c) => el('th', { class: 'sortable' + (c.key === statSort.key ? ' sorted' : ''), title: c.tip || 'Sort by ' + c.label,
    onclick: () => { statSort = { key: c.key, dir: statSort.key === c.key ? -statSort.dir : (c.text ? 1 : -1) }; renderStats(); } },
    totals && c.totalLabel ? c.totalLabel : c.label, c.key === statSort.key ? (statSort.dir < 0 ? ' ▼' : ' ▲') : '')));
  const body = rows.map((p) => el('tr', { class: p.steamid === me?.steamid ? 'me' : '' }, STAT_COLS.map((c) => {
    const v = val(c, p);
    const noData = (c.src === 'demo' && !p.demoMatches) || (c.src === 'full' && !p.fullMatches);
    const text = noData ? '—' : c.fmt ? c.fmt(v, p, totals) : (!totals && PCT_KEYS.has(c.key) ? v + '%' : v);
    const title = c.key === 'award' ? Object.entries(p.awards || {}).filter(([k]) => AWARD_LABEL[k]).map(([k, n]) => `${AWARD_LABEL[k] || k} ×${n}`).join('\n')
      : noData ? 'No matches with a demo or FACEIT yet — these come from scanned demos' : c.key === 'award' && topAward(p).n === 0 && topAward(p).k ? 'Best overall stat in the squad (no match awards yet)'
      : c.key === 'matches' ? `${p.demoMatches || 0} with a demo (all fun stats) · ${p.faceitMatches || 0} FACEIT · ${p.historyMatches || 0} from Steam match history (wins, K/D, HS %, MVPs)` : '';
    return el('td', { title }, text);
  })));
  box.replaceChildren(el('div', { class: 'tablewrap' }, el('table', { class: 'stats' }, el('thead', {}, head), el('tbody', {}, body))));
}
$('#statTotals').addEventListener('change', renderStats);
$('#statDays').addEventListener('change', loadStats);

// Scrutinize: a deeper check of one player; anything suspicious goes to Review
const scrutinyBusy = new Set();
function scrutinizeButton(r, key, c) {
  if (r.steamid === me?.steamid || r.flagged) return null;
  const d = r.deep, job = key + '|' + r.steamid;
  // only for players who already look off: Caution or Flagged account, or weak gameplay signals
  const suspect = (c && (c.tier === 'limited' || c.tier === 'rejected')) || r.signals.length > 0;
  if (!suspect && !d) return null;
  if (d) {
    const label = !d.flagged ? '✓ Scrutinized — clean' : d.carriedOver === 'cleared' ? 'Scrutinized — cleared by vote earlier' : 'Scrutinized — sent to Review';
    const b = el('button', { class: 'small scrut ' + (d.flagged ? 'bad' : 'ok'), disabled: true,
      title: d.flagged ? d.signals.map((x) => `${x.name}: ${x.value}`).join(' · ') : 'Extra checks found nothing suspicious (' + new Date(d.at).toLocaleString() + ')' }, label);
    return b;
  }
  const busy = scrutinyBusy.has(job);
  return el('button', { class: 'small scrut', disabled: busy, title: 'Run extra checks on this player (stricter rules + pre-aim, aim-lock, smoke, headshot and flash checks). Anything suspicious goes to Review.',
    onclick: (ev) => {
      ev.stopPropagation();
      scrutinyBusy.add(job); ev.target.disabled = true; ev.target.textContent = 'Scrutinizing…';
      log(`Scrutinizing ${r.name}… this takes a minute or two.`);
      cf.scrutinize(key, r.steamid).then((d) => {
        log(d.flagged ? `${r.name}: suspicious (${d.signals.map((x) => x.name).join(', ')}) — sent to Review.` : `${r.name}: scrutinized, nothing suspicious.`);
      }).catch((e) => { fail(e); }).finally(() => { scrutinyBusy.delete(job); refreshHistory(); });
    } }, busy ? 'Scrutinizing…' : 'Scrutinize');
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
        el('p', { class: 'muted' }, `${f.extra && f.extra.scrutinized ? 'Scrutinized by' : 'Flagged by'} ${f.reporter_name || f.reporter}`),
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

cf.on('lobby', (l) => { if (state) state.lobby = l; renderLobby(l); renderSquad(l); });
cf.on('progress', (p) => { $('#progress').textContent = `${p.shareCode}: ${p.step}…`; });
cf.on('match', () => refreshHistory());
cf.on('log', log);
cf.on('goto', (t) => showTab(t));
cf.on('update', (t) => { $('#updStatus').textContent = '· ' + t; });
// update waiting: offer to install right away (otherwise it installs after the match)
function showUpdateReady(v) {
  if (!v || typeof v !== 'string') return;
  $('#updBarMsg').textContent = `CheaterFlag ${v} is ready. It installs by itself after your match — or install it now (takes about 10 seconds; the app reopens, CS2 keeps running).`;
  $('#updBar').classList.remove('hidden');
}
cf.on('updateReady', showUpdateReady);
cf.updateReady().then(showUpdateReady).catch(() => {});
$('#btnInstallNow').addEventListener('click', (e) => { e.target.disabled = true; e.target.textContent = 'Installing…'; cf.installUpdate().catch((err) => { e.target.disabled = false; e.target.textContent = 'Install now'; fail(err); }); });
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
