'use strict';
// Guard: when detection rules change, the version numbers must change too — that is what makes every app
// re-scan its matches (SCANNER_VERSION) and re-check everyone it scrutinized (SCRUTINY_VERSION).
// If this fails: bump the version in lib/demoScan.js, then update the fingerprint below.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const D = require('../lib/demoScan');

const hash = (...parts) => crypto.createHash('sha1').update(parts.map((p) => (typeof p === 'function' ? p.toString() : JSON.stringify(p))).join('\n')).digest('hex').slice(0, 12);
const scanPrint = hash(D.THRESHOLDS, D.STRICT, D.analyze, D.judge, D.applyScrutiny);
const deepPrint = hash(D.DEEP, D.deepAnalyze, D.bombReads, D.mechanicsChecks);

const KNOWN = {
  scanner: { [D.SCANNER_VERSION]: '164c0d03b365' },
  scrutiny: { [D.SCRUTINY_VERSION]: 'fc3526bcde81' },
};

test('detection changes come with a version bump', () => {
  assert.equal(scanPrint, KNOWN.scanner[D.SCANNER_VERSION], `Scan rules changed: bump SCANNER_VERSION and set its fingerprint to ${scanPrint}`);
  assert.equal(deepPrint, KNOWN.scrutiny[D.SCRUTINY_VERSION], `Scrutinize rules changed: bump SCRUTINY_VERSION and set its fingerprint to ${deepPrint}`);
});
