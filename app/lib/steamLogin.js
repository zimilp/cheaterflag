'use strict';
// "Sign in through Steam" (OpenID 2.0) using a one-time local callback. The password is only
// ever typed on steamcommunity.com; the shared service re-verifies the response with Steam.
const http = require('http');

function steamSignIn(openUrl, timeoutMs = 5 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname !== '/callback') { res.writeHead(404); return res.end(); }
      const params = Object.fromEntries(url.searchParams.entries());
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><body style="font-family:sans-serif;background:#111;color:#eee;text-align:center;padding-top:80px">' +
        '<h2>Signed in to CheaterFlag</h2><p>You can close this tab.</p></body></html>');
      clearTimeout(timer); server.close();
      if (params['openid.mode'] !== 'id_res') return reject(new Error('Steam sign-in was cancelled.'));
      resolve(params);
    });
    const timer = setTimeout(() => { server.close(); reject(new Error('Steam sign-in timed out.')); }, timeoutMs);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const returnTo = `http://127.0.0.1:${port}/callback`;
      const q = new URLSearchParams({
        'openid.ns': 'http://specs.openid.net/auth/2.0',
        'openid.mode': 'checkid_setup',
        'openid.return_to': returnTo,
        'openid.realm': `http://127.0.0.1:${port}`,
        'openid.identity': 'http://specs.openid.net/auth/2.0/identifier_select',
        'openid.claimed_id': 'http://specs.openid.net/auth/2.0/identifier_select',
      });
      openUrl('https://steamcommunity.com/openid/login?' + q.toString());
    });
  });
}

module.exports = { steamSignIn };
