'use strict';
// Demo scanner. scanDemo(path) parses a CS2 demo; analyze(data) is pure so it can be tested
// with synthetic data. Thresholds are deliberately strict ("strong evidence only") and are
// first guesses — tune them with real demos via the THRESHOLDS object.

const { aimError, viewDelta, distance, angleBetween } = require('./geometry');

const THRESHOLDS = {
  sampleEvery: 8,          // ticks between tracking samples (64 tick → 8 samples/s)
  trackMaxError: 3,        // degrees: crosshair "on" a hidden enemy (tightened further by distance)
  trackBodyUnits: 40,      // ...or within ~a player's width at long range, whichever is smaller
  trackMinStreak: 8,       // consecutive samples (~1 s) to count as a tracking streak
  trackMinSweep: 10,       // degrees the enemy's bearing must move during the streak (sideways movement)
  trackMinTurn: 8,         // degrees the shooter's view must turn to follow (not a held angle)
  trackRecentlySeen: 96,   // ticks (~1.5 s): ignore enemies the shooter just saw (they know where they went)
  trackMinDistance: 300,   // ignore point-blank
  snapWindow: 8,           // ticks before the kill (~125 ms)
  snapMinTurn: 25,         // degrees turned within the window
  snapMaxFinalError: 1.5,  // degrees off target right before the kill
  snapMinStartError: 20,   // degrees off target at window start
  minKillsForRate: 10,
  // signal triggers
  wallStreaks: 4, wallStreaksExtreme: 8,
  snapRate: 0.35, snapRateExtreme: 0.5,
  unseenWallbangs: 3,
  reactionTicks: 8, minReactionSamples: 8,
};

const NON_AIM_WEAPONS = /knife|bayonet|hegrenade|molotov|incgrenade|inferno|flashbang|smokegrenade|decoy|taser|world/i;

function bearing(from, to) {
  const dx = to.X - from.X, dy = to.Y - from.Y, dz = (to.Z + 56) - (from.Z + 64);
  const l = Math.hypot(dx, dy, dz) || 1;
  return [dx / l, dy / l, dz / l];
}

function sid(v) { return v == null ? null : String(v); }

function spottedSet(row) {
  const v = row.approximate_spotted_by;
  if (v == null) return null;
  if (Array.isArray(v)) return new Set(v.map(String));
  return new Set(String(v).split(/[,\s]+/).filter(Boolean));
}

function roundAt(tick, roundStarts) {
  let r = 0;
  for (let i = 0; i < roundStarts.length; i++) if (tick >= roundStarts[i]) r = i + 1;
  return r || 1;
}

/**
 * data = {
 *   players: [{steamid, name}],
 *   deaths: [{tick, attacker_steamid, user_steamid, weapon, penetrated, thrusmoke}],
 *   roundStarts: [tick, ...],
 *   samples: rows sampled every N ticks [{tick, steamid, X,Y,Z,pitch,yaw,is_alive,team_num,approximate_spotted_by}],
 *   killWindows: rows for ticks around kills (same shape),
 * }
 */
