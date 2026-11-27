'use strict';
// Each test: an ordinary in-game explanation must NOT count, while the cheat version still does.
const test = require('node:test');
const assert = require('node:assert');
const { analyze, judge, mechanicsChecks, THRESHOLDS, DEEP } = require('../lib/demoScan');

// shooter s (team 2, at the origin) keeps the crosshair on enemy e (team 3) 1200 units away for 6 s.
// opts: e walks (silent) or runs; teammate m may spot e; e may shoot.
function track({ enemySpeed = 60, mateSpots = false, enemyFires = false } = {}) {
  const players = [{ steamid: 's', name: 'S' }, { steamid: 'm', name: 'M' }, { steamid: 'e', name: 'E' }], samples = [];
  for (let t = 0; t <= 384; t += 8) {
    const e = { X: 1200, Y: -200 + (t / 64) * enemySpeed, Z: 0 };
    samples.push({ tick: t, steamid: 's', X: 0, Y: 0, Z: 0, pitch: 0, yaw: Math.atan2(e.Y, e.X) * 180 / Math.PI, is_alive: true, team_num: 2, approximate_spotted_by: [] });
    samples.push({ tick: t, steamid: 'm', X: -3000, Y: 0, Z: 0, pitch: 0, yaw: 0, is_alive: true, team_num: 2, approximate_spotted_by: [] });
    samples.push({ tick: t, steamid: 'e', ...e, pitch: 0, yaw: 180, is_alive: true, team_num: 3, approximate_spotted_by: mateSpots ? ['m'] : [] });
  }
  const allFires = enemyFires ? Array.from({ length: 8 }, (_, i) => ({ tick: i * 48, user_steamid: 'e', weapon: 'ak47' })) : [];
  return { players, deaths: [], roundStarts: [0], samples, killWindows: [], allFires };
}
const walls = (d) => analyze(d, THRESHOLDS).find((r) => r.steamid === 's').metrics.wallStreaks;

test('wall-tracking: a silent enemy nobody on the team could see counts', () => {
  assert.ok(walls(track()) >= 1);
});
test('wall-tracking: enemy on the radar (a teammate sees them) does not count', () => {
  assert.equal(walls(track({ mateSpots: true })), 0);
});
test('wall-tracking: a running (audible) enemy does not count', () => {
  assert.equal(walls(track({ enemySpeed: 220 })), 0);
});
test('wall-tracking: an enemy who keeps shooting (audible) does not count', () => {
  assert.equal(walls(track({ enemyFires: true })), 0);
});

test('warmup is ignored', () => {
  const d = track();
  assert.equal(walls({ ...d, matchStart: 10000 }), 0);
});

test('reaction time: already aiming at the spot (holding an angle) is not measured', () => {
  // killer k aims straight at where v appears; v becomes visible at 960 and dies at 968 (8 ticks)
  const players = [{ steamid: 'k', name: 'K' }, { steamid: 'v', name: 'V' }];
  const rows = [];
  for (let t = 936; t <= 1000; t++) {
    rows.push({ tick: t, steamid: 'k', X: 0, Y: 0, Z: 0, pitch: 0, yaw: 0, is_alive: true, team_num: 2, approximate_spotted_by: [] });
    rows.push({ tick: t, steamid: 'v', X: 1000, Y: 0, Z: 0, pitch: 0, yaw: 180, is_alive: true, team_num: 3, approximate_spotted_by: t >= 960 ? ['k'] : [] });
  }
  const r = analyze({ players, deaths: [{ tick: 968, attacker_steamid: 'k', user_steamid: 'v', weapon: 'ak47' }], roundStarts: [0], samples: [], killWindows: rows }, THRESHOLDS);
  assert.equal(r.find((x) => x.steamid === 'k').metrics.reactionSamples, 0);
});

test('"while they were flashed" needs a real flash, not a fading one', () => {
  const base = (blinds) => {
    const players = [{ steamid: 'k', name: 'K' }, { steamid: 'v', name: 'V' }];
    const rows = [{ tick: 999, steamid: 'k', X: 0, Y: 0, Z: 0, pitch: 0, yaw: 0, is_alive: true, team_num: 2 }, { tick: 999, steamid: 'v', X: 500, Y: 0, Z: 0, pitch: 0, yaw: 0, is_alive: true, team_num: 3 }];
    const r = analyze({ players, deaths: [{ tick: 1000, attacker_steamid: 'k', user_steamid: 'v', weapon: 'ak47', attackerblind: true }], roundStarts: [0], samples: [], killWindows: rows, blinds }, THRESHOLDS);
    return (r.find((x) => x.steamid === 'v').oddDeaths || []).some((o) => o.reasons.includes('while they were flashed'));
  };
  assert.equal(base([{ tick: 900, user_steamid: 'k', blind_duration: 1.7 }]), false);   // 0.2 s left
  assert.equal(base([{ tick: 950, user_steamid: 'k', blind_duration: 3.0 }]), true);    // 2.2 s left
});

test('spinning only counts in live play, not in freeze time or after the round', () => {
  const samples = [];
  for (let t = 0; t <= 400; t += 4) samples.push({ tick: t, steamid: 'p', X: 0, Y: 0, Z: 0, pitch: 0, yaw: (t * 30) % 360 - 180, is_alive: true, team_num: 2 });
  const live = mechanicsChecks({ samples, roundStarts: [0], roundEnds: [1000] }, 'p', DEEP);
  const frozen = mechanicsChecks({ samples, roundStarts: [500], roundEnds: [1000] }, 'p', DEEP);
  assert.ok(live.spinRuns >= 1);
  assert.equal(frozen.spinRuns, 0);
});

test('odd kills repeated on several players are a signal; one or two are not', () => {
  const m = { kills: 20, wallStreaks: 0, snaps: 0, snapRate: 0, unseenWallbangs: 0, reactionSamples: 0 };
  assert.equal(judge({ ...m, teamOddKills: 2, teamOddVictims: 2 }).signals.length, 0);
  assert.equal(judge({ ...m, teamOddKills: 3, teamOddVictims: 1 }).signals.length, 0);
  const s = judge({ ...m, teamOddKills: 3, teamOddVictims: 2 });
  assert.equal(s.signals[0].name, 'Odd kills on several players');
  assert.equal(s.flagged, false);   // one signal alone: Caution / Scrutinize, not a flag
});
