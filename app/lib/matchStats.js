'use strict';
// Fun per-match stats and awards (Stats tab). Pure counting from a demo — separate from cheat detection.
// computeStats(data) works on already-parsed data (testable); parseStats(demoPath) parses a demo itself.

const sid = (v) => (v == null ? null : String(v));
const TRADE_TICKS = 5 * 64;           // a kill within 5 s of a teammate's death avenges it
const BAIT_RANGE = 900;               // units: "was right there" when a teammate died
const UTIL = /hegrenade|inferno|molotov|incgrenade/;
const KNIFE = /knife|bayonet/;
// buy prices of guns worth dropping (CS2, Nov 2026)
const PRICES = {
  'AK-47': 2700, 'M4A4': 3100, 'M4A1-S': 2900, 'AWP': 4750, 'Galil AR': 1800, 'FAMAS': 2050, 'SG 553': 3000, 'AUG': 3300,
  'SSG 08': 1700, 'MAC-10': 1050, 'MP9': 1250, 'MP7': 1500, 'MP5-SD': 1500, 'UMP-45': 1200, 'P90': 2350, 'PP-Bizon': 1400,
  'Nova': 1050, 'XM1014': 2000, 'MAG-7': 1300, 'Sawed-Off': 1100, 'M249': 5200, 'Negev': 1700, 'G3SG1': 5000, 'SCAR-20': 5000,
};
const FIELDS = ['rounds', 'kills', 'deaths', 'assists', 'headshots', 'damage', 'utilDamage', 'flashAssists', 'enemiesFlashed', 'teamFlashSecs',
  'entryKills', 'firstDeaths', 'trades', 'baits', 'clutchWins', 'clutchAttempts', 'bestClutch', 'saves', 'plants', 'defuses', 'ninjaDefuses',
  'k3', 'k4', 'aces', 'awpKills', 'knifeKills', 'wallbangs', 'smokeKills', 'blindKills', 'noscopes', 'teamKills', 'dropsGiven', 'distance'];

const blank = () => Object.fromEntries(FIELDS.map((f) => [f, 0]));
const dist2d = (a, b) => Math.hypot(a.X - b.X, a.Y - b.Y);
const teamNum = (w) => (w == null ? null : typeof w === 'number' ? w : /CT/i.test(String(w)) ? 3 : /T/i.test(String(w)) ? 2 : Number(w) || null);

/**
 * data: { players:[{steamid,name}], deaths, hurts, blinds, roundStarts (freeze-end ticks), roundEnds:[{tick,winner}],
 *         plants:[{tick,user_steamid}], defuses:[{tick,user_steamid}], samples:[{tick,steamid,X,Y,is_alive,team_num}],
 *         buys:[{tick,steamid,balance,inventory,team_num}] (two snapshots per round: start of buy time, end of buy time) }
 * Returns Map steamid -> stats object (numbers only).
 */
