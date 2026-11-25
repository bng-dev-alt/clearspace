// RUN 02B closeout -- does DISCONNECT really revoke the grant AT GOOGLE? (LIVE, real Google, local stack, loopback only)
// Run through: frontend/scripts/google-live.sh revoke-check   (env + secrets are loaded there; nothing is printed but statuses)
//  1. read the owner's stored refresh token (server RPC) and decrypt it IN MEMORY only
//  2. prove it is live: refresh_token grant -> 200
//  3. DELETE /api/google/connection (the product's own disconnect) -> expect revokedAtGoogle=true
//  4. replay the OLD refresh token -> Google must answer invalid_grant (that is the proof of a real revocation)
// Afterwards the owner has no connection: reconnect once in the UI (one click + consent).
import { createDecipheriv } from 'node:crypto';
import assert from 'node:assert/strict';

const { E2E_SUPABASE_URL: API, E2E_SUPABASE_ANON_KEY: ANON, E2E_BASE_URL: APP, E2E_PASSWORD: PW, GOOGLE_SERVER_SECRET: SECRET,
  GOOGLE_TOKEN_ENCRYPTION_KEY: KEYB64, GOOGLE_OAUTH_CLIENT_ID: CID, GOOGLE_OAUTH_CLIENT_SECRET: CSEC, GOOGLE_API_MOCK_BASE: MOCK } = process.env;
for (const u of [API, APP]) if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(u ?? '')) { console.error('refusing: loopback only'); process.exit(2); }
if (MOCK || !CSEC?.startsWith('GOCSPX-')) { console.error('refusing: real-Google mode only'); process.exit(2); }

const j = async (res) => { const t = await res.text(); try { return JSON.parse(t); } catch { return {}; } };
const login = await fetch(`${API}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'alice@collab.test', password: PW }) });
const session = await j(login);
assert.ok(session.access_token, `owner session (HTTP ${login.status}, ${session.error_code ?? session.msg ?? '?'}, anon key ${ANON ? 'set' : 'MISSING'}, password ${PW ? 'set' : 'MISSING'})`);
const bearer = { Authorization: `Bearer ${session.access_token}`, apikey: ANON, 'Content-Type': 'application/json' };

const cred = await j(await fetch(`${API}/rest/v1/rpc/google_credentials_get`, { method: 'POST', headers: bearer, body: JSON.stringify({ p_server_secret: SECRET, p_cost: 0 }) }));
const row = Array.isArray(cred) ? cred[0] : cred;
assert.ok(row?.refresh_token_enc, 'owner has a stored (encrypted) refresh token -- connect first');
const m = /^v1\.([0-9a-f]{8})\.([\w-]+)\.([\w-]+)\.([\w-]+)$/.exec(row.refresh_token_enc);
const d = createDecipheriv('aes-256-gcm', Buffer.from(KEYB64.trim(), 'base64'), Buffer.from(m[2], 'base64url'));
d.setAAD(Buffer.from(`clearspace:google:refresh:${row.user_id}`, 'utf8')); d.setAuthTag(Buffer.from(m[4], 'base64url'));
const refresh = Buffer.concat([d.update(Buffer.from(m[3], 'base64url')), d.final()]).toString('utf8');

const grant = async () => {
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh, client_id: CID, client_secret: CSEC }) });
  const b = await j(r);
  return { status: r.status, error: b.error ?? null, gotAccessToken: Boolean(b.access_token) };
};

const before = await grant();
console.log('1. old refresh token BEFORE disconnect  ->', JSON.stringify(before));
assert.equal(before.status, 200, 'the stored refresh token must be live before the test');

const del = await fetch(`${APP}/api/google/connection`, { method: 'DELETE', headers: bearer });
const delBody = await j(del);
console.log('2. DELETE /api/google/connection        ->', del.status, JSON.stringify({ disconnected: delBody.disconnected, revokedAtGoogle: delBody.revokedAtGoogle }));

const after = await grant();
console.log('3. old refresh token AFTER disconnect   ->', JSON.stringify(after));

const stored = await j(await fetch(`${API}/rest/v1/rpc/google_connection_status`, { method: 'POST', headers: bearer, body: '{}' }));
console.log('4. connection row after disconnect      ->', JSON.stringify(Array.isArray(stored) ? stored.length : (stored?.status ?? null)));

const real = after.status === 400 && after.error === 'invalid_grant';
console.log(real ? 'RESULT: REAL REVOCATION AT GOOGLE (old refresh token rejected: invalid_grant)'
                 : 'RESULT: grant NOT revoked at Google (old token still accepted or unexpected answer)');
process.exit(real && delBody.revokedAtGoogle === true ? 0 : 1);
