import { test, expect, type APIRequestContext, type Page } from '@playwright/test';

/**
 * Meeting Intelligence end to end against a THROWAWAY local Supabase stack (real GoTrue, PostgREST, RLS and the
 * intelligence RPCs) with a LOCAL FAKE Gemini (e2e/support/fake-gemini.mjs, GEMINI_BASE_URL). No real AI call,
 * no credits. Skipped unless E2E_SUPABASE_URL is set. See docs/intelligence/IMPLEMENTATION_REPORT.md for the recipe.
 */
const SB = process.env.E2E_SUPABASE_URL;
const ANON = process.env.E2E_SUPABASE_ANON_KEY ?? '';
const SERVICE = process.env.E2E_SUPABASE_SERVICE_KEY ?? '';
const FAKE = process.env.E2E_FAKE_GEMINI_URL ?? '';
test.skip(!SB || !FAKE, 'needs E2E_SUPABASE_URL and E2E_FAKE_GEMINI_URL (isolated local stack + fake Gemini)');
test.describe.configure({ mode: 'serial' });

const run = Date.now().toString(36);
const PASSWORD = 'Test-Password-123';
const PROJECT = `mi-p-${run}`;
const TRANSCRIPT = [
  'Petr Novák: Dobrý den, začneme releasem. Rozhodli jsme, že release posuneme na pátek.',
  'Honza: Já připraví migraci databáze do 25. listopadu, to slibuji.',
  'Petr Novák: Riziko: dodavatel může zpozdit certifikát.',
].join('\n');

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
  return { id: r.json.user.id as string, token: r.json.access_token as string, email };
}
async function loginUi(page: Page, email: string) {
  await page.goto('/login');
  await page.getByPlaceholder('jmeno@firma.cz').fill(email);
  await page.locator('input[type="password"]').first().fill(PASSWORD);
  await page.getByRole('button', { name: 'Přihlásit se' }).click();
  await expect(page).toHaveURL(/\/$/);
}
const rest = (request: APIRequestContext, token: string, path: string) => sb(request, `/rest/v1/${path}`, { token });
const rpc = (request: APIRequestContext, token: string, fn: string, data: unknown) => sb(request, `/rest/v1/rpc/${fn}`, { method: 'POST', token, data });

const ownerEmail = `mi-owner-${run}@example.test`;
const strangerEmail = `mi-stranger-${run}@example.test`;
let owner: Awaited<ReturnType<typeof signUp>>;
let stranger: Awaited<ReturnType<typeof signUp>>;
let meetingUrl = '';
let meetingId = '';

test.beforeAll(async ({ request }) => {
  owner = await signUp(request, ownerEmail);
  stranger = await signUp(request, strangerEmail);
  // project of the owner with a column, an unrelated card and a team member "Honza Novák"
  expect((await sb(request, '/rest/v1/projects', { method: 'POST', token: owner.token, headers: { Prefer: 'return=minimal' }, data: { id: PROJECT, name: 'Porady E2E' } })).status).toBe(201);
  await sb(request, '/rest/v1/columns', { method: 'POST', token: owner.token, data: [{ id: `${PROJECT}-c1`, project_id: PROJECT, name: 'K řešení', position: 0 }, { id: `${PROJECT}-c2`, project_id: PROJECT, name: 'Hotovo', position: 1 }] });
  await sb(request, '/rest/v1/cards', { method: 'POST', token: owner.token, data: { id: `${PROJECT}-k0`, column_id: `${PROJECT}-c1`, title: 'Úplně jiná karta' } });
  const wm = await sb(request, '/rest/v1/workspace_members', { method: 'POST', token: owner.token, headers: { Prefer: 'return=representation' }, data: { id: `wm-honza-${run}`, owner_id: owner.id, full_name: 'Honza Novák', initials: 'HN' } });
  expect(wm.status, JSON.stringify(wm.json)).toBe(201);
  const ownerWm = await rest(request, owner.token, `workspace_members?profile_id=eq.${owner.id}&select=id`);
  await sb(request, '/rest/v1/project_members', { method: 'POST', token: owner.token, data: [{ project_id: PROJECT, member_id: `wm-honza-${run}` }, { project_id: PROJECT, member_id: ownerWm.json[0].id }] });
});