function computeStats(data) {
  const S = new Map(data.players.map((p) => [sid(p.steamid), blank()]));
  const st = (id) => S.get(sid(id));
  const tickOf = (rows) => { const m = new Map(); for (const r of rows || []) { if (!m.has(r.tick)) m.set(r.tick, new Map()); m.get(r.tick).set(sid(r.steamid), r); } return m; };
  const samples = tickOf(data.samples);
  const sampleTicks = [...samples.keys()].sort((a, b) => a - b);
  const nearest = (t) => { // last sample at or before t
    let lo = 0, hi = sampleTicks.length - 1, best = null;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (sampleTicks[mid] <= t) { best = sampleTicks[mid]; lo = mid + 1; } else hi = mid - 1; }
    return best == null ? null : samples.get(best);
  };

  // ---- rounds: [freezeEnd, end]
  const starts = [...(data.roundStarts || [])].sort((a, b) => a - b);
  const ends = [...(data.roundEnds || [])].sort((a, b) => a.tick - b.tick);
  const rounds = [];
  for (let i = 0; i < starts.length; i++) {
    const next = starts[i + 1] ?? Infinity;
    const end = ends.find((e) => e.tick > starts[i] && e.tick <= next);
    if (!end) continue;
    const snap = nearest(starts[i] + 16);
    const team = new Map();
    for (const [id, r] of snap || []) if ((r.team_num === 2 || r.team_num === 3) && r.is_alive !== false && S.has(id)) team.set(id, r.team_num);
    if (team.size) rounds.push({ start: starts[i], end: end.tick, winner: teamNum(end.winner), team });
  }
  const roundOf = (t) => rounds.find((r) => t > r.start - 64 && t <= r.end + 64);
  const teamAt = (id, t) => { const r = roundOf(t); return r ? r.team.get(sid(id)) : undefined; };

  // ---- kills and deaths
  for (const r of rounds) {
    for (const id of r.team.keys()) st(id).rounds += 1;
    const deaths = (data.deaths || []).filter((d) => d.tick > r.start - 64 && d.tick <= r.end + 64).sort((a, b) => a.tick - b.tick);
    const alive = new Map([...r.team.keys()].map((id) => [id, true]));
    const killsThisRound = new Map();
    let first = true;
    const clutch = new Map();   // team -> { id, vs }
    for (let i = 0; i < deaths.length; i++) {
      const d = deaths[i];
      const v = sid(d.user_steamid), k = sid(d.attacker_steamid);
      const vt = r.team.get(v), kt = r.team.get(k);
      if (st(v)) st(v).deaths += 1;
      alive.set(v, false);
      const enemyKill = k && k !== v && st(k) && kt && vt && kt !== vt;
      if (k && st(k) && kt && kt === vt && k !== v) st(k).teamKills += 1;
      if (enemyKill) {
        const s = st(k);
        s.kills += 1; killsThisRound.set(k, (killsThisRound.get(k) || 0) + 1);
        if (d.headshot) s.headshots += 1;
        const w = String(d.weapon || '');
        if (w === 'awp') s.awpKills += 1;
        if (KNIFE.test(w)) s.knifeKills += 1;
        if (Number(d.penetrated) > 0) s.wallbangs += 1;
        if (d.thrusmoke) s.smokeKills += 1;
        if (d.attackerblind) s.blindKills += 1;
        if (d.noscope) s.noscopes += 1;
        if (first) { s.entryKills += 1; if (st(v)) st(v).firstDeaths += 1; first = false; }
      }
      const a = sid(d.assister_steamid);
      if (a && st(a) && r.team.get(a) && r.team.get(a) !== vt) { st(a).assists += 1; if (d.assistedflash) st(a).flashAssists += 1; }
      // trade: the killer dies to one of the victim's teammates within 5 s
      let traded = false;
      if (enemyKill) {
        for (let j = i + 1; j < deaths.length && deaths[j].tick - d.tick <= TRADE_TICKS; j++) {
          const e = deaths[j];
          if (sid(e.user_steamid) === k && r.team.get(sid(e.attacker_steamid)) === vt) { if (st(e.attacker_steamid)) st(e.attacker_steamid).trades += 1; traded = true; break; }
        }
      }
      // "popcorn seat": the closest living teammate was right there, didn't trade, and stayed alive
      if (enemyKill && !traded) {
        const snap = nearest(d.tick), vp = snap && snap.get(v);
        let best = null, bestD = BAIT_RANGE;
        for (const [id, isAlive] of alive) {
          if (!isAlive || id === v || r.team.get(id) !== vt) continue;
          const p = snap && snap.get(id);
          if (!vp || !p) continue;
          const dd = dist2d(vp, p);
          if (dd < bestD) { bestD = dd; best = id; }
        }
        const diedSoon = best && deaths.some((e) => sid(e.user_steamid) === best && e.tick > d.tick && e.tick - d.tick <= TRADE_TICKS);
        if (best && !diedSoon) st(best).baits += 1;
      }
      // clutch: last one alive on a team
      for (const t of [2, 3]) {
        if (clutch.has(t)) continue;
        const mine = [...alive].filter(([id, al]) => al && r.team.get(id) === t).map(([id]) => id);
        const enemies = [...alive].filter(([id, al]) => al && r.team.get(id) && r.team.get(id) !== t).length;
        if (mine.length === 1 && enemies >= 1 && [...r.team.values()].filter((x) => x === t).length >= 2) clutch.set(t, { id: mine[0], vs: enemies });
      }
    }
    for (const [t, c] of clutch) {
      const s = st(c.id); s.clutchAttempts += 1;
      if (r.winner === t) { s.clutchWins += 1; s.bestClutch = Math.max(s.bestClutch, c.vs); }
    }
    for (const [id, n] of killsThisRound) { const s = st(id); if (n === 3) s.k3 += 1; else if (n === 4) s.k4 += 1; else if (n >= 5) s.aces += 1; }
    if (r.winner) for (const [id, al] of alive) if (al && r.team.get(id) !== r.winner) st(id).saves += 1;
    // ninja defuse: defused with a T still alive
    for (const df of data.defuses || []) {
      if (df.tick <= r.start || df.tick > r.end + 64) continue;
      const id = sid(df.user_steamid);
      if (!st(id)) continue;
      const tsAlive = [...r.team.keys()].some((x) => r.team.get(x) === 2 && !(data.deaths || []).some((e) => sid(e.user_steamid) === x && e.tick > r.start && e.tick <= df.tick));
      if (tsAlive) st(id).ninjaDefuses += 1;
    }
  }
  for (const p of data.plants || []) if (st(p.user_steamid)) st(p.user_steamid).plants += 1;
  for (const p of data.defuses || []) if (st(p.user_steamid)) st(p.user_steamid).defuses += 1;

  // ---- damage and utility
  for (const h of data.hurts || []) {
    const a = sid(h.attacker_steamid), v = sid(h.user_steamid);
    if (!a || a === v || !st(a)) continue;
    const at = teamAt(a, h.tick), vt = teamAt(v, h.tick);
    if (!at || !vt || at === vt) continue;
    const dmg = Math.min(Number(h.dmg_health) || 0, 100);
    st(a).damage += dmg;
    if (UTIL.test(String(h.weapon || ''))) st(a).utilDamage += dmg;
  }
  // ---- flashes
  for (const b of data.blinds || []) {
    const a = sid(b.attacker_steamid), v = sid(b.user_steamid), dur = Number(b.blind_duration) || 0;
    if (!a || a === v || !st(a)) continue;
    const at = teamAt(a, b.tick), vt = teamAt(v, b.tick);
    if (!at || !vt) continue;
    if (at !== vt && dur >= 1) st(a).enemiesFlashed += 1;
    if (at === vt) st(a).teamFlashSecs += dur;
  }
  // ---- distance moved while alive
  const last = new Map();
  for (const t of sampleTicks) {
    for (const [id, r] of samples.get(t)) {
      if (!st(id) || r.is_alive === false || r.X == null) { last.delete(id); continue; }
      const p = last.get(id);
      if (p) { const d = dist2d(p, r); if (d < 400) st(id).distance += d; }
      last.set(id, r);
    }
  }
  // ---- drops (best guess): a teammate gets a gun without paying, and someone on the team paid for it
  const buys = tickOf(data.buys);
  const buyTicks = [...buys.keys()].sort((a, b) => a - b);
  for (let i = 0; i + 1 < buyTicks.length; i += 2) {
    const before = buys.get(buyTicks[i]), after = buys.get(buyTicks[i + 1]);
    const guns = (row) => new Set((row && row.inventory || []).filter((n) => PRICES[n]));
    const spent = new Map(), extra = new Map();
    for (const [id, r1] of after) {
      const r0 = before.get(id);
      if (!r0 || !st(id)) continue;
      const pay = (Number(r0.balance) || 0) - (Number(r1.balance) || 0);
      const own = [...guns(r1)].filter((g) => !guns(r0).has(g));
      spent.set(id, { team: r1.team_num, pay, own });
    }
    for (const [id, s] of spent) {
      for (const g of s.own) {
        if (s.pay >= PRICES[g] * 0.8) continue;                  // they bought it themselves
        let giver = null, best = 0;
        for (const [gid, gs] of spent) {
          if (gid === id || gs.team !== s.team) continue;
          const ownCost = gs.own.reduce((x, n) => x + (PRICES[n] || 0), 0);
          const left = gs.pay - ownCost - (extra.get(gid) || 0);
          if (left >= PRICES[g] * 0.9 && left > best) { best = left; giver = gid; }
        }
        if (giver) { st(giver).dropsGiven += 1; extra.set(giver, (extra.get(giver) || 0) + PRICES[g]); }
      }
    }
  }
  for (const s of S.values()) { s.teamFlashSecs = Math.round(s.teamFlashSecs * 10) / 10; s.distance = Math.round(s.distance); }
  return S;
}

