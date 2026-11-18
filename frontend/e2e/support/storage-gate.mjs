// Minimal PUBLIC-FACING gate for the REAL Soniox test (scripts/soniox-real-test.sh). Soniox downloads audio from the internet, the local Supabase
// Storage is private to this machine. This gate is what a tunnel points at: it forwards ONLY GET/HEAD of signed object URLs of the bucket
// `meeting-audio` (path + ?token=...) to the local Supabase API and answers 404 to everything else (no auth, REST, upload, listing, other buckets).
//   node e2e/support/storage-gate.mjs <listen-port> <local-supabase-origin>      e.g. 55592 http://127.0.0.1:55521
import http from 'node:http';

const listen = Number(process.argv[2] || 55592);
const target = new URL(process.argv[3] || 'http://127.0.0.1:55521');
if (!/^(127\.0\.0\.1|localhost)$/.test(target.hostname)) { console.error('refusing: target must be a local Supabase'); process.exit(2); }
const ALLOWED = /^\/storage\/v1\/object\/sign\/meeting-audio\/[A-Za-z0-9._\/-]+\?token=[A-Za-z0-9._-]+$/;
let served = 0;

export const gate = http.createServer((req, res) => {
  if (!['GET', 'HEAD'].includes(req.method ?? '') || !ALLOWED.test(req.url ?? '')) { res.writeHead(404); res.end(); return; }
  const up = http.request({ host: target.hostname, port: target.port, path: req.url, method: req.method, headers: { range: req.headers.range ?? '' , host: target.host } }, (r) => {
    res.writeHead(r.statusCode ?? 502, { 'content-type': r.headers['content-type'] ?? 'application/octet-stream', ...(r.headers['content-length'] ? { 'content-length': r.headers['content-length'] } : {}), ...(r.headers['content-range'] ? { 'content-range': r.headers['content-range'] } : {}) });
    r.pipe(res);
  });
  up.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
  up.end();
  served += 1;
  console.log(`gate ${req.method} #${served} ${(req.url ?? '').split('?')[0].split('/').slice(-1)[0]} (token not logged)`);
});
if (import.meta.url === `file://${process.argv[1]}`) gate.listen(listen, '127.0.0.1', () => console.log(`storage gate on ${listen} -> ${target.origin}`));