function analyze(data, T = THRESHOLDS) {
  const stats = new Map();
  for (const p of data.players) {
    stats.set(sid(p.steamid), {
      steamid: sid(p.steamid), name: p.name, kills: 0, snaps: 0, wallStreaks: 0,
      unseenWallbangs: 0, reactions: [], rounds: new Set(), moments: [], spottedDataAvailable: false,
    });
  }
  const get = (id) => stats.get(sid(id));

  // ---- index rows by tick
  const byTick = (rows) => {
    const m = new Map();
    for (const r of rows || []) {
      const t = r.tick;
      if (!m.has(t)) m.set(t, new Map());
      m.get(t).set(sid(r.steamid), r);
    }
    return m;
  };
  const sampleTicks = byTick(data.samples);
  const windowTicks = byTick(data.killWindows);
  const hasSpotted = (data.samples || []).some((r) => r.approximate_spotted_by != null);

  // ---- 1) tracking hidden enemies that move sideways, with the crosshair following them
  if (hasSpotted) {
    const ticks = [...sampleTicks.keys()].sort((a, b) => a - b);
    const streaks = new Map();   // shooter|enemy -> streak
    const lastSeen = new Map();  // shooter|enemy -> last tick enemy was spotted by shooter
    const closeStreak = (key, cur) => {
      const sweep = angleBetween(bearing(cur.startShooter, cur.start), bearing(cur.lastShooter, cur.last));
      const turn = viewDelta(cur.startShooter, cur.lastShooter);
      if (cur.len >= T.trackMinStreak && sweep >= T.trackMinSweep && turn >= T.trackMinTurn) {
        const st = get(key.split('|')[0]);
        st.wallStreaks += 1;
        st.rounds.add(roundAt(cur.startTick, data.roundStarts || []));
        st.moments.push({ tick: cur.startTick, round: roundAt(cur.startTick, data.roundStarts || []), what: 'Tracked a hidden enemy' });
      }
    };
    for (const t of ticks) {
      const rows = sampleTicks.get(t);
      const seen = new Set();
      for (const [shooterId, s] of rows) {
        const st = get(shooterId);
        if (!st || !s.is_alive) continue;
        st.spottedDataAvailable = true;
        for (const [enemyId, e] of rows) {
          if (enemyId === shooterId || !e.is_alive || e.team_num === s.team_num) continue;
          const key = shooterId + '|' + enemyId;
          const spotted = spottedSet(e);
          if (spotted && spotted.has(shooterId)) { lastSeen.set(key, t); continue; }
          if (!spotted) continue;
          if (lastSeen.has(key) && t - lastSeen.get(key) < T.trackRecentlySeen) continue;
          const dist = distance(s, e);
          if (dist <= T.trackMinDistance) continue;
          const maxErr = Math.min(T.trackMaxError, Math.atan(T.trackBodyUnits / dist) * 180 / Math.PI);
          if (aimError(s, e) > maxErr) continue;
          seen.add(key);
          let cur = streaks.get(key);
          if (cur && t - cur.lastTick > T.sampleEvery * 1.5) { closeStreak(key, cur); cur = null; }
          if (!cur) cur = { len: 0, start: e, startShooter: s, startTick: t };
          cur.len += 1; cur.last = e; cur.lastShooter = s; cur.lastTick = t;
          streaks.set(key, cur);
        }
      }
      for (const [key, cur] of streaks) {
        if (seen.has(key)) continue;
        closeStreak(key, cur);
        streaks.delete(key);
      }
    }
    for (const [key, cur] of streaks) closeStreak(key, cur);
  }

  // ---- 2) kills: snaps, reaction time, unseen wallbangs (+ "how did I die?" notes for each victim)
  const deathLog = new Map();   // victim -> { total, odd: [{ tick, round, killer, killerName, weapon, reasons }] }
  const names = new Map((data.players || []).map((p) => [sid(p.steamid), p.name]));
  for (const d of data.deaths || []) {
    const vic = sid(d.user_steamid);
    if (vic && sid(d.attacker_steamid) && sid(d.attacker_steamid) !== vic) {
      const e = deathLog.get(vic) || { total: 0, odd: [] }; e.total += 1; deathLog.set(vic, e);
    }
    const why = [];
    const st = get(d.attacker_steamid);
    if (!st || sid(d.attacker_steamid) === sid(d.user_steamid)) continue;
    if (NON_AIM_WEAPONS.test(d.weapon || '')) continue;
    st.kills += 1;
    const round = roundAt(d.tick, data.roundStarts || []);
    const at = (t, who) => windowTicks.get(t) && windowTicks.get(t).get(sid(who));

    const endA = at(d.tick - 1, d.attacker_steamid), endV = at(d.tick - 1, d.user_steamid);
    const startA = at(d.tick - T.snapWindow, d.attacker_steamid), startV = at(d.tick - T.snapWindow, d.user_steamid);
    if (endA && endV && startA && startV) {
      const turned = viewDelta(startA, endA);
      if (turned >= T.snapMinTurn && aimError(endA, endV) <= T.snapMaxFinalError &&
          aimError(startA, startV) >= T.snapMinStartError) {
        st.snaps += 1; st.rounds.add(round); st.moments.push({ tick: d.tick - T.snapWindow - 32, round, what: 'Snap kill' });
        why.push(`snapped ${Math.round(turned)}° onto you`);
      }
    }

    // reaction: first tick in the window where victim is spotted by the attacker
    let firstSpot = null, anySpotData = false;
    for (let t = d.tick - 64; t <= d.tick; t++) {
      const v = at(t, d.user_steamid);
      const s = v && spottedSet(v);
      if (!s) continue;
      anySpotData = true;
      if (s.has(sid(d.attacker_steamid))) { firstSpot = t; break; }
    }
    if (anySpotData) {
      if (firstSpot === null) {
        if (Number(d.penetrated) > 0 && !d.thrusmoke) { st.unseenWallbangs += 1; st.rounds.add(round); st.moments.push({ tick: d.tick - 128, round, what: 'Wallbang kill on an unseen enemy' }); why.push('wallbanged you without ever seeing you'); }
      } else if (firstSpot > d.tick - 64) {
        st.reactions.push(d.tick - firstSpot);
        // tracked you through the wall just before you came into view?
        let on = 0, first = null, last = null;
        for (let t = Math.max(d.tick - 64, firstSpot - 24); t < firstSpot; t++) {
          const a = at(t, d.attacker_steamid), v = at(t, d.user_steamid);
          if (!a || !v) continue;
          first = first || a; last = a;
          const dist = distance(a, v);
          if (dist > T.trackMinDistance && aimError(a, v) <= Math.min(T.trackMaxError, Math.atan(T.trackBodyUnits / dist) * 180 / Math.PI)) on += 1;
        }
        if (on >= 12 && first && last && viewDelta(first, last) >= 4) why.push('followed you through the wall before you were visible');
      }
    }
    if (d.thrusmoke) why.push('through smoke');
    if (d.attackerblind) why.push('while they were flashed');
    if (why.length && deathLog.has(vic)) deathLog.get(vic).odd.push({ tick: d.tick - 192, round, killer: sid(d.attacker_steamid), killerName: names.get(sid(d.attacker_steamid)) || '', weapon: d.weapon || '', reasons: why });
  }

  // ---- 3) verdicts
  const results = [];
  for (const st of stats.values()) {
    const snapRate = st.kills ? st.snaps / st.kills : 0;
    const reactions = st.reactions.slice().sort((a, b) => a - b);
    const medianReaction = reactions.length ? reactions[Math.floor(reactions.length / 2)] : null;
    const metrics = { kills: st.kills, wallStreaks: st.wallStreaks, snaps: st.snaps, snapRate: +snapRate.toFixed(3), unseenWallbangs: st.unseenWallbangs,
      medianReactionTicks: medianReaction, reactionSamples: reactions.length, spottedDataAvailable: st.spottedDataAvailable };
    results.push({
      steamid: st.steamid, name: st.name, kills: st.kills,
      ...judge(metrics, T),
      rounds: [...st.rounds].sort((a, b) => a - b),
      moments: st.moments.sort((a, b) => a.tick - b.tick).slice(0, 20),
      metrics,
    });
  }
  for (const r of results) { const e = deathLog.get(r.steamid); if (e) { r.deathsTotal = e.total; r.oddDeaths = e.odd.slice(0, 15); } }
  return results.sort((a, b) => b.score - a.score);
}

