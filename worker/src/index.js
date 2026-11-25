// CheaterFlag shared service — Cloudflare Worker + D1 (free tier).
// Secrets (wrangler secret put): STEAM_API_KEY, SESSION_SECRET, BOT_SECRET
import { computeTier } from './vetting.js';

const now = () => Math.floor(Date.now() / 1000);
const SHARE_CODE = /^CSGO(-[A-Za-z0-9]{5}){5}$/;
const STEAM64 = /^7656119\d{10}$/;
const MATCH_KEY = /^(CSGO(-[A-Za-z0-9]{5}){5}|demo:\d{6,30}_\d{1,12}|file:[^\u0000-\u001f]{1,80})$/;
const TOKEN_DAYS = 30;
// Voting on flags (timed to Valve's demo retention — Valve keeps match demos only ~6 days):
//  - early: decided only with clear agreement (5+ votes, 2/3 agreeing)
//  - on day DECIDE_AFTER_DAYS: any votes -> the majority decides (while the demo can still be watched)
//  - no votes by FLAG_EXPIRY_DAYS: cleared
// Removing someone from the blacklist always needs 5+ votes with 2/3 agreeing.
const MIN_VOTES = 5;
function strongDecision(a, b) { const t = a + b; if (t < MIN_VOTES) return null; if (a / t >= 2 / 3) return 'a'; if (b / t >= 2 / 3) return 'b'; return null; }
function majorityDecision(a, b) { if (a + b < 1 || a === b) return null; return a > b ? 'a' : 'b'; }
const decideRemoval = strongDecision;
const DECIDE_AFTER_DAYS = 4;
const FLAG_EXPIRY_DAYS = 5;

async function applyFlagDecision(env, f, action, actor) {
  if (action === 'confirm' && await isProtectedMember(env, f.steamid)) {
    await env.DB.prepare("UPDATE members SET status = 'suspended' WHERE steamid = ?").bind(f.steamid).run();
    await audit(env, actor, 'member_suspended_cheating', f.steamid, { flag: f.id });
  }
  if (action === 'confirm') {
    await env.DB.batch([
      env.DB.prepare("UPDATE flags SET status = 'confirmed', reviewed_by = ? WHERE id = ?").bind(actor, f.id),
      env.DB.prepare('INSERT OR REPLACE INTO blacklist (steamid, name, category, reason, added_by, created_at) VALUES (?,?,?,?,?,?)')
        .bind(f.steamid, f.name, f.category || 'Other cheating', `Confirmed from demo review (${String(f.map || '').replace(/^de_/, '') || 'match'}, rounds ${JSON.parse(f.rounds || '[]').join(', ')})`, actor, now()),
    ]);
  } else {
    await env.DB.prepare("UPDATE flags SET status = 'cleared', reviewed_by = ? WHERE id = ?").bind(actor, f.id).run();
  }
  await audit(env, actor, 'flag_' + action, f.steamid, { flag: f.id });
}

async function isProtectedMember(env, steamid) {
  return !!(await env.DB.prepare("SELECT 1 FROM members WHERE steamid = ? AND status = 'approved'").bind(steamid).first());
}

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

// ---------------- session tokens (HMAC-SHA256)
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg)));
}
async function makeToken(env, steamid) {
  const body = `${steamid}.${now() + TOKEN_DAYS * 86400}`;
  return `${body}.${await hmac(env.SESSION_SECRET, body)}`;
}
async function readToken(env, req) {
  const t = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const [steamid, exp, sig] = t.split('.');
  if (!steamid || !exp || !sig) return null;
  if (Number(exp) < now()) return null;
  const expect = await hmac(env.SESSION_SECRET, `${steamid}.${exp}`);
  if (expect.length !== sig.length) return null;
  let diff = 0; for (let i = 0; i < sig.length; i++) diff |= expect.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0 ? steamid : null;
}

async function member(env, req, { approved = true, admin = false } = {}) {
  const steamid = await readToken(env, req);
  if (!steamid) throw new HttpError(401, 'Please sign in again.');
  const m = await env.DB.prepare('SELECT * FROM members WHERE steamid = ?').bind(steamid).first();
  if (!m) throw new HttpError(401, 'Unknown member.');
  if (m.status === 'pending') {   // auto-approve: anyone still waiting is approved the next time their app checks in
    await env.DB.prepare("UPDATE members SET status = 'approved' WHERE steamid = ?").bind(steamid).run();
    m.status = 'approved';
  }
  if (approved && m.status !== 'approved') throw new HttpError(403, m.status === 'suspended' ? 'Your CheaterFlag access is suspended.' : 'Waiting for admin approval.');
  if (admin && m.role !== 'admin') throw new HttpError(403, 'Admins only.');
  await env.DB.prepare('UPDATE members SET last_seen = ? WHERE steamid = ?').bind(now(), steamid).run();
  return m;
}

