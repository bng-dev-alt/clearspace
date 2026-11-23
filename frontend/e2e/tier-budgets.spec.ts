import { createHash } from 'node:crypto';
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { ensureFixedOwner } from './support/owner';

/**
 * Tiered AI/STT budgets against a THROWAWAY local Supabase stack with FAKE Gemini and FAKE Soniox (no keys, no credits).
 * App under test (cs-e2e-app.sh tiers): AI_OWNER_USER_IDS=<owner>, AI_DEMO_USER_IDS=<demo>, AND production-style squeezed shared budgets
 * (AI_DAILY_TOKEN_BUDGET_PER_USER=5000, STT_DAILY_AUDIO_MIN_*=1) that the OWNER must ignore and the DEMO account must not.
 */
const SB = process.env.E2E_SUPABASE_URL;
const ANON = process.env.E2E_SUPABASE_ANON_KEY ?? '';
const SERVICE = process.env.E2E_SUPABASE_SERVICE_KEY ?? '';
const FAKE = process.env.E2E_FAKE_GEMINI_URL ?? '';
const SONIOX = process.env.E2E_FAKE_SONIOX_URL ?? '';
const OWNER_ID = process.env.E2E_OWNER_USER_ID ?? '';
const DEMO_ID = process.env.E2E_DEMO_USER_ID ?? '';
const SECRET = process.env.E2E_STT_SERVER_SECRET ?? '';
test.skip(!SB || !FAKE || !SONIOX || !OWNER_ID || !DEMO_ID || SECRET.length < 32, 'needs the tiers app (cs-e2e-app.sh tiers) and E2E_* ids/secret');
test.describe.configure({ mode: 'serial' });

const run = Date.now().toString(36);
const PASSWORD = 'Test-Password-123';
const PO = `tb-o-${run}`; const PD = `tb-d-${run}`;
const ownerEmail = 'owner-fixed@example.test'; const demoEmail = 'demo-fixed@example.test';
const OWNER_ONLY = 'AI funkce jsou zatím dostupné jen vlastníkovi instalace.';
const BUDGET = 'Byl vyčerpán denní rozpočet AI. Zkuste to prosím zítra.';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any;
async function sb(request: APIRequestContext, path: string, opts: { method?: string; token?: string; key?: string; data?: unknown; headers?: Record<string, string> } = {}) {
  const k = opts.key ?? ANON;
  const res = await request.fetch(`${SB}${path}`, { method: opts.method ?? 'GET', headers: { apikey: k, Authorization: `Bearer ${opts.token ?? k}`, 'Content-Type': 'application/json', ...opts.headers }, data: opts.data === undefined ? undefined : JSON.stringify(opts.data) });
  const text = await res.text(); let json: J = null; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status(), json };
}
const svc = (request: APIRequestContext, path: string, o: { method?: string; data?: unknown; headers?: Record<string, string> } = {}) => sb(request, path, { ...o, key: SERVICE });
async function makeUser(request: APIRequestContext, id: string, email: string) {
  return ensureFixedOwner(request, { sb: SB!, anon: ANON, service: SERVICE, id, email, password: PASSWORD });
}
async function loginUi(page: Page, email: string) {
  await page.goto('/login');
  await page.getByPlaceholder('jmeno@firma.cz').fill(email);
  await page.locator('input[type="password"]').first().fill(PASSWORD);
  await page.getByRole('button', { name: 'Přihlásit se' }).click();
  await expect(page).toHaveURL(/\/$/);
}
const improve = (request: APIRequestContext, token: string | null, projectId: string, extra: { headers?: Record<string, string>; body?: Record<string, unknown> } = {}) =>
  request.post('/api/intelligence/improve', { headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra.headers }, data: { projectId, card: { id: `${projectId}-k`, title: 'Improve me', details: '' }, ...extra.body } });
