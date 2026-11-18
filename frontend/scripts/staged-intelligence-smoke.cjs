// Smoke of the Intelligence screens on a STAGED deployment (or a local server) against the hosted database; disposable accounts, no AI call can succeed (firewall deny).
// Run through scripts/staged-intelligence-smoke.sh (it creates and deletes the accounts and checks that nothing is left).
const { createRequire } = require('module');
const req = createRequire('/Volumes/WORKSPACE/Dev/Apps/ClearSpace/V1-intelligence/frontend/package.json');
const { chromium } = req('playwright-core');
const { BASE, BYPASS, SB, ANON, A, B, PW } = process.env;
const origin = new URL(BASE).origin;
const out = []; let failed = false;
const wait = async (loc) => loc.waitFor({ timeout: 15000 }).then(() => true).catch(() => false);
const ok = (n, c, d = '') => { out.push(`${c ? 'ok  ' : 'FAIL'} - ${n}${d ? ' :: ' + d : ''}`); if (!c) failed = true; };
const api = async (path, { method = 'GET', token, data } = {}) => {
  const r = await fetch(`${SB}${path}`, { method, headers: { apikey: ANON, Authorization: `Bearer ${token ?? ANON}`, 'Content-Type': 'application/json' }, body: data ? JSON.stringify(data) : undefined });
  const t = await r.text(); return { status: r.status, json: t ? JSON.parse(t) : null };
};
const tok = async (email) => (await api('/auth/v1/token?grant_type=password', { method: 'POST', data: { email, password: PW } })).json.access_token;
(async () => {
  const ta = await tok(A), tb = await tok(B);
  const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM_PATH });
  const ctx = await browser.newContext(); const page = await ctx.newPage();
  await page.route((u) => u.origin === origin, (route) => route.continue({ headers: { ...route.request().headers(), 'x-vercel-protection-bypass': BYPASS } }));
  const hosts = new Set(); page.on('request', (r) => { try { hosts.add(new URL(r.url()).hostname); } catch {} });
  const aiReq = []; page.on('request', (r) => { if (r.url().includes('/api/ai/')) aiReq.push(new URL(r.url()).pathname); });
  const aiStatus = []; page.on('response', (r) => { if (r.url().includes('/api/ai/')) aiStatus.push(r.status()); });
  await page.goto(`${BASE}/login`);
  await page.getByPlaceholder('jmeno@firma.cz').fill(A); await page.locator('input[type="password"]').first().fill(PW);
  await page.getByRole('button', { name: 'Přihlásit se' }).click(); await page.waitForURL(/\/$/); ok('login (UI) on staged URL', true);
  let pr; for (let i = 0; i < 10; i++) { pr = await api('/rest/v1/projects?select=id', { token: ta }); if (Array.isArray(pr.json) && pr.json.length) break; await new Promise((r) => setTimeout(r, 1000)); }
  if (!Array.isArray(pr.json) || !pr.json.length) throw new Error('no project for account A: status=' + pr.status + ' body=' + JSON.stringify(pr.json).slice(0, 200) + ' tokenLen=' + (ta ? ta.length : 0));
  const pid = pr.json[0].id;
  await page.goto(`${BASE}/projects/${pid}`); await page.locator('.app-container[data-hydrated="true"]').waitFor(); ok('project/board loads', true);
  await page.getByTestId('view-switch-meetings').click(); await page.waitForURL(new RegExp(`/projects/${pid}/meetings$`));
  ok('Porady page renders (empty state)', await wait(page.getByText('Zatím žádné porady')));
  await page.getByTestId('meeting-new').click(); await page.getByLabel('Název porady').fill('Staged smoke');
  await page.getByLabel('Přepis').fill('Petr Novák: Rozhodli jsme, že release posuneme na pátek.\nHonza: Připravím migraci do 25. listopadu.');
  await page.getByTestId('meeting-create').click(); await page.waitForURL(/\/meetings\/[0-9a-f-]{36}$/);
  const mid = page.url().split('/').pop(); ok('create meeting from pasted text', await wait(page.getByTestId('segment-seg-0')));
  await page.getByTestId('meeting-analyze').click(); await page.getByTestId('meeting-error').waitFor();
  const msg = (await page.getByTestId('meeting-error').textContent()) ?? ''; ok('Analyzovat shows the clear AI-disabled message', msg.includes('AI funkce jsou v této instalaci zatím vypnuté'), msg);
  ok('analysis request answered 403 by the firewall', aiStatus.length > 0 && aiStatus.every((s) => s === 403), `paths=${aiReq.join(',')} statuses=${aiStatus.join(',')}`);
  ok('audio panel is NOT shown (audio disabled)', (await page.getByTestId('audio-panel').count()) === 0);
  aiStatus.length = 0; aiReq.length = 0;
  await page.goto(`${BASE}/projects/${pid}`); await page.locator('.app-container[data-hydrated="true"]').waitFor();
  await page.getByTestId('project-intelligence-btn').click(); await page.getByTestId('project-intelligence-drawer').waitFor();
  await page.getByTestId('pi-tab-brief').click(); ok('project brief panel renders', await wait(page.getByTestId('brief-freshness')));
  await page.getByTestId('brief-generate').click(); await page.getByTestId('brief-error').waitFor();
  const bm = (await page.getByTestId('brief-error').textContent()) ?? ''; ok('brief shows the AI-disabled message', bm.includes('AI funkce jsou v této instalaci zatím vypnuté'), bm);
  ok('brief request answered 403', aiStatus.length > 0 && aiStatus.every((s) => s === 403), `statuses=${aiStatus.join(',')}`);
  ok('browser talked only to the staged origin + the new Supabase project', [...hosts].every((h) => h === new URL(BASE).hostname || h === 'twjlnsxjtuntujarwner.supabase.co' || h.endsWith('vercel.app') === false && h.endsWith('.supabase.co') && h.startsWith('twjlnsxjtuntujarwner')), [...hosts].join(','));
  await browser.close();
  // DB truth + RLS
  ok('no AI run / ledger row was created', (await api('/rest/v1/intelligence_runs?select=id', { token: ta })).json.length === 0 && (await api('/rest/v1/ai_requests?select=id', { token: ta })).json.length === 0);
  ok('owner sees own meeting', (await api(`/rest/v1/meetings?id=eq.${mid}&select=id,status`, { token: ta })).json.length === 1);
  ok('RLS: other user sees no meetings', (await api('/rest/v1/meetings?select=id', { token: tb })).json.length === 0);
  ok('RLS: other user sees no transcripts', (await api('/rest/v1/meeting_transcripts?select=meeting_id', { token: tb })).json.length === 0);
  const ins = await api('/rest/v1/intelligence_items', { method: 'POST', token: ta, data: { meeting_id: mid } });
  ok('authenticated cannot INSERT intelligence_items directly', ins.status >= 400, `status=${ins.status}`);
  const stt = await api('/rest/v1/rpc/stt_reserve', { method: 'POST', token: ta, data: {} });
  ok('authenticated cannot call stt_* RPCs', stt.status >= 400, `status=${stt.status}`);
  const anonM = await api('/rest/v1/meetings?select=id');
  ok('anon reads no meetings', anonM.status === 401 || anonM.status === 403 || (Array.isArray(anonM.json) && anonM.json.length === 0), `status=${anonM.status}`);
  console.log(out.join('\n')); console.log(failed ? 'STAGED INTELLIGENCE SMOKE: FAIL' : 'STAGED INTELLIGENCE SMOKE: PASS'); process.exit(failed ? 1 : 0);
})().catch((e) => { console.log(out.join('\n')); console.log('ERROR', e.message.split('\n')[0]); process.exit(1); });
