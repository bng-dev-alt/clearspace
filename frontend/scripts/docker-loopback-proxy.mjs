// Scoped loopback-only publishing for ONE Supabase-CLI stack, WITHOUT touching the global Docker settings or any other project.
// The Supabase CLI has no bind-address option, so Docker publishes its ports on 0.0.0.0 (the LAN). This is a tiny Docker-API proxy: the CLI is
// pointed at it with DOCKER_HOST=unix://<listen-socket> for that one process only; it forwards everything to the real Docker socket and rewrites
// ONLY `POST /containers/create` so every published port gets HostIp 127.0.0.1. Containers created by anything else are not affected.
//   node scripts/docker-loopback-proxy.mjs <listen-socket> [<docker-socket>]
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';

const listen = process.argv[2];
const upstream = process.argv[3] || '/var/run/docker.sock';

export function loopbackOnly(body) {
  const cfg = JSON.parse(body);
  const pb = cfg?.HostConfig?.PortBindings;
  if (pb && typeof pb === 'object') for (const k of Object.keys(pb)) pb[k] = (pb[k] ?? [{}]).map((b) => ({ ...b, HostIp: '127.0.0.1' }));
  return JSON.stringify(cfg);
}
const isCreate = (req) => req.method === 'POST' && /^(\/v[\d.]+)?\/containers\/create(\?|$)/.test(req.url ?? '');

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    let body = Buffer.concat(chunks);
    const headers = { ...req.headers };
    if (isCreate(req)) { try { body = Buffer.from(loopbackOnly(body.toString('utf8'))); headers['content-length'] = String(body.length); delete headers['transfer-encoding']; console.log('create: ports -> 127.0.0.1'); } catch { /* not JSON: pass through unchanged */ } }
    const up = http.request({ socketPath: upstream, path: req.url, method: req.method, headers }, (r) => { res.writeHead(r.statusCode ?? 502, r.headers); r.pipe(res); });
    up.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    up.end(body);
  });
});
// attach/exec streams (hijacked connections): plain byte pipe, nothing rewritten
server.on('upgrade', (req, socket, head) => {
  const up = net.connect(upstream, () => {
    up.write(`${req.method} ${req.url} HTTP/1.1\r\n${Object.entries(req.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`);
    if (head?.length) up.write(head);
    socket.pipe(up); up.pipe(socket);
  });
  up.on('error', () => socket.destroy()); socket.on('error', () => up.destroy());
});
if (import.meta.url === `file://${process.argv[1]}`) {
  if (!listen) { console.error('usage: docker-loopback-proxy.mjs <listen-socket> [<docker-socket>]'); process.exit(2); }
  try { fs.unlinkSync(listen); } catch { /* none */ }
  server.listen(listen, () => { fs.chmodSync(listen, 0o600); console.log(`loopback proxy on ${listen} -> ${upstream}`); });
}