test('project page links to meetings; empty state; input validation (empty, unsupported, invalid SRT)', async ({ page }) => {
  await loginUi(page, ownerEmail);
  await page.goto(`/projects/${PROJECT}`);
  await page.getByTestId('view-switch-meetings').click();
  await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT}/meetings$`));
  await expect(page.getByText('Zatím žádné porady')).toBeVisible();

  await page.getByTestId('meeting-new').click();
  await page.getByLabel('Název porady').fill('Prázdná');
  await page.getByTestId('meeting-create').click();
  await expect(page.getByTestId('meeting-error')).toContainText('prázdný');

  await page.getByTestId('meeting-file').setInputFiles({ name: 'porada.pdf', mimeType: 'application/pdf', buffer: Buffer.from('x') });
  await expect(page.getByTestId('meeting-error')).toContainText('Nepodporovaný typ souboru');

  await page.getByTestId('meeting-file').setInputFiles({ name: 'zle.srt', mimeType: 'text/plain', buffer: Buffer.from('Tohle není titulkový soubor.') });
  await page.getByTestId('meeting-create').click();
  await expect(page.getByTestId('meeting-error')).toContainText('platný titulek');
  // nothing was stored by any of the failed attempts
  expect((await page.request.fetch(`${SB}/rest/v1/meetings?select=id`, { headers: { apikey: ANON, Authorization: `Bearer ${owner.token}` } }).then((r) => r.json())).length).toBe(0);
});

test('paste a transcript -> meeting detail with transcript, steps and an explicit analyze button (nothing analysed automatically)', async ({ page, request }) => {
  await loginUi(page, ownerEmail);
  await page.goto(`/projects/${PROJECT}/meetings`);
  await page.getByTestId('meeting-new').click();
  await page.getByLabel('Název porady').fill('Týdenní porada');
  await page.getByLabel('Přepis').fill(TRANSCRIPT);
  await page.getByTestId('meeting-create').click();
  await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT}/meetings/[0-9a-f-]{36}$`));
  meetingUrl = page.url();
  meetingId = meetingUrl.split('/').pop()!;
  await expect(page.getByTestId('segment-seg-0')).toContainText('Petr Novák:');
  await expect(page.getByTestId('meeting-steps')).toContainText('Přepis');
  await expect(page.getByTestId('meeting-analyze')).toBeEnabled();
  const m = await rest(request, owner.token, `meetings?id=eq.${meetingId}&select=status,current_revision`);
  expect(m.json[0].status).toBe('transcribed');
  expect(m.json[0].current_revision).toMatch(/^[0-9a-f]{64}$/);
  expect((await rest(request, owner.token, 'intelligence_runs?select=id')).json).toEqual([]); // no AI yet
  expect((await rest(request, owner.token, 'ai_requests?select=id')).json).toEqual([]);
});