/**
 * Turns a player's measured gameplay into signals and a verdict.
 * level 'normal'  : standard thresholds; flag = two independent signals or one extreme signal
 * level 'caution' : stricter thresholds (account is new/private/old-ban); same flag rule
 * level 'high'    : stricter thresholds and any one signal flags (recent ban or on the blacklist)
 */
const STRICT = { wallStreaks: 3, wallStreaksExtreme: 6, unseenWallbangs: 3, snapRate: 0.2, snapRateExtreme: 0.35, minKillsForRate: 8, reactionTicks: 8, minReactionSamples: 6 };
function judge(m, T = THRESHOLDS, level = 'normal') {
  const L = level === 'normal' ? T : { ...T, ...STRICT };
  const signals = [];
  if (m.wallStreaks >= L.wallStreaks) signals.push({ type: 'wallhack', name: 'Tracked hidden enemies through walls', value: m.wallStreaks, extreme: m.wallStreaks >= L.wallStreaksExtreme });
  if (m.unseenWallbangs >= L.unseenWallbangs) signals.push({ type: 'wallhack', name: 'Wallbang kills on enemies never seen', value: m.unseenWallbangs, extreme: false });
  if (m.kills >= L.minKillsForRate && m.snapRate >= L.snapRate) signals.push({ type: 'aimbot', name: 'Instant snap-to-target kills', value: Math.round(m.snapRate * 100) + '%', extreme: m.snapRate >= L.snapRateExtreme });
  if ((m.reactionSamples || 0) >= L.minReactionSamples && m.medianReactionTicks != null && m.medianReactionTicks <= L.reactionTicks)
    signals.push({ type: 'aimbot', name: 'Inhuman reaction time', value: Math.round(m.medianReactionTicks * 15.6) + ' ms median', extreme: false });
  const flagged = level === 'high' ? signals.length >= 1 : signals.length >= 2 || signals.some((x) => x.extreme);
  const wall = signals.filter((x) => x.type === 'wallhack').length, aim = signals.filter((x) => x.type === 'aimbot').length;
  return {
    flagged, signals, scrutiny: level,
    category: !signals.length ? null : wall >= aim ? 'Wallhack' : 'Aimbot',
    score: Math.min(100, signals.reduce((a, x) => a + (x.extreme ? 60 : 35), 0) + (level === 'high' && signals.length ? 25 : 0)),
  };
}

/** Re-judges scan results with extra scrutiny for players whose account check isn't clean. */
function applyScrutiny(results, checks, T = THRESHOLDS) {
  const tierOf = new Map((checks || []).map((c) => [c.steamid, c.tier]));
  return results.map((r) => {
    if (!r.metrics) return r;
    const tier = tierOf.get(r.steamid);
    const level = tier === 'rejected' ? 'high' : tier === 'limited' ? 'caution' : 'normal';
    return level === 'normal' ? { ...r, scrutiny: 'normal' } : { ...r, ...judge(r.metrics, T, level) };
  }).sort((a, b) => b.score - a.score);
}

/** Final score: [{score, players:[steamid]}] for both teams (empty if unavailable). */
function finalScore(dp, demoPath) {
  try {
    const ends = dp.parseEvent(demoPath, 'round_end') || [];
    if (!ends.length) return [];
    const last = Math.max(...ends.map((e) => e.tick));
    let rows = dp.parseTicks(demoPath, ['team_rounds_total', 'team_num'], [last + 64]);
    if (!rows.length) rows = dp.parseTicks(demoPath, ['team_rounds_total', 'team_num'], [last]);
    const byTeam = new Map();
    for (const r of rows) {
      if (r.team_num !== 2 && r.team_num !== 3) continue;
      const t = byTeam.get(r.team_num) || { score: 0, players: [] };
      t.score = Math.max(t.score, Number(r.team_rounds_total) || 0);
      t.players.push(sid(r.steamid));
      byTeam.set(r.team_num, t);
    }
    return [...byTeam.values()];
  } catch (_) { return []; }
}

/**
 * Players who left before the end (abandon, disconnect) aren't in the final-tick team list.
 * Put each one on the team whose players they shared a side with most often during the match.
 */
function addLeavers(teams, players, samples) {
  if (teams.length !== 2) return teams;
  const known = new Map();
  teams.forEach((t, i) => t.players.forEach((id) => known.set(id, i)));
  const byTick = new Map();
  for (const r of samples || []) {
    if (r.team_num !== 2 && r.team_num !== 3) continue;
    if (!byTick.has(r.tick)) byTick.set(r.tick, []);
    byTick.get(r.tick).push(r);
  }
  for (const p of players) {
    const id = sid(p.steamid);
    if (known.has(id)) continue;
    const votes = [0, 0];
    for (const rows of byTick.values()) {
      const mine = rows.find((r) => sid(r.steamid) === id);
      if (!mine) continue;
      for (const r of rows) {
        const t = known.get(sid(r.steamid));
        if (t !== undefined && r.team_num === mine.team_num) votes[t] += 1;
      }
    }
    if (votes[0] || votes[1]) teams[votes[0] >= votes[1] ? 0 : 1].players.push(id);
  }
  return teams;
}

