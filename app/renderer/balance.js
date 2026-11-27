'use strict';
// Fair 5v5 teams for an inhouse match: skill (whole history) + current form (last 14 days) + ping to the chosen
// server, one in-game leader (IGL) per team, and the AWPers split up. Ten players = only 126 different splits,
// so every split is tried and the fairest one wins. Everything comes from the players' own match stats.
(function (root) {
  const z = (o, k) => (o && o[k]) || 0;
  const AVG = 1.0;

  /** Rating from summed match stats: ~1.00 is an average player in this group's games. */
  function ratingOf(d) {
    const r = z(d, 'rounds');
    if (r < 20) return null;
    const kpr = z(d, 'kills') / r, dpr = z(d, 'deaths') / r;
    const adr = z(d, 'damage') ? z(d, 'damage') / r : kpr * 115;          // match-history rows have no damage
    const impact = (z(d, 'entryKills') - z(d, 'firstDeaths') + z(d, 'k3') + 2 * z(d, 'k4') + 3 * z(d, 'aces') + z(d, 'clutchWins')) / r;
    const games = z(d, 'wins') + z(d, 'losses') + z(d, 'ties');
    const wr = games >= 3 ? (z(d, 'wins') + 0.5 * z(d, 'ties')) / games : 0.5;
    const raw = 0.40 * (kpr / 0.70) + 0.30 * (adr / 80) + 0.20 * ((1 - dpr) / 0.32) + 0.05 * (1 + impact / 0.08) + 0.05 * (wr / 0.5);
    const conf = r / (r + 150);                                             // few rounds -> pulled towards average
    return { value: AVG + (raw - AVG) * conf, rounds: r, kpr, adr, wr, games };
  }
  const pick = (p) => (p && (p.fullMatches >= 3 ? p.full : p.all)) || null;

  /** Skill (overall + current form), IGL score and role for one player. `all`/`form` are /stats rows (or null). */
  function profile(name, steamid, all, form, Roles) {
    const ov = ratingOf(pick(all)), fm = ratingOf(pick(form));
    let skill = AVG, why;
    if (ov && fm && fm.rounds >= 60) { skill = 0.5 * ov.value + 0.5 * fm.value; why = `form ${fm.value.toFixed(2)} (14 days), overall ${ov.value.toFixed(2)}`; }
    else if (ov) { skill = ov.value; why = `overall ${ov.value.toFixed(2)}${fm ? ', few games lately' : ', no games in 14 days'}`; }
    else why = 'no stats yet — counted as average';
    const d = (all && all.full) || {};
    const rounds = z(d, 'rounds');
    const nat = Roles && rounds >= (Roles.MIN_ROUNDS || 20) ? Roles.naturalRoles(d) : null;
    const role = nat ? (Roles.LABEL[nat.t] || null) : null;
    // IGL: nobody's leadership is in a demo, so this uses what good IGLs tend to show — utility for the team,
    // trading and assisting, staying alive (few first deaths), clutching, and experience.
    let igl = 0, iglWhy = [];
    if (rounds >= 40) {
      const util = (z(d, 'flashAssists') * 2 + z(d, 'enemiesFlashed') * 0.5 + z(d, 'utilDamage') / 25) / rounds;
      const team = (z(d, 'trades') + z(d, 'assists')) / rounds;
      const safe = 1 - z(d, 'firstDeaths') / rounds;
      const clutch = z(d, 'clutchAttempts') >= 3 ? z(d, 'clutchWins') / z(d, 'clutchAttempts') : 0.2;
      const exp = Math.min(1, ((all && all.matches) || 0) / 40);
      igl = util / 0.6 + team / 0.35 + safe / 0.9 + clutch / 0.25 * 0.5 + exp;
      if (util / 0.6 >= 1.1) iglWhy.push(`${(z(d, 'flashAssists') / rounds * 10).toFixed(1)} flash assists / 10 rounds`);
      if (team / 0.35 >= 1.1) iglWhy.push('trades and assists a lot');
      if (clutch >= 0.3 && z(d, 'clutchAttempts') >= 3) iglWhy.push(`wins ${Math.round(clutch * 100)}% of clutches`);
      if (exp >= 1) iglWhy.push(`${all.matches} matches of experience`);
      if (safe >= 0.92) iglWhy.push('rarely dies first');
    }
    return { name, steamid, skill: +skill.toFixed(3), why, role, igl: +igl.toFixed(2), iglWhy: iglWhy.slice(0, 2).join(', ') || null, guest: !all };
  }

  /** Every 5v5 split, best first. players[i].ping: { pop: ms } (optional). */
  function splits(players, pop) {
    const n = players.length;
    if (n !== 10) throw new Error('Pick exactly 10 players.');
    const ping = (p) => (pop && p.ping && p.ping[pop] != null ? p.ping[pop] : null);
    const iglRank = [...players].sort((a, b) => b.igl - a.igl).map((p) => p.steamid || 'g:' + p.name);
    const awpers = players.filter((p) => p.role === 'AWPer').map((p) => p.steamid || 'g:' + p.name);
    const out = [];
    for (let mask = 0; mask < 1 << 10; mask++) {
      if (!(mask & 1) || popcount(mask) !== 5) continue;          // player 0 always in team A: each split once
      const A = [], B = [];
      players.forEach((p, i) => (mask & (1 << i) ? A : B).push(p));
      const sum = (t) => t.reduce((s, p) => s + p.skill, 0);
      const pingAvg = (t) => { const v = t.map(ping).filter((x) => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
      const sA = sum(A), sB = sum(B), pA = pingAvg(A), pB = pingAvg(B);
      const id = (p) => p.steamid || 'g:' + p.name;
      let cost = Math.abs(sA - sB) * 10;                                  // skill gap is what matters most
      if (pA != null && pB != null) cost += Math.abs(pA - pB) / 25;       // 25 ms average ping gap ~ 0.1 rating
      const inA = new Set(A.map(id));
      if (iglRank.length >= 2 && inA.has(iglRank[0]) === inA.has(iglRank[1])) cost += 0.4;   // the two best IGLs apart
      if (awpers.length >= 2 && awpers.every((x) => inA.has(x)) || awpers.length >= 2 && awpers.every((x) => !inA.has(x))) cost += 0.3;
      out.push({ A, B, sA, sB, pA, pB, cost });
    }
    return out.sort((a, b) => a.cost - b.cost);
  }
  function popcount(x) { let c = 0; while (x) { c += x & 1; x >>= 1; } return c; }

  /** The final teams: IGL per team, win chance, reasons. `which` = 0 for the best split, 1.. for the next ones. */
  function balance(players, pop, which = 0) {
    const all = splits(players, pop);
    const s = all[Math.min(which, all.length - 1)];
    const lead = (t) => [...t].sort((a, b) => b.igl - a.igl)[0];
    const winA = 1 / (1 + Math.exp(-(s.sA - s.sB) * 4));
    const team = (t, sum, pingAvg) => {
      const igl = lead(t);
      return {
        igl: igl.steamid || 'g:' + igl.name,
        iglWhy: igl.iglWhy || (igl.igl > 0 ? 'best mix of utility, trading and experience in this team' : 'no stats — pick your own caller'),
        skill: +(sum / t.length).toFixed(2), ping: pingAvg != null ? Math.round(pingAvg) : null,
        players: [...t].sort((a, b) => b.skill - a.skill).map((p) => ({ ...p, reason: [p.why, p.role].filter(Boolean).join(' · ') + (pop && p.ping && p.ping[pop] != null ? ` · ${p.ping[pop]} ms` : '') })),
      };
    };
    return { pop, options: all.length, which, A: team(s.A, s.sA, s.pA), B: team(s.B, s.sB, s.pB), winA: Math.round(winA * 100) };
  }

  /** Server regions ranked for these players: lowest worst-ping first (nobody gets a terrible connection). */
  function rankRegions(players, popNames = {}) {
    const pops = new Set(); players.forEach((p) => Object.keys(p.ping || {}).forEach((k) => pops.add(k)));
    return [...pops].map((pop) => {
      const v = players.map((p) => (p.ping || {})[pop]).filter((x) => x != null);
      return { pop, name: popNames[pop] || pop, worst: Math.max(...v), avg: Math.round(v.reduce((a, b) => a + b, 0) / v.length), known: v.length };
    }).filter((r) => r.known >= Math.max(1, Math.ceil(players.filter((p) => p.ping).length / 2)))
      .sort((a, b) => a.worst - b.worst || a.avg - b.avg);
  }

  const api = { ratingOf, profile, splits, balance, rankRegions };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Balance = api;
})(typeof window !== 'undefined' ? window : globalThis);
