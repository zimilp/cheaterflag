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

const SCANNER_VERSION = 5;
module.exports = { analyze, scanDemo, judge, applyScrutiny, THRESHOLDS, STRICT, SCANNER_VERSION };