/** Parse what computeStats needs. `base` can pass players/deaths/samples/roundStarts already parsed by the scanner. */
function parseStats(demoPath, base = {}) {
  const dp = require('@laihoe/demoparser2');
  const ev = (name, extra = []) => { try { return dp.parseEvent(demoPath, name, [], extra) || []; } catch (_) { return []; } };
  const players = base.players || dp.parsePlayerInfo(demoPath).map((p) => ({ steamid: sid(p.steamid), name: p.name }));
  const deaths = base.deaths || ev('player_death');
  const roundStarts = base.roundStarts || ev('round_freeze_end').map((e) => e.tick);
  const roundEnds = ev('round_end').map((e) => ({ tick: e.tick, winner: e.winner }));
  let samples = base.samples;
  if (!samples) {
    const lastTick = deaths.reduce((m, d) => Math.max(m, d.tick), 0);
    const list = []; for (let t = 0; t <= lastTick; t += 8) list.push(t);
    samples = dp.parseTicks(demoPath, ['X', 'Y', 'is_alive', 'team_num'], list);
  }
  // buy time: from the start of each round to 20 s after freeze time ends
  const rs = ev('round_start').map((e) => e.tick).sort((a, b) => a - b);
  const buyList = [];
  for (const fe of [...roundStarts].sort((a, b) => a - b)) {
    const s = [...rs].reverse().find((t) => t < fe);
    if (s != null) buyList.push(s + 8, fe + 20 * 64);
  }
  let buys = [];
  try { if (buyList.length) buys = dp.parseTicks(demoPath, ['balance', 'inventory', 'team_num'], buyList); } catch (_) {}
  return computeStats({
    players, deaths, roundStarts, roundEnds, samples, buys,
    hurts: ev('player_hurt'), blinds: ev('player_blind'), plants: ev('bomb_planted'), defuses: ev('bomb_defused'),
  });
}