const ledger = async (request: APIRequestContext, userId: string) => (await svc(request, `/rest/v1/ai_requests?user_id=eq.${userId}&feature=eq.improve&select=id,status,reserved_tokens,created_at&order=created_at`)).json as { id: string; status: string; reserved_tokens: number }[];
const geminiCalls = async (request: APIRequestContext) => ((await request.get(`${FAKE}/__stats`).then((r) => r.json())) as { calls: number }).calls;
const sonioxJobs = async (request: APIRequestContext) => ((await request.get(`${SONIOX}/__stats`).then((r) => r.json())) as { jobs: unknown[] }).jobs.length;
async function seedProject(request: APIRequestContext, token: string, id: string) {
  expect((await sb(request, '/rest/v1/projects', { method: 'POST', token, headers: { Prefer: 'return=minimal' }, data: { id, name: id } })).status).toBe(201);
  await sb(request, '/rest/v1/columns', { method: 'POST', token, data: [{ id: `${id}-c`, project_id: id, name: 'K řešení', position: 0 }] });
  await sb(request, '/rest/v1/cards', { method: 'POST', token, data: { id: `${id}-k`, column_id: `${id}-c`, title: 'Improve me', position: 0 } });
}

let owner: { id: string; token: string }, demo: { id: string; token: string }, other: { id: string; token: string };

test.beforeAll(async ({ request }) => {
  owner = await makeUser(request, OWNER_ID, ownerEmail);
  demo = await makeUser(request, DEMO_ID, demoEmail);
  const c = await svc(request, '/auth/v1/admin/users', { method: 'POST', data: { email: `tb-other-${run}@example.test`, password: PASSWORD, email_confirm: true } });
  const l = await sb(request, '/auth/v1/token?grant_type=password', { method: 'POST', data: { email: `tb-other-${run}@example.test`, password: PASSWORD } });
  other = { id: c.json.id, token: l.json.access_token };
  await seedProject(request, owner.token, PO);
  await seedProject(request, demo.token, PD);
  await seedProject(request, other.token, `tb-x-${run}`);
  expect((await svc(request, '/rest/v1/server_trust', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, data: { purpose: 'stt', secret_sha256: createHash('sha256').update(SECRET).digest('hex') } })).status).toBeLessThan(300);
});

test('the access answer is per tier: owner AI+STT, demo AI only, others nothing', async ({ request }) => {
  const a = (t: string) => request.post('/api/intelligence/access', { headers: { Authorization: `Bearer ${t}` }, data: {} }).then((r) => r.json());
  expect(await a(owner.token)).toEqual({ aiOwner: true, stt: true });
  expect(await a(demo.token)).toEqual({ aiOwner: true, stt: false });
  expect(await a(other.token)).toEqual({ aiOwner: false, stt: false });
});

test('OWNER ignores the exhausted shared budget: 90k tokens already in the ledger, budget env says 5k, the owner still works and is still booked', async ({ request }) => {
  expect((await svc(request, '/rest/v1/ai_requests', { method: 'POST', headers: { Prefer: 'return=minimal' }, data: { user_id: owner.id, feature: 'improve', status: 'succeeded', reserved_tokens: 90_000, total_tokens: 90_000 } })).status).toBe(201);
  const before = (await ledger(request, owner.id)).length;
  const g0 = await geminiCalls(request);
  for (let i = 0; i < 3; i++) {
    const r = await improve(request, owner.token, PO);
    expect(r.status(), await r.text()).toBe(200);
  }
  expect(await geminiCalls(request)).toBe(g0 + 3);
  const rows = await ledger(request, owner.id);
  expect(rows.length).toBe(before + 3); // cost telemetry stays: one row per paid call
  expect(rows.slice(-3).every((x) => x.status === 'succeeded' && x.reserved_tokens > 0)).toBe(true);
});

