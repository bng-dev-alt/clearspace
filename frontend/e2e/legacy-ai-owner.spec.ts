import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { ensureFixedOwner } from './support/owner';

/**
 * Existing AI features (Improve, Daily Brief, Project Manager, Generate Project/Backlog/Sprint, Risk, Capacity, Resource AI, Voice, Chat)
 * run through the owner-gated /api/intelligence/* routes, because the production firewall keeps /api/ai/* closed.
 * Throwaway local Supabase + FAKE Gemini. App in production-like mode: AI_OWNER_USER_IDS=<E2E_OWNER_USER_ID>, no AI_ALLOW_ALL_AUTHENTICATED.
 */
const SB = process.env.E2E_SUPABASE_URL;
const ANON = process.env.E2E_SUPABASE_ANON_KEY ?? '';
const SERVICE = process.env.E2E_SUPABASE_SERVICE_KEY ?? '';
const FAKE = process.env.E2E_FAKE_GEMINI_URL ?? '';
const OWNER_ID = process.env.E2E_OWNER_USER_ID ?? '';
test.skip(!SB || !FAKE || !OWNER_ID, 'needs E2E_SUPABASE_URL, E2E_FAKE_GEMINI_URL and E2E_OWNER_USER_ID');
test.describe.configure({ mode: 'serial' });

const run = Date.now().toString(36);
const PASSWORD = 'Test-Password-123';
const PA = `la-a-${run}`;
const ownerEmail = 'owner-fixed@example.test';
const memberEmail = `la-member-${run}@example.test`;
const OWNER_ONLY = 'AI funkce jsou zatím dostupné jen vlastníkovi instalace.';
const FEATURES = ['improve', 'daily-brief', 'project-manager', 'generate-project', 'generate-backlog', 'generate-sprint', 'risk-analysis', 'capacity-planning', 'analyze-resource', 'voice-action', 'chat'];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any;
async function sb(request: APIRequestContext, path: string, opts: { method?: string; token?: string; key?: string; data?: unknown; headers?: Record<string, string> } = {}) {
  const k = opts.key ?? ANON;
  const res = await request.fetch(`${SB}${path}`, { method: opts.method ?? 'GET', headers: { apikey: k, Authorization: `Bearer ${opts.token ?? k}`, 'Content-Type': 'application/json', ...opts.headers }, data: opts.data === undefined ? undefined : JSON.stringify(opts.data) });
  const text = await res.text();
  let json: J = null; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status(), json };
}
async function loginUi(page: Page, email: string) {
  await page.goto('/login');
  await page.getByPlaceholder('jmeno@firma.cz').fill(email);
  await page.locator('input[type="password"]').first().fill(PASSWORD);
  await page.getByRole('button', { name: 'Přihlásit se' }).click();
  await expect(page).toHaveURL(/\/$/);
}
const callApp = (request: APIRequestContext, path: string, token: string | null, data: Record<string, unknown>) =>
  request.post(path, { headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, data });
const geminiCalls = async (request: APIRequestContext) => ((await request.get(`${FAKE}/__stats`).then((r) => r.json())) as { calls: number }).calls;

let owner: { id: string; token: string }, member: { id: string; token: string };
const body = (): Record<string, unknown> => ({ projectId: PA, card: { id: `${PA}-k`, title: 'Improve me', details: '' }, messages: [{ role: 'user', content: 'Co je nové?' }] });

test.beforeAll(async ({ request }) => {
  owner = await ensureFixedOwner(request, { sb: SB!, anon: ANON, service: SERVICE, id: OWNER_ID, email: ownerEmail, password: PASSWORD });
  const c = await sb(request, '/auth/v1/admin/users', { method: 'POST', key: SERVICE, data: { email: memberEmail, password: PASSWORD, email_confirm: true } });
  const l = await sb(request, '/auth/v1/token?grant_type=password', { method: 'POST', data: { email: memberEmail, password: PASSWORD } });
  member = { id: c.json.id, token: l.json.access_token };
  expect((await sb(request, '/rest/v1/projects', { method: 'POST', token: owner.token, headers: { Prefer: 'return=minimal' }, data: { id: PA, name: 'Projekt vlastníka' } })).status).toBe(201);
  await sb(request, '/rest/v1/columns', { method: 'POST', token: owner.token, data: [{ id: `${PA}-c`, project_id: PA, name: 'K řešení', position: 0 }] });
  await sb(request, '/rest/v1/cards', { method: 'POST', token: owner.token, data: { id: `${PA}-k`, column_id: `${PA}-c`, title: 'Improve me', position: 0 } });
});