// ---- awards among members in one match
const AWARDS = [
  { key: 'support', label: '🧠 Support', score: (s) => s.flashAssists * 2 + s.enemiesFlashed * 0.5 + s.utilDamage / 25, min: 4 },
  { key: 'sugar', label: '🎁 Sugar Daddy', score: (s) => s.dropsGiven, min: 2 },
  { key: 'popcorn', label: '🍿 Popcorn seat', score: (s) => s.baits, min: 3 },   // watched a teammate go down up close and lived
  { key: 'clutcher', label: '🦾 Clutcher', score: (s) => s.clutchWins * 10 + s.bestClutch, min: 10 },
  { key: 'entry', label: '🚪 Entry fragger', score: (s) => s.entryKills, min: 3 },
  { key: 'firstdeath', label: '💀 First to die', score: (s) => s.firstDeaths, min: 4 },
  { key: 'trader', label: '🤝 Trader', score: (s) => s.trades, min: 3 },
  { key: 'teamflash', label: '😎 Team flasher', score: (s) => s.teamFlashSecs, min: 8 },
  { key: 'bomb', label: '💣 Bomb boy', score: (s) => s.plants + s.defuses + s.ninjaDefuses, min: 3 },
  { key: 'headshot', label: '🎯 Headshot machine', score: (s) => (s.kills >= 10 ? s.headshots / s.kills : 0), min: 0.6 },
  { key: 'awp', label: '🔭 AWP god', score: (s) => s.awpKills, min: 6 },
  { key: 'ace', label: '🔥 Ace', score: (s) => s.aces, min: 1 },
  { key: 'marathon', label: '🏃 Marathon runner', score: (s) => (s.rounds ? s.distance / s.rounds : 0), min: 1, needs: 2 },
];
/** stats: Map/obj steamid -> stats, members: Set of member steamids. Returns Map steamid -> [award keys]. */
function awards(stats, members) {
  const out = new Map();
  const entries = [...(stats instanceof Map ? stats : Object.entries(stats))].filter(([id]) => members.has(id));
  for (const a of AWARDS) {
    if (entries.length < (a.needs || 1)) continue;
    let best = -Infinity, who = [];
    for (const [id, s] of entries) { const v = a.score(s); if (v > best) { best = v; who = [id]; } else if (v === best) who.push(id); }
    if (best < a.min) continue;
    for (const id of who) out.set(id, [...(out.get(id) || []), a.key]);
  }
  return out;
}

module.exports = { computeStats, parseStats, awards, AWARDS, FIELDS, PRICES };
