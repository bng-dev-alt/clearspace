import { createHash } from 'node:crypto';
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { ensureFixedOwner } from './support/owner';

/**
 * THE WHOLE MEETING-INTELLIGENCE FLOW in the real UI on a throwaway local Supabase stack, with a local FAKE Soniox and a local FAKE
 * Gemini (no keys, no credits, synthetic Czech data):
 *   audio (consent) -> transcript (Soniox, 2 speakers) -> speaker names -> analysis (Gemini-shaped, cites with "Jméno mluvčího: ..." prefixes)
 *   -> evidence-validated proposals (negated decision flagged, wrong-speaker attribution / invented owner / invented quote removed)
 *   -> human review (accept / reject) -> approved task with human-chosen assignee and date (duplicate prevented)
 *   -> Project Intelligence: only the human-approved conclusion is knowledge and brief context; nothing else changed on the board.
 * App must run with STT_ENABLED=1, NEXT_PUBLIC_ENABLE_MEETING_AUDIO=1, fake provider URLs and STT_SERVER_SECRET (see meeting-audio.spec.ts).
 */
const SB = process.env.E2E_SUPABASE_URL;
const ANON = process.env.E2E_SUPABASE_ANON_KEY ?? '';
const SERVICE = process.env.E2E_SUPABASE_SERVICE_KEY ?? '';
const SONIOX = process.env.E2E_FAKE_SONIOX_URL ?? '';
const FAKE = process.env.E2E_FAKE_GEMINI_URL ?? '';
const SERVER_SECRET = process.env.E2E_STT_SERVER_SECRET ?? '';
test.skip(!SB || !SONIOX || !FAKE || SERVER_SECRET.length < 32, 'needs E2E_SUPABASE_URL, E2E_FAKE_SONIOX_URL, E2E_FAKE_GEMINI_URL and E2E_STT_SERVER_SECRET');
test.describe.configure({ mode: 'serial' });

const run = Date.now().toString(36);
const PASSWORD = 'Test-Password-123';
const PROJECT = `fl-p-${run}`;
// Owner-only mode (E2E_OWNER_USER_ID = AI_OWNER_USER_IDS of the app under test): the whole flow runs as THE owner account.
const OWNER_ID = process.env.E2E_OWNER_USER_ID;
const ownerEmail = OWNER_ID ? 'owner-fixed@example.test' : `fl-owner-${run}@example.test`;
const strangerEmail = `fl-stranger-${run}@example.test`;
const MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(125)]);
const TURNS = [
  { speaker: '1', text: 'Plánovací scénář Q4. Rozhodli jsme, že release posuneme na pátek.' },
  { speaker: '2', text: 'Honza připraví migraci databáze do 25. listopadu, to slibuji.' },
  { speaker: '1', text: 'Nerozhodli jsme se zrušit testovací prostředí, zatím zůstává.' },
  { speaker: '2', text: 'Riziko: dodavatel může zpozdit certifikát.' },
  { speaker: '1', text: 'Kdo zajistí školení týmu? Nevíme zatím.' },
];

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
const control = (request: APIRequestContext, data: Record<string, unknown>) => request.post(`${SONIOX}/__control`, { data });
const lastPrompt = async (request: APIRequestContext) => (await request.get(`${FAKE}/__last`).then((r) => r.json())) as { system: string; text: string };
const cardsOf = async (request: APIRequestContext, token: string) => (await rest(request, token, `cards?select=id,title,due_date,archived&column_id=eq.${PROJECT}-c1&order=position`)).json as { id: string; title: string; due_date: string | null; archived: boolean }[];
const item = (page: Page, text: string) => page.locator('[data-testid^="item-"][data-kind]', { hasText: text });
const checkUntil = async (page: Page, state: RegExp) => {
  for (let i = 0; i < 10; i++) {
    if (await page.getByTestId('stt-state').filter({ hasText: state }).count()) return;
    const btn = page.getByTestId('stt-check');
    if (await btn.count()) await btn.click();
    await page.waitForTimeout(700);
  }
  await expect(page.getByTestId('stt-state')).toHaveText(state);
};

