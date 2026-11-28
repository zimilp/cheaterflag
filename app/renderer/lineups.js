'use strict';
// Smoke lineup videos per map, shown in the Lobby tab for the map being played. Picked for being recent (after the
// latest map changes), short (clips with timestamps, no 20-minute talk) and easy (standard throws first).
// Checked 27 Nov 2026 against the Premier pool: Ancient, Anubis, Cache, Dust II, Inferno, Mirage, Nuke.
// "Newest on YouTube" always links a live search sorted by upload date, so there is always something current.
(function (root) {
  const V = (id, title, when, note) => ({ id, title, when, note });
  const MAPS = {
    mirage: { name: 'Mirage', active: true, videos: [
      V('CrEHKSQkjVo', 'Pro smokes every player should know', 'Nov 2026', 'A site 3 smokes, B site, CT, top con, mid — ~2 min, after the Sept 2026 balcony change'),
      V('H3NktBWFUsE', 'Every Mirage smoke you need (2026)', 'Mar 2026', 'Easy window, jungle, stairs lineups with chapters'),
    ] },
    inferno: { name: 'Inferno', active: true, videos: [
      V('6JMf6HY3Fog', 'Meta smokes to dominate', 'Nov 2026', 'Fast mid, short, banana, CT — quick clips'),
      V('eljDZdMTPzs', 'Inferno smokes you need to know (2026)', 'Oct 2025', 'T and CT essentials'),
    ] },
    dust2: { name: 'Dust II', active: true, videos: [
      V('NiJ6dj_IgQE', 'The only smokes you need to win', 'Sep 2026', 'CT, long, cross, box, mid — ~15 s per smoke'),
      V('HY85NcZMrAg', 'Dust 2 smokes you need to know (2026)', 'Mar 2026', 'Full T and CT set'),
    ] },
    nuke: { name: 'Nuke', active: true, videos: [
      V('h710cpEs7rU', 'Nuke smokes (T side)', 'Aug 2026', 'Outside, red, garage, mini — from T spawn'),
      V('NUeQ3gvx3z0', 'Nuke as fast as possible', 'Mar 2026', 'Meta nades both sides, fast format'),
    ] },
    ancient: { name: 'Ancient', active: true, videos: [
      V('GvOfPgHmxh0', '5 must-know instant smokes', 'Jun 2026', 'Instant mid/elbow smokes'),
      V('_N_4CeoP7L4', 'The only essential smokes you need', 'Jan 2026', 'Cheetah, red room, A CT, donut, B long/short/cave'),
    ] },
    anubis: { name: 'Anubis', active: true, videos: [
      V('4IR3obZTb-M', 'The only Anubis smokes you need', 'Sep 2026', 'Mid / E-box, B, temple, A camera & heaven'),
      V('ZMzsbaTLptQ', 'Anubis utility guide', 'Oct 2026', 'Smokes, mollies and flashes'),
    ] },
    cache: { name: 'Cache', active: true, videos: [
      V('eI6EnqTgi0E', 'Cache smokes you need to know (2026)', 'Jul 2026', 'A, mid and B on the new Cache'),
      V('5gbIC3igve8', 'Cache nades you need to know (2026)', 'Jul 2026', 'Smokes plus flashes, mollies, HE'),
    ] },
    overpass: { name: 'Overpass', active: false, videos: [
      V('cIaxlHA3omU', 'Overpass as fast as possible', 'Feb 2026', 'Meta nades, fast format'),
    ] },
    train: { name: 'Train', active: false, videos: [
      V('COKMUhpOtgU', 'Train as fast as possible', 'Nov 2024', 'Older — check Newest on YouTube'),
    ] },
  };
  const key = (map) => String(map || '').toLowerCase().replace(/^(de|cs)_/, '').replace(/[\s_]+/g, '').replace(/^dustii$/, 'dust2');
  const forMap = (map) => MAPS[key(map)] || null;
  const newestUrl = (map) => `https://www.youtube.com/results?search_query=${encodeURIComponent('cs2 ' + ((forMap(map) || {}).name || key(map)) + ' smokes')}&sp=CAI%253D`;
  const thumb = (id) => `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;
  const api = { MAPS, key, forMap, newestUrl, thumb };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Lineups = api;
})(typeof window !== 'undefined' ? window : globalThis);
