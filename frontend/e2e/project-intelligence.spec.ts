import { test, expect, type APIRequestContext, type Page } from '@playwright/test';

/**
 * Project Intelligence 2.0 end to end against a THROWAWAY local Supabase stack with a LOCAL FAKE Gemini
 * (no real AI call, no credits). Skipped unless E2E_SUPABASE_URL and E2E_FAKE_GEMINI_URL are set.
 */
const SB = process.env.E2E_SUPABASE_URL;
const ANON = process.env.E2E_SUPABASE_ANON_KEY ?? '';
const SERVICE = process.env.E2E_SUPABASE_SERVICE_KEY ?? '';
const FAKE = process.env.E2E_FAKE_GEMINI_URL ?? '';
test.skip(!SB || !FAKE, 'needs E2E_SUPABASE_URL and E2E_FAKE_GEMINI_URL (isolated local stack + fake Gemini)');
test.describe.configure({ mode: 'serial' });

const run = Date.now().toString(36);
const PASSWORD = 'Test-Password-123';
const PROJECT = `pi-p-${run}`;
const TRANSCRIPT = 'Petr Novák: Rozhodli jsme, že release posuneme na pátek.\nHonza: Já připraví migraci databáze do 25. listopadu.';

async function sb(request: APIRequestContext, path: string, opts: { method?: string; token?: string; data?: unknown; headers?: Record<string, string> } = {}) {
  const res = await request.fetch(`${SB}${path}`, {
    method: opts.method ?? 'GET',
    headers: { apikey: ANON, Authorization: `Bearer ${opts.token ?? ANON}`, 'Content-Type': 'application/json', ...opts.headers },
    data: opts.data === undefined ? undefined : JSON.stringify(opts.data),
  });
  const text = await res.text();
  return { status: res.status(), json: text ? JSON.parse(text) : null };
}
async function signUp(request: APIRequestContext, email: string) {
  const r = await sb(request, '/auth/v1/signup', { method: 'POST', data: { email, password: PASSWORD } });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return { id: r.json.user.id as string, token: r.json.access_token as string };
}
async function loginUi(page: Page, email: string) {
  await page.goto('/login');
  await page.getByPlaceholder('jmeno@firma.cz').fill(email);
  await page.locator('input[type="password"]').first().fill(PASSWORD);
  await page.getByRole('button', { name: 'Přihlásit se' }).click();
  await expect(page).toHaveURL(/\/$/);
}
const rest = (request: APIRequestContext, token: string, path: string) => sb(request, `/rest/v1/${path}`, { token });
const fakeCalls = async (request: APIRequestContext) => (await request.get(`${FAKE}/__stats`).then((r) => r.json())).calls as number;
async function openDrawer(page: Page) {
  await page.goto(`/projects/${PROJECT}`);
  await expect(page.locator('.app-container')).toHaveAttribute('data-hydrated', 'true');
  await expect(page.getByText('Blokovaná migrace').first()).toBeVisible();
  await page.keyboard.press('Control+i');
  await expect(page.getByTestId('project-intelligence-drawer')).toBeVisible();
}

const ownerEmail = `pi-owner-${run}@example.test`;
const strangerEmail = `pi-stranger-${run}@example.test`;
let owner: Awaited<ReturnType<typeof signUp>>;
let stranger: Awaited<ReturnType<typeof signUp>>;
let meetingId = '';
let cardSnapshot = '';