/** Parse a .dem file and analyze it. Heavy: run it in a utility process. */
function scanDemo(demoPath, T = THRESHOLDS) {
  const dp = require('@laihoe/demoparser2');
  const players = dp.parsePlayerInfo(demoPath).map((p) => ({ steamid: sid(p.steamid), name: p.name }));
  const deaths = dp.parseEvent(demoPath, 'player_death', [], ['total_rounds_played']) || [];
  let roundStarts = [];
  try { roundStarts = (dp.parseEvent(demoPath, 'round_freeze_end') || []).map((e) => e.tick).sort((a, b) => a - b); } catch (_) {}

  const baseProps = ['X', 'Y', 'Z', 'pitch', 'yaw', 'is_alive', 'team_num'];
  let props = baseProps.concat('approximate_spotted_by');
  const header = dp.parseHeader(demoPath) || {};
  const lastTick = deaths.reduce((m, d) => Math.max(m, d.tick), 0) || Number(header.playback_ticks) || 0;

  const sampleList = [];
  for (let t = 0; t <= lastTick; t += T.sampleEvery) sampleList.push(t);
  const windowSet = new Set();
  for (const d of deaths) for (let t = d.tick - 64; t <= d.tick; t++) if (t >= 0) windowSet.add(t);

  const ticks = (list) => {
    try { return dp.parseTicks(demoPath, props, list); }
    catch (e) { props = baseProps; return dp.parseTicks(demoPath, props, list); } // older parser without spotted data
  };
  const samples = ticks(sampleList);
  const killWindows = ticks([...windowSet]);
  const results = analyze({ players, deaths, roundStarts, samples, killWindows }, T);
  // fun stats for the Stats tab (never allowed to break detection)
  try {
    const stats = require('./matchStats').parseStats(demoPath, { players, deaths, roundStarts, samples });
    for (const r of results) if (stats.has(r.steamid)) { r.stats = { ...stats.get(r.steamid) }; r.highlights = stats.get(r.steamid).highlights || []; }
  } catch (_) {}
  const teams = finalScore(dp, demoPath);
  addLeavers(teams, players, samples);
  for (const r of results) {
    const own = teams.find((t) => t.players.includes(r.steamid));
    const opp = teams.find((t) => t !== own);
    if (own && opp) { r.teamScore = own.score; r.oppScore = opp.score; }
  }
  return { mapName: header.map_name || null, players, teams, results };
}

// ---------------------------------------------------------------------------------------------
// Scrutinize: a deeper, on-request check of ONE player. Runs the normal checks with the strict
// thresholds, at twice the sample rate, plus extra checks that are too noisy to run on everyone:
//   pre-aim  — crosshair already following a hidden enemy just before they come into view
//   aim lock — crosshair glued to a moving target in the moments before a kill
//   smoke    — many kills through smoke
//   headshot — extreme headshot rate
//   blind    — kills while fully flashed
// Any one signal sends the player to Review, where members vote.
const DEEP = {
  ...THRESHOLDS, sampleEvery: 4, trackMinStreak: 16,      // same ~1 s streak at the finer sample rate
  preWindow: 24, preMinOnTicks: 16, preMinTurn: 4, preAims: 3, preAimRate: 0.2,
  lockWindow: 16, lockMaxError: 0.6, lockMinSweep: 4, locks: 3, lockRate: 0.25,
  smokeKills: 3, smokeRate: 0.2, hsMinKills: 12, hsRate: 0.8, blindKills: 3,
  // bomb reads (CT): moving to the site the bomb ends up on before the CT team had any sight of it
  bombAwayFrom: 1800, bombMoved: 1200, bombInfoRange: 1500, bombFakeRange: 2000, bombReads: 3, bombReadRate: 0.5, fakeReads: 2,
  bombHabitRange: 2000, bombUnusual: 2, bombWrongRatio: 3,   // habits: reads must beat where they go anyway
  // triggerbot: fired within 1 tick of the crosshair sliding onto an enemy, kill after kill
  trigMaxTicks: 1, trigMinMove: 1.0, trigBodyUnits: 18, trigKills: 4, trigRate: 0.6, trigMinEligible: 6,
  // no-recoil: aim (view + recoil) stays dead still through a spray
  sprayGapTicks: 10, sprayMinShots: 6, recoilStill: 0.1, recoilSprays: 4, recoilRate: 0.5,
  // spinbot / rage: impossible pitch, or spinning faster than a hand can
  rageTicks: 8, spinDegPerTick: 25, spinMinRun: 16,
  // bhop scripts: long chains of jumps that each land and leave on the perfect tick while gaining speed
  bhopMinGap: 36, bhopMaxGap: 48, bhopMinSpeed: 260, bhopChain: 6, bhopChains: 3,
};

/** data has the same shape as analyze(); killWindows must cover 96 ticks before each of the target's kills. */
/**
 * Bomb reads for one CT player. For every planted round: where did they start (5 s after freeze time) and
 * how far had they moved toward the site the bomb was planted at by the moment their team first had any
 * information about that site (a T seen within 1500 units of it, the plant starting, or a CT dying there)?
 * Moving 1200+ units toward the right site from far away, again and again, with no information, is what
 * radar/ESP looks like. A "fake read" is doing it while the planter had been seen far from that site.
 */
