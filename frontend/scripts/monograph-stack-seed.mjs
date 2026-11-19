#!/usr/bin/env node
// Seeds a REALISTIC owner state on the throwaway local stack for Monograph screenshots: project + board + members, a Soniox-style audio
// meeting (FAKE Soniox, 2 named speakers, long transcript), a FAKE-Gemini analysis with evidence-backed proposals, one accepted / one rejected /
// one task created with a human-chosen assignee and date, and a Project Intelligence brief. Nothing leaves 127.0.0.1; no paid call, no real key.
// Used by scripts/monograph-stack.sh. Writes the STACK_CTX json that scripts/monograph-shots.mjs (MODE=stack) reads.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { chromium } from 'playwright-core';

const env = (k) => { const v = process.env[k]; if (!v) throw new Error(`missing ${k}`); return v; };
const SB = env('E2E_SUPABASE_URL'), ANON = env('E2E_SUPABASE_ANON_KEY'), SERVICE = env('E2E_SUPABASE_SERVICE_KEY');
const SONIOX = env('E2E_FAKE_SONIOX_URL'), SECRET = env('E2E_STT_SERVER_SECRET'), BASE = env('BASE_URL'), OWNER_ID = env('E2E_OWNER_USER_ID'), OUT = env('STACK_CTX');
const CHROMIUM = process.env.PW_CHROMIUM_PATH;
if (!/^http:\/\/127\.0\.0\.1:/.test(SB)) throw new Error('refusing: not a local stack');
const EMAIL = 'owner-fixed@example.test', PASSWORD = 'Test-Password-123', P = 'mg-p-seed';

const j = async (path, { method = 'GET', token, data, headers } = {}) => {
  const r = await fetch(`${SB}${path}`, { method, headers: { apikey: ANON, Authorization: `Bearer ${token ?? ANON}`, 'Content-Type': 'application/json', ...headers }, body: data === undefined ? undefined : JSON.stringify(data) });
  const t = await r.text(); let json = null; try { json = t ? JSON.parse(t) : null; } catch { json = t; }
  return { status: r.status, json };
};
const admin = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' };
await fetch(`${SB}/auth/v1/admin/users/${OWNER_ID}`, { method: 'DELETE', headers: admin });
const made = await fetch(`${SB}/auth/v1/admin/users`, { method: 'POST', headers: admin, body: JSON.stringify({ id: OWNER_ID, email: EMAIL, password: PASSWORD, email_confirm: true, user_metadata: { display_name: 'Eva Vlčková' } }) });
if (made.status !== 200) throw new Error(`cannot create owner: ${made.status}`);
const tok = (await (await fetch(`${SB}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: EMAIL, password: PASSWORD }) })).json()).access_token;

const must = (r, what) => { if (r.status >= 300) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.json)}`); return r; };
must(await j('/rest/v1/projects', { method: 'POST', token: tok, headers: { Prefer: 'return=minimal' }, data: { id: P, name: 'Plánování Q4' } }), 'project');
must(await j('/rest/v1/projects', { method: 'POST', token: tok, headers: { Prefer: 'return=minimal' }, data: { id: 'mg-p-empty', name: 'Prázdný projekt' } }), 'empty project');
must(await j('/rest/v1/columns', { method: 'POST', token: tok, data: [['c1', 'K řešení'], ['c2', 'V průběhu'], ['c3', 'Revize'], ['c4', 'Hotovo']].map(([k, n], i) => ({ id: `${P}-${k}`, project_id: P, name: n, position: i })) }), 'columns');
must(await j('/rest/v1/cards', { method: 'POST', token: tok, data: [
  { id: `${P}-k0`, column_id: `${P}-c1`, title: 'Úplně jiná karta s poměrně dlouhým názvem, který se musí zalomit na více řádků', priority: 'High' },
  { id: `${P}-k1`, column_id: `${P}-c1`, title: 'Návrh rozpočtu na rok 2027', priority: 'Medium' },
  { id: `${P}-k2`, column_id: `${P}-c2`, title: 'Příprava školicích materiálů', priority: 'Low' },
  { id: `${P}-k3`, column_id: `${P}-c4`, title: 'Audit dodavatelů dokončen', priority: 'Low' },
] }), 'cards');
must(await j('/rest/v1/workspace_members', { method: 'POST', token: tok, headers: { Prefer: 'return=minimal' }, data: [
  { id: 'wm-honza', owner_id: OWNER_ID, full_name: 'Honza Novák', initials: 'HN' },
  { id: 'wm-petr', owner_id: OWNER_ID, full_name: 'Petr Novák', initials: 'PN' },
  { id: 'wm-jana', owner_id: OWNER_ID, full_name: 'Jana Dvořáková', initials: 'JD' },
] }), 'members');
must(await j('/rest/v1/project_members', { method: 'POST', token: tok, headers: { Prefer: 'return=minimal' }, data: ['wm-honza', 'wm-petr', 'wm-jana'].map((m) => ({ project_id: P, member_id: m })) }), 'project members');
must(await j('/rest/v1/server_trust', { method: 'POST', token: SERVICE, headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, data: { purpose: 'stt', secret_sha256: createHash('sha256').update(SECRET).digest('hex') } }), 'server_trust');

const TURNS = [
  { speaker: '1', text: 'Plánovací scénář Q4. Rozhodli jsme, že release posuneme na pátek.' },
  { speaker: '2', text: 'Honza připraví migraci databáze do 25. listopadu, to slibuji.' },
  { speaker: '1', text: 'Nerozhodli jsme se zrušit testovací prostředí, zatím zůstává.' },
  { speaker: '2', text: 'Riziko: dodavatel může zpozdit certifikát.' },
  { speaker: '1', text: 'Kdo zajistí školení týmu? Nevíme zatím.' },
  ...Array.from({ length: 14 }, (_, i) => ({ speaker: String((i % 2) + 1), text: `Doplňující bod ${i + 1}: probíráme závislosti mezi týmy, rozpočet na další čtvrtletí a to, jak se vyhneme zpoždění u externích dodavatelů, kteří nám dodávají klíčové komponenty.` })),
  { speaker: '2', text: 'https://example.test/velmi/dlouhy/odkaz/na/dokumentaci/ktery/nema/zadne/mezery/a/musi/se/zalomit/nebo/orezat/aby/nerozbil/rozlozeni/stranky' },
];
await fetch(`${SONIOX}/__control`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reset: true, mode: 'ok', pollsUntilDone: 1, durationMs: 1_260_000, fetchAudio: true, turns: TURNS }) });