let owner: Awaited<ReturnType<typeof signUp>>;
let stranger: Awaited<ReturnType<typeof signUp>>;
let meetingUrl = '';
let meetingId = '';
let boardBefore = '';

test.beforeAll(async ({ request }) => {
  owner = OWNER_ID ? await ensureFixedOwner(request, { sb: SB!, anon: ANON, service: SERVICE, id: OWNER_ID, email: ownerEmail, password: PASSWORD }) : await signUp(request, ownerEmail);
  stranger = await signUp(request, strangerEmail);
  expect((await sb(request, '/rest/v1/projects', { method: 'POST', token: owner.token, headers: { Prefer: 'return=minimal' }, data: { id: PROJECT, name: 'Plánování Q4' } })).status).toBe(201);
  await sb(request, '/rest/v1/columns', { method: 'POST', token: owner.token, data: [{ id: `${PROJECT}-c1`, project_id: PROJECT, name: 'K řešení', position: 0 }] });
  await sb(request, '/rest/v1/cards', { method: 'POST', token: owner.token, data: { id: `${PROJECT}-k0`, column_id: `${PROJECT}-c1`, title: 'Úplně jiná karta' } });
  const wm = await sb(request, '/rest/v1/workspace_members', { method: 'POST', token: owner.token, headers: { Prefer: 'return=minimal' }, data: { id: `wm-honza-${run}`, owner_id: owner.id, full_name: 'Honza Novák', initials: 'HN' } });
  expect(wm.status, JSON.stringify(wm.json)).toBe(201);
  await sb(request, '/rest/v1/project_members', { method: 'POST', token: owner.token, headers: { Prefer: 'return=minimal' }, data: { project_id: PROJECT, member_id: `wm-honza-${run}` } });
  const reg = await sb(request, '/rest/v1/server_trust', { method: 'POST', token: SERVICE, headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, data: { purpose: 'stt', secret_sha256: createHash('sha256').update(SERVER_SECRET).digest('hex') } });
  expect(reg.status, JSON.stringify(reg.json)).toBeLessThan(300);
  await control(request, { reset: true, mode: 'ok', pollsUntilDone: 1, durationMs: 48_000, fetchAudio: true, turns: TURNS });
  boardBefore = JSON.stringify(await cardsOf(request, owner.token));
});

