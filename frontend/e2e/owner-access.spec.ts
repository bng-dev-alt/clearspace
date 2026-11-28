import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { ensureFixedOwner } from './support/owner';

/**
 * OWNER-ONLY ACTIVATION against a THROWAWAY local Supabase stack with local FAKE Gemini and FAKE Soniox (no keys, no credits).
 * The app under test runs in the production-like mode: AI_OWNER_USER_IDS=<E2E_OWNER_USER_ID>, STT_ENABLED=1, NEXT_PUBLIC_ENABLE_MEETING_AUDIO=1,
 * NO AI_ALLOW_ALL_AUTHENTICATED. Roles: the owner (fixed id), a REAL project member who is not the owner, a stranger, and an anonymous caller.
 * Whatever the denied roles try, no provider is contacted, no quota is reserved and no ledger row appears.
 */
const SB = process.env.E2E_SUPABASE_URL;
const ANON = process.env.E2E_SUPABASE_ANON_KEY ?? '';
const SERVICE = process.env.E2E_SUPABASE_SERVICE_KEY ?? '';
const FAKE = process.env.E2E_FAKE_GEMINI_URL ?? '';
const SONIOX = process.env.E2E_FAKE_SONIOX_URL ?? '';
const OWNER_ID = process.env.E2E_OWNER_USER_ID ?? '';
test.skip(!SB || !FAKE || !SONIOX || !OWNER_ID, 'needs E2E_SUPABASE_URL, E2E_FAKE_GEMINI_URL, E2E_FAKE_SONIOX_URL and E2E_OWNER_USER_ID (the app must run with AI_OWNER_USER_IDS set to it)');
test.describe.configure({ mode: 'serial' });

const run = Date.now().toString(36);
const PASSWORD = 'Test-Password-123';
const PA = `oa-a-${run}`; // project of the owner (the member belongs to it)
const PB = `oa-b-${run}`; // project of somebody else (the owner is NOT a member)
const ownerEmail = 'owner-fixed@example.test';
const memberEmail = `oa-member-${run}@example.test`;
const strangerEmail = `oa-stranger-${run}@example.test`;
const OWNER_ONLY = 'AI funkce jsou zatím dostupné jen vlastníkovi instalace.';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any;
async function sb(request: APIRequestContext, path: string, opts: { method?: string; token?: string; key?: string; data?: unknown; headers?: Record<string, string> } = {}) {
  const k = opts.key ?? ANON;
  const res = await request.fetch(`${SB}${path}`, { method: opts.method ?? 'GET', headers: { apikey: k, Authorization: `Bearer ${opts.token ?? k}`, 'Content-Type': 'application/json', ...opts.headers }, data: opts.data === undefined ? undefined : JSON.stringify(opts.data) });
  const text = await res.text();
  let json: J = null; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status(), json };
}
async function makeUser(request: APIRequestContext, email: string) {
  const c = await sb(request, '/auth/v1/admin/users', { method: 'POST', key: SERVICE, data: { email, password: PASSWORD, email_confirm: true } });
  expect(c.status, JSON.stringify(c.json)).toBe(200);
  const l = await sb(request, '/auth/v1/token?grant_type=password', { method: 'POST', data: { email, password: PASSWORD } });
  return { id: c.json.id as string, token: l.json.access_token as string };
}
async function loginUi(page: Page, email: string) {
  await page.goto('/login');
  await page.getByPlaceholder('jmeno@firma.cz').fill(email);
  await page.locator('input[type="password"]').first().fill(PASSWORD);
  await page.getByRole('button', { name: 'Přihlásit se' }).click();
  await expect(page).toHaveURL(/\/$/);
}
const callApp = (request: APIRequestContext, path: string, token: string | null, data: Record<string, unknown> = {}) =>
  request.post(path, { headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, data });
const geminiCalls = async (request: APIRequestContext) => ((await request.get(`${FAKE}/__stats`).then((r) => r.json())) as { calls: number }).calls;
const sonioxJobs = async (request: APIRequestContext) => ((await request.get(`${SONIOX}/__stats`).then((r) => r.json())) as { jobs: unknown[] }).jobs.length;
async function newTextMeeting(page: Page, projectId: string, title: string) {
  await page.goto(`/projects/${projectId}/meetings`);
  await page.getByTestId('meeting-new').click();
  await page.getByLabel('Název porady').fill(title);
  await page.getByLabel('Přepis').fill('Petr Novák: Rozhodli jsme, že release posuneme na pátek.\nHonza: Připravím migraci do 25. listopadu.');
  await page.getByTestId('meeting-create').click();
  await expect(page).toHaveURL(/\/meetings\/[0-9a-f-]{36}$/);
  return page.url().split('/').pop()!;
}