function bombReads(data, me, T) {
  const rows = new Map();
  for (const r of data.samples || []) { if (!rows.has(r.tick)) rows.set(r.tick, new Map()); rows.get(r.tick).set(sid(r.steamid), r); }
  const ticks = [...rows.keys()].sort((a, b) => a - b);
  const near = (t) => { let lo = 0, hi = ticks.length - 1, best = null; while (lo <= hi) { const m = (lo + hi) >> 1; if (ticks[m] <= t) { best = ticks[m]; lo = m + 1; } else hi = m - 1; } return best; };
  const out = { away: 0, reads: 0, fakeReads: 0, unusual: 0, wrong: 0, habit: {}, moments: [] };
  const flat = (a, b) => Math.hypot(a.X - b.X, a.Y - b.Y);
  // the match's bombsites = where bombs were planted (grouped), so we can tell "right site" from "the other site"
  const sites = [];
  for (const p of data.plants || []) {
    const r = rows.get(near(p.tick)); const pl = r && r.get(sid(p.user_steamid));
    if (!pl) continue;
    const c = sites.find((x) => flat(x, pl) < T.bombInfoRange);
    if (c) { c.X = (c.X * c.n + pl.X) / (c.n + 1); c.Y = (c.Y * c.n + pl.Y) / (c.n + 1); c.n += 1; } else sites.push({ X: pl.X, Y: pl.Y, n: 1 });
  }
  // habit: in rounds where the bomb did NOT go to a site, how often did they end up there anyway (35 s in)?
  // Someone who walks to B every round has a high B habit; someone who only shows up where the bomb is, doesn't.
  const plantRound = (p) => [...(data.roundStarts || [])].filter((t) => t < p.tick).pop();
  const habitOf = (site) => {
    let n = 0, there = 0;
    for (const st of data.roundStarts || []) {
      const plantedHere = (data.plants || []).some((p) => plantRound(p) === st && (() => { const r = rows.get(near(p.tick)); const pl = r && r.get(sid(p.user_steamid)); return pl && flat(pl, site) < T.bombInfoRange; })());
      if (plantedHere) continue;
      const r = rows.get(near(st + 35 * 64)); const row = r && r.get(me);
      if (!row || row.team_num !== 3 || row.is_alive === false) continue;
      n += 1; if (flat(row, site) < T.bombHabitRange) there += 1;
    }
    return n >= 3 ? there / n : 0.5;     // too few other rounds to know their habit: count reads at half weight
  };
  for (const st of sites) st.habit = habitOf(st);
  for (const p of data.plants || []) {
    const start = [...(data.roundStarts || [])].filter((t) => t < p.tick).pop();
    if (start == null) continue;
    const at = rows.get(near(p.tick)); const planter = at && at.get(sid(p.user_steamid));
    if (!planter) continue;
    const site = { X: planter.X, Y: planter.Y };
    const begin = Math.min(p.tick, ...(data.beginPlants || []).filter((b) => b.tick > start && b.tick <= p.tick).map((b) => b.tick));
    const t0 = near(start + 5 * 64);
    const first = t0 != null && rows.get(t0).get(me);
    if (!first || first.team_num !== 3 || first.is_alive === false) continue;
    let infoTick = begin, sawFake = false;
    for (const t of ticks) {
      if (t < t0) continue;
      if (t >= begin) break;
      const snap = rows.get(t);
      const cts = [...snap].filter(([, r]) => r.team_num === 3);
      const ctIds = new Set(cts.map(([id]) => id));
      let info = cts.some(([, r]) => r.is_alive === false && flat(r, site) < T.bombInfoRange);   // a CT died there
      for (const [id, r] of snap) {
        if (r.team_num !== 2 || r.is_alive === false) continue;
        const seen = [...(spottedSet(r) || [])].some((x) => ctIds.has(x));
        if (!seen) continue;
        if (flat(r, site) < T.bombInfoRange) info = true;
        else if (id === sid(p.user_steamid) && flat(r, site) > T.bombFakeRange) sawFake = true;
      }
      if (info) { infoTick = t; break; }
    }
    const last = rows.get(near(infoTick)) && rows.get(near(infoTick)).get(me);
    if (!last || last.is_alive === false) continue;
    const d0 = flat(first, site), d1 = flat(last, site);
    if (d0 < T.bombAwayFrom) continue;     // already there (their spawn / their usual spot): not a read
    out.away += 1;
    const here = sites.find((x) => flat(x, site) < T.bombInfoRange) || { habit: 0 };
    const other = sites.find((x) => x !== here);
    if (other && flat(first, other) - flat(last, other) >= T.bombMoved && d0 - d1 < T.bombMoved) out.wrong += 1;   // went to the other site
    if (d0 - d1 >= T.bombMoved) {
      out.reads += 1;
      out.unusual += 1 - here.habit;       // a site they head to most rounds anyway counts for little
      if (sawFake && here.habit <= 0.5) out.fakeReads += 1;
      out.moments.push({ tick: t0, round: roundAt(p.tick, data.roundStarts || []), what: sawFake ? 'Went to the real bomb site while the bomb was seen elsewhere' : 'Rotated to the bomb site before anyone saw it' });
    }
  }
  out.habit = Object.fromEntries(sites.map((x, i) => [i, Math.round(x.habit * 100)]));
  return out;
}

const SPRAY_WEAPONS = /ak47|m4a1|m4a1_silencer|famas|galilar|aug|sg556|mp9|mac10|mp7|mp5sd|ump45|p90|bizon|m249|negev|cz75a/;
const punchOf = (row) => {
  const v = row && row.aim_punch_angle;
  if (v == null) return null;
  if (Array.isArray(v)) return { p: Number(v[0]) || 0, y: Number(v[1]) || 0 };
  if (typeof v === 'object') return { p: Number(v.x ?? v.X ?? v[0]) || 0, y: Number(v.y ?? v.Y ?? v[1]) || 0 };
  return null;
};

