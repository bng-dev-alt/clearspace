// RUN 03B critical security gate, against REAL Google: the token the browser gets for the Drive Picker must be Drive-only,
// whatever the grant at Google holds (Gmail enabled, or Gmail switched off in ClearSpace only). Asks Google itself
// (tokeninfo) which scopes the token carries and proves it is refused by the Gmail API. Prints scopes and HTTP statuses
// only -- never a token.
//   eval "$(scripts/gmail-stack.sh env)"; COLLAB_PASSWORD=... node supabase/tests/gmail_live_gate.mjs [expect-gmail|expect-no-gmail]
import assert from 'node:assert/strict';

const { E2E_SUPABASE_URL: API, E2E_SUPABASE_ANON_KEY: ANON, E2E_BASE_URL: APP, COLLAB_PASSWORD } = process.env;
const expectServerGmail = process.argv[2] !== 'expect-no-gmail';
const DRIVE_FILE = 'https://www.googleapis.com/auth/drive.file';
const ALLOWED = new Set(['openid', 'email', 'https://www.googleapis.com/auth/userinfo.email', DRIVE_FILE]);

const json = async (r) => { try { return await r.json(); } catch { return null; } };
const login = await fetch(`${API}/auth/v1/token?grant_type=password`, {
  method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'alice@collab.test', password: COLLAB_PASSWORD }),
});
const session = await json(login);
assert.equal(login.status, 200, 'dev identity alice signs in');
const auth = { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' };

const status = await json(await fetch(`${APP}/api/google/connection`, { headers: auth }));
assert.equal(status?.simulated, false, 'the app runs against REAL Google (no mock)');
console.log('ClearSpace services:', JSON.stringify(status?.connection?.services));

const pt = await fetch(`${APP}/api/google/picker-token`, { method: 'POST', headers: auth });
const body = await json(pt);
assert.equal(pt.status, 200, `picker-token minted (got ${pt.status} ${body?.error ?? ''})`);
const token = body.accessToken;

const info = await json(await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(token)}`));
const scopes = String(info?.scope ?? '').split(' ').filter(Boolean).sort();
console.log('Google tokeninfo scopes of the Picker token:', scopes.join(' '), `| expires_in=${info?.expires_in}s`);
assert.ok(scopes.includes(DRIVE_FILE), 'Picker token carries drive.file');
assert.deepEqual(scopes.filter((s) => !ALLOWED.has(s)), [], 'Picker token carries NOTHING beyond identity + drive.file (no Gmail)');

const gmail = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', { headers: { Authorization: `Bearer ${token}` } });
console.log('Gmail API with the Picker token ->', gmail.status);
assert.equal(gmail.status, 403, 'Gmail API refuses the Picker token (insufficient scopes)');
const drive = await fetch('https://www.googleapis.com/drive/v3/files?pageSize=1&fields=files(id)', { headers: { Authorization: `Bearer ${token}` } });
console.log('Drive API with the Picker token ->', drive.status);
assert.equal(drive.status, 200, 'Drive API accepts the Picker token');

// The server-side (stored) path still has Gmail when enabled, and refuses Gmail when it was switched off in ClearSpace.
const s = await fetch(`${APP}/api/gmail/search?kind=thread&text=${encodeURIComponent('ClearSpace test')}`, { headers: auth });
console.log('server-side Gmail search ->', s.status);
assert.equal(s.status, expectServerGmail ? 200 : 409, expectServerGmail ? 'server reads Gmail for its owner' : 'server refuses Gmail once disabled');
console.log(`LIVE GATE PASS (${expectServerGmail ? 'Gmail enabled' : 'Gmail disabled in ClearSpace, grant at Google unchanged'})`);
