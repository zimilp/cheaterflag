'use strict';
// In-app 2D replay of one moment of a demo: who was where, where everyone was aiming, who could see whom,
// kills, shots, flashes and smokes. The map outline is built from where players walked during the whole match,
// so no game files are needed and every map (including new ones) works.

const CELL = 48;              // map outline resolution in game units
const BEFORE = 64 * 5, AFTER = 64 * 5, STEP = 2;

function sid(v) { return v == null ? null : String(v); }
function spottedList(v) {
  if (v == null) return [];
  return (Array.isArray(v) ? v : String(v).split(/[,\s]+/)).map(String).filter(Boolean);
}

/** Occupied cells of a top-down grid → { cell, minX, maxY, cols, rows, data: base64 bitmap }. */
function buildFloor(points, cell = CELL) {
  if (!points.length) return null;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [x, y] of points) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
  minX -= cell * 2; minY -= cell * 2; maxX += cell * 2; maxY += cell * 2;
  const cols = Math.ceil((maxX - minX) / cell), rows = Math.ceil((maxY - minY) / cell);
  const bits = Buffer.alloc(Math.ceil(cols * rows / 8));
  const set = (c, r) => { if (c < 0 || r < 0 || c >= cols || r >= rows) return; const i = r * cols + c; bits[i >> 3] |= 1 << (i & 7); };
  for (const [x, y] of points) {
    const c = Math.floor((x - minX) / cell), r = Math.floor((maxY - y) / cell);
    set(c, r); set(c + 1, r); set(c - 1, r); set(c, r + 1); set(c, r - 1);   // players are ~32 units wide: widen a little
  }
  return { cell, minX, maxY, cols, rows, data: bits.toString('base64') };
}
function floorHas(floor, x, y) {
  const c = Math.floor((x - floor.minX) / floor.cell), r = Math.floor((floor.maxY - y) / floor.cell);
  if (c < 0 || r < 0 || c >= floor.cols || r >= floor.rows) return false;
  const i = r * floor.cols + c, bits = Buffer.from(floor.data, 'base64');
  return !!(bits[i >> 3] & (1 << (i & 7)));
}

/** Bomb site centres from plants: [{ name: 'A'|'B', x, y }]. */
function sitesFrom(plants) {
  const by = {};
  for (const p of plants) {
    const place = String(p.user_last_place_name || p.last_place_name || '');
    const m = /bombsite\s*([ab])/i.exec(place) || /^([ab])\s*site/i.exec(place);
    const key = m ? m[1].toUpperCase() : String(p.site);
    const x = Number(p.user_X ?? p.X), y = Number(p.user_Y ?? p.Y);
    if (!isFinite(x) || !isFinite(y)) continue;
    (by[key] = by[key] || []).push([x, y]);
  }
  return Object.entries(by).filter(([k]) => k === 'A' || k === 'B').map(([name, pts]) => ({
    name, x: Math.round(pts.reduce((a, p) => a + p[0], 0) / pts.length), y: Math.round(pts.reduce((a, p) => a + p[1], 0) / pts.length),
  }));
}

/** Packs parsed rows into compact frames. Each player entry: [index, x, y, yaw, pitch, alive, hp, spottedByMask]. */
function packFrames(rows, players) {
  const idx = new Map(players.map((p, i) => [p.steamid, i]));
  const byTick = new Map();
  for (const r of rows) {
    const i = idx.get(sid(r.steamid)); if (i == null) continue;
    let mask = 0; for (const s of spottedList(r.approximate_spotted_by)) { const j = idx.get(s); if (j != null) mask |= 1 << j; }
    if (!byTick.has(r.tick)) byTick.set(r.tick, []);
    byTick.get(r.tick).push([i, Math.round(r.X), Math.round(r.Y), +Number(r.yaw).toFixed(1), +Number(r.pitch).toFixed(1), r.is_alive === false ? 0 : 1, r.health == null ? null : Number(r.health), mask]);
  }
  return [...byTick.keys()].sort((a, b) => a - b).map((t) => ({ t, p: byTick.get(t) }));
}

function safeEvent(dp, f, name, props = []) { try { return dp.parseEvent(f, name, props) || []; } catch (_) { return []; } }