const audit = (env, actor, action, target, detail) =>
  env.DB.prepare('INSERT INTO audit (actor, action, target, detail, created_at) VALUES (?,?,?,?,?)').bind(actor, action, target || null, detail ? JSON.stringify(detail) : null, now()).run();

// ---------------- Steam
async function steamApi(env, path, params) {
  const u = new URL('https://api.steampowered.com/' + path);
  u.searchParams.set('key', env.STEAM_API_KEY);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const r = await fetch(u, { headers: { 'user-agent': 'CheaterFlag/0.1' } });
  return r;
}

async function verifyOpenId(params) {
  const body = new URLSearchParams({ ...params, 'openid.mode': 'check_authentication' });
  const r = await fetch('https://steamcommunity.com/openid/login', { method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  const text = await r.text();
  if (!/is_valid\s*:\s*true/.test(text)) return null;
  const m = String(params['openid.claimed_id'] || '').match(/^https:\/\/steamcommunity\.com\/openid\/id\/(7656119\d{10})$/);
  return m ? m[1] : null;
}

/** Fetch bans, profile and CS2 hours for many SteamIDs, with a 24 h cache. */
async function profiles(env, steamids, { force = false } = {}) {
  const out = new Map();
  const ids = [...new Set(steamids)].filter((s) => STEAM64.test(s));
  if (!ids.length) return out;
  if (!force) {
    const ph = ids.map(() => '?').join(',');
    const { results } = await env.DB.prepare(`SELECT steamid, data FROM profiles WHERE steamid IN (${ph}) AND fetched_at > ?`).bind(...ids, now() - 86400).all();
    for (const r of results) { const d = JSON.parse(r.data); if (d.v === 2) out.set(r.steamid, d); }
  }
  const missing = ids.filter((id) => !out.has(id));
  for (let i = 0; i < missing.length; i += 100) {
    const chunk = missing.slice(i, i + 100);
    const [bansR, sumR] = await Promise.all([
      steamApi(env, 'ISteamUser/GetPlayerBans/v1/', { steamids: chunk.join(',') }),
      steamApi(env, 'ISteamUser/GetPlayerSummaries/v2/', { steamids: chunk.join(',') }),
    ]);
    if (!bansR.ok || !sumR.ok) throw new HttpError(502, `Steam API error (${bansR.status}/${sumR.status}). Check the API key.`);
    const bans = new Map(((await bansR.json()).players || []).map((p) => [p.SteamId, p]));
    const sums = new Map((((await sumR.json()).response || {}).players || []).map((p) => [p.steamid, p]));
    const hours = await Promise.all(chunk.map(async (id) => {
      try {
        const r = await steamApi(env, 'IPlayerService/GetOwnedGames/v1/', { steamid: id, include_played_free_games: '1', include_appinfo: '0' });
        if (!r.ok) return null;
        const games = ((await r.json()).response || {}).games || [];
        const cs2 = games.find((x) => Number(x.appid) === 730);
        // 0 minutes means Steam is hiding the playtime (they're playing CS2 right now), not that they never played
        return cs2 && cs2.playtime_forever > 0 ? cs2.playtime_forever : null;
      } catch (_) { return null; }
    }));
    const stmts = [];
    chunk.forEach((id, k) => {
      const s = sums.get(id);
      const data = {
        v: 2,
        bans: bans.get(id) || null,
        summary: s ? { personaname: s.personaname, avatar: s.avatarmedium, communityvisibilitystate: s.communityvisibilitystate, timecreated: s.timecreated || null } : null,
        cs2Minutes: hours[k],
      };
      out.set(id, data);
      stmts.push(env.DB.prepare('INSERT OR REPLACE INTO profiles (steamid, data, fetched_at) VALUES (?,?,?)').bind(id, JSON.stringify(data), now()));
    });
    if (stmts.length) await env.DB.batch(stmts);
  }
  return out;
}

async function checkPlayers(env, steamids, opts) {
  const ids = [...new Set(steamids)].filter((s) => STEAM64.test(s)).slice(0, 100);
  if (!ids.length) return [];
  const ph = ids.map(() => '?').join(',');
  const [prof, bl, ov, mem] = await Promise.all([
    profiles(env, ids, opts),
    env.DB.prepare(`SELECT * FROM blacklist WHERE steamid IN (${ph})`).bind(...ids).all(),
    env.DB.prepare(`SELECT * FROM overrides WHERE steamid IN (${ph})`).bind(...ids).all(),
    env.DB.prepare(`SELECT steamid FROM members WHERE status = 'approved' AND steamid IN (${ph})`).bind(...ids).all(),
  ]);
  const blm = new Map(bl.results.map((r) => [r.steamid, r]));
  const members = new Set(mem.results.map((r) => r.steamid));
  const ovm = new Map(ov.results.map((r) => [r.steamid, r]));
  return ids.map((id) => {
    const p = prof.get(id) || {};
    const { tier, reasons } = members.has(id) && !(opts && opts.rawForMembers)
      ? { tier: 'approved', reasons: ['CheaterFlag member'] }
      : computeTier({ ...p, blacklisted: blm.get(id), override: ovm.get(id) });
    return { steamid: id, name: p.summary?.personaname || null, avatar: p.summary?.avatar || null, tier, reasons, blacklisted: !!blm.get(id) };
  });
}

// ---------------- routes
// ---- wake the demo bot (a GitHub Actions run) as soon as someone needs a demo link.
// GitHub's own 5-minute schedule is "best effort" and can be hours late, so we start a run on demand.
async function meta(env, k) { const r = await env.DB.prepare('SELECT v FROM meta WHERE k = ?').bind(k).first(); return r ? r.v : 0; }
async function setMeta(env, k, v) { await env.DB.prepare('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)').bind(k, v).run(); }
async function wakeBot(env) {
  if (!env.GITHUB_DISPATCH_TOKEN) return;
  try {
    if (now() - await meta(env, 'bot_seen') < 45) return;     // a bot is online and will pick the job up
    if (now() - await meta(env, 'bot_woken') < 150) return;   // a run was just started and is still booting
    await setMeta(env, 'bot_woken', now());
    const repo = env.GITHUB_REPO || 'zimilp/cheaterflag';
    await fetch(`https://api.github.com/repos/${repo}/actions/workflows/bot.yml/dispatches`, {
      method: 'POST',
      headers: { authorization: 'Bearer ' + env.GITHUB_DISPATCH_TOKEN, accept: 'application/vnd.github+json', 'user-agent': 'cheaterflag', 'content-type': 'application/json' },
      body: JSON.stringify({ ref: 'main' }),
    });
  } catch (_) { /* the schedule is still a fallback */ }
}

async function route(req, env) {
  const url = new URL(req.url);
  const p = url.pathname.replace(/\/$/, '') || '/';
  const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
  let m;

  if (p === '/' ) return json({ service: 'CheaterFlag', ok: true });

  // --- auth
  if (p === '/auth/steam' && req.method === 'POST') {
    const steamid = await verifyOpenId(body.params || {});
    if (!steamid) throw new HttpError(401, 'Steam sign-in could not be verified.');
    const prof = (await profiles(env, [steamid])).get(steamid);
    const name = prof?.summary?.personaname || null;
    const existing = await env.DB.prepare('SELECT * FROM members WHERE steamid = ?').bind(steamid).first();
    if (!existing) {
      const anyAdmin = await env.DB.prepare("SELECT 1 FROM members WHERE role = 'admin' LIMIT 1").first();
      // the very first person to sign in becomes the admin
      await env.DB.prepare('INSERT INTO members (steamid, name, status, role, created_at, last_seen) VALUES (?,?,?,?,?,?)')
        .bind(steamid, name, 'approved', anyAdmin ? 'member' : 'admin', now(), now()).run();   // auto-approve (admin can still suspend)
      await audit(env, steamid, anyAdmin ? 'signup' : 'bootstrap_admin', steamid);
    } else if (name) {
      await env.DB.prepare('UPDATE members SET name = ? WHERE steamid = ?').bind(name, steamid).run();
    }
    const mem = await env.DB.prepare('SELECT * FROM members WHERE steamid = ?').bind(steamid).first();
    return json({ token: await makeToken(env, steamid), member: mem });
  }

  if (p === '/me') { m = await member(env, req, { approved: false }); return json({ member: m }); }

  // --- bot (shared secret)
  if (p.startsWith('/bot/')) {
    if (!env.BOT_SECRET || req.headers.get('x-bot-secret') !== env.BOT_SECRET) throw new HttpError(401, 'Bad bot secret.');
    if (p === '/bot/jobs' && req.method === 'GET') {
      await setMeta(env, 'bot_seen', now()).catch(() => {});
      const { results } = await env.DB.prepare("SELECT id, share_code FROM demo_jobs WHERE status = 'pending' ORDER BY id LIMIT 10").all();
      return json({ jobs: results });
    }
    const jm = p.match(/^\/bot\/jobs\/(\d+)$/);
    if (jm && req.method === 'POST') {
      const ok = typeof body.url === 'string' && /^https?:\/\/replay\d*\.(valve\.net|wmsj\.cn)\//.test(body.url);
      await env.DB.prepare('UPDATE demo_jobs SET status = ?, url = ?, error = ?, updated_at = ? WHERE id = ?')
        .bind(ok ? 'done' : 'error', ok ? body.url : null, ok ? null : String(body.error || 'Invalid demo URL').slice(0, 300), now(), Number(jm[1])).run();
      return json({ ok: true });
    }
    throw new HttpError(404, 'Not found');
  }

  // --- everything below needs an approved member
  m = await member(env, req);

  if (p === '/check' && req.method === 'POST') {
    return json({ players: await checkPlayers(env, (body.steamids || []).map(String)) });
  }

  if (p === '/live-check' && req.method === 'POST') {
    const names = new Set((body.names || []).map((n) => String(n).trim().toLowerCase()).filter(Boolean).slice(0, 20));
    const { results: bl } = await env.DB.prepare('SELECT steamid, name, category, reason FROM blacklist').all();
    const ids = [m.steamid, ...bl.map((b) => b.steamid)];
    const live = new Map();
    for (let i = 0; i < ids.length; i += 100) {
      const r = await steamApi(env, 'ISteamUser/GetPlayerSummaries/v2/', { steamids: ids.slice(i, i + 100).join(',') });
      if (!r.ok) throw new HttpError(502, 'Steam API error.');
      for (const pl of ((await r.json()).response || {}).players || []) live.set(pl.steamid, pl);
    }
    const me = live.get(m.steamid) || {};
    const myServer = me.gameserversteamid && me.gameserversteamid !== '0' ? me.gameserversteamid : null;
    const myLobby = me.lobbysteamid && me.lobbysteamid !== '0' ? me.lobbysteamid : null;
    const out = { serverKnown: !!(myServer || myLobby), confirmed: [], likely: [], nameOnly: [] };
    for (const b of bl) {
      const pl = live.get(b.steamid) || {};
      const sameServer = (myServer && pl.gameserversteamid === myServer) || (myLobby && pl.lobbysteamid === myLobby);
      const current = pl.personaname || b.name || '';
      const nameMatch = names.has(current.toLowerCase()) || names.has((b.name || '').toLowerCase());
      const entry = { steamid: b.steamid, name: current || b.name, category: b.category, reason: b.reason };
      if (sameServer) out.confirmed.push(entry);
      else if (nameMatch && String(pl.gameid) === '730') out.likely.push(entry);
      else if (nameMatch) out.nameOnly.push(entry);
    }
    return json(out);
  }

  if (p === '/check-names' && req.method === 'POST') {
    const names = [...new Set((body.names || []).map((n) => String(n).trim().toLowerCase()).filter(Boolean))].slice(0, 20);
    if (!names.length) return json({ matches: [] });
    const ph = names.map(() => '?').join(',');
    const { results } = await env.DB.prepare(`SELECT steamid, name, category, reason FROM blacklist WHERE lower(name) IN (${ph})`).bind(...names).all();
    return json({ matches: results });
  }

  if (p === '/blacklist' && req.method === 'GET') {
    const { results } = await env.DB.prepare(`SELECT b.*, m.name AS added_by_name,
        (SELECT COUNT(*) FROM blacklist_votes v WHERE v.steamid = b.steamid AND v.vote = 'keep') AS keep_votes,
        (SELECT COUNT(*) FROM blacklist_votes v WHERE v.steamid = b.steamid AND v.vote = 'remove') AS remove_votes,
        (SELECT vote FROM blacklist_votes v WHERE v.steamid = b.steamid AND v.voter = ?) AS my_vote
      FROM blacklist b LEFT JOIN members m ON m.steamid = b.added_by ORDER BY b.created_at DESC`).bind(m.steamid).all();
    return json({ entries: results, rules: { removal: MIN_VOTES + '+ votes, 2/3 agree' } });
  }
  if (p === '/blacklist' && req.method === 'POST') {
    const id = String(body.steamid || '');
    if (!STEAM64.test(id)) throw new HttpError(400, 'Invalid SteamID64.');
    if (!body.reason) throw new HttpError(400, 'A reason is required.');
    const prof = (await profiles(env, [id])).get(id);
    if (m.role !== 'admin') {   // members' additions go to the review queue for a vote
      await env.DB.prepare('INSERT OR IGNORE INTO flags (share_code, steamid, name, category, score, rounds, signals, map, reporter, created_at, extra) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
        .bind('file:manual report', id, prof?.summary?.personaname || null, String(body.category || 'Other cheating').slice(0, 40), 0, '[]',
          JSON.stringify([{ name: 'Reported by a member', value: String(body.reason).slice(0, 300) }]), '', m.steamid, now(), null).run();
      await audit(env, m.steamid, 'manual_report', id, { reason: body.reason });
      return json({ ok: true, queued: true });
    }
    if (id !== m.steamid) await env.DB.prepare("UPDATE members SET status = 'suspended' WHERE steamid = ? AND role != 'admin'").bind(id).run();
    await env.DB.prepare('INSERT OR REPLACE INTO blacklist (steamid, name, category, reason, added_by, created_at) VALUES (?,?,?,?,?,?)')
      .bind(id, prof?.summary?.personaname || null, String(body.category || 'Other cheating').slice(0, 40), String(body.reason).slice(0, 500), m.steamid, now()).run();
    await audit(env, m.steamid, 'blacklist_add', id, { category: body.category, reason: body.reason });
    return json({ ok: true });
  }
  const bv = p.match(/^\/blacklist\/(7656119\d{10})\/vote$/);
  if (bv && req.method === 'POST') {
    if (!['keep', 'remove'].includes(body.vote)) throw new HttpError(400, 'Vote keep or remove.');
    const entry = await env.DB.prepare('SELECT * FROM blacklist WHERE steamid = ?').bind(bv[1]).first();
    if (!entry) throw new HttpError(404, 'Not on the blacklist.');
    await env.DB.prepare('INSERT OR REPLACE INTO blacklist_votes (steamid, voter, vote, created_at) VALUES (?,?,?,?)').bind(bv[1], m.steamid, body.vote, now()).run();
    const t = await env.DB.prepare("SELECT SUM(vote = 'remove') AS r, SUM(vote = 'keep') AS k FROM blacklist_votes WHERE steamid = ?").bind(bv[1]).first();
    let outcome = null;
    if (decideRemoval(t.r || 0, t.k || 0) === 'a') {
      await env.DB.batch([
        env.DB.prepare('DELETE FROM blacklist WHERE steamid = ?').bind(bv[1]),
        env.DB.prepare('DELETE FROM blacklist_votes WHERE steamid = ?').bind(bv[1]),
      ]);
      outcome = 'removed';
      await audit(env, 'vote', 'blacklist_remove', bv[1], { remove: t.r, keep: t.k });
    }
    return json({ ok: true, outcome });
  }
  const bl = p.match(/^\/blacklist\/(7656119\d{10})$/);
  if (bl && req.method === 'DELETE') {
    if (m.role !== 'admin') throw new HttpError(403, 'Admins only.');
    await env.DB.batch([
      env.DB.prepare('DELETE FROM blacklist WHERE steamid = ?').bind(bl[1]),
      env.DB.prepare('DELETE FROM blacklist_votes WHERE steamid = ?').bind(bl[1]),
    ]);
    await audit(env, m.steamid, 'blacklist_remove', bl[1]);
    return json({ ok: true });
  }

  // --- review queue
  if (p === '/flags' && req.method === 'GET') {
    const status = ['pending', 'confirmed', 'cleared'].includes(url.searchParams.get('status')) ? url.searchParams.get('status') : 'pending';
    const { results } = await env.DB.prepare(`SELECT f.*, m.name AS reporter_name,
        (SELECT COUNT(*) FROM flag_votes v WHERE v.flag_id = f.id AND v.vote = 'cheater') AS cheater_votes,
        (SELECT COUNT(*) FROM flag_votes v WHERE v.flag_id = f.id AND v.vote = 'clean') AS clean_votes,
        (SELECT vote FROM flag_votes v WHERE v.flag_id = f.id AND v.voter = ?) AS my_vote
      FROM flags f LEFT JOIN members m ON m.steamid = f.reporter WHERE f.status = ? ORDER BY f.created_at DESC LIMIT 200`).bind(m.steamid, status).all();
    return json({ flags: results.map((f) => ({ ...f, rounds: JSON.parse(f.rounds || '[]'), signals: JSON.parse(f.signals || '[]'), extra: f.extra ? JSON.parse(f.extra) : null })) });
  }
  if (p === '/flags/clear-all' && req.method === 'POST') {
    if (m.role !== 'admin') throw new HttpError(403, 'Admins only.');
    const r = await env.DB.prepare("UPDATE flags SET status = 'cleared', reviewed_by = ? WHERE status = 'pending'").bind(m.steamid).run();
    await audit(env, m.steamid, 'flags_clear_all', null, { count: r.meta && r.meta.changes });
    return json({ ok: true });
  }
  if (p === '/flags' && req.method === 'POST') {
    if (!MATCH_KEY.test(body.shareCode || '') || !STEAM64.test(String(body.steamid || ''))) throw new HttpError(400, 'Invalid flag.');
    const extra = body.extra && typeof body.extra === 'object' ? {
      moments: (Array.isArray(body.extra.moments) ? body.extra.moments : []).slice(0, 20).map((x) => ({ tick: Number(x.tick) || 0, round: Number(x.round) || 0, what: String(x.what || '').slice(0, 60) })),
      score: body.extra.score && Number.isFinite(+body.extra.score.own) && Number.isFinite(+body.extra.score.opp) ? { own: +body.extra.score.own, opp: +body.extra.score.opp } : null,
      demoUrl: /^https?:\/\/replay\d+\.valve\.net\/730\/\d+_\d+\.dem(\.bz2)?$/.test(body.extra.demoUrl || '') ? body.extra.demoUrl : null,
    } : null;
    if (extra) extra.scannerVersion = Number(body.extra.scannerVersion) || 0;
    if (extra && body.extra.scrutinized === true) extra.scrutinized = true;   // manual Scrutinize: survives scanner updates
    const sid64 = String(body.steamid);
    const vals = [String(body.name || '').slice(0, 64), String(body.category || '').slice(0, 40), Number(body.score) || 0,
      JSON.stringify(body.rounds || []).slice(0, 2000), JSON.stringify(body.signals || []).slice(0, 4000), String(body.map || '').slice(0, 40), m.steamid, now(),
      extra ? JSON.stringify(extra) : null];
    const existing = await env.DB.prepare('SELECT * FROM flags WHERE share_code = ? AND steamid = ?').bind(body.shareCode, sid64).first();
    // decided by people before (this match): keep that decision
    if (existing && (existing.status === 'confirmed' || (existing.status === 'cleared' && !['rescan', 'expired'].includes(existing.reviewed_by)))) {
      return json({ ok: true, carriedOver: existing.status });
    }
    if (existing) {
      await env.DB.prepare("UPDATE flags SET name = ?, category = ?, score = ?, rounds = ?, signals = ?, map = ?, reporter = ?, created_at = ?, extra = ?, status = 'pending', reviewed_by = NULL WHERE id = ?")
        .bind(...vals, existing.id).run();
    } else {
      await env.DB.prepare('INSERT INTO flags (share_code, steamid, name, category, score, rounds, signals, map, reporter, created_at, extra) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
        .bind(body.shareCode, sid64, ...vals).run();
    }
    // already blacklisted (decided in another match): confirm automatically, no new vote needed
    if (await env.DB.prepare('SELECT 1 FROM blacklist WHERE steamid = ?').bind(sid64).first()) {
      await env.DB.prepare("UPDATE flags SET status = 'confirmed', reviewed_by = 'auto: already blacklisted' WHERE share_code = ? AND steamid = ?").bind(body.shareCode, sid64).run();
      return json({ ok: true, carriedOver: 'confirmed' });
    }
    return json({ ok: true });
  }
  if (p === '/flags/supersede' && req.method === 'POST') {
    // a scanner update: undecided flags from older scanner versions are replaced by the re-scan
    const v = Number(body.scannerVersion) || 0;
    await env.DB.prepare("UPDATE flags SET status = 'cleared', reviewed_by = 'rescan' WHERE status = 'pending' AND share_code NOT LIKE 'file:manual%' AND COALESCE(json_extract(extra, '$.scrutinized'), 0) = 0 AND COALESCE(json_extract(extra, '$.scannerVersion'), 0) < ?").bind(v).run();
    return json({ ok: true });
  }
  const fm = p.match(/^\/flags\/(\d+)$/);
  if (fm && req.method === 'POST') {
    const f = await env.DB.prepare('SELECT * FROM flags WHERE id = ?').bind(Number(fm[1])).first();
    if (!f) throw new HttpError(404, 'Flag not found.');
    if (f.status !== 'pending') throw new HttpError(409, 'This flag was already decided.');
    // members vote; early decisions need clear agreement, the rest is decided on decision day
    if (body.action === 'vote' || (m.role !== 'admin' && ['confirm', 'clear'].includes(body.action))) {
      const vote = body.vote || (body.action === 'confirm' ? 'cheater' : 'clean');
      if (!['cheater', 'clean'].includes(vote)) throw new HttpError(400, 'Vote cheater or clean.');
      await env.DB.prepare('INSERT OR REPLACE INTO flag_votes (flag_id, voter, vote, created_at) VALUES (?,?,?,?)').bind(f.id, m.steamid, vote, now()).run();
      const t = await env.DB.prepare("SELECT SUM(vote = 'cheater') AS c, SUM(vote = 'clean') AS k FROM flag_votes WHERE flag_id = ?").bind(f.id).first();
      const d = strongDecision(t.c || 0, t.k || 0);
      if (!d) return json({ ok: true, outcome: null });
      body.action = d === 'a' ? 'confirm' : 'clear';
      await applyFlagDecision(env, f, body.action, 'vote');
      return json({ ok: true, outcome: body.action === 'confirm' ? 'confirmed' : 'cleared' });
    }
    if (!['confirm', 'clear'].includes(body.action)) throw new HttpError(400, 'Unknown action.');
    await applyFlagDecision(env, f, body.action, m.steamid);
    return json({ ok: true, outcome: body.action === 'confirm' ? 'confirmed' : 'cleared' });
  }

  // --- match history + demo jobs
  if (p === '/matches/next' && req.method === 'POST') {
    if (!SHARE_CODE.test(body.knownCode || '')) throw new HttpError(400, 'Your most recent match code looks wrong (CSGO-xxxxx-…).');
    const r = await steamApi(env, 'ICSGOPlayers_730/GetNextMatchSharingCode/v1', { steamid: m.steamid, steamidkey: String(body.authCode || ''), knowncode: body.knownCode });
    if (r.status === 403) throw new HttpError(400, 'Steam rejected your game authentication code.');
    if (r.status === 412) throw new HttpError(400, 'Steam rejected your match code — paste your most recent one again.');
    if (r.status === 202) return json({ nextCode: null });
    if (!r.ok) throw new HttpError(502, `Steam match history error (${r.status}).`);
    const next = ((await r.json()).result || {}).nextcode;
    return json({ nextCode: next && next !== 'n/a' ? next : null });
  }
  if (p === '/demos/request' && req.method === 'POST') {
    if (!SHARE_CODE.test(body.shareCode || '')) throw new HttpError(400, 'Invalid share code.');
    await env.DB.prepare('INSERT OR IGNORE INTO demo_jobs (share_code, requested_by, created_at) VALUES (?,?,?)').bind(body.shareCode, m.steamid, now()).run();
    // retry failed jobs
    await env.DB.prepare("UPDATE demo_jobs SET status = 'pending', error = NULL WHERE share_code = ? AND status = 'error'").bind(body.shareCode).run();
    const j = await env.DB.prepare('SELECT id FROM demo_jobs WHERE share_code = ?').bind(body.shareCode).first();
    await wakeBot(env);
    return json({ id: j.id });
  }
  const dm = p.match(/^\/demos\/(\d+)$/);
  if (dm) {
    const j = await env.DB.prepare('SELECT id, share_code, status, url, error FROM demo_jobs WHERE id = ?').bind(Number(dm[1])).first();
    if (!j) throw new HttpError(404, 'Job not found.');
    if (j.status === 'pending') await wakeBot(env);   // a bot run may have ended just before this job arrived
    return json(j);
  }

  // --- admin
  if (p === '/admin/members' && req.method === 'GET') {
    if (m.role !== 'admin') throw new HttpError(403, 'Admins only.');
    const { results } = await env.DB.prepare("SELECT * FROM members ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, created_at DESC").all();
    return json({ members: results });
  }
  const am = p.match(/^\/admin\/members\/(7656119\d{10})$/);
  if (am && req.method === 'POST') {
    if (m.role !== 'admin') throw new HttpError(403, 'Admins only.');
    const status = ['pending', 'approved', 'suspended'].includes(body.status) ? body.status : null;
    const role = ['member', 'admin'].includes(body.role) ? body.role : null;
    if (status) await env.DB.prepare('UPDATE members SET status = ? WHERE steamid = ?').bind(status, am[1]).run();
    if (role) await env.DB.prepare('UPDATE members SET role = ? WHERE steamid = ?').bind(role, am[1]).run();
    await audit(env, m.steamid, 'member_update', am[1], { status, role });
    return json({ ok: true });
  }
  const ao = p.match(/^\/admin\/overrides\/(7656119\d{10})$/);
  if (ao && req.method === 'POST') {
    if (m.role !== 'admin') throw new HttpError(403, 'Admins only.');
    if (!body.tier) await env.DB.prepare('DELETE FROM overrides WHERE steamid = ?').bind(ao[1]).run();
    else if (['limited', 'rejected'].includes(body.tier) && await isProtectedMember(env, ao[1])) {
      throw new HttpError(403, 'That player is a CheaterFlag member — trust overrides can\'t lower a member.');
    } else if (['approved', 'limited', 'rejected'].includes(body.tier)) {
      await env.DB.prepare('INSERT OR REPLACE INTO overrides (steamid, tier, note, set_by, created_at) VALUES (?,?,?,?,?)').bind(ao[1], body.tier, String(body.note || '').slice(0, 300), m.steamid, now()).run();
    } else throw new HttpError(400, 'Unknown tier.');
    await audit(env, m.steamid, 'override', ao[1], { tier: body.tier, note: body.note });
    return json({ ok: true });
  }

  throw new HttpError(404, 'Not found');
}

// Daily: re-check every member for new bans (auto-suspend), expire old jobs and caches.
async function daily(env) {
  const { results } = await env.DB.prepare("SELECT steamid FROM members WHERE status = 'approved' AND role = 'member'").all();
  const ids = results.map((r) => r.steamid);
  for (let i = 0; i < ids.length; i += 100) {
    const checks = await checkPlayers(env, ids.slice(i, i + 100), { force: true, rawForMembers: true });
    for (const c of checks) {
      if (c.tier === 'rejected') {
        await env.DB.prepare("UPDATE members SET status = 'suspended' WHERE steamid = ?").bind(c.steamid).run();
        await audit(env, 'system', 'auto_suspend', c.steamid, { reasons: c.reasons });
      }
    }
  }
  // decision day: any votes -> the majority decides
  const { results: due } = await env.DB.prepare(`SELECT f.*, (SELECT SUM(vote = 'cheater') FROM flag_votes v WHERE v.flag_id = f.id) AS c,
      (SELECT SUM(vote = 'clean') FROM flag_votes v WHERE v.flag_id = f.id) AS k
    FROM flags f WHERE f.status = 'pending' AND f.created_at < ?`).bind(now() - DECIDE_AFTER_DAYS * 86400).all();
  for (const f of due) {
    const d = majorityDecision(f.c || 0, f.k || 0);
    if (!d) continue;
    await applyFlagDecision(env, f, d === 'a' ? 'confirm' : 'clear', 'vote (decision day)');
  }
  // expiry: no decision -> cleared (Valve's copy of the demo is about to expire)
  await env.DB.prepare("UPDATE flags SET status = 'cleared', reviewed_by = 'expired' WHERE status = 'pending' AND created_at < ?").bind(now() - FLAG_EXPIRY_DAYS * 86400).run();
  await env.DB.prepare('DELETE FROM demo_jobs WHERE created_at < ?').bind(now() - 7 * 86400).run();
  await env.DB.prepare("UPDATE demo_jobs SET status = 'error', error = 'Bot did not respond' WHERE status = 'pending' AND created_at < ?").bind(now() - 3600).run();
  await env.DB.prepare('DELETE FROM profiles WHERE fetched_at < ?').bind(now() - 7 * 86400).run();
}

export default {
  async fetch(req, env) {
    try { return await route(req, env); }
    catch (e) { return json({ error: e.message || 'Server error' }, e.status || 500); }
  },
  async scheduled(_event, env, ctx) { ctx.waitUntil(daily(env)); },
};
