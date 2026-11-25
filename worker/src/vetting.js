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
    const banCount = (bans.NumberOfVACBans || 0) + (bans.NumberOfGameBans || 0);
    if (bans.CommunityBanned) { lower('rejected'); reasons.push('Steam community ban'); }
    if (banCount > 0) {
      const recent = (bans.DaysSinceLastBan ?? 99999) < R.recentBanDays;
      lower(recent ? 'rejected' : 'limited');
      reasons.push(`${bans.NumberOfVACBans || 0} VAC / ${bans.NumberOfGameBans || 0} game ban(s), last ${bans.DaysSinceLastBan} days ago`);
    }
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