/** Floor + sites for a whole demo (slow part: cache per demo). */
function demoBackground(demoPath) {
  const dp = require('@laihoe/demoparser2');
  const header = dp.parseHeader(demoPath) || {};
  const deaths = safeEvent(dp, demoPath, 'player_death');
  const last = deaths.reduce((m, d) => Math.max(m, d.tick), 0) || Number(header.playback_ticks) || 0;
  const ticks = []; for (let t = 0; t <= last; t += 32) ticks.push(t);
  const pts = (dp.parseTicks(demoPath, ['X', 'Y', 'is_alive'], ticks) || []).filter((r) => r.is_alive !== false && r.X != null).map((r) => [r.X, r.Y]);
  const plants = safeEvent(dp, demoPath, 'bomb_planted', ['X', 'Y', 'last_place_name']);
  return { map: header.map_name || null, floor: buildFloor(pts), sites: sitesFrom(plants) };
}

/** One moment: frames from ~5 s before to ~5 s after `tick`. */
function buildReplay(demoPath, tick, focus, bg = null) {
  const dp = require('@laihoe/demoparser2');
  bg = bg || demoBackground(demoPath);
  const players = dp.parsePlayerInfo(demoPath).map((p) => ({ steamid: sid(p.steamid), name: p.name }));
  const from = Math.max(0, Math.floor(tick) - BEFORE), to = Math.floor(tick) + AFTER;
  const ticks = []; for (let t = from; t <= to; t += STEP) ticks.push(t);
  const rows = dp.parseTicks(demoPath, ['X', 'Y', 'pitch', 'yaw', 'is_alive', 'health', 'team_num', 'approximate_spotted_by'], ticks) || [];
  const team = {}; for (const r of rows) if (r.team_num) team[sid(r.steamid)] = Number(r.team_num);
  const list = players.filter((p) => team[p.steamid] === 2 || team[p.steamid] === 3).map((p) => ({ ...p, team: team[p.steamid] === 3 ? 'CT' : 'T' }));
  const frames = packFrames(rows, list);
  const idx = new Map(list.map((p, i) => [p.steamid, i]));
  const inWin = (e, pad = 0) => e.tick >= from - pad && e.tick <= to;
  const events = [];
  // all event types in one pass over the demo (one pass per type was ~1 s each)
  let all = [];
  try { all = dp.parseEvents(demoPath, ['player_death', 'weapon_fire', 'smokegrenade_detonate', 'inferno_startburn', 'flashbang_detonate', 'hegrenade_detonate', 'player_blind']) || []; } catch (_) {}
  const of = (n) => all.filter((e) => e.event_name === n);
  for (const d of of('player_death')) if (inWin(d)) events.push({ t: d.tick, type: 'kill', a: idx.get(sid(d.attacker_steamid)) ?? null, v: idx.get(sid(d.user_steamid)) ?? null, weapon: String(d.weapon || '').replace(/^weapon_/, ''), hs: !!d.headshot, wall: Number(d.penetrated) > 0, smoke: !!d.thrusmoke, blind: !!d.attackerblind });
  for (const s of of('weapon_fire')) if (inWin(s) && !/knife|grenade|flashbang|smoke|molotov|incgrenade|decoy|c4/.test(s.weapon || '')) events.push({ t: s.tick, type: 'shot', a: idx.get(sid(s.user_steamid)) ?? null });
  for (const s of of('smokegrenade_detonate')) if (inWin(s, 64 * 20)) events.push({ t: s.tick, type: 'smoke', x: Math.round(s.x), y: Math.round(s.y), until: s.tick + 64 * 20 });
  for (const s of of('inferno_startburn')) if (inWin(s, 64 * 7)) events.push({ t: s.tick, type: 'fire', x: Math.round(s.x), y: Math.round(s.y), until: s.tick + 64 * 7 });
  for (const s of of('flashbang_detonate')) if (inWin(s)) events.push({ t: s.tick, type: 'flash', x: Math.round(s.x), y: Math.round(s.y) });
  for (const s of of('hegrenade_detonate')) if (inWin(s)) events.push({ t: s.tick, type: 'he', x: Math.round(s.x), y: Math.round(s.y) });
  for (const s of of('player_blind')) if (inWin(s)) events.push({ t: s.tick, type: 'blind', v: idx.get(sid(s.user_steamid)) ?? null, until: s.tick + Math.round(Number(s.blind_duration || 0) * 64) });
  events.sort((a, b) => a.t - b.t);
  return { map: bg.map, floor: bg.floor, sites: bg.sites, tickrate: 64, from, to, moment: Math.floor(tick), focus: focus ? idx.get(String(focus)) ?? null : null, players: list, frames, events };
}

module.exports = { buildReplay, demoBackground, buildFloor, floorHas, sitesFrom, packFrames, CELL };
