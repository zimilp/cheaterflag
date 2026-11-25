// Trust tiers. Pure function so it can be unit-tested.
// approved = clean, limited = caution, rejected = flagged.

export const RULES = {
  recentBanDays: 730,     // a VAC/game ban within 2 years → rejected
  minAccountDays: 365,
  minCs2Hours: 100,
};

const DAY = 86400;

export function computeTier({ bans, summary, cs2Minutes, blacklisted, override }, now = Date.now() / 1000, R = RULES) {
  const reasons = [];
  if (override && override.tier) {
    return { tier: override.tier, reasons: [`Admin override${override.note ? ': ' + override.note : ''}`] };
  }
  if (blacklisted) {
    return { tier: 'rejected', reasons: [`On CheaterFlag blacklist (${blacklisted.category}): ${blacklisted.reason}`] };
  }
  let tier = 'approved';
  const lower = (t) => { if (t === 'rejected' || (t === 'limited' && tier === 'approved')) tier = t; };

  if (bans) {
    const vac = bans.NumberOfVACBans || 0, game = bans.NumberOfGameBans || 0;
    const ago = bans.DaysSinceLastBan;
    const when = ago == null ? '' : ago === 0 ? ' (today)' : ago < 60 ? ` (${ago} days ago)` : ago < 730 ? ` (${Math.round(ago / 30)} months ago)` : ` (${(ago / 365).toFixed(1)} years ago)`;
    const recent = (ago ?? 99999) < R.recentBanDays;
    // Steam only tells us the type, count and age of bans - never the game or the exact reason.
    if (vac > 0) {
      lower(recent ? 'rejected' : 'limited');
      reasons.push(`${vac} VAC ban${vac > 1 ? 's' : ''}${when}: caught by Valve Anti-Cheat running cheat software (game not disclosed by Steam)`);
    }
    if (game > 0) {
      lower(recent ? 'rejected' : 'limited');
      reasons.push(`${game} game ban${game > 1 ? 's' : ''}${vac ? '' : when}: banned by a game's developer, e.g. CS2 Overwatch for cheating or griefing (game not disclosed by Steam)`);
    }
    if (bans.CommunityBanned) { lower('rejected'); reasons.push('Steam Community ban: banned by Steam for breaking community rules (spam, scams, abuse)'); }
    if (bans.EconomyBan && bans.EconomyBan !== 'none') { lower('limited'); reasons.push(`Steam trade ban (${bans.EconomyBan}): blocked from trading, usually for scams or fraud`); }
  } else {
    lower('limited'); reasons.push('Ban status unavailable');
  }

  if (!summary) {
    lower('limited'); reasons.push('Profile not found');
  } else {
    if (summary.communityvisibilitystate !== 3) { lower('limited'); reasons.push('Private profile'); }
    if (summary.timecreated) {
      const days = Math.floor((now - summary.timecreated) / DAY);
      if (days < R.minAccountDays) { lower('limited'); reasons.push(`New account (${days} days old)`); }
    } else if (summary.communityvisibilitystate === 3) {
      lower('limited'); reasons.push('Account age hidden');
    }
  }

  if (cs2Minutes == null) { lower('limited'); reasons.push('CS2 hours hidden'); }
  else if (cs2Minutes / 60 < R.minCs2Hours) { lower('limited'); reasons.push(`Only ${Math.round(cs2Minutes / 60)} CS2 hours`); }

  if (!reasons.length) reasons.push('No bans, established account');
  return { tier, reasons };
}
