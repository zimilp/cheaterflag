'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { judge, applyScrutiny } = require('../lib/demoScan');

const base = { kills: 20, wallStreaks: 0, snaps: 0, snapRate: 0, unseenWallbangs: 0, medianReactionTicks: 30, reactionSamples: 12 };

test('normal players need strong evidence; risky accounts get stricter rules', () => {
  const m = { ...base, wallStreaks: 3 };
  assert.equal(judge(m).flagged, false);                 // below normal threshold (4)
  assert.equal(judge(m, undefined, 'caution').flagged, false); // one signal, needs two
  assert.equal(judge(m, undefined, 'high').flagged, true);     // banned/blacklisted: one signal is enough
  const two = { ...base, wallStreaks: 3, unseenWallbangs: 3 };
  assert.equal(judge(two, undefined, 'caution').flagged, true);
});

test('applyScrutiny picks the level from the account check', () => {
  const results = [{ steamid: 'a', name: 'A', metrics: { ...base, wallStreaks: 3 }, flagged: false, signals: [], score: 0 },
                   { steamid: 'b', name: 'B', metrics: { ...base, wallStreaks: 3 }, flagged: false, signals: [], score: 0 }];
  const out = applyScrutiny(results, [{ steamid: 'a', tier: 'rejected' }, { steamid: 'b', tier: 'approved' }]);
  assert.equal(out.find((r) => r.steamid === 'a').flagged, true);
  assert.equal(out.find((r) => r.steamid === 'a').scrutiny, 'high');
  assert.equal(out.find((r) => r.steamid === 'b').flagged, false);
});
