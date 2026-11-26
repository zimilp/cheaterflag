'use strict';
const test = require('node:test');
const assert = require('node:assert');
const Roles = require('../renderer/roles');

const base = { rounds: 100, roundsT: 50, roundsCT: 50, kills: 70 };
test('roles come from the stats and don\'t overlap in a squad', () => {
  const players = [
    { steamid: 'awp', name: 'Sniper', demo: { ...base, awpKills: 35, ctA: 10, ctB: 10 } },
    { steamid: 'ent', name: 'Entry', demo: { ...base, entryKills: 15, firstDeaths: 12, ctB: 35 } },
    { steamid: 'sup', name: 'Supp', demo: { ...base, flashAssists: 20, enemiesFlashed: 60, utilDamage: 900, ctA: 30 } },
    { steamid: 'lrk', name: 'Lurk', demo: { ...base, tLurk: 25, ctB: 5, ctA: 5 } },
    { steamid: 'new', name: 'Newbie', demo: { rounds: 5 } },
  ];
  const plan = Roles.squadPlan(players);
  assert.equal(plan.get('awp').t, 'awp');
  assert.equal(plan.get('ent').t, 'entry');
  assert.equal(plan.get('sup').t, 'support');
  assert.equal(plan.get('lrk').t, 'lurk');
  assert.equal(plan.get('ent').ct, 'anchorB');
  assert.equal(plan.get('sup').ct, 'anchorA');
  assert.equal(plan.get('lrk').ct, 'rotator');
  assert.equal(plan.get('new').t, null);           // not enough data: no role
  assert.equal(Roles.naturalRoles({ rounds: 5 }), null);
});