test('OWNER is still bound by authorization: another project is refused (403 forbidden), nothing is booked or called', async ({ request }) => {
  const g0 = await geminiCalls(request); const n0 = (await ledger(request, owner.id)).length;
  const r = await improve(request, owner.token, `tb-x-${run}`);
  expect(r.status()).toBe(403);
  expect((await r.json()).code).toBe('forbidden');
  expect(await geminiCalls(request)).toBe(g0); expect((await ledger(request, owner.id)).length).toBe(n0);
});

test.setTimeout(150_000);
test('OWNER per-minute rate limit stays on (the app limit is 30/min here): a burst past it is refused with rate_limited, before the provider', async ({ request }) => {
  const burst = await Promise.all(Array.from({ length: 40 }, () => improve(request, owner.token, PO)));
  const codes = burst.map((r) => r.status());
  expect(codes.filter((c) => c === 200).length).toBeLessThanOrEqual(30);
  expect(codes.some((c) => c === 429)).toBe(true);
  const body = await burst[codes.indexOf(429)].json();
  expect(body.code).toBe('rate_limited');
  await new Promise((r) => setTimeout(r, 61_000)); // let the minute window pass for the following tests
});

test('DEMO obeys its own strict budget: concurrent requests book EXACTLY what fits, the rest get budget_exceeded before the provider', async ({ request }) => {
  const first = await improve(request, demo.token, PD); expect(first.status(), await first.text()).toBe(200);
  const r = (await ledger(request, demo.id))[0].reserved_tokens; expect(r).toBeGreaterThan(1000);
  const fits = Math.floor(20_000 / r); // AI_DEMO_DAILY_TOKEN_BUDGET default
  expect(fits).toBeGreaterThanOrEqual(2); expect(fits).toBeLessThan(10);
  const g0 = await geminiCalls(request);
  const burst = await Promise.all(Array.from({ length: 12 }, () => improve(request, demo.token, PD)));
  const ok = burst.filter((x) => x.status() === 200).length;
  const denied = burst.filter((x) => x.status() === 429);
  expect(ok).toBe(fits - 1); // the first call already took one slot: the advisory lock makes the parallel check exact
  expect(denied.length).toBe(12 - ok);
  expect((await denied[0].json()).error).toBe(BUDGET);
  expect(await geminiCalls(request)).toBe(g0 + ok); // refused requests never reach the provider
  expect((await ledger(request, demo.id)).length).toBe(fits);
});

test('demo exhaustion does not block the OWNER (separate user budget and a reserved per-minute slot)', async ({ request }) => {
  const r = await improve(request, owner.token, PO);
  expect(r.status(), await r.text()).toBe(200);
});

test('ROLLOVER: the daily window is the last 24 h. A 23 h old booking still counts, a 25 h old one does not', async ({ request }) => {
  const rows = await ledger(request, demo.id);
  const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
  // everything 23 h old: still exhausted
  for (const x of rows) await svc(request, `/rest/v1/ai_requests?id=eq.${x.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, data: { created_at: hoursAgo(23) } });
  expect((await improve(request, demo.token, PD)).status()).toBe(429);
  // 25 h old: the window moved on, demo can work again (and is again limited by its own budget afterwards)
  for (const x of rows) await svc(request, `/rest/v1/ai_requests?id=eq.${x.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, data: { created_at: hoursAgo(25) } });
  const again = await improve(request, demo.token, PD);
  expect(again.status(), await again.text()).toBe(200);
});

test('UNAUTHORIZED: anonymous 401, an unlisted account 403 owner-only; no provider call, no ledger row', async ({ request }) => {
  const g0 = await geminiCalls(request);
  expect((await improve(request, null, PO)).status()).toBe(401);
  const r = await improve(request, other.token, `tb-x-${run}`);
  expect(r.status()).toBe(403); expect((await r.json()).error).toBe(OWNER_ONLY);
  expect(await geminiCalls(request)).toBe(g0);
  expect((await svc(request, `/rest/v1/ai_requests?user_id=eq.${other.id}&select=id`)).json).toEqual([]);
});

