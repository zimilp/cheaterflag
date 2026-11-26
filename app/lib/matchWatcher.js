'use strict';
// After-every-game pipeline:
// new share code (Steam match history) -> demo link (via the bot) -> download -> scan ->
// check all 10 players -> send strong-evidence flags to the review queue -> retention.
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { EventEmitter } = require('events');
const retention = require('./retention');
const { SCANNER_VERSION, applyScrutiny } = require('./demoScan');
const { awards } = require('./matchStats');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class MatchWatcher extends EventEmitter {
  constructor({ api, store, dataDir, runScan, intervalMs = 30 * 60 * 1000, watchDir = null }) {
    super();
    Object.assign(this, { api, store, runScan, intervalMs, watchDir });
    this.demoDir = path.join(dataDir, 'demos');
    this.flaggedDir = path.join(this.demoDir, 'flagged');
    this.cleanDir = path.join(this.demoDir, 'clean');
    this.busy = false;
    this.playedAt = new Map();
  }

  keepCleanDays() { const d = this.store.get('keepCleanDays'); return d == null ? 7 : Number(d) || 0; }

  start() {
    fs.mkdirSync(this.demoDir, { recursive: true });
    retention.sweep(this.demoDir, this.flaggedDir, Date.now(), retention.FLAGGED_DAYS, [this.watchDir], this.cleanDir, this.keepCleanDays());
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    setTimeout(() => this.tick(), 15000);
  }
  stop() { clearInterval(this.timer); }

  async tick() {
    if (this.busy) return;
    const authCode = this.store.get('authCode'), known = this.store.get('lastShareCode');
    if (!authCode || !known || !this.store.get('token')) return 0;
    let found = 0;
    this.busy = true;
    this.store.set({ lastMatchCheck: Date.now() });
    try {
      retention.sweep(this.demoDir, this.flaggedDir, Date.now(), retention.FLAGGED_DAYS, [this.watchDir], this.cleanDir, this.keepCleanDays());
      let code = known;
      for (let i = 0; i < 10; i++) {               // catch up on up to 10 matches per run
        const { nextCode } = await this.api.nextMatch(authCode, code);
        if (!nextCode) break;
        await this.processMatch(nextCode);
        code = nextCode;
        this.store.set({ lastShareCode: code });
        found++;
      }
    } catch (e) {
      this.emit('error', e);
    } finally { this.busy = false; }
    return found;
  }

  /**
   * Right after a match ends: check every minute (for up to 25 minutes) until Steam lists the new match,
   * then scan it straight away. Regular checks are only a fallback (every 30 minutes).
   */
  async afterMatch() {
    if (this.fast) return;
    this.fast = true;
    try {
      for (let i = 0; i < 25; i++) {
        await sleep(60 * 1000);
        if (this.busy) continue;
        if ((await this.tick()) > 0) return;
      }
    } finally { this.fast = false; }
  }

  async processMatch(shareCode) {
    this.emit('progress', { shareCode, step: 'Requesting demo link' });
    const { id } = await this.api.requestDemo(shareCode);
    let job;
    for (let i = 0; i < 96; i++) {               // up to ~8 min: the bot may need a minute or two to start
      job = await this.api.demoJob(id);
      if (job.status !== 'pending') break;
      await sleep(5000);
    }
    if (!job || job.status !== 'done') throw new Error(`Demo link failed for ${shareCode}: ${job && job.error || 'the demo bot did not answer in time - it will be tried again automatically'}`);

    this.emit('progress', { shareCode, step: 'Downloading demo' });
    const demoPath = await this.download(job.url, shareCode);

    return this.processDemo(demoPath, shareCode, { ownFile: false, demoUrl: job.url, playedAt: this.playedAt.get(demoPath) });
  }

  /**
   * Scan a demo, check all 10 accounts, send strong-evidence flags to the review queue,
   * apply retention (never to the user's own files), save to history.
   */
  async processDemo(demoPath, key, { ownFile, demoUrl = null, playedAt = null }) {
    this.emit('progress', { shareCode: key, step: 'Scanning demo' });
    const scan = await this.runScan(demoPath);
    let checks = [];
    try { checks = (await this.api.check(scan.players.map((p) => p.steamid))).players || []; } catch (e) { this.emit('error', e); }
    // extra scrutiny: players with a Caution/Flagged account are judged with stricter gameplay rules
    scan.results = applyScrutiny(scan.results, checks);
    const flagged = scan.results.filter((r) => r.flagged);
    for (const r of flagged) {
      await this.api.submitFlag({
        shareCode: key, steamid: r.steamid, name: r.name, category: r.category,
        score: r.score, rounds: r.rounds, signals: r.signals, map: scan.mapName,
        extra: { scannerVersion: SCANNER_VERSION, moments: r.moments || [], demoUrl, score: r.teamScore != null ? { own: r.teamScore, opp: r.oppScore } : null },
      }).catch((e) => this.emit('error', e));
    }
    const kept = ownFile ? demoPath : retention.afterScan(demoPath, this.flaggedDir, flagged.length > 0, this.keepCleanDays() > 0 ? this.cleanDir : null);
    if (!playedAt && ownFile) { try { playedAt = fs.statSync(demoPath).mtimeMs; } catch (_) {} }
    const result = { shareCode: key, map: scan.mapName, teams: scan.teams || [], playedAt, at: Date.now(), results: scan.results, checks, keptDemo: kept, local: ownFile, demoUrl };
    this.addAwards(result);
    this.shareStats(result);
    this.store.set({ history: [result, ...(this.store.get('history') || [])].slice(0, 100) });
    this.emit('match', result);
    return result;
  }

  /** Fun-stats awards, only among CheaterFlag members in this match. */
  addAwards(result) {
    const members = new Set((result.checks || []).filter((c) => (c.reasons || []).includes('CheaterFlag member')).map((c) => String(c.steamid)));
    const stats = new Map(result.results.filter((r) => r.stats).map((r) => [r.steamid, r.stats]));
    const aw = awards(stats, members);
    for (const r of result.results) { if (members.has(r.steamid) && r.stats) r.awards = aw.get(r.steamid) || []; else { delete r.awards; } }
    result.statsV = 1;
  }

  /** Send members' stats for the Stats tab (the service keeps members only). Needs Valve's match id. */
  shareStats(result) {
    // Valve's match id: in the demo link (…/730/<id>_<n>.dem) or a CS2 replay file name (match730_<id>_<n>_<server>.dem)
    const matchId = [result.demoUrl, result.keptDemo, result.shareCode].map((x) => (String(x || '').match(/(\d{15,30})_\d{6,12}/) || [])[1]).find(Boolean);
    if (!matchId) return;
    const wl = (r) => (r.teamScore == null ? {} : { wins: +(r.teamScore > r.oppScore), losses: +(r.teamScore < r.oppScore), ties: +(r.teamScore === r.oppScore) });
    const players = result.results.filter((r) => r.awards && r.stats).map((r) => ({ steamid: r.steamid, name: r.name, stats: { ...r.stats, ...wl(r), awards: r.awards } }));
    if (!players.length) return;
    this.api.uploadStats({ matchId, playedAt: result.playedAt || result.at, map: result.map, players }).catch((e) => this.emit('error', e));
  }

  /** Scan a .dem file you already have (e.g. downloaded in CS2's Watch tab). Your file is never deleted. */
  async scanFile(demoPath) {
    return this.processDemo(demoPath, 'file:' + path.basename(demoPath).slice(0, 80), { ownFile: true });
  }

  /**
   * First-run backfill: older matches. `items` = [{type:'url', url}] (Valve demo links) or
   * [{type:'file', path}] (demos already on this PC). Runs one at a time; remembers progress.
   */
  async backfill(items) {
    const done = new Set(this.store.get('backfillDone') || []);
    const todo = items.filter((it) => it.type === 'kept' || !done.has(it.url || it.path));
    let n = 0;
    for (const it of todo) {
      while (this.busy) await sleep(5000);
      this.busy = true;
      n++;
      const id = it.url || it.path;
      if (it.type === 'kept') done.delete(id);
      this.emit('backfill', { current: n, total: todo.length });
      try {
        if (it.type === 'url') {
          const key = 'demo:' + (id.match(/(\d+_\d+)\.dem/) || [, String(n)])[1];
          this.emit('progress', { shareCode: key, step: `Older match ${n}/${todo.length}: downloading` });
          const p = await this.download(id, key);
          await this.processDemo(p, key, { ownFile: false, demoUrl: id, playedAt: this.playedAt.get(p) });
        } else if (it.type === 'kept') {   // re-scan a kept demo after a scanner update
          const key = 'demo:' + ((path.basename(id).match(/(\d+_\d+)/) || [])[1] || path.basename(id, '.dem'));
          await this.processDemo(id, key, { ownFile: false, demoUrl: it.demoUrl || null, playedAt: it.playedAt || null });
        } else {
          await this.processDemo(id, 'file:' + path.basename(id).slice(0, 80), { ownFile: true });
        }
      } catch (e) {
        this.emit('error', new Error(`Older match ${n}: ${e.message}`));
      } finally {
        this.busy = false;
        done.add(id);
        this.store.set({ backfillDone: [...done] });
      }
    }
    this.emit('backfill', { current: todo.length, total: todo.length, finished: true });
  }

  /** Scan one specific past match by its share code (demo must still be on Valve's servers). */
  async scanShareCode(shareCode) {
    if (!/^CSGO(-[A-Za-z0-9]{5}){5}$/.test(shareCode)) throw new Error('That is not a match share code (CSGO-xxxxx-xxxxx-xxxxx-xxxxx-xxxxx).');
    if (this.busy) throw new Error('A scan is already running — try again in a minute.');
    this.busy = true;
    try { return await this.processMatch(shareCode); } finally { this.busy = false; }
  }

  async download(url, shareCode) {
    const safe = shareCode.replace(/[^A-Za-z0-9_-]/g, '');
    const out = path.join(this.demoDir, safe + '.dem');
    let res;
    try { res = await fetch(url); }
    catch (_) { throw new Error("Couldn't download the match demo from Valve (internet hiccup?). It will try again later."); }
    if (!res.ok) throw new Error(`Demo download failed (HTTP ${res.status}) — Valve may have expired it.`);
    // Valve uploads the demo when the match ends, so its timestamp is when the match was played
    const lm = Date.parse(res.headers.get('last-modified') || '');
    if (!Number.isNaN(lm)) this.playedAt.set(out, lm);
    const body = Readable.fromWeb(res.body);
    if (/\.bz2(\?|$)/.test(url)) {
      const bz2 = require('unbzip2-stream');
      await pipeline(body, bz2(), fs.createWriteStream(out));
    } else {
      await pipeline(body, fs.createWriteStream(out));
    }
    return out;
  }
}

module.exports = { MatchWatcher };