test('anonymous and non-owner are refused on every existing AI feature, no provider is contacted', async ({ request }) => {
  const g0 = await geminiCalls(request);
  for (const f of FEATURES) {
    expect((await callApp(request, `/api/intelligence/${f}`, null, body())).status(), `${f} anonymous`).toBe(401);
    const r = await callApp(request, `/api/intelligence/${f}`, member.token, body());
    expect(r.status(), `${f} non-owner`).toBe(403);
    expect((await r.json()).error, f).toBe(OWNER_ONLY);
  }
  expect(await geminiCalls(request)).toBe(g0);
});

test('the owner passes the gate on every existing AI feature (a mock provider answers; not 401/403)', async ({ request }) => {
  const g0 = await geminiCalls(request);
  const imp = await callApp(request, '/api/intelligence/improve', owner.token, body());
  expect(imp.status(), await imp.text()).toBe(200);
  expect(await geminiCalls(request)).toBeGreaterThan(g0);
  for (const f of FEATURES) {
    const r = await callApp(request, `/api/intelligence/${f}`, owner.token, body());
    expect([401, 403], `${f} -> ${r.status()} ${await r.text()}`).not.toContain(r.status());
  }
});

test('UI: the owner uses AI Improve on a card; the client calls /api/intelligence/improve and shows no "vypnuté"', async ({ page }) => {
  const urls: string[] = [];
  page.on('request', (rq) => { if (rq.url().includes('/api/ai/') || rq.url().includes('/api/intelligence/improve')) urls.push(new URL(rq.url()).pathname); });
  await loginUi(page, ownerEmail);
  await page.goto(`/projects/${PA}`);
  await page.getByText('Improve me').first().click();
  await page.getByTestId('ai-improve-btn').first().click();
  await expect.poll(() => urls.length).toBeGreaterThan(0);
  expect(urls).toEqual(['/api/intelligence/improve']);
  await expect(page.getByText('zatím vypnuté')).toHaveCount(0);
});

test('UI: a non-owner member sees the owner-only message, not "vypnuté", and no /api/ai call is made', async ({ page, request }) => {
  void request;
  const urls: string[] = [];
  page.on('request', (rq) => { if (rq.url().includes('/api/ai/') || rq.url().includes('/api/intelligence/improve')) urls.push(new URL(rq.url()).pathname); });
  // the member needs a project of their own to open
  const MP = `la-m-${run}`;
  await loginUi(page, memberEmail);
  await sb(page.request, '/rest/v1/projects', { method: 'POST', token: member.token, headers: { Prefer: 'return=minimal' }, data: { id: MP, name: 'Projekt člena' } });
  await sb(page.request, '/rest/v1/columns', { method: 'POST', token: member.token, data: [{ id: `${MP}-c`, project_id: MP, name: 'K řešení', position: 0 }] });
  await sb(page.request, '/rest/v1/cards', { method: 'POST', token: member.token, data: { id: `${MP}-k`, column_id: `${MP}-c`, title: 'Improve me', position: 0 } });
  await page.goto(`/projects/${MP}`);
  await page.getByText('Improve me').first().click();
  await page.getByTestId('ai-improve-btn').first().click();
  await expect(page.getByText(OWNER_ONLY).first()).toBeVisible();
  expect(urls).toEqual(['/api/intelligence/improve']);
  await expect(page.getByText('zatím vypnuté')).toHaveCount(0);
});
