#!/usr/bin/env node
// Preflight BEFORE any local login (browser E2E, visual QA, a person at /login): which Auth instance will the app use, and does the dev identity work there?
//   node scripts/local-auth-preflight.mjs                       # checks the env the app will get (NEXT_PUBLIC_SUPABASE_URL / _ANON_KEY, DEV_LOGIN_EMAIL / _PASSWORD)
//   APP_URL=http://127.0.0.1:3421 node scripts/local-auth-preflight.mjs   # + the running app's dev-login route answers for that identity
// Refuses (exit 1) when the Auth target is not loopback: local development never logs in against hosted/production Auth. Prints no secret.
const env = process.env;
const fail = (msg) => { console.error(`AUTH PREFLIGHT FAIL: ${msg}`); process.exit(1); };
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

if (env.NEXT_PUBLIC_FORCE_DEMO === '1') fail('NEXT_PUBLIC_FORCE_DEMO=1: the app uses browser-local mock accounts, no real or local Supabase login is possible (unset it)');
const url = env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const anon = env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
let u;
try { u = new URL(url); } catch { fail('NEXT_PUBLIC_SUPABASE_URL is missing or invalid'); }
if (!LOOPBACK.has(u.hostname)) {
  const ref = /^([a-z0-9]{20})\.supabase\.co$/.exec(u.hostname)?.[1];
  fail(`Auth target is ${ref ? `the HOSTED project ${ref}` : u.host}, not an isolated local instance; local dev login is only allowed against 127.0.0.1`);
}
if (!anon) fail('NEXT_PUBLIC_SUPABASE_ANON_KEY is missing');
if (!env.DEV_LOGIN_EMAIL || !env.DEV_LOGIN_PASSWORD) fail('DEV_LOGIN_EMAIL / DEV_LOGIN_PASSWORD not set (run scripts/local-dev.sh seed)');

const health = await fetch(`${url}/auth/v1/health`, { headers: { apikey: anon } }).catch(() => null);
if (!health || health.status !== 200) fail(`local Auth at ${u.host} is not reachable (HTTP ${health?.status ?? 'none'}); start the stack: scripts/local-dev.sh up`);

const login = await fetch(`${url}/auth/v1/token?grant_type=password`, {
  method: 'POST',
  headers: { apikey: anon, 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: env.DEV_LOGIN_EMAIL, password: env.DEV_LOGIN_PASSWORD }),
});
const j = await login.json().catch(() => ({}));
if (login.status !== 200 || !j.user?.id) fail(`the dev identity ${env.DEV_LOGIN_EMAIL} cannot sign in at ${u.host} (HTTP ${login.status}); re-seed: scripts/local-dev.sh seed`);

if (env.APP_URL) {
  const app = new URL(env.APP_URL);
  if (!LOOPBACK.has(app.hostname)) fail(`APP_URL ${app.host} is not loopback`);
  const r = await fetch(`${env.APP_URL}/api/dev/login`, { method: 'POST', headers: { 'x-clearspace-dev-login': '1' } }).catch(() => null);
  if (!r || r.status !== 200) fail(`the app at ${app.host} refused the dev login (HTTP ${r?.status ?? 'none'}): it is not running with this env (see the server log line [dev-login] refused: ...)`);
}
console.log(`AUTH PREFLIGHT OK: Auth = isolated local instance ${u.host}; dev identity ${env.DEV_LOGIN_EMAIL} (${j.user.id.slice(0, 8)}) signs in${env.APP_URL ? `; app ${new URL(env.APP_URL).host} dev login works` : ''}`);
