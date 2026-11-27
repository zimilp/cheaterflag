'use strict';
// Measures this PC's ping to Valve's server regions (the relay points CS2 matches run through), so the team
// balancer can pick a fair server and spread bad connections evenly. Uses Valve's public relay list and plain
// Windows `ping` — nothing is sent anywhere except the resulting numbers to the group's own server.
const { execFile } = require('child_process');

const SDR_URL = 'https://api.steampowered.com/ISteamApps/GetSDRConfig/v1/?appid=730';

/** { pop: { name, ips: [..] } } from Valve's relay list. */
async function relayList(fetchImpl = fetch) {
  const res = await fetchImpl(SDR_URL);
  if (!res.ok) throw new Error('Valve relay list unavailable (' + res.status + ')');
  const j = await res.json();
  const out = {};
  for (const [pop, v] of Object.entries(j.pops || (j.response && j.response.pops) || {})) {
    const ips = (v.relays || []).map((r) => r.ipv4).filter(Boolean).slice(0, 2);
    if (ips.length) out[pop] = { name: String(v.desc || pop), ips };
  }
  return out;
}

/** Average round-trip from one `ping` run, in ms (null if no reply). */
function parsePing(text) {
  const avg = /(?:Average|Mittelwert|Moyenne|Media|Gemiddelde)\s*=\s*(\d+)\s*ms/i.exec(text) || /min\/avg\/max[^=]*=\s*[\d.]+\/([\d.]+)/.exec(text);
  return avg ? Math.round(Number(avg[1])) : null;
}
function pingOnce(ip) {
  return new Promise((resolve) => {
    const args = process.platform === 'win32' ? ['-n', '3', '-w', '800', ip] : ['-c', '3', '-W', '1', ip];
    execFile('ping', args, { windowsHide: true, timeout: 8000 }, (err, stdout) => resolve(parsePing(String(stdout || ''))));
  });
}

/** Ping every region (a few at a time). Returns { pop: ms } for regions that answered. */
async function measureAll(list, parallel = 6) {
  const pops = Object.keys(list), out = {};
  let i = 0;
  const worker = async () => {
    while (i < pops.length) {
      const pop = pops[i++];
      for (const ip of list[pop].ips) { const ms = await pingOnce(ip); if (ms != null) { out[pop] = ms; break; } }
    }
  };
  await Promise.all(Array.from({ length: parallel }, worker));
  return out;
}

module.exports = { relayList, measureAll, parsePing, SDR_URL };