test('1. audio with consent -> Soniox transcript with two speakers (explicit start, one paid job)', async ({ page, request }) => {
  await loginUi(page, ownerEmail);
  await page.goto(`/projects/${PROJECT}/meetings`);
  await page.getByTestId('meeting-new').click();
  await page.getByTestId('mode-audio').click();
  await page.getByLabel('Název porady').fill('Plánovací porada Q4');
  await page.getByTestId('audio-file').setInputFiles({ name: 'porada.mp3', mimeType: 'audio/mpeg', buffer: MP3 });
  await page.getByTestId('audio-consent').check();
  await page.getByTestId('meeting-create').click();
  await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT}/meetings/[0-9a-f-]{36}$`), { timeout: 30_000 });
  meetingUrl = page.url();
  meetingId = meetingUrl.split('/').pop()!;
  await page.getByTestId('stt-start').click();
  await checkUntil(page, /Přepis hotov/);
  await expect(page.locator('[data-testid^="segment-seg-"]')).toHaveCount(TURNS.length);
  await expect(page.getByTestId('machine-transcript-note')).toContainText('Strojový přepis');
  const tr = (await rest(request, owner.token, `meeting_transcripts?meeting_id=eq.${meetingId}&select=source,speakers`)).json;
  expect(tr[0].source).toBe('soniox');
  expect(tr[0].speakers.map((s: { id: string }) => s.id)).toEqual(['S1', 'S2']);
  const stats = await request.get(`${SONIOX}/__stats`).then((r) => r.json());
  expect(stats.jobs).toHaveLength(1); // exactly one paid submission
  expect((await rest(request, owner.token, 'ai_requests?feature=eq.meeting-transcribe&select=status,audio_ms')).json).toEqual([{ status: 'succeeded', audio_ms: 48_000 }]);
});

test('2. a person names the speakers; analysis proposes only evidence-backed items, citing with speaker prefixes', async ({ page, request }) => {
  await loginUi(page, ownerEmail);
  await page.goto(meetingUrl);
  await page.locator('summary', { hasText: 'Jména mluvčích' }).click();
  await page.locator('#sp-S1').fill('Petr Novák');
  await page.locator('#sp-S2').fill('Honza Novák');
  await page.getByTestId('save-speakers').click();
  await expect(page.getByTestId('segment-seg-0-0')).toContainText('Petr Novák:');
  await page.getByTestId('meeting-analyze').click();
  await expect(page.getByTestId('meeting-notice')).toContainText('Analýza hotová', { timeout: 30_000 });
  // the model saw the speaker names (Czech, diacritics) in the transcript it was given
  expect((await lastPrompt(request)).text).toContain('Petr Novák:');

  // CITATIONS WITH SPEAKER PREFIXES ARE FOUND: the stored quote is the literal segment text
  const decision = item(page, 'Release se posouvá na pátek.');
  await expect(decision).toContainText('Citace nalezena');
  await expect(decision.getByTestId('negation-flag')).toHaveCount(0);
  const ev = (await rest(request, owner.token, 'intelligence_items?select=kind,text,support,evidence,review_state&order=ordinal')).json as { kind: string; text: string; support: string; evidence: { quote: string | null; quoteFound: boolean; flag?: string }[]; review_state: string }[];
  const dec = ev.find((i) => i.text === 'Release se posouvá na pátek.')!;
  expect(dec.evidence[0]).toMatchObject({ quote: 'release posuneme na pátek', quoteFound: true }); // prefix removed, literal text kept
  // NEGATED DECISION ("Nerozhodli jsme se zrušit ..."), WRONG-SPEAKER ATTRIBUTION ("Honza Novák: release ..." on Petr's segment), INVENTED ITEM:
  // none of them is stored or shown (rejected by the evidence validator and counted), so no person can approve a reversed or false claim by accident
  for (const gone of ['Testovací prostředí se ruší.', 'Release posouvá Honza.', 'Vymyšlený úkol.']) {
    await expect(page.getByText(gone)).toHaveCount(0);
    expect(ev.find((i) => i.text === gone), gone).toBeUndefined();
  }
  const run1 = (await rest(request, owner.token, `intelligence_runs?select=rejected_count,validator_version&meeting_id=eq.${meetingId}`)).json[0];
  expect(run1.validator_version).toBe('cs-evidence-v2');
  expect(run1.rejected_count).toBeGreaterThanOrEqual(3);
  // INVENTED OWNER: the hallucinated "Karel Dvořák" never reaches the UI
  const cert = item(page, 'Zkontrolovat certifikát.');
  await expect(cert).not.toContainText('Karel');
  // OWNER AND DATE are hints only, never assigned by the AI
  const migr = item(page, 'Připravit migraci databáze.');
  await expect(migr.getByTestId('item-hints')).toContainText('Honza');
  expect(ev.every((i) => i.review_state === 'proposed')).toBe(true);
  expect(ev.filter((i) => i.kind === 'open_question').map((i) => i.review_state)).toEqual(['proposed']); // an open question is a proposal until a person reviews it
  // nothing reached the board by analysing
  expect(JSON.stringify(await cardsOf(request, owner.token))).toBe(boardBefore);
});

test('3. human review: accept the decision, REJECT another, approve the task with a human-chosen assignee and date; a duplicate is refused', async ({ page, request }) => {
  await loginUi(page, ownerEmail);
  await page.goto(meetingUrl);
  await item(page, 'Release se posouvá na pátek.').getByTestId('item-accept').click();
  await expect(item(page, 'Release se posouvá na pátek.')).toHaveAttribute('data-state', 'accepted');
  await item(page, 'Zkontrolovat certifikát.').getByTestId('item-reject').click();
  await expect(item(page, 'Zkontrolovat certifikát.')).toHaveAttribute('data-state', 'rejected');
  expect(JSON.stringify(await cardsOf(request, owner.token))).toBe(boardBefore); // accept/reject change no card

  const migr = item(page, 'Připravit migraci databáze.');
  await migr.getByTestId('item-create').click();
  await expect(migr.getByTestId('create-assignee')).toHaveValue(''); // nothing is pre-selected
  await migr.getByTestId('use-suggested-assignee').click(); // the person accepts the "Honza" suggestion
  await migr.getByTestId('create-due').fill('2026-11-25');
  await migr.getByTestId('create-confirm').click();
  await expect(migr.getByTestId('applied-info')).toContainText('Vytvořena karta');
  const cards = await cardsOf(request, owner.token);
  expect(cards).toHaveLength(2);
  const created = cards.find((c) => c.title.includes('migraci'))!;
  expect(created).toMatchObject({ due_date: '2026-11-25', archived: false });
  expect((await rest(request, owner.token, `card_assignees?select=member_id&card_id=eq.${created.id}`)).json).toEqual([{ member_id: `wm-honza-${run}` }]);

  // a second analysis of an equivalent meeting cannot create the same task twice without an explicit override
  await page.goto(`/projects/${PROJECT}/meetings`);
  await page.getByTestId('meeting-new').click();
  await page.getByLabel('Název porady').fill('Druhá porada');
  await page.getByLabel('Přepis').fill('Petr Novák: Plánovací scénář Q4 dvě.\nHonza Novák: Honza připraví migraci databáze do 25. listopadu, to slibuji.');
  await page.getByTestId('meeting-create').click();
  await page.getByTestId('meeting-analyze').click();
  await expect(page.getByTestId('meeting-notice')).toContainText('Analýza hotová', { timeout: 30_000 });
  const dup = item(page, 'Připravit migraci databáze.');
  await expect(dup.getByTestId('duplicate-warning')).toBeVisible();
  await dup.getByTestId('item-create').click();
  await dup.getByTestId('create-confirm').click();
  await expect(dup.getByTestId('item-error')).toContainText('duplicita');
  expect(await cardsOf(request, owner.token)).toHaveLength(2);
});

test('4. Project Intelligence: only the human-approved conclusion is knowledge and brief context; the rest of the board is untouched', async ({ page, request }) => {
  await loginUi(page, ownerEmail);
  await page.goto(`/projects/${PROJECT}`);
  await expect(page.locator('.app-container')).toHaveAttribute('data-hydrated', 'true');
  await page.keyboard.press('Control+i');
  await expect(page.getByTestId('project-intelligence-drawer')).toBeVisible();
  await page.getByTestId('pi-tab-knowledge').click();
  const knowledge = page.getByTestId('project-knowledge');
  await expect(knowledge).toContainText('Release se posouvá na pátek.');
  await expect(knowledge).not.toContainText('Zkontrolovat certifikát.'); // rejected by the human
  await expect(knowledge).not.toContainText('Kdo zajistí školení týmu?'); // never reviewed
  await expect(page.getByTestId('knowledge-source').first()).toHaveAttribute('href', new RegExp(`/meetings/${meetingId}$`));
  // the brief's CONTEXT carries the approved conclusion and not the rejected one (checked on the exact prompt the model received)
  await page.getByTestId('pi-tab-brief').click();
  await page.getByTestId('brief-generate').click();
  await expect(page.getByTestId('brief-notice')).toContainText('Brief byl aktualizován', { timeout: 30_000 });
  const prompt = (await lastPrompt(request)).text;
  expect(prompt).toContain('Release se posouvá na pátek.');
  expect(prompt).not.toContain('Zkontrolovat certifikát.');
  expect(prompt).not.toContain('Testovací prostředí se ruší.'); // the negated claim never existed in the system
  // only the one approved task was added to the board
  const cards = await cardsOf(request, owner.token);
  expect(cards).toHaveLength(2);
  expect(cards.some((c) => c.title === 'Úplně jiná karta') && cards.some((c) => c.title.includes('migraci'))).toBe(true);
});

test('5. a stranger sees nothing of this meeting, its proposals or its knowledge', async ({ request }) => {
  expect((await rest(request, stranger.token, 'meetings?select=id')).json).toEqual([]);
  expect((await rest(request, stranger.token, 'meeting_transcripts?select=meeting_id')).json).toEqual([]);
  expect((await rest(request, stranger.token, 'intelligence_items?select=id')).json).toEqual([]);
  expect((await rest(request, stranger.token, 'intelligence_runs?select=id')).json).toEqual([]);
});