test('analysis (fake Gemini): evidence-backed proposals only; hallucinated owner/date and unsupported items are removed; project is untouched', async ({ page, request }) => {
  await loginUi(page, ownerEmail);
  await page.goto(meetingUrl);
  await page.getByTestId('meeting-analyze').click();
  await expect(page.getByTestId('meeting-notice')).toContainText('Analýza hotová: 4 návrhy; 1 položka bez důkazu byla vynechána');
  await expect(page.getByTestId('meeting-summary')).toContainText('release');
  await expect(page.getByRole('heading', { name: 'Rozhodnutí (1)' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Úkoly (2)' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Rizika (1)' })).toBeVisible();
  const honza = page.locator('[data-kind="action_item"]', { hasText: 'Připravit migraci databáze' });
  await expect(honza.getByTestId('item-hints')).toContainText('Honza');
  const karel = page.locator('[data-kind="action_item"]', { hasText: 'Zkontrolovat certifikát' });
  await expect(karel).not.toContainText('Karel'); // hallucinated owner never reaches the UI
  await expect(karel.getByTestId('item-hints')).toHaveCount(0);

  // DB truth: 4 proposed items, none applied, the board is unchanged, usage booked, provenance recorded
  const items = (await rest(request, owner.token, 'intelligence_items?select=kind,review_state,owner_text,due_text,support&order=ordinal')).json;
  expect(items).toHaveLength(4);
  expect(items.every((i: { review_state: string }) => i.review_state === 'proposed')).toBe(true);
  expect(items.find((i: { owner_text: string | null }) => i.owner_text === 'Karel Dvořák')).toBeUndefined();
  expect((await rest(request, owner.token, `cards?select=id&column_id=eq.${PROJECT}-c1`)).json).toHaveLength(1); // still only the original card
  const ledger = (await rest(request, owner.token, 'ai_requests?select=feature,status,total_tokens,model')).json;
  expect(ledger).toEqual([{ feature: 'meeting-analyze', status: 'succeeded', total_tokens: 444, model: 'fake-gemini' }]);
  const run1 = (await rest(request, owner.token, 'intelligence_runs?select=ai_request_id,prompt_version,validator_version,rejected_count')).json[0];
  expect(run1).toMatchObject({ prompt_version: 'meeting-brief-p2', validator_version: 'cs-evidence-v3', rejected_count: 1 });
  expect(run1.ai_request_id).toBeTruthy();
});

