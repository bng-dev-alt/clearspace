/**
 * Development-only login helper. FAILS CLOSED: every condition must hold, otherwise the route answers 404
 * as if it did not exist. It never bypasses authentication -- it performs a normal password sign-in for a
 * dedicated disposable account, on the SERVER (the password never reaches the browser), and hands the
 * resulting session to supabase-js. RLS stays fully on; no privileged key is involved.
 */
export interface DevLoginEnv {
  nodeEnv?: string;
  enabled?: string;
  /** Set on Vercel (any deployment) -- never allowed there. */
  vercel?: string;
  email?: string;
  password?: string;
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
/** Headers only a tunnel / CDN adds (Cloudflare, Vercel): present => the request did not come straight from this machine. */
const TUNNEL_HEADERS = ['forwarded', 'cf-connecting-ip', 'cf-ray', 'cf-ipcountry', 'x-vercel-id', 'x-vercel-forwarded-for'];
const LOOPBACK_IPS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const allLoopbackIps = (v: string) => v.split(',').map((x) => x.trim()).every((x) => LOOPBACK_IPS.has(x));

export function hostnameOf(hostHeader: string | null): string {
  if (!hostHeader) return '';
  const h = hostHeader.trim().toLowerCase();
  if (h.startsWith('[')) return h.slice(0, h.indexOf(']') + 1); // [::1]:3000
  return h.split(':')[0];
}

export function isLoopbackHost(hostHeader: string | null): boolean {
  return LOOPBACK.has(hostnameOf(hostHeader));
}

/** Returns the reason the request must be refused, or null when the dev login may proceed. */
export function devLoginRefusal(env: DevLoginEnv, headers: Headers): string | null {
  if (env.nodeEnv !== 'development') return 'not a development build';
  if (env.enabled !== '1') return 'CLEARSPACE_DEV_LOGIN is not 1';
  if (env.vercel) return 'running on Vercel';
  if (!env.email || !env.password) return 'dev account not configured';
  if (!isLoopbackHost(headers.get('host'))) return 'host is not loopback';
  for (const h of TUNNEL_HEADERS) if (headers.has(h)) return `tunnel header ${h} present`;
  // `next dev` itself adds x-forwarded-for/-host (= the direct peer), so these are only suspicious when they name a non-loopback party.
  for (const h of ['x-forwarded-for', 'x-real-ip']) {
    const v = headers.get(h);
    if (v && !allLoopbackIps(v)) return `${h} names a non-loopback client`;
  }
  const fwdHost = headers.get('x-forwarded-host');
  if (fwdHost && !isLoopbackHost(fwdHost)) return 'x-forwarded-host is not loopback';
  const origin = headers.get('origin');
  if (origin) {
    try { if (!LOOPBACK.has(new URL(origin).hostname)) return 'foreign origin'; } catch { return 'bad origin'; }
  }
  const site = headers.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none') return 'cross-site request';
  if (headers.get('x-clearspace-dev-login') !== '1') return 'missing marker header';
  return null;
}