let owner: { id: string; token: string }, member: { id: string; token: string }, stranger: { id: string; token: string };
let meetingA = '', meetingB = '';
const ROUTES = ['/api/intelligence/meetings/transcribe', '/api/intelligence/meetings/sync', '/api/intelligence/meetings/analyze', '/api/intelligence/meetings/purge', '/api/intelligence/meetings/sweep', '/api/intelligence/project-brief', '/api/intelligence/chat', '/api/ai/chat'];

test.beforeAll(async ({ request }) => {
  owner = await ensureFixedOwner(request, { sb: SB!, anon: ANON, service: SERVICE, id: OWNER_ID, email: ownerEmail, password: PASSWORD });
  member = await makeUser(request, memberEmail);
  stranger = await makeUser(request, strangerEmail);
  // owner's project A (+ column), the member becomes a REAL member of A through the invitation flow
  expect((await sb(request, '/rest/v1/projects', { method: 'POST', token: owner.token, headers: { Prefer: 'return=minimal' }, data: { id: PA, name: 'Projekt vlastníka' } })).status).toBe(201);
  await sb(request, '/rest/v1/columns', { method: 'POST', token: owner.token, data: [{ id: `${PA}-c1`, project_id: PA, name: 'K řešení', position: 0 }] });
  const inv = await sb(request, '/rest/v1/rpc/create_workspace_invitation', { method: 'POST', token: owner.token, data: { p_email: memberEmail } });
  expect(inv.status, JSON.stringify(inv.json)).toBe(200);
  const acc = await sb(request, '/rest/v1/rpc/accept_workspace_invitation', { method: 'POST', token: member.token, data: { p_token: inv.json[0].token, p_display_name: 'Člen' } });
  expect(acc.status, JSON.stringify(acc.json)).toBeLessThan(300);
  const wm = await sb(request, `/rest/v1/workspace_members?select=id&profile_id=eq.${member.id}`, { token: owner.token });
  expect(wm.json.length, JSON.stringify(wm.json)).toBeGreaterThan(0);
  expect((await sb(request, '/rest/v1/project_members', { method: 'POST', token: owner.token, headers: { Prefer: 'return=minimal' }, data: { project_id: PA, member_id: wm.json[0].id } })).status).toBe(201);
  // somebody else's project B (the member's own workspace); the owner is NOT in it
  expect((await sb(request, '/rest/v1/projects', { method: 'POST', token: stranger.token, headers: { Prefer: 'return=minimal' }, data: { id: PB, name: 'Cizí projekt' } })).status).toBe(201);
  await sb(request, '/rest/v1/columns', { method: 'POST', token: stranger.token, data: [{ id: `${PB}-c1`, project_id: PB, name: 'K řešení', position: 0 }] });
});

test('0. setup through the UI: the owner creates meeting A, the stranger creates meeting B (text only, nothing analysed)', async ({ browser }) => {
  const c1 = await browser.newContext(); const p1 = await c1.newPage();
  await loginUi(p1, ownerEmail); meetingA = await newTextMeeting(p1, PA, 'Porada vlastníka'); await c1.close();
  const c2 = await browser.newContext(); const p2 = await c2.newPage();
  await loginUi(p2, strangerEmail); meetingB = await newTextMeeting(p2, PB, 'Cizí porada'); await c2.close();
});

test('1. ANONYMOUS: every AI/STT route answers 401; nothing reaches a provider', async ({ request }) => {
  const g0 = await geminiCalls(request), s0 = await sonioxJobs(request);
  for (const r of ROUTES) expect((await callApp(request, r, null, { projectId: PA, meetingId: meetingA, messages: [{ role: 'user', content: 'x' }] })).status(), r).toBe(401);
  expect((await callApp(request, '/api/intelligence/access', null)).status()).toBe(401);
  expect([await geminiCalls(request), await sonioxJobs(request)]).toEqual([g0, s0]);
});

test('2. A REAL PROJECT MEMBER who is not the owner is refused everywhere with ai_owner_only; no provider, no quota, no ledger row', async ({ request }) => {
  const g0 = await geminiCalls(request), s0 = await sonioxJobs(request);
  for (const r of ROUTES) {
    const res = await callApp(request, r, member.token, { projectId: PA, meetingId: meetingA, messages: [{ role: 'user', content: 'x' }] });
    expect(res.status(), r).toBe(403);
    expect((await res.json()).code, r).toBe('ai_owner_only');
  }
  expect(await (await callApp(request, '/api/intelligence/access', member.token)).json()).toMatchObject({ aiOwner: false, stt: false, ai: { available: false } });
  expect([await geminiCalls(request), await sonioxJobs(request)]).toEqual([g0, s0]);
  expect((await sb(request, '/rest/v1/ai_requests?select=id', { token: member.token })).json).toEqual([]);
  expect((await sb(request, '/rest/v1/intelligence_runs?select=id', { token: member.token })).json).toEqual([]);
});