test('analysing the same transcript again is refused (idempotency, no second AI call); source navigation highlights the segment', async ({ page, request }) => {
  await loginUi(page, ownerEmail);
  await page.goto(meetingUrl);
  const calls = async () => (await request.get(`${FAKE}/__stats`).then((r) => r.json())).calls as number;
  const before = await calls();
  const r = await request.post('/api/intelligence/meetings/analyze', { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${owner.token}` }, data: { projectId: PROJECT, meetingId } });
  expect(r.status()).toBe(409);
  expect(await calls()).toBe(before); // refused BEFORE the model was called
  expect((await rest(request, owner.token, 'ai_requests?select=id')).json).toHaveLength(1);

  await page.locator('[data-kind="decision"]').getByTestId('evidence-link').click();
  await expect(page.getByTestId('segment-seg-0')).toHaveAttribute('data-highlight', 'true');
});

test('approval: nothing changes until confirmed; create card with a human-chosen assignee and date; reload keeps it; undo archives; second approval is idempotent', async ({ page, request }) => {
  await loginUi(page, ownerEmail);
  await page.goto(meetingUrl);
  const honza = page.locator('[data-kind="action_item"]', { hasText: 'Připravit migraci databáze' });
  await honza.getByTestId('item-create').click();
  // opening the form wrote nothing
  expect((await rest(request, owner.token, `cards?select=id&column_id=eq.${PROJECT}-c1`)).json).toHaveLength(1);
  await expect(honza.getByTestId('create-assignee')).toHaveValue(''); // not pre-selected
  await honza.getByTestId('use-suggested-assignee').click(); // human accepts the Honza suggestion
  await honza.getByTestId('create-title').fill('Migrace databáze');
  await honza.getByTestId('create-due').fill('2026-11-25');
  await honza.getByTestId('create-confirm').click();
  await expect(honza.getByTestId('applied-info')).toContainText('Vytvořena karta: Migrace databáze');

  const cards = (await rest(request, owner.token, `cards?select=id,title,due_date,archived&column_id=eq.${PROJECT}-c1&order=position`)).json;
  expect(cards).toHaveLength(2);
  expect(cards[1]).toMatchObject({ title: 'Migrace databáze', due_date: '2026-11-25', archived: false });
  const assigned = (await rest(request, owner.token, `card_assignees?select=member_id&card_id=eq.${cards[1].id}`)).json;
  expect(assigned).toEqual([{ member_id: `wm-honza-${run}` }]);
  // TD-3 (RUN 11): creating a card WITH an assignee legitimately writes two domain events since RUN 01 (migration 1000):
  // card_created (this approval) + card_assigned (trigger collab_assignee_events, the same event that drives assignment
  // notifications – end to end in notify.spec "assignment: bell in the app AND a Telegram message"). Exactly these two, by type:
  const log = (await rest(request, owner.token, `activity_logs?select=action_type,details,actor_id&card_id=eq.${cards[1].id}&order=created_at`)).json;
  expect(log.map((l: { action_type: string }) => l.action_type).sort()).toEqual(['card_assigned', 'card_created']);
  const byType = Object.fromEntries(log.map((l: { action_type: string }) => [l.action_type, l]));
  expect(byType.card_created).toMatchObject({ actor_id: owner.id });
  expect(byType.card_created.details.source.type).toBe('intelligence_item');
  expect(byType.card_assigned).toMatchObject({ actor_id: owner.id });
  expect(byType.card_assigned.details).toMatchObject({ member_id: `wm-honza-${run}`, name: 'Honza Novák', title: 'Migrace databáze' });
  // Honza has no ClearSpace account (workspace member without a profile), so collab_notify skips the bell notification by design.

  await page.reload();
  await expect(page.locator('[data-kind="action_item"]', { hasText: 'Připravit migraci databáze' }).getByTestId('applied-info')).toContainText('Migrace databáze');

  // second approval of the same item through the API returns the first card and writes nothing
  const itemId = (await rest(request, owner.token, 'intelligence_items?select=id&review_state=eq.applied')).json[0].id;
  const again = await rpc(request, owner.token, 'apply_intelligence_item', { p_item: itemId, p_target: { mode: 'create_card', column_id: `${PROJECT}-c1` } });
  expect(again.json).toMatchObject({ already_applied: true, card_id: cards[1].id });
  expect((await rest(request, owner.token, `cards?select=id&column_id=eq.${PROJECT}-c1`)).json).toHaveLength(2);

  // undo from the UI archives the card (never deletes) and returns the item to "accepted"
  await page.locator('[data-kind="action_item"]', { hasText: 'Připravit migraci databáze' }).getByTestId('item-undo').click();
  await expect(page.locator('[data-kind="action_item"]', { hasText: 'Připravit migraci databáze' })).toHaveAttribute('data-state', 'accepted');
  const afterUndo = (await rest(request, owner.token, `cards?select=archived&id=eq.${cards[1].id}`)).json;
  expect(afterUndo).toEqual([{ archived: true }]);
});

test('duplicate prevention across meetings: the same action cannot be created twice without an explicit override', async ({ page, request }) => {
  await loginUi(page, ownerEmail);
  await page.goto(meetingUrl);
  // re-apply the (undone) item so that an equivalent item exists as APPLIED
  const first = page.locator('[data-kind="action_item"]', { hasText: 'Připravit migraci databáze' });
  await first.getByTestId('item-create').click();
  await first.getByTestId('create-confirm').click();
  await expect(first.getByTestId('applied-info')).toBeVisible();

  // second meeting with the same content
  await page.goto(`/projects/${PROJECT}/meetings`);
  await page.getByTestId('meeting-new').click();
  await page.getByLabel('Název porady').fill('Druhá porada');
  await page.getByLabel('Přepis').fill(TRANSCRIPT);
  await page.getByTestId('meeting-create').click();
  await page.getByTestId('meeting-analyze').click();
  await expect(page.getByTestId('meeting-notice')).toContainText('Analýza hotová');
  const dup = page.locator('[data-kind="action_item"]', { hasText: 'Připravit migraci databáze' });
  await expect(dup.getByTestId('duplicate-warning')).toBeVisible();
  const cardsBefore = (await rest(request, owner.token, `cards?select=id&column_id=eq.${PROJECT}-c1`)).json.length;
  await dup.getByTestId('item-create').click();
  await dup.getByTestId('create-confirm').click();
  await expect(dup.getByTestId('item-error')).toContainText('duplicita');
  expect((await rest(request, owner.token, `cards?select=id&column_id=eq.${PROJECT}-c1`)).json).toHaveLength(cardsBefore);
  await dup.getByTestId('allow-duplicate').check();
  await dup.getByTestId('create-confirm').click();
  await expect(dup.getByTestId('applied-info')).toBeVisible();
  expect((await rest(request, owner.token, `cards?select=id&column_id=eq.${PROJECT}-c1`)).json).toHaveLength(cardsBefore + 1);
});

test('authorization: a stranger sees nothing, cannot analyse, review, apply or delete', async ({ page, request }) => {
  await loginUi(page, strangerEmail);
  await page.goto(meetingUrl);
  await expect(page.getByText('Porada nenalezena')).toBeVisible();
  expect((await rest(request, stranger.token, 'meetings?select=id')).json).toEqual([]);
  expect((await rest(request, stranger.token, 'intelligence_items?select=id')).json).toEqual([]);
  expect((await rest(request, stranger.token, 'meeting_transcripts?select=revision')).json).toEqual([]);

  const analyze = await request.post('/api/intelligence/meetings/analyze', { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${stranger.token}` }, data: { projectId: PROJECT, meetingId } });
  expect(analyze.status()).toBe(403);
  const itemId = (await rest(request, owner.token, 'intelligence_items?select=id&review_state=eq.proposed')).json[0].id;
  expect((await rpc(request, stranger.token, 'review_intelligence_item', { p_item: itemId, p_decision: 'accept' })).status).toBeGreaterThanOrEqual(400);
  expect((await rpc(request, stranger.token, 'apply_intelligence_item', { p_item: itemId, p_target: { mode: 'link_card', card_id: `${PROJECT}-k0` } })).status).toBeGreaterThanOrEqual(400);
  expect((await sb(request, `/rest/v1/meetings?id=eq.${meetingId}`, { method: 'DELETE', token: stranger.token, headers: { Prefer: 'return=representation' } })).json).toEqual([]);
  // no client may write AI output directly
  const forged = await sb(request, '/rest/v1/intelligence_items', { method: 'POST', token: owner.token, data: { project_id: PROJECT, kind: 'risk', text: 'forged', support: 'linked', evidence: [] } });
  expect(forged.status).toBeGreaterThanOrEqual(400);
  // the owner's data is intact
  expect((await rest(request, owner.token, 'meetings?select=id')).json.length).toBe(2);
});

test('deleting a meeting removes its transcript, proposals and ledger link; cards created from it remain', async ({ page, request }) => {
  await loginUi(page, ownerEmail);
  await page.goto(meetingUrl);
  const cardsBefore = (await rest(request, owner.token, `cards?select=id&column_id=eq.${PROJECT}-c1`)).json.length;
  await page.getByTestId('meeting-delete').click();
  await page.getByTestId('meeting-delete-confirm').click();
  await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT}/meetings$`));
  expect((await rest(request, owner.token, `meeting_transcripts?select=revision&meeting_id=eq.${meetingId}`)).json).toEqual([]);
  expect((await rest(request, owner.token, `intelligence_items?select=id&meeting_id=eq.${meetingId}`)).json).toEqual([]);
  expect((await rest(request, owner.token, `cards?select=id&column_id=eq.${PROJECT}-c1`)).json).toHaveLength(cardsBefore);
});

test.afterAll(async ({ request }) => {
  // best-effort cleanup of the throwaway stack (service role only if provided)
  if (!SERVICE) return;
  for (const u of [owner, stranger]) if (u) await request.delete(`${SB}/auth/v1/admin/users/${u.id}`, { headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` } });
});
