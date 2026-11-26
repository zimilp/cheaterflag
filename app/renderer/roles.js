'use strict';
// Pro-style role tags from a member's own demo stats, and a role plan for the members you queue with.
// Everything here is counted from demos — no guesses about what players "meant" to do:
//   AWPer      share of kills with the AWP
//   Entry      how often they take the first fight of the round (first kill or first death)
//   Lurker     T rounds where they were far (1200+ units) from every teammate 30 s in
//   Support    flash assists, enemies flashed and grenade damage per round
//   A / B anchor  CT rounds where they held that bombsite 20 s in
//   Rotator    CT rounds where they held neither site (mid / in between)
(function (root) {
  const z = (o, k) => (o && o[k]) || 0;
  const MIN_ROUNDS = 20;   // fewer demo rounds than this = not enough to tag a role

  // each score is "how strongly they play this role", 1.0 = a typical player in that role
  function roleScores(d) {
    const rounds = z(d, 'rounds'), rT = z(d, 'roundsT'), rCT = z(d, 'roundsCT');
    const support = rounds ? (z(d, 'flashAssists') * 2 + z(d, 'enemiesFlashed') * 0.5 + z(d, 'utilDamage') / 25) / rounds : 0;
    return {
      enough: rounds >= MIN_ROUNDS,
      awp: z(d, 'kills') ? (z(d, 'awpKills') / z(d, 'kills')) / 0.3 : 0,
      entry: rounds ? ((z(d, 'entryKills') + z(d, 'firstDeaths')) / rounds) / 0.2 : 0,
      lurk: rT ? (z(d, 'tLurk') / rT) / 0.35 : 0,
      support: support / 0.6,
      anchorA: rCT ? (z(d, 'ctA') / rCT) / 0.5 : 0,
      anchorB: rCT ? (z(d, 'ctB') / rCT) / 0.5 : 0,
      rotator: rCT ? ((rCT - z(d, 'ctA') - z(d, 'ctB')) / rCT) / 0.5 : 0,
    };
  }

  const LABEL = { awp: 'AWPer', entry: 'Entry fragger', lurk: 'Lurker', support: 'Support', rifler: 'Rifler', anchorA: 'A anchor', anchorB: 'B anchor', rotator: 'Rotator' };
  const T_ROLES = ['entry', 'lurk', 'support'];
  const CT_ROLES = ['anchorA', 'anchorB', 'rotator'];

  /** A member's natural roles: { t, ct } role keys, or null when there isn't enough demo data. */
  function naturalRoles(d) {
    const s = roleScores(d);
    if (!s.enough) return null;
    if (s.awp >= 1) return { t: 'awp', ct: 'awp', s };
    const best = (keys) => keys.reduce((a, k) => (s[k] > s[a] ? k : a), keys[0]);
    const t = best(T_ROLES);
    return { t: s[t] >= 0.8 ? t : 'rifler', ct: best(CT_ROLES), s };
  }

  // all ways to give `n` people distinct slots from `slots` (n <= 5, so this is tiny)
  function permutations(slots, n) {
    if (!n) return [[]];
    const out = [];
    slots.forEach((x, i) => { for (const rest of permutations(slots.filter((_, j) => j !== i), n - 1)) out.push([x, ...rest]); });
    return out;
  }

  /**
   * Role plan for the members you're playing with: one AWPer at most, then T and CT roles that
   * don't overlap, chosen so the total fit (their own role scores) is as high as possible.
   * players: [{ steamid, name, demo }] — `demo` = demo-stat sums (on this map when available).
   */
  function squadPlan(players) {
    const rows = players.map((p) => ({ ...p, s: roleScores(p.demo) }));
    const known = rows.filter((r) => r.s.enough);
    const plan = new Map(rows.map((r) => [r.steamid, { t: null, ct: null, fit: {} }]));
    if (!known.length) return plan;
    const awper = known.filter((r) => r.s.awp >= 0.8).sort((a, b) => b.s.awp - a.s.awp)[0];
    if (awper) Object.assign(plan.get(awper.steamid), { t: 'awp', ct: 'awp' });
    const others = known.filter((r) => r !== awper);
    const assign = (side, slots) => {
      let best = null, bestScore = -1;
      for (const perm of permutations(slots, Math.min(others.length, slots.length))) {
        const score = perm.reduce((a, role, i) => a + (role === 'rifler' ? 0.8 : others[i].s[role]), 0);
        if (score > bestScore) { bestScore = score; best = perm; }
      }
      (best || []).forEach((role, i) => { plan.get(others[i].steamid)[side] = role; });
      others.slice((best || []).length).forEach((r) => { plan.get(r.steamid)[side] = side === 't' ? 'rifler' : 'rotator'; });
    };
    assign('t', ['entry', 'lurk', 'support', 'rifler', 'rifler'].slice(0, Math.max(3, others.length)));
    assign('ct', ['anchorA', 'anchorB', 'rotator', 'rotator', 'anchorA'].slice(0, Math.max(3, others.length)));
    for (const r of rows) plan.get(r.steamid).fit = r.s;
    return plan;
  }

  /** Where to draw someone on the map plan: their own average hold spot for that CT role, in game units. */
  function holdSpot(d, role) {
    if (role === 'anchorA' && z(d, 'ctA')) return { x: z(d, 'ctAX') / z(d, 'ctA'), y: z(d, 'ctAY') / z(d, 'ctA') };
    if (role === 'anchorB' && z(d, 'ctB')) return { x: z(d, 'ctBX') / z(d, 'ctB'), y: z(d, 'ctBY') / z(d, 'ctB') };
    if (z(d, 'ctN')) return { x: z(d, 'ctX') / z(d, 'ctN'), y: z(d, 'ctY') / z(d, 'ctN') };
    return null;
  }
  /** Bombsite centres on this map, from the demos (game units). */
  function siteCentres(rows) {
    const c = { A: null, B: null };
    for (const k of ['A', 'B']) {
      let x = 0, y = 0, n = 0;
      for (const d of rows) { if (z(d, 'site' + k + 'N')) { x += z(d, 'site' + k + 'X'); y += z(d, 'site' + k + 'Y'); n += z(d, 'site' + k + 'N'); } }
      if (n) c[k] = { x: x / n, y: y / n };
    }
    return c;
  }

  const api = { roleScores, naturalRoles, squadPlan, holdSpot, siteCentres, LABEL, MIN_ROUNDS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Roles = api;
})(typeof window !== 'undefined' ? window : globalThis);
