'use strict';
// One id per match, whatever we know it by: Valve's replay link / demo file name ("003856…_1240405222") or the
// share code ("CSGO-Ys2AY-…"). A share code encodes the same number (the reservation id), so the two can be
// matched — the same match downloaded by share code and again by link is then one entry, not two.
const DICT = 'ABCDEFGHJKLMNOPQRSTUVWXYZabcdefhijkmnopqrstuvwxyz23456789';

/** { matchId, reservationId, tvPort } as decimal strings, or null if it isn't a share code. */
function decodeShareCode(code) {
  const m = String(code || '').match(/CSGO(-[A-Za-z0-9]{5}){5}/);
  if (!m) return null;
  let big = 0n;
  for (const c of [...m[0].slice(5).replace(/-/g, '')].reverse()) { const i = DICT.indexOf(c); if (i < 0) return null; big = big * 57n + BigInt(i); }
  const b = Buffer.from(big.toString(16).padStart(36, '0'), 'hex');
  if (b.length !== 18) return null;
  return { matchId: b.readBigUInt64LE(0).toString(), reservationId: b.readBigUInt64LE(8).toString(), tvPort: b.readUInt16LE(16) };
}

/** The match's number as a plain decimal string (no leading zeros), from any of the given strings. */
function matchKey(...vals) {
  for (const v of vals) {
    const m = String(v || '').match(/(\d{15,30})_\d{6,12}/);
    if (m) return BigInt(m[1]).toString();
  }
  for (const v of vals) { const d = decodeShareCode(v); if (d) return d.reservationId; }
  return null;
}
const entryKey = (h) => matchKey(h.demoUrl, h.keptDemo, h.shareCode);

/** Merge history entries that are the same match: keep the newest scan, but the earliest known "played" time and any link. */
function dedupeHistory(history) {
  const out = [], byKey = new Map();
  for (const h of [...history].sort((a, b) => (b.at || 0) - (a.at || 0))) {
    const k = entryKey(h) || 'sc:' + h.shareCode;
    const prev = byKey.get(k);
    if (!prev) { const copy = { ...h }; byKey.set(k, copy); out.push(copy); continue; }
    if (!prev.playedAt && h.playedAt) prev.playedAt = h.playedAt;
    if (!prev.demoUrl && h.demoUrl) prev.demoUrl = h.demoUrl;
    if (!prev.keptDemo && h.keptDemo) prev.keptDemo = h.keptDemo;
  }
  return out;
}

module.exports = { decodeShareCode, matchKey, entryKey, dedupeHistory };
