'use strict';
const test = require('node:test');
const assert = require('node:assert');
const R = require('../lib/replay');
const P = require('../renderer/replay');
const { analyze, THRESHOLDS } = require('../lib/demoScan');

test('map outline marks walked cells and nothing far away', () => {
  const pts = []; for (let x = 0; x <= 2000; x += 20) pts.push([x, 500]);
  const f = R.buildFloor(pts);
  assert.ok(R.floorHas(f, 1000, 500));
  assert.ok(!R.floorHas(f, 1000, 1500));
});

test('bomb sites come from where the bomb was planted', () => {
  const s = R.sitesFrom([{ user_X: 100, user_Y: 100, user_last_place_name: 'BombsiteA' }, { user_X: 300, user_Y: 100, user_last_place_name: 'BombsiteA' }, { user_X: -900, user_Y: 0, user_last_place_name: 'BombsiteB' }]);
  assert.deepEqual(s.find((x) => x.name === 'A'), { name: 'A', x: 200, y: 100 });
  assert.equal(s.find((x) => x.name === 'B').x, -900);
});

test('frames pack who-spotted-whom as a bitmask', () => {
  const players = [{ steamid: '1' }, { steamid: '2' }];
  const fr = R.packFrames([{ tick: 10, steamid: '1', X: 0, Y: 0, yaw: 0, pitch: 0, is_alive: true, health: 100, approximate_spotted_by: ['2'] }, { tick: 10, steamid: '2', X: 5, Y: 5, yaw: 90, pitch: 0, is_alive: true, health: 80, approximate_spotted_by: [] }], players);
  assert.equal(fr[0].p.find((r) => r[0] === 0)[7], 2);
  assert.equal(fr[0].p.find((r) => r[0] === 1)[7], 0);
});

function moment({ spottedFrom = null, wallKill = false }) {
  // player 0 (T) at the origin aims along +X at player 1 (CT) 1000 units away; 0 kills 1 at tick 200
  const frames = [];
  for (let t = 0; t <= 260; t += 2) frames.push({ t, p: [[0, 0, 0, 0, 0, 1, 100, 0], [1, 1000, 0, 180, 0, t <= 200 ? 1 : 0, 100, spottedFrom != null && t >= spottedFrom ? 1 : 0]] });
  return { players: [{ steamid: 'a', name: 'A', team: 'T' }, { steamid: 'b', name: 'B', team: 'CT' }], frames, events: [{ t: 200, type: 'kill', a: 0, v: 1, wall: wallKill }], from: 0, to: 260, moment: 150, focus: 0, tickrate: 64 };
}

test('replay: the spotted flag lag is allowed for, and a clean kill means line of sight', () => {
  const lag = P.lagAdjust(moment({ spottedFrom: 120 }));
  assert.ok(P.stateAt(lag, 100).find((s) => s.i === 1).mask & 1, 'visible half a second before the flag caught up');
  assert.ok(!(P.stateAt(lag, 60).find((s) => s.i === 1).mask & 1), 'hidden well before');
  const never = P.lagAdjust(moment({}));
  assert.ok(P.stateAt(never, 190).find((s) => s.i === 1).mask & 1, 'non-wallbang kill: visible just before it');
  const wall = P.lagAdjust(moment({ wallKill: true }));
  assert.ok(!(P.stateAt(wall, 190).find((s) => s.i === 1).mask & 1), 'wallbang: still hidden');
});

test('replay: aim error and the fight target', () => {
  assert.ok(P.aimError({ x: 0, y: 0, yaw: 0 }, { x: 1000, y: 0 }) < 0.01);
  assert.ok(Math.abs(P.aimError({ x: 0, y: 0, yaw: 90 }, { x: 1000, y: 0 }) - 90) < 0.01);
  const d = moment({});
  assert.equal(P.targetOf(d), 1);
  const st = P.stateAt(d, 201);   // interpolates between frames
  assert.equal(st.length, 2);
});

// ---- wall-tracking must not count the moments the "spotted" flag was simply late
function trackData({ spotAfter }) {
  // shooter s stands still at the origin; enemy e walks sideways 1200 units away; s aims dead on the whole time.
  // e is "hidden" (not spotted) until tick `spotAfter`, then spotted.
  const players = [{ steamid: 's', name: 'S' }, { steamid: 'e', name: 'E' }], samples = [];
  for (let t = 0; t <= 400; t += 8) {
    const ey = -400 + t * 2, e = { X: 1200, Y: ey, Z: 0 };
    const yaw = Math.atan2(e.Y, e.X) * 180 / Math.PI;
    samples.push({ tick: t, steamid: 's', X: 0, Y: 0, Z: 0, pitch: 0, yaw, is_alive: true, team_num: 2, approximate_spotted_by: [] });
    samples.push({ tick: t, steamid: 'e', ...e, pitch: 0, yaw: 180, is_alive: true, team_num: 3, approximate_spotted_by: t >= spotAfter ? ['s'] : [] });
  }
  return { players, deaths: [], roundStarts: [0], samples, killWindows: [] };
}
const wallOf = (d) => analyze(d, THRESHOLDS).find((r) => r.steamid === 's').metrics.wallStreaks;
test('wall-tracking: a long track through a wall counts; one the spotted flag was just late for does not', () => {
  assert.equal(wallOf(trackData({ spotAfter: 9999 })), 1);       // tracked hidden enemy the whole time
  assert.equal(wallOf(trackData({ spotAfter: 104 })), 0);        // hidden ~1.6 s, but the last 0.5 s was flag lag: what is left is too short to count
  assert.equal(wallOf(trackData({ spotAfter: 200 })), 1);        // hidden for 3 s before being seen: still counts
});
