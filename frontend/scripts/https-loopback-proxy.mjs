#!/usr/bin/env node
/**
 * RUN 05 live acceptance only: Slack accepts only HTTPS redirect URLs. This forwards https://localhost:<HTTPS_PORT> (self-signed certificate,
 * loopback only) to the local app at http://127.0.0.1:<APP_PORT>, so the Slack dev app can redirect to
 * https://localhost:<HTTPS_PORT>/api/notify/slack/callback. Never exposed to the network (binds 127.0.0.1), no tunnel, no dependency.
 *   node scripts/https-loopback-proxy.mjs <cert.pem> <key.pem> [HTTPS_PORT=3472] [APP_PORT=3471]
 */
import https from 'node:https';
import http from 'node:http';
import net from 'node:net';
import { readFileSync } from 'node:fs';

const [cert, key, httpsPort = '3472', appPort = '3471'] = process.argv.slice(2);
if (!cert || !key) { console.error('usage: https-loopback-proxy.mjs <cert.pem> <key.pem> [https-port] [app-port]'); process.exit(2); }
const server = https.createServer({ cert: readFileSync(cert), key: readFileSync(key) }, (req, res) => {
  const up = http.request({ host: '127.0.0.1', port: Number(appPort), method: req.method, path: req.url,
    headers: { ...req.headers, 'x-forwarded-proto': 'https', host: `localhost:${httpsPort}` } }, (r) => {
    res.writeHead(r.statusCode ?? 502, r.headers);
    r.pipe(res);
  });
  up.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end('app not reachable'); });
  req.pipe(up);
});
// WebSocket upgrades (RUN 08): Next 16 dev (Turbopack) needs its HMR socket /_next/webpack-hmr -- without it the page never finishes loading
server.on('upgrade', (req, client, head) => {
  const up = net.connect(Number(appPort), '127.0.0.1', () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (const [k, v] of Object.entries({ ...req.headers, host: `localhost:${httpsPort}`, 'x-forwarded-proto': 'https' })) {
      for (const one of Array.isArray(v) ? v : [v]) lines.push(`${k}: ${one}`);
    }
    up.write(lines.join('\r\n') + '\r\n\r\n');
    if (head?.length) up.write(head);
    up.pipe(client); client.pipe(up);
  });
  const close = () => { up.destroy(); client.destroy(); };
  up.on('error', close); client.on('error', close);
});
server.listen(Number(httpsPort), '127.0.0.1', () => console.log(`https-loopback-proxy: https://localhost:${httpsPort} -> http://127.0.0.1:${appPort} (local only)`));
