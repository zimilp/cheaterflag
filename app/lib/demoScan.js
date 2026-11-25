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

  // ---- 2) kills: snaps, reaction time, unseen wallbangs
  for (const d of data.deaths || []) {
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
        if (Number(d.penetrated) > 0 && !d.thrusmoke) { st.unseenWallbangs += 1; st.rounds.add(round); st.moments.push({ tick: d.tick - 128, round, what: 'Wallbang kill on an unseen enemy' }); }
      } else if (firstSpot > d.tick - 64) {
        st.reactions.push(d.tick - firstSpot);
      }
    }
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
  const teams = finalScore(dp, demoPath);
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
};

/** data has the same shape as analyze(); killWindows must cover 96 ticks before each of the target's kills. */
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
  const verdict = judge(base.metrics, T, 'high');    // strict thresholds, any one signal counts
  const signals = [...verdict.signals];
  const rate = (n, of) => (of ? n / of : 0);
  if (m.preAims >= T.preAims && rate(m.preAims, m.checkedKills) >= T.preAimRate) signals.push({ type: 'wallhack', name: 'Aimed at enemies before they were visible', value: `${m.preAims} of ${m.checkedKills} kills`, extreme: false });
  if (m.locks >= T.locks && rate(m.locks, m.checkedKills) >= T.lockRate) signals.push({ type: 'aimbot', name: 'Crosshair locked on moving targets', value: `${m.locks} of ${m.checkedKills} kills`, extreme: false });
  if (m.smokeKills >= T.smokeKills && rate(m.smokeKills, m.kills) >= T.smokeRate) signals.push({ type: 'wallhack', name: 'Kills through smoke', value: `${m.smokeKills} of ${m.kills} kills`, extreme: false });
  if (m.kills >= T.hsMinKills && rate(m.headshots, m.kills) >= T.hsRate) signals.push({ type: 'aimbot', name: 'Extreme headshot rate', value: Math.round(rate(m.headshots, m.kills) * 100) + '%', extreme: false });
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
  return deepAnalyze({ players, deaths, roundStarts, samples, killWindows }, steamid, T);
}

const SCANNER_VERSION = 5;
module.exports = { analyze, scanDemo, judge, applyScrutiny, deepAnalyze, deepScan, THRESHOLDS, STRICT, DEEP, SCANNER_VERSION };
