'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { summarize, cfgText } = require('../lib/gsi');
const { parseVdf } = require('../lib/steamConfig');

test('gsi: menu vs warmup vs live vs game over', () => {
  assert.deepEqual(summarize({ player: { activity: 'menu' } }), { inMatch: false, phase: null, activity: 'menu', map: null, round: null });
  assert.equal(summarize({ map: { name: 'de_dust2', phase: 'warmup' }, player: { activity: 'playing' } }).inMatch, true);
  assert.equal(summarize({ map: { name: 'de_dust2', phase: 'live' } }).phase, 'live');
  assert.equal(summarize({ map: { name: 'de_dust2', phase: 'gameover' } }).inMatch, false);
  assert.equal(summarize({ map: { name: 'de_dust2', phase: 'live', round: 6 } }).round, 7);
});

test('gsi: config file is valid KeyValues with our token', () => {
  const v = parseVdf(cfgText('abc123'));
  assert.equal(v.CheaterFlag.auth.token, 'abc123');
  assert.equal(v.CheaterFlag.data.map, '1');
});
