'use strict';
const test = require('node:test');
const assert = require('node:assert');
const L = require('../renderer/lineups');

test('smoke videos: every Premier map has recent, valid videos', () => {
  for (const k of ['ancient', 'anubis', 'cache', 'dust2', 'inferno', 'mirage', 'nuke']) {
    const m = L.MAPS[k];
    assert.ok(m && m.active && m.videos.length >= 1, k);
    for (const v of m.videos) { assert.match(v.id, /^[A-Za-z0-9_-]{11}$/); assert.ok(v.title && v.when && v.note); }
  }
  assert.equal(L.forMap('de_dust2').name, 'Dust II');
  assert.equal(L.forMap('de_mirage').name, 'Mirage');
  assert.equal(L.forMap('de_unknown'), null);
  assert.match(L.newestUrl('de_nuke'), /search_query=cs2%20Nuke%20smokes&sp=/);
});