const browser = await chromium.launch({ executablePath: CHROMIUM });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, baseURL: BASE })).newPage();
const MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(125)]);
const item = (t) => page.locator('[data-testid^="item-"][data-kind]', { hasText: t });
await page.goto('/login');
await page.getByPlaceholder('jmeno@firma.cz').fill(EMAIL);
await page.locator('input[type="password"]').first().fill(PASSWORD);
await page.getByRole('button', { name: 'Přihlásit se' }).click();
await page.waitForURL((u) => !u.pathname.startsWith('/login'));
await page.goto(`/projects/${P}/meetings`);
await page.getByTestId('meeting-new').click();
await page.getByTestId('mode-audio').click();
await page.getByLabel('Název porady').fill('Plánovací porada Q4');
await page.getByTestId('audio-file').setInputFiles({ name: 'porada.mp3', mimeType: 'audio/mpeg', buffer: MP3 });
await page.getByTestId('audio-consent').check();
await page.getByTestId('meeting-create').click();
await page.waitForURL(new RegExp(`/projects/${P}/meetings/[0-9a-f-]{36}$`), { timeout: 30000 });
const meetingId = page.url().split('/').pop();
await page.getByTestId('stt-start').click();
for (let i = 0; i < 12; i++) {
  if (await page.getByTestId('stt-state').filter({ hasText: /Přepis hotov/ }).count()) break;
  const b = page.getByTestId('stt-check'); if (await b.count()) await b.click();
  await page.waitForTimeout(700);
}
await page.locator('summary', { hasText: 'Jména mluvčích' }).click();
await page.locator('#sp-S1').fill('Petr Novák');
await page.locator('#sp-S2').fill('Honza Novák');
await page.getByTestId('save-speakers').click();
await page.getByTestId('segment-seg-0-0').waitFor();
await page.getByTestId('meeting-analyze').click();
await page.getByTestId('meeting-notice').filter({ hasText: 'Analýza hotová' }).waitFor({ timeout: 30000 });
await item('Release se posouvá na pátek.').getByTestId('item-accept').click();
await item('Zkontrolovat certifikát.').getByTestId('item-reject').click();
const migr = item('Připravit migraci databáze.');
await migr.getByTestId('item-create').click();
await migr.getByTestId('use-suggested-assignee').click();
await migr.getByTestId('create-due').fill('2026-11-25');
await migr.getByTestId('create-confirm').click();
await migr.getByTestId('applied-info').waitFor();
await page.goto(`/projects/${P}`);
await page.locator('.app-container[data-hydrated="true"]').waitFor();
await page.keyboard.press('Control+i');
await page.getByTestId('project-intelligence-drawer').waitFor();
await page.getByTestId('pi-tab-brief').click();
await page.getByTestId('brief-generate').click();
await page.getByTestId('brief-notice').filter({ hasText: 'Brief byl aktualizován' }).waitFor({ timeout: 30000 });
await browser.close();
fs.writeFileSync(OUT, JSON.stringify({ email: EMAIL, password: PASSWORD, projectId: P, meetingId }));
console.log('seeded: project', P, 'meeting', meetingId);