/** Triggerbot, no-recoil, spinbot/rage and bhop-script checks for one player (Scrutinize only). */
function mechanicsChecks(data, me, T = DEEP) {
  const out = { trig: 0, trigEligible: 0, stillSprays: 0, sprays: 0, rageTicks: 0, spinRuns: 0, bhopChains: 0, moments: [] };
  const rs = data.roundStarts || [];
  // --- triggerbot (kill windows hold every tick before each of their kills)
  const win = new Map();
  for (const r of data.killWindows || []) { if (!win.has(r.tick)) win.set(r.tick, new Map()); win.get(r.tick).set(sid(r.steamid), r); }
  const at = (t, who) => win.get(t) && win.get(t).get(sid(who));
  const fires = (data.fires || []).filter((f) => sid(f.user_steamid) === me).map((f) => f.tick).sort((a, b) => a - b);
  for (const d of data.deaths || []) {
    if (sid(d.attacker_steamid) !== me || sid(d.user_steamid) === me || NON_AIM_WEAPONS.test(d.weapon || '')) continue;
    const shot = fires.find((f) => f >= d.tick - 96 && f <= d.tick);
    if (shot == null) continue;
    let entry = null;
    for (let t = shot - 16; t <= shot; t++) {
      const a = at(t, me), v = at(t, d.user_steamid);
      if (!a || !v) continue;
      const dist = distance(a, v);
      if (aimError(a, v) <= Math.atan(T.trigBodyUnits / Math.max(dist, 1)) * 180 / Math.PI) { entry = t; break; }
    }
    if (entry == null) continue;
    const before = at(entry - 2, me), onIt = at(entry, me);
    if (!before || !onIt || viewDelta(before, onIt) < T.trigMinMove) continue;   // crosshair was already resting there: not a trigger case
    out.trigEligible += 1;
    if (shot - entry <= T.trigMaxTicks) { out.trig += 1; out.moments.push({ tick: shot - 64, round: roundAt(shot, rs), what: 'Fired the instant the crosshair touched an enemy' }); }
  }
  // --- no-recoil: sprays of 6+ shots; aim = view + 2 x recoil punch should wander for a human
  const fireRows = new Map((data.fireRows || []).filter((r) => sid(r.steamid) === me).map((r) => [r.tick, r]));
  const myFires = (data.fires || []).filter((f) => sid(f.user_steamid) === me && SPRAY_WEAPONS.test(String(f.weapon || '')));
  let spray = [];
  const endSpray = () => {
    if (spray.length >= T.sprayMinShots) {
      const pts = spray.slice(3).map((t) => { const r = fireRows.get(t); const pu = punchOf(r); return r && pu ? r.pitch + 2 * pu.p : null; }).filter((x) => x != null);
      if (pts.length >= 3) {
        out.sprays += 1;
        const mean = pts.reduce((a, b) => a + b, 0) / pts.length;
        const sd = Math.sqrt(pts.reduce((a, b) => a + (b - mean) ** 2, 0) / pts.length);
        if (sd < T.recoilStill) { out.stillSprays += 1; out.moments.push({ tick: spray[0] - 64, round: roundAt(spray[0], rs), what: 'Spray with no recoil movement at all' }); }
      }
    }
    spray = [];
  };
  for (const f of myFires) { if (spray.length && f.tick - spray[spray.length - 1] > T.sprayGapTicks) endSpray(); spray.push(f.tick); }
  endSpray();
  // --- spinbot / rage (samples every few ticks)
  const mine = (data.samples || []).filter((r) => sid(r.steamid) === me && r.is_alive !== false).sort((a, b) => a.tick - b.tick);
  let run = 0, inSpin = false;
  for (let i = 0; i < mine.length; i++) {
    const r = mine[i], p = mine[i - 1];
    if (Math.abs(Number(r.pitch)) > 89.5) out.rageTicks += 1;
    const fast = p && r.tick - p.tick <= 8 && Math.abs(((r.yaw - p.yaw + 540) % 360) - 180) / (r.tick - p.tick) >= T.spinDegPerTick;
    if (!fast) { run = 0; inSpin = false; continue; }
    run += r.tick - p.tick;
    if (run >= T.spinMinRun && !inSpin) { inSpin = true; out.spinRuns += 1; out.moments.push({ tick: r.tick - 64, round: roundAt(r.tick, rs), what: 'Spinning faster than a hand can' }); }
  }
  // --- bhop chains
  const jumps = (data.jumps || []).filter((j) => sid(j.user_steamid) === me).map((j) => j.tick).sort((a, b) => a - b);
  const speedAt = (t) => { const i = mine.findIndex((r) => r.tick >= t); const a = mine[i - 1], b = mine[i]; return a && b && b.tick > a.tick ? Math.hypot(b.X - a.X, b.Y - a.Y) / ((b.tick - a.tick) / 64) : 0; };
  let chain = 1;
  for (let i = 1; i <= jumps.length; i++) {
    const gap = i < jumps.length ? jumps[i] - jumps[i - 1] : 0;
    if (i < jumps.length && gap >= T.bhopMinGap && gap <= T.bhopMaxGap && speedAt(jumps[i]) >= T.bhopMinSpeed) chain += 1;
    else { if (chain >= T.bhopChain) { out.bhopChains += 1; out.moments.push({ tick: jumps[i - 1] - 64 * 4, round: roundAt(jumps[i - 1], rs), what: `${chain} perfect bunny hops in a row` }); } chain = 1; }
  }
  return out;
}

