#!/usr/bin/env node
/**
 * RUN 07B: the ONLY thing a public HTTPS tunnel may reach during live acceptance. Listens on loopback and forwards exactly the provider
 * webhook routes (POST) to the local app; every other path / method answers 404 without touching the app. No cookies, no Authorization,
 * no forwarded-for headers pass; bodies are capped. The DEV login, the UI and every user API stay unreachable from the internet.
 *
 *   node scripts/hub-webhook-gate.mjs [listenPort=3473] [appPort=3471]
 */
import http from 'node:http';

const LISTEN = Number(process.argv[2] || 3473), APP = Number(process.argv[3] || 3471);
const ALLOWED = new Set(['/api/hub/slack/commands', '/api/hub/slack/interactivity', '/api/hub/slack/events', '/api/hub/telegram/webhook', '/api/hub/telegram/pi-webhook']);
const PASS = /^(content-type|content-length|x-slack-signature|x-slack-request-timestamp|x-slack-retry-num|x-slack-retry-reason|x-telegram-bot-api-secret-token|user-agent)$/i;
const MAX = 256 * 1024;
let served = 0, refused = 0;

const server = http.createServer((req, res) => {
  const path = (req.url ?? '').split('?')[0];
  if (req.method !== 'POST' || !ALLOWED.has(path)) { refused++; res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('not found'); }
  const chunks = []; let size = 0, aborted = false;
  req.on('data', (c) => { size += c.length; if (size > MAX) { aborted = true; res.writeHead(413); res.end(); req.destroy(); } else chunks.push(c); });
  req.on('end', () => {
    if (aborted) return;
    const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => PASS.test(k)));
    const up = http.request({ host: '127.0.0.1', port: APP, method: 'POST', path, headers }, (r) => {
      served++;
      const out = Object.fromEntries(Object.entries(r.headers).filter(([k]) => /^content-type$/i.test(k)));
      res.writeHead(r.statusCode ?? 502, out); r.pipe(res);
    });
    up.on('error', () => { res.writeHead(502); res.end(); });
    up.setTimeout(25_000, () => up.destroy());
    up.end(Buffer.concat(chunks));
  });
});
server.listen(LISTEN, '127.0.0.1', () => console.log(`hub webhook gate on 127.0.0.1:${LISTEN} -> app :${APP} (only ${ALLOWED.size} POST webhook paths)`));
setInterval(() => console.log(JSON.stringify({ evt: 'gate', served, refused })), 60_000).unref();