test('NO claim, header, e-mail, metadata or parameter can raise a tier', async ({ request }) => {
  // demo account asks to be the owner in every way a client can
  const spoof = { 'x-ai-tier': 'owner', 'x-clearspace-owner': '1', 'x-owner': 'true' };
  const body = { tier: 'owner', owner: true, unlimited: true, dailyTokenBudget: 99999999, userId: OWNER_ID, is_owner: true };
  await svc(request, `/auth/v1/admin/users/${DEMO_ID}`, { method: 'PUT', data: { user_metadata: { role: 'owner', tier: 'owner', ai_owner: true }, app_metadata: { role: 'owner', tier: 'owner', ai_owner: true } } });
  const relog = await sb(request, '/auth/v1/token?grant_type=password', { method: 'POST', data: { email: demoEmail, password: PASSWORD } });
  const t = relog.json.access_token as string;
  // the demo budget is exhausted by the previous test's run: fill it to be sure, then try to cross it
  let denied = 0;
  for (let i = 0; i < 12; i++) { const r = await improve(request, t, PD, { headers: spoof, body }); if (r.status() === 429) denied++; }
  expect(denied).toBeGreaterThan(0); // still a demo budget, still enforced
  // an unlisted account that claims everything stays out (and its e-mail equals nothing special)
  await svc(request, `/auth/v1/admin/users/${other.id}`, { method: 'PUT', data: { app_metadata: { role: 'owner', tier: 'owner' }, user_metadata: { role: 'owner' } } });
  const o2 = await sb(request, '/auth/v1/token?grant_type=password', { method: 'POST', data: { email: `tb-other-${run}@example.test`, password: PASSWORD } });
  const r = await improve(request, o2.json.access_token, `tb-x-${run}`, { headers: spoof, body });
  expect(r.status()).toBe(403); expect((await r.json()).code).toBe('ai_owner_only');
});

test('STT: the OWNER is not capped (ledger already holds 2 h against a 1 min env cap), the DEMO account cannot transcribe, nothing leaks to Soniox', async ({ page, request }) => {
  const MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(125)]);
  const rows = [owner.id, other.id].map((u) => ({ user_id: u, feature: 'meeting-transcribe', status: 'succeeded', reserved_tokens: 0, provider: 'soniox', audio_ms: 7_200_000, billing_state: 'actual' }));
  expect((await svc(request, '/rest/v1/ai_requests', { method: 'POST', headers: { Prefer: 'return=minimal' }, data: rows })).status).toBe(201);
  const j0 = await sonioxJobs(request);
  await loginUi(page, ownerEmail);
  await page.goto(`/projects/${PO}/meetings`);
  await page.getByTestId('meeting-new').click();
  await page.getByTestId('mode-audio').click();
  await page.getByLabel('Název porady').fill('Zvuk vlastníka');
  await page.getByTestId('audio-file').setInputFiles({ name: 'porada.mp3', mimeType: 'audio/mpeg', buffer: MP3 });
  await page.getByTestId('audio-consent').check();
  await page.getByTestId('meeting-create').click();
  await expect(page).toHaveURL(/\/meetings\/[0-9a-f-]{36}$/);
  const meetingId = page.url().split('/').pop()!;
  await page.getByTestId('stt-start').click();
  await expect(page.getByTestId('stt-state')).toHaveText(/Přepisuji|Odesílám|Přepis hotov/, { timeout: 15_000 });
  expect(await sonioxJobs(request)).toBe(j0 + 1); // exactly one paid job: no cap, no retry
  // demo: refused before anything is read or sent
  const dr = await request.post('/api/intelligence/meetings/transcribe', { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${demo.token}` }, data: { projectId: PD, meetingId } });
  expect(dr.status()).toBe(403);
  expect(await sonioxJobs(request)).toBe(j0 + 1);
});