function deepAnalyze(data, steamid, T = DEEP) {
  const me = sid(steamid);
  const base = analyze(data, T).find((r) => r.steamid === me);
  if (!base) throw new Error('That player is not in this demo.');
  const rows = new Map();
  for (const r of data.killWindows || []) { if (!rows.has(r.tick)) rows.set(r.tick, new Map()); rows.get(r.tick).set(sid(r.steamid), r); }
  const at = (t, who) => rows.get(t) && rows.get(t).get(sid(who));
  const roundStarts = data.roundStarts || [];
  const m = { kills: 0, headshots: 0, smokeKills: 0, blindKills: 0, preAims: 0, locks: 0, checkedKills: 0 };
  const moments = [...(base.moments || [])];
  for (const d of data.deaths || []) {
    if (sid(d.attacker_steamid) !== me || sid(d.user_steamid) === me || NON_AIM_WEAPONS.test(d.weapon || '')) continue;
    m.kills += 1;
    const round = roundAt(d.tick, roundStarts);
    if (d.headshot) m.headshots += 1;
    if (d.thrusmoke) { m.smokeKills += 1; moments.push({ tick: d.tick - 96, round, what: 'Kill through smoke' }); }
    if (d.attackerblind) { m.blindKills += 1; moments.push({ tick: d.tick - 96, round, what: 'Kill while flashed' }); }
    // first tick the victim was visible to us
    let firstSpot = null;
    for (let t = d.tick - 96; t <= d.tick; t++) { const v = at(t, d.user_steamid); const s = v && spottedSet(v); if (s && s.has(me)) { firstSpot = t; break; } }
    if (firstSpot == null) continue;
    m.checkedKills += 1;
    // pre-aim: crosshair on the hidden enemy (and moving with them) just before they appear
    const from = firstSpot - T.preWindow;
    if (from >= d.tick - 96) {
      let on = 0, first = null, last = null;
      for (let t = from; t < firstSpot; t++) {
        const a = at(t, me), v = at(t, d.user_steamid);
        if (!a || !v) continue;
        first = first || a; last = a;
        const dist = distance(a, v);
        if (dist > T.trackMinDistance && aimError(a, v) <= Math.min(T.trackMaxError, Math.atan(T.trackBodyUnits / dist) * 180 / Math.PI)) on += 1;
      }
      if (on >= T.preMinOnTicks && first && last && viewDelta(first, last) >= T.preMinTurn) {
        m.preAims += 1; moments.push({ tick: from - 32, round, what: 'Aimed at an enemy before they were visible' });
      }
    }
    // aim lock: glued to a target that is moving across the screen
    const s0 = at(d.tick - T.lockWindow, me), v0 = at(d.tick - T.lockWindow, d.user_steamid), s1 = at(d.tick - 1, me), v1 = at(d.tick - 1, d.user_steamid);
    if (s0 && v0 && s1 && v1 && angleBetween(bearing(s0, v0), bearing(s1, v1)) >= T.lockMinSweep) {
      let locked = true;
      for (let t = d.tick - T.lockWindow; t < d.tick && locked; t++) { const a = at(t, me), v = at(t, d.user_steamid); if (!a || !v || aimError(a, v) > T.lockMaxError) locked = false; }
      if (locked) { m.locks += 1; moments.push({ tick: d.tick - T.lockWindow - 32, round, what: 'Crosshair locked on a moving target' }); }
    }
  }
  const bomb = bombReads(data, me, T);
  const mech = mechanicsChecks(data, me, T);
  Object.assign(m, { trig: mech.trig, trigEligible: mech.trigEligible, stillSprays: mech.stillSprays, sprays: mech.sprays, rageTicks: mech.rageTicks, spinRuns: mech.spinRuns, bhopChains: mech.bhopChains });
  moments.push(...mech.moments);
  m.bombAway = bomb.away; m.bombReads = bomb.reads; m.fakeReads = bomb.fakeReads; m.bombWrong = bomb.wrong; m.bombUnusual = Math.round(bomb.unusual * 10) / 10;
  moments.push(...bomb.moments);
  const verdict = judge(base.metrics, T, 'high');    // strict thresholds, any one signal counts
  const signals = [...verdict.signals];
  const rate = (n, of) => (of ? n / of : 0);
  if (m.preAims >= T.preAims && rate(m.preAims, m.checkedKills) >= T.preAimRate) signals.push({ type: 'wallhack', name: 'Aimed at enemies before they were visible', value: `${m.preAims} of ${m.checkedKills} kills`, extreme: false });
  if (m.locks >= T.locks && rate(m.locks, m.checkedKills) >= T.lockRate) signals.push({ type: 'aimbot', name: 'Crosshair locked on moving targets', value: `${m.locks} of ${m.checkedKills} kills`, extreme: false });
  if (m.smokeKills >= T.smokeKills && rate(m.smokeKills, m.kills) >= T.smokeRate) signals.push({ type: 'wallhack', name: 'Kills through smoke', value: `${m.smokeKills} of ${m.kills} kills`, extreme: false });
  if (m.kills >= T.hsMinKills && rate(m.headshots, m.kills) >= T.hsRate) signals.push({ type: 'aimbot', name: 'Extreme headshot rate', value: Math.round(rate(m.headshots, m.kills) * 100) + '%', extreme: false });
  if (bomb.reads >= T.bombReads && rate(bomb.reads, bomb.away) >= T.bombReadRate && bomb.unusual >= T.bombUnusual && bomb.reads >= T.bombWrongRatio * bomb.wrong) signals.push({ type: 'wallhack', name: 'Rotated to the bomb site before anyone saw it', value: `${bomb.reads} of ${bomb.away} planted rounds, wrong site ${bomb.wrong}×`, extreme: false });
  if (bomb.fakeReads >= T.fakeReads) signals.push({ type: 'wallhack', name: 'Ignored fakes: went to the real site while the bomb was seen elsewhere', value: `${bomb.fakeReads} rounds`, extreme: false });
  if (mech.trig >= T.trigKills && mech.trigEligible >= T.trigMinEligible && rate(mech.trig, mech.trigEligible) >= T.trigRate) signals.push({ type: 'aimbot', name: 'Triggerbot: fired the instant the crosshair touched an enemy', value: `${mech.trig} of ${mech.trigEligible} kills`, extreme: false });
  if (mech.stillSprays >= T.recoilSprays && rate(mech.stillSprays, mech.sprays) >= T.recoilRate) signals.push({ type: 'aimbot', name: 'No recoil: sprays with no recoil movement', value: `${mech.stillSprays} of ${mech.sprays} sprays`, extreme: false });
  if (mech.rageTicks >= T.rageTicks || mech.spinRuns >= 1) signals.push({ type: 'aimbot', name: 'Rage cheat: impossible view angles or spinning', value: mech.spinRuns ? `${mech.spinRuns} spins` : 'impossible aim angles', extreme: true });
  if (mech.bhopChains >= T.bhopChains) signals.push({ type: 'aimbot', name: 'Bhop script: perfect bunny-hop chains', value: `${mech.bhopChains} chains`, extreme: false });
  if (m.blindKills >= T.blindKills) signals.push({ type: 'aimbot', name: 'Kills while fully flashed', value: m.blindKills, extreme: false });
  const wall = signals.filter((x) => x.type === 'wallhack').length, aim = signals.length - wall;
  const rounds = new Set(base.rounds); for (const x of moments) rounds.add(x.round);
  return {
    steamid: me, name: base.name, kills: base.kills, scrutiny: 'deep',
    flagged: signals.length > 0, signals,
    category: !signals.length ? null : wall >= aim ? 'Wallhack' : 'Aimbot',
    score: Math.min(100, signals.reduce((a, x) => a + (x.extreme ? 60 : 35), 0)),
    rounds: [...rounds].sort((a, b) => a - b),
    moments: moments.sort((a, b) => a.tick - b.tick).slice(0, 20),
    metrics: { ...base.metrics, ...m },
  };
}

