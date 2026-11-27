'use strict';
const test = require('node:test');
const assert = require('node:assert');
const M = require('../lib/matchId');

test('a share code and a replay link of the same match give the same id', () => {
  assert.equal(M.matchKey('CSGO-Ys2AY-8zCAe-SVef3-iZO7Q-q7NQC'), M.matchKey('C:/x/demo003856295397416763723_1240405222.dem'));
  assert.equal(M.matchKey('http://replay1.valve.net/730/003856295397416763723_1240405222.dem.bz2'), '3856295397416763723');
  assert.equal(M.matchKey('file:match.dem'), null);
});

test('duplicate history entries merge, keeping the newest scan and the played date', () => {
  const h = [
    { shareCode: 'demo:CSGO-Ys2AY-8zCAe-SVef3-iZO7Q-q7NQC', keptDemo: 'clean/CSGO-Ys2AY-8zCAe-SVef3-iZO7Q-q7NQC.dem', at: 300, playedAt: null, results: ['new'] },
    { shareCode: 'demo:003856295397416763723_1240405222', demoUrl: 'http://r/730/003856295397416763723_1240405222.dem.bz2', at: 200, playedAt: 111, results: ['old'] },
    { shareCode: 'file:other.dem', at: 100, playedAt: 50, results: [] },
  ];
  const d = M.dedupeHistory(h);
  assert.equal(d.length, 2);
  assert.deepEqual(d[0].results, ['new']);
  assert.equal(d[0].playedAt, 111);
  assert.ok(d[0].demoUrl);
});