test.beforeAll(async ({ request }) => {
  owner = await signUp(request, ownerEmail);
  stranger = await signUp(request, strangerEmail);
  expect((await sb(request, '/rest/v1/projects', { method: 'POST', token: owner.token, headers: { Prefer: 'return=minimal' }, data: { id: PROJECT, name: 'Intelligence E2E' } })).status).toBe(201);
  const cols = await sb(request, '/rest/v1/columns', { method: 'POST', token: owner.token, data: [{ id: `${PROJECT}-c1`, project_id: PROJECT, name: 'K řešení', position: 0 }, { id: `${PROJECT}-c2`, project_id: PROJECT, name: 'Hotovo', position: 1 }] });
  expect(cols.status, JSON.stringify(cols.json)).toBe(201);
  const cds = await sb(request, '/rest/v1/cards', { method: 'POST', token: owner.token, data: [
    { id: `${PROJECT}-k1`, column_id: `${PROJECT}-c1`, title: 'Blokovaná migrace', tag: 'Blokováno', due_date: '2020-01-01', position: 0 },
    { id: `${PROJECT}-k2`, column_id: `${PROJECT}-c1`, title: 'Obyčejná karta', tag: null, due_date: '2099-01-01', position: 1 },
    { id: `${PROJECT}-k3`, column_id: `${PROJECT}-c2`, title: 'Hotová karta', tag: null, due_date: null, position: 0 },
  ] });
  expect(cds.status, JSON.stringify(cds.json)).toBe(201);
  // a meeting whose decision a human accepted -> meeting-derived knowledge
  const m = await sb(request, '/rest/v1/meetings', { method: 'POST', token: owner.token, headers: { Prefer: 'return=representation' }, data: { project_id: PROJECT, title: 'Plánovací porada', source_kind: 'text' } });
  meetingId = m.json[0].id;
  const segments = [
    { id: 'seg-0', startMs: null, endMs: null, speakerId: 'S1', text: 'Rozhodli jsme, že release posuneme na pátek.' },
    { id: 'seg-1', startMs: null, endMs: null, speakerId: 'S2', text: 'Já připraví migraci databáze do 25. listopadu.' },
  ];
  const rev = 'e'.repeat(64);
  expect((await sb(request, '/rest/v1/meeting_transcripts', { method: 'POST', token: owner.token, data: { meeting_id: meetingId, project_id: PROJECT, revision: rev, source: 'paste', speakers: [{ id: 'S1', label: 'Petr Novák', displayName: null }, { id: 'S2', label: 'Honza', displayName: null }], segments, char_count: 90 } })).status).toBe(201);
  const analyze = await request.post('/api/ai/meetings/analyze', { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${owner.token}` }, data: { projectId: PROJECT, meetingId } });
  expect(analyze.status(), await analyze.text()).toBe(200);
  const items = (await rest(request, owner.token, 'intelligence_items?select=id,kind,review_state')).json;
  const decision = items.find((i: { kind: string }) => i.kind === 'decision');
  expect((await sb(request, '/rest/v1/rpc/review_intelligence_item', { method: 'POST', token: owner.token, data: { p_item: decision.id, p_decision: 'accept' } })).status).toBe(200);
  void TRANSCRIPT;
});

test('overview shows the DETERMINISTIC health (formula, not AI); no brief yet; opening the drawer calls no AI', async ({ page, request }) => {
  await loginUi(page, ownerEmail);
  const before = await fakeCalls(request);
  await openDrawer(page);
  // 100 - blockers 8 - overdue 6 - unassigned 2 (two open cards without assignee) = 84, "attention" because of the danger signals
  await expect(page.getByTestId('pi-health-score')).toHaveText('84 / 100');
  await expect(page.getByTestId('pi-health')).toContainText('Vyžaduje pozornost');
  await page.getByTestId('pi-tab-brief').click();
  await expect(page.getByTestId('brief-freshness')).toContainText('Zatím nevygenerováno');
  expect(await fakeCalls(request)).toBe(before);
  cardSnapshot = JSON.stringify((await rest(request, owner.token, 'cards?select=id,title,tag,due_date,archived,updated_at&order=id')).json);
});

test('brief generation: evidence-backed interpretation, verified facts separate, hallucinations dropped, nothing in the project changes', async ({ page, request }) => {
  await loginUi(page, ownerEmail);
  await openDrawer(page);
  await page.getByTestId('pi-tab-brief').click();
  await page.getByTestId('brief-generate').click();
  await expect(page.getByTestId('brief-notice')).toContainText('Brief byl aktualizován', { timeout: 30_000 });
  await expect(page.getByTestId('brief-summary')).toContainText('blokovanou migrací');
  await expect(page.getByTestId('brief-freshness')).toContainText('Aktuální');

  const facts = page.getByTestId('brief-facts');
  await expect(facts).toContainText('Ověřená fakta');
  await expect(facts).toContainText('Zdraví 84/100'); // same number as the deterministic overview
  await expect(facts).toContainText('Blokováno: 1');
  await expect(page.getByLabel('Interpretace AI')).toBeVisible();

  // hallucinated risk (unknown refs) dropped; claim with a quote that is not in the source is flagged; fake target card nulled
  await expect(page.getByTestId('project-brief')).not.toContainText('Vymyšlené riziko');
  await expect(page.getByTestId('brief-rejected')).toContainText('1 tvrzení bez ověřitelného zdroje');
  const unverified = page.locator('[data-testid="brief-claim"][data-support="unverified"]');
  await expect(unverified).toContainText('Migrace může ohrozit termín.');
  await expect(unverified).toContainText('Neověřeno');
  await expect(page.getByTestId('brief-actions').getByTestId('brief-open-target')).toHaveCount(1); // only the REAL target card
  await expect(page.getByTestId('project-brief')).toContainText('nic se neprovádí automaticky');

  // stored: provenance, ledger, deterministic facts equal the overview, meeting conclusion cited as a source
  const runs = (await rest(request, owner.token, 'intelligence_runs?select=kind,status,prompt_version,validator_version,ai_request_id,rejected_count,output&kind=eq.project_brief')).json;
  expect(runs).toHaveLength(1);
  expect(runs[0]).toMatchObject({ status: 'succeeded', prompt_version: 'project-brief-p1', validator_version: 'cs-evidence-v2', rejected_count: 1 });
  expect(runs[0].ai_request_id).toBeTruthy();
  expect(runs[0].output.facts.score).toBe(84);
  expect(runs[0].output.sources.some((s: { kind: string; meetingId: string | null }) => s.kind === 'item' && s.meetingId === meetingId)).toBe(true);
  const ledger = (await rest(request, owner.token, 'ai_requests?select=feature,status&feature=eq.project-brief')).json;
  expect(ledger).toEqual([{ feature: 'project-brief', status: 'succeeded' }]);

  // NO silent modification of the project
  expect(JSON.stringify((await rest(request, owner.token, 'cards?select=id,title,tag,due_date,archived,updated_at&order=id')).json)).toBe(cardSnapshot);
});

test('source navigation: a card source opens the card; a meeting conclusion links to the meeting', async ({ page }) => {
  await loginUi(page, ownerEmail);
  await openDrawer(page);
  await page.getByTestId('pi-tab-brief').click();
  const meetingChip = page.getByTestId('source-chip').filter({ hasText: 'porada' }).first();
  await expect(meetingChip).toHaveAttribute('href', new RegExp(`/projects/${PROJECT}/meetings/${meetingId}$`));
  await page.getByTestId('source-chip').filter({ hasText: 'karta: Blokovaná migrace' }).first().click();
  await expect(page.getByTestId('task-detail-drawer')).toBeVisible();
  await expect(page.getByTestId('drawer-title-input')).toHaveValue('Blokovaná migrace');
});

test('persistence + freshness: the brief survives a reload; after a project change it is flagged stale; an unchanged brief is not paid for twice', async ({ page, request }) => {
  await loginUi(page, ownerEmail);
  await openDrawer(page);
  await page.getByTestId('pi-tab-brief').click();
  await expect(page.getByTestId('brief-summary')).toContainText('blokovanou migrací'); // persisted
  await expect(page.getByTestId('brief-freshness')).toContainText('Aktuální');

  // unchanged input: the server refuses a second paid run (409 BEFORE the model), the UI explains and offers an override
  const before = await fakeCalls(request);
  await page.getByTestId('brief-generate').click();
  await expect(page.getByTestId('brief-notice')).toContainText('Brief je aktuální');
  expect(await fakeCalls(request)).toBe(before);

  // a change in the project (new card) -> stale after reload
  await sb(request, '/rest/v1/cards', { method: 'POST', token: owner.token, data: { id: `${PROJECT}-k4`, column_id: `${PROJECT}-c1`, title: 'Nová karta', position: 2 } });
  await openDrawer(page);
  await page.getByTestId('pi-tab-brief').click();
  await expect(page.getByTestId('brief-freshness')).toContainText('Zastaralé');

  // regenerate: previous brief superseded, exactly one current
  await page.getByTestId('brief-generate').click();
  await expect(page.getByTestId('brief-notice')).toContainText('Brief byl aktualizován', { timeout: 30_000 });
  await expect(page.getByTestId('brief-freshness')).toContainText('Aktuální');
  const runs = (await rest(request, owner.token, 'intelligence_runs?select=superseded_at&kind=eq.project_brief&order=created_at')).json;
  expect(runs).toHaveLength(2);
  expect(runs[0].superseded_at).not.toBeNull();
  expect(runs[1].superseded_at).toBeNull();
});

test('project chat cites verified sources: fake refs vanish, a citation opens the card', async ({ page, request }) => {
  await loginUi(page, ownerEmail);
  await openDrawer(page);
  await page.getByTestId('pi-ask-input').fill('Co blokuje projekt?');
  await page.getByTestId('pi-ask-send').click();
  const log = page.getByTestId('pi-chat-log');
  await expect(page.getByTestId('pi-chat-citation')).toHaveCount(1, { timeout: 30_000 });
  await expect(log).not.toContainText('neexistuje');
  await expect(log).not.toContainText('card:');
  await page.getByTestId('pi-chat-citation').click();
  await expect(page.getByTestId('drawer-title-input')).toHaveValue('Blokovaná migrace');
  const ledger = (await rest(request, owner.token, 'ai_requests?select=feature,status&feature=eq.chat')).json;
  expect(ledger).toEqual([{ feature: 'chat', status: 'succeeded' }]);
});

test('knowledge tab shows the human-approved conclusion with a link to its meeting; unapproved AI proposals are not shown', async ({ page }) => {
  await loginUi(page, ownerEmail);
  await openDrawer(page);
  await page.getByTestId('pi-tab-knowledge').click();
  const items = page.getByTestId('knowledge-item');
  await expect(items).toHaveCount(1);
  await expect(items.first()).toContainText('Release se posouvá na pátek.');
  await expect(page.getByTestId('project-knowledge')).not.toContainText('Připravit migraci'); // still only proposed
  await expect(page.getByTestId('knowledge-source')).toHaveAttribute('href', new RegExp(`/meetings/${meetingId}$`));
  await page.getByTestId('knowledge-filter').selectOption('risk');
  await expect(page.getByTestId('knowledge-empty')).toBeVisible();
});

test('authorization: a stranger cannot read briefs/knowledge, generate a brief, or store one', async ({ page, request }) => {
  expect((await rest(request, stranger.token, 'intelligence_runs?select=id')).json).toEqual([]);
  expect((await rest(request, stranger.token, 'intelligence_items?select=id')).json).toEqual([]);
  const gen = await request.post('/api/ai/project-brief', { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${stranger.token}` }, data: { projectId: PROJECT } });
  expect(gen.status()).toBe(403);
  const before = await fakeCalls(request);
  const forged = await sb(request, '/rest/v1/rpc/persist_project_brief', { method: 'POST', token: stranger.token, data: { p_project_id: PROJECT, p_run: { status: 'succeeded', input_fingerprint: 'x', contract_version: 'c', prompt_version: 'p', validator_version: 'v', output: { brief: { summary: 'FORGED' } } } } });
  expect(forged.status).toBeGreaterThanOrEqual(400);
  expect(await fakeCalls(request)).toBe(before);
  // the stranger's own UI shows nothing of this project
  await loginUi(page, strangerEmail);
  await page.goto(`/projects/${PROJECT}`);
  await expect(page.getByText('Blokovaná migrace')).toHaveCount(0);
  const runs = (await rest(request, owner.token, 'intelligence_runs?select=output&kind=eq.project_brief&superseded_at=is.null')).json;
  expect(JSON.stringify(runs)).not.toContain('FORGED');
});

test.afterAll(async ({ request }) => {
  if (!SERVICE) return;
  for (const u of [owner, stranger]) if (u) await request.delete(`${SB}/auth/v1/admin/users/${u.id}`, { headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` } });
});