/** Parse a .dem file and scrutinize one player. Heavy: run it in a utility process. */
function deepScan(demoPath, steamid, T = DEEP) {
  const dp = require('@laihoe/demoparser2');
  const players = dp.parsePlayerInfo(demoPath).map((p) => ({ steamid: sid(p.steamid), name: p.name }));
  const deaths = dp.parseEvent(demoPath, 'player_death', [], ['total_rounds_played']) || [];
  let roundStarts = [];
  try { roundStarts = (dp.parseEvent(demoPath, 'round_freeze_end') || []).map((e) => e.tick).sort((a, b) => a - b); } catch (_) {}
  const header = dp.parseHeader(demoPath) || {};
  const lastTick = deaths.reduce((x, d) => Math.max(x, d.tick), 0) || Number(header.playback_ticks) || 0;
  const props = ['X', 'Y', 'Z', 'pitch', 'yaw', 'is_alive', 'team_num', 'approximate_spotted_by'];
  const sampleList = [];
  for (let t = 0; t <= lastTick; t += T.sampleEvery) sampleList.push(t);
  const windowSet = new Set();
  for (const d of deaths) {
    const mine = sid(d.attacker_steamid) === sid(steamid);
    for (let t = d.tick - (mine ? 96 : 64); t <= d.tick; t++) if (t >= 0) windowSet.add(t);
  }
  const samples = dp.parseTicks(demoPath, props, sampleList);
  const killWindows = dp.parseTicks(demoPath, props, [...windowSet]);
  let plants = [], beginPlants = [];
  try { plants = dp.parseEvent(demoPath, 'bomb_planted') || []; beginPlants = dp.parseEvent(demoPath, 'bomb_beginplant') || []; } catch (_) {}
  let fires = [], jumps = [], fireRows = [];
  try { fires = (dp.parseEvent(demoPath, 'weapon_fire') || []).filter((f) => sid(f.user_steamid) === sid(steamid)); } catch (_) {}
  try { jumps = (dp.parseEvent(demoPath, 'player_jump') || []).filter((j) => sid(j.user_steamid) === sid(steamid)); } catch (_) {}
  try { if (fires.length) fireRows = dp.parseTicks(demoPath, ['pitch', 'yaw', 'aim_punch_angle'], [...new Set(fires.map((f) => f.tick))]); } catch (_) {}
  return deepAnalyze({ players, deaths, roundStarts, samples, killWindows, plants, beginPlants, fires, jumps, fireRows }, steamid, T);
}

const SCANNER_VERSION = 6;   // 6: "how did I die", players who left early, highlights, economy
module.exports = { addLeavers, bombReads, mechanicsChecks, analyze, scanDemo, judge, applyScrutiny, deepAnalyze, deepScan, THRESHOLDS, STRICT, DEEP, SCANNER_VERSION };
