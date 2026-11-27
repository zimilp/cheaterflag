'use strict';
// Client for the CheaterFlag shared service (Cloudflare Worker).

class Api {
  constructor(getBase, getToken) { this.getBase = getBase; this.getToken = getToken; }

  async req(method, route, body) {
    const base = (this.getBase() || '').replace(/\/$/, '');
    if (!base) throw new Error('CheaterFlag service URL is not set (Settings).');
    let res;
    try {
      res = await fetch(base + route, {
        method,
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + (this.getToken() || '') },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (_) {
      throw new Error("Couldn't reach the CheaterFlag service (internet hiccup?). It will try again automatically.");
    }
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch (_) { data = { error: text }; }
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  signIn(openidParams) { return this.req('POST', '/auth/steam', { params: openidParams }); }
  me() { return this.req('GET', '/me'); }
  liveCheck(names) { return this.req('POST', '/live-check', { names }); }
  checkNames(names) { return this.req('POST', '/check-names', { names }); }
  check(steamids) { return this.req('POST', '/check', { steamids }); }
  blacklist() { return this.req('GET', '/blacklist'); }
  addBlacklist(entry) { return this.req('POST', '/blacklist', entry); }
  removeBlacklist(steamid) { return this.req('DELETE', '/blacklist/' + steamid); }
  flags(status = 'pending') { return this.req('GET', '/flags?status=' + status); }
  submitFlag(flag) { return this.req('POST', '/flags', flag); }
  voteFlag(id, vote) { return this.req('POST', '/flags/' + id, { action: 'vote', vote }); }
  voteBlacklist(steamid, vote) { return this.req('POST', '/blacklist/' + steamid + '/vote', { vote }); }
  supersede(scannerVersion) { return this.req('POST', '/flags/supersede', { scannerVersion }); }
  clearAllFlags() { return this.req('POST', '/flags/clear-all', {}); }
  reviewFlag(id, action) { return this.req('POST', '/flags/' + id, { action }); }
  members() { return this.req('GET', '/admin/members'); }
  setMember(steamid, patch) { return this.req('POST', '/admin/members/' + steamid, patch); }
  setOverride(steamid, tier, note) { return this.req('POST', '/admin/overrides/' + steamid, { tier, note }); }
  nextMatch(authCode, knownCode) { return this.req('POST', '/matches/next', { authCode, knownCode }); }
  requestDemo(shareCode) { return this.req('POST', '/demos/request', { shareCode }); }
  demoJob(id) { return this.req('GET', '/demos/' + id); }
  uploadStats(body) { return this.req('POST', '/stats', body); }
  uploadStatsBatch(matches) { return this.req('POST', '/stats', { matches }); }
  withdrawFlag(shareCode, steamid) { return this.req('POST', '/flags/withdraw', { shareCode, steamid }); }
  presence(names) { return this.req('POST', '/presence', { names }); }
  squad(names, map) { return this.req('POST', '/squad', { names, map }); }
  uploadPings(body) { return this.req('POST', '/pings', body); }
  pings() { return this.req('GET', '/pings'); }
  stats(days = 0) { return this.req('GET', '/stats?days=' + Number(days || 0)); }
}

module.exports = { Api };