test('3. the member in the UI: text meetings still work, there is NO audio option, "Analyzovat" explains that it is owner-only and calls no provider', async ({ browser, request }) => {
  const g0 = await geminiCalls(request);
  const ctx = await browser.newContext(); const page = await ctx.newPage();
  await loginUi(page, memberEmail);
  await page.goto(`/projects/${PA}/meetings`);
  await expect(page.getByTestId('meetings-page')).toBeVisible();
  await page.getByTestId('meeting-new').click();
  await expect(page.getByTestId('new-meeting-form')).toBeVisible();
  await page.waitForTimeout(1500); // the access answer has arrived
  await expect(page.getByTestId('mode-audio')).toHaveCount(0);
  await page.goto(`/projects/${PA}/meetings/${meetingA}`);
  await page.getByTestId('meeting-analyze').click();
  await expect(page.getByTestId('meeting-error')).toContainText(OWNER_ONLY);
  await ctx.close();
  expect(await geminiCalls(request)).toBe(g0);
});

test('4. the owner in the UI sees the audio option; the access answer is true/true', async ({ browser, request }) => {
  expect(await (await callApp(request, '/api/intelligence/access', owner.token)).json()).toMatchObject({ aiOwner: true, stt: true, ai: { available: true, tier: 'owner' } });
  const ctx = await browser.newContext(); const page = await ctx.newPage();
  await loginUi(page, ownerEmail);
  await page.goto(`/projects/${PA}/meetings`);
  await page.getByTestId('meeting-new').click();
  await expect(page.getByTestId('mode-audio')).toBeVisible({ timeout: 15_000 });
  await ctx.close();
});

test('5. CROSS-PROJECT ISOLATION: the owner cannot use AI/STT on a project and meeting they are not a member of; nothing is stored or billed', async ({ request }) => {
  const g0 = await geminiCalls(request), s0 = await sonioxJobs(request);
  for (const r of ['/api/intelligence/meetings/analyze', '/api/intelligence/meetings/transcribe', '/api/intelligence/project-brief']) {
    const res = await callApp(request, r, owner.token, { projectId: PB, meetingId: meetingB });
    expect([403, 404], `${r} -> ${res.status()}`).toContain(res.status());
  }
  expect([await geminiCalls(request), await sonioxJobs(request)]).toEqual([g0, s0]);
  expect((await sb(request, '/rest/v1/ai_requests?select=id,project_id', { token: owner.token })).json.filter((r: { project_id: string }) => r.project_id === PB)).toEqual([]);
  expect((await sb(request, '/rest/v1/intelligence_runs?select=id', { token: stranger.token })).json).toEqual([]); // B's owner sees no run either
});

test('6. the OWNER on the OWNER\'S project: analysis works (fake Gemini), one ledger row for the owner, none for the member, usage booked', async ({ request }) => {
  const g0 = await geminiCalls(request);
  const res = await callApp(request, '/api/intelligence/meetings/analyze', owner.token, { projectId: PA, meetingId: meetingA });
  expect(res.status(), await res.text()).toBe(200);
  expect(await geminiCalls(request)).toBe(g0 + 1);
  const led = (await sb(request, '/rest/v1/ai_requests?select=feature,status', { token: owner.token })).json as { feature: string; status: string }[];
  expect(led.filter((r) => r.feature === 'meeting-analyze' && r.status === 'succeeded').length).toBeGreaterThanOrEqual(1);
  expect((await sb(request, '/rest/v1/ai_requests?select=id', { token: member.token })).json).toEqual([]);
  // a second identical analysis is refused without a second provider call (idempotency still holds in owner mode)
  const again = await callApp(request, '/api/intelligence/meetings/analyze', owner.token, { projectId: PA, meetingId: meetingA });
  expect(again.status()).toBe(409);
  expect(await geminiCalls(request)).toBe(g0 + 1);
});

test('7. the legacy /api/ai/* paths are refused for the member and the stranger too (defence in depth behind the firewall)', async ({ request }) => {
  for (const t of [member.token, stranger.token]) {
    const res = await callApp(request, '/api/ai/chat', t, { messages: [{ role: 'user', content: 'x' }] });
    expect(res.status()).toBe(403); expect((await res.json()).code).toBe('ai_owner_only');
  }
});
