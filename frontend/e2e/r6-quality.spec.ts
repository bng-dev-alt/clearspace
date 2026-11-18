import { test, expect, type APIRequestContext, type Page } from '@playwright/test';

/**
 * R6 + R7 end to end on the THROWAWAY local Supabase stack with the LOCAL FAKE Gemini: column roles, comment-sensitive brief
 * freshness, transcript revisions (edit -> new revision -> stale analysis -> re-analysis), meeting quota, ledger-backed AI usage,
 * deterministic PM health score and framed context for the existing AI features. No real AI call.
 * Skipped unless E2E_SUPABASE_URL and E2E_FAKE_GEMINI_URL are set.
 */
const SB = process.env.E2E_SUPABASE_URL;
const ANON = process.env.E2E_SUPABASE_ANON_KEY ?? '';
const FAKE = process.env.E2E_FAKE_GEMINI_URL ?? '';
test.skip(!SB || !FAKE, 'needs E2E_SUPABASE_URL and E2E_FAKE_GEMINI_URL');
test.describe.configure({ mode: 'serial' });

const run = Date.now().toString(36);
const PASSWORD = 'Test-Password-123';
const PROJECT = `r6-p-${run}`;
const email = `r6-owner-${run}@example.test`;

async function sb(request: APIRequestContext, path: string, opts: { method?: string; token?: string; data?: unknown; headers?: Record<string, string> } = {}) {
  const res = await request.fetch(`${SB}${path}`, {
    method: opts.method ?? 'GET',
    headers: { apikey: ANON, Authorization: `Bearer ${opts.token ?? ANON}`, 'Content-Type': 'application/json', ...opts.headers },
    data: opts.data === undefined ? undefined : JSON.stringify(opts.data),
  });
  const text = await res.text();
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status(), json: json as any }; // eslint-disable-line @typescript-eslint/no-explicit-any
}
const rest = (request: APIRequestContext, token: string, path: string) => sb(request, `/rest/v1/${path}`, { token });
async function loginUi(page: Page) {
  await page.goto('/login');
  await page.getByPlaceholder('jmeno@firma.cz').fill(email);
  await page.locator('input[type="password"]').first().fill(PASSWORD);
  await page.getByRole('button', { name: 'Přihlásit se' }).click();
  await expect(page).toHaveURL(/\/$/);
}
const ai = (request: APIRequestContext, route: string, body: Record<string, unknown> = {}) =>
  request.post(`/api/ai/${route}`, { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${owner.token}` }, data: { projectId: PROJECT, ...body } });
const last = async (request: APIRequestContext) => (await request.get(`${FAKE}/__last`).then((r) => r.json())) as { system: string; text: string };
const calls = async (request: APIRequestContext) => (await request.get(`${FAKE}/__stats`).then((r) => r.json())).calls as number;

let owner: { id: string; token: string };
let meetingId = '';
const SEGS = [
  { id: 'seg-0', startMs: null, endMs: null, speakerId: 'S1', text: 'Rozhodli jsme, že release posuneme na pátek.' },
  { id: 'seg-1', startMs: null, endMs: null, speakerId: 'S2', text: 'Honza připraví migraci databáze do 25. listopadu.' },
  { id: 'seg-2', startMs: null, endMs: null, speakerId: 'S1', text: 'Riziko: dodavatel může zpozdit certifikát.' },
];

test.beforeAll(async ({ request }) => {
  const r = await sb(request, '/auth/v1/signup', { method: 'POST', data: { email, password: PASSWORD } });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  owner = { id: r.json.user.id, token: r.json.access_token };
  expect((await sb(request, '/rest/v1/projects', { method: 'POST', token: owner.token, headers: { Prefer: 'return=minimal' }, data: { id: PROJECT, name: 'R6 E2E' } })).status).toBe(201);
  expect((await sb(request, '/rest/v1/columns', { method: 'POST', token: owner.token, data: [{ id: `${PROJECT}-c1`, project_id: PROJECT, name: 'Zákazníci', position: 0 }, { id: `${PROJECT}-c2`, project_id: PROJECT, name: 'Hotovo', position: 1 }] })).status).toBe(201);
  const cards = await sb(request, '/rest/v1/cards', { method: 'POST', token: owner.token, data: [
    { id: `${PROJECT}-k1`, column_id: `${PROJECT}-c1`, title: 'Zpožděná karta', due_date: '2020-01-01', position: 0, details: 'UNIKATNÍ-POPIS-KARTY' },
    { id: `${PROJECT}-k2`, column_id: `${PROJECT}-c1`, title: 'Druhá karta', due_date: '2099-01-01', position: 1, details: '' },
  ] });
  expect(cards.status, JSON.stringify(cards.json)).toBe(201);
});

test('R6 column roles: an unusual column name set to "done" persists, survives reload, and the deterministic health follows it', async ({ page, request }) => {
  await loginUi(page);
  const before = (await ai(request, 'project-manager').then((r) => r.json())).parsed.healthScore as number;
  await page.goto(`/projects/${PROJECT}`);
  await expect(page.locator('.app-container')).toHaveAttribute('data-hydrated', 'true');
  await expect(page.getByText('Zpožděná karta')).toBeVisible();
  await page.getByTestId(`column-menu-btn-${PROJECT}-c1`).click();
  await expect(page.getByTestId(`column-role-${PROJECT}-c1`).locator('option').first()).toContainText('Automaticky (bez role)');
  await page.getByTestId(`column-role-${PROJECT}-c1`).selectOption('done');
  await expect.poll(async () => (await rest(request, owner.token, `columns?id=eq.${PROJECT}-c1&select=role`)).json[0].role).toBe('done');
  await page.reload();
  await expect(page.locator('.app-container')).toHaveAttribute('data-hydrated', 'true');
  await page.getByTestId(`column-menu-btn-${PROJECT}-c1`).click();
  await expect(page.getByTestId(`column-role-${PROJECT}-c1`)).toHaveValue('done');
  // all cards are now in a "done" column: nothing is overdue any more, so the formula score cannot be lower
  const after = (await ai(request, 'project-manager').then((r) => r.json())).parsed.healthScore as number;
  expect(after).toBeGreaterThanOrEqual(before);
  await page.getByTestId(`column-role-${PROJECT}-c1`).selectOption(''); // back to automatic
  await expect.poll(async () => (await rest(request, owner.token, `columns?id=eq.${PROJECT}-c1&select=role`)).json[0].role).toBeNull();
});

test('R7 PM: the model\'s own healthScore (3) is replaced by the formula score; data is one framed block in the user message', async ({ request }) => {
  const r = await ai(request, 'project-manager');
  expect(r.status()).toBe(200);
  const j = await r.json();
  expect(j.parsed.healthScore).not.toBe(3);
  expect(j.parsed.healthScore).toBeGreaterThan(0);
  expect(j.parsed.summary).toBe('PM shrnutí');
  const l = await last(request);
  expect(l.system).toContain('NEVRACEJTE');
  expect(l.system).not.toContain('UNIKATNÍ-POPIS-KARTY');
  expect(l.text).toContain('<<<DATA:PROJECT>>>');
  expect(l.text.split('UNIKATNÍ-POPIS-KARTY').length - 1).toBe(1); // card data appears exactly once (no duplicate context construction)
  expect(l.text).toContain(`column ${PROJECT}-c1`); // column ids for the model's suggestions
});

test('R7 shortcuts: daily brief of an EMPTY project and capacity without members never call the model', async ({ request }) => {
  const empty = `${PROJECT}-empty`;
  expect((await sb(request, '/rest/v1/projects', { method: 'POST', token: owner.token, headers: { Prefer: 'return=minimal' }, data: { id: empty, name: 'Prázdný' } })).status).toBe(201);
  await sb(request, '/rest/v1/columns', { method: 'POST', token: owner.token, data: [{ id: `${empty}-c1`, project_id: empty, name: 'K řešení', position: 0 }] });
  const before = await calls(request);
  const ledgerBefore = (await rest(request, owner.token, 'ai_requests?select=id')).json.length;
  const daily = await request.post('/api/ai/daily-brief', { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${owner.token}` }, data: { projectId: empty, activityLogsText: '' } });
  expect((await daily.json()).deterministic).toBe(true);
  const pm = await request.post('/api/ai/project-manager', { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${owner.token}` }, data: { projectId: empty } });
  expect((await pm.json())).toMatchObject({ deterministic: true, model: 'deterministic' });
  const cap = await ai(request, 'capacity-planning', { members: [] });
  expect((await cap.json()).deterministic).toBe(true);
  expect(await calls(request)).toBe(before); // no model call
  // not free of limits: each precomputed answer takes the per-minute slot and leaves a 0-token, model 'deterministic' ledger row
  const rows = (await rest(request, owner.token, 'ai_requests?select=model,total_tokens,status&order=created_at.desc')).json as { model: string | null; total_tokens: number; status: string }[];
  expect(rows.length).toBe(ledgerBefore + 3);
  expect(rows.slice(0, 3)).toEqual([1, 2, 3].map(() => ({ model: 'deterministic', total_tokens: 0, status: 'succeeded' })));
});

test('R6 brief freshness: a COMMENT-only change makes a brief stale (the database stamp sees it)', async ({ page, request }) => {
  const gen = await ai(request, 'project-brief');
  expect(gen.status(), await gen.text()).toBe(200);
  await loginUi(page);
  const open = async () => {
    await page.goto(`/projects/${PROJECT}`);
    await expect(page.locator('.app-container')).toHaveAttribute('data-hydrated', 'true');
    await page.keyboard.press('Control+i');
    await expect(page.getByTestId('project-intelligence-drawer')).toBeVisible();
    await page.getByTestId('pi-tab-brief').click();
  };
  await open();
  await expect(page.getByTestId('brief-freshness')).toContainText('Aktuální');
  const c = await sb(request, '/rest/v1/task_comments', { method: 'POST', token: owner.token, headers: { Prefer: 'return=minimal' }, data: { id: `cm-${run}`, card_id: `${PROJECT}-k2`, author_name: 'Test', content: 'Nový komentář bez změny karty' } });
  expect(c.status, JSON.stringify(c.json)).toBe(201);
  await open();
  await expect(page.getByTestId('brief-freshness')).toContainText('Zastaralé');
});

test('R6 transcript revisions: edit -> NEW immutable revision (parent kept) -> stale-analysis banner -> re-analysis of the current revision', async ({ page, request }) => {
  const m = await sb(request, '/rest/v1/meetings', { method: 'POST', token: owner.token, headers: { Prefer: 'return=representation' }, data: { project_id: PROJECT, title: 'Revize', source_kind: 'text' } });
  meetingId = m.json[0].id;
  const rev1 = 'a1'.repeat(32);
  expect((await sb(request, '/rest/v1/meeting_transcripts', { method: 'POST', token: owner.token, data: { meeting_id: meetingId, project_id: PROJECT, revision: rev1, source: 'paste', speakers: [{ id: 'S1', label: 'Petr Novák', displayName: null }, { id: 'S2', label: 'Honza', displayName: null }], segments: SEGS, char_count: 120 } })).status).toBe(201);
  const a1 = await ai(request, 'meetings/analyze', { meetingId });
  expect(a1.status(), await a1.text()).toBe(200);

  await loginUi(page);
  await page.goto(`/projects/${PROJECT}/meetings/${meetingId}`);
  await expect(page.getByTestId('stale-analysis')).toHaveCount(0);
  await page.getByTestId('revision-edit').click();
  const ta = page.getByTestId('revision-text');
  await expect(ta).toHaveValue(/Petr Novák: Rozhodli jsme, že release posuneme na pátek\./);
  await ta.fill('Petr Novák: Rozhodli jsme, že release posuneme na pátek.\nHonza: Honza připraví migraci databáze do 26. listopadu.\nPetr Novák: Riziko: dodavatel může zpozdit certifikát.');
  await page.getByTestId('revision-note').fill('oprava data');
  await page.getByTestId('revision-save').click();
  await expect(page.getByTestId('meeting-notice')).toContainText('Vytvořena nová revize');
  await expect(page.getByTestId('stale-analysis')).toBeVisible();

  const revs = (await rest(request, owner.token, `meeting_transcripts?meeting_id=eq.${meetingId}&select=revision,parent_revision,source,edit_note&order=created_at`)).json;
  expect(revs).toHaveLength(2);
  expect(revs[0]).toMatchObject({ revision: rev1, source: 'paste', parent_revision: null }); // the original is untouched
  expect(revs[1]).toMatchObject({ source: 'edit', parent_revision: rev1, edit_note: 'oprava data' });
  // the old analysis is still the active run (nothing was re-analysed automatically)
  expect((await rest(request, owner.token, `intelligence_runs?meeting_id=eq.${meetingId}&superseded_at=is.null&select=transcript_revision`)).json).toEqual([{ transcript_revision: rev1 }]);
  await expect(page.getByTestId('revision-select').locator('option')).toHaveCount(2);

  const gemini = await calls(request);
  await page.getByTestId('analyze-current-revision').click();
  await expect(page.getByTestId('meeting-notice')).toContainText('Analýza hotová', { timeout: 30_000 });
  await expect(page.getByTestId('stale-analysis')).toHaveCount(0);
  expect(await calls(request)).toBe(gemini + 1); // exactly one explicit model call
  const active = (await rest(request, owner.token, `intelligence_runs?meeting_id=eq.${meetingId}&superseded_at=is.null&select=transcript_revision`)).json;
  expect(active).toHaveLength(1);
  expect(active[0].transcript_revision).toBe(revs[1].revision);
});

test('R6 quota: the 41st meeting of a day is refused with a readable message; the database says why', async ({ page, request }) => {
  const rows = Array.from({ length: 40 }, (_, i) => ({ project_id: PROJECT, title: `Hromadná ${i}`, source_kind: 'text' }));
  const have = (await rest(request, owner.token, 'meetings?select=id')).json.length as number;
  const bulk = await sb(request, '/rest/v1/meetings', { method: 'POST', token: owner.token, headers: { Prefer: 'return=minimal' }, data: rows.slice(0, 40 - have) });
  expect(bulk.status, JSON.stringify(bulk.json)).toBe(201);
  const over = await sb(request, '/rest/v1/meetings', { method: 'POST', token: owner.token, headers: { Prefer: 'return=minimal' }, data: { project_id: PROJECT, title: 'Navíc', source_kind: 'text' } });
  expect(over.status).toBeGreaterThanOrEqual(400);
  expect(JSON.stringify(over.json)).toContain('denního limitu');
  await loginUi(page);
  await page.goto(`/projects/${PROJECT}/meetings`);
  await page.getByTestId('meeting-new').click();
  await page.getByLabel('Název porady').fill('Přes limit');
  await page.getByLabel('Přepis').fill('Petr: Ahoj světe, tohle je test.');
  await page.getByTestId('meeting-create').click();
  await expect(page.getByTestId('meeting-error')).toContainText('denního limitu');
});

test('R6 observability: AI Studio reads the server ledger (own rows only), says so, and cannot be wiped from the browser', async ({ page }) => {
  await loginUi(page);
  await page.goto('/ai-control-center');
  await expect(page.getByTestId('ledger-note')).toContainText('serverového záznamu', { timeout: 20_000 });
  await expect(page.locator('.ai-cc-clear-logs')).toBeDisabled();
  // the browser keeps no prompt content: nothing resembling a stored payload in localStorage
  const stored = await page.evaluate(() => Object.keys(localStorage).filter((k) => /ai_control_center_logs/.test(k)).map((k) => localStorage.getItem(k) ?? ''));
  expect(stored.join('')).not.toContain('UNIKATNÍ-POPIS-KARTY');
});
