#!/usr/bin/env node
// Visual QA for the opt-in Monograph style (real Chromium via playwright-core). Captures every covered screen at 1440 / 768 / 375 px,
// Monograph light + dark (and "existing" for a regression subset), and asserts per case: no page-level horizontal overflow, no page errors.
//   MODE=demo   (default) app started with NEXT_PUBLIC_FORCE_DEMO=1 NEXT_PUBLIC_ENABLE_MONOGRAPH=1 (localStorage mock auth, board seed)
//   MODE=stack  real local Supabase stack + fake providers (owner account, meeting + transcript + analysis): see docs/monograph/MONOGRAPH_INTEGRATION.md
//   BASE_URL=http://127.0.0.1:3421 OUT=../docs/monograph/shots-full node scripts/monograph-shots.mjs [--only=board,login] [--widths=1440,375] [--styles=monograph-light,monograph-dark,existing-light]
// Zero paid calls: nothing here talks to any provider.
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:3421';
const OUT = path.resolve(process.env.OUT || '../docs/monograph/shots-full');
const MODE = process.env.MODE || 'demo';
const CHROMIUM = process.env.PW_CHROMIUM_PATH || `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell`;
const arg = (n, d) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || '').split('=')[1] || d;
const only = arg('only', '').split(',').filter(Boolean);
const WIDTHS = arg('widths', '1440,768,375').split(',').map(Number);
const STYLES = arg('styles', 'monograph-light,monograph-dark,existing-light').split(',');
const HEIGHT = { 1440: 900, 768: 1024, 375: 812 };
const REGRESSION = new Set(['login', 'projects', 'board', 'team']); // "existing" is only captured for these

const SEED_NOW = new Date('2026-07-15T12:00:00');
const MOCK_UID = 'e2e-user';
const seedAuth = (page) => page.addInitScript((uid) => {
  localStorage.setItem('kanban_mock_session', JSON.stringify({ user: { id: uid, email: 'e2e@clearspace.test', user_metadata: { display_name: 'E2E Tester' } }, access_token: 'mock-jwt-token-' + uid }));
  localStorage.setItem('kanban_mock_profiles', JSON.stringify([{ id: uid, email: 'e2e@clearspace.test', display_name: 'E2E Tester', created_at: new Date().toISOString() }]));
}, MOCK_UID);

const BOARD = '/projects/project-default';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const clickIf = async (page, sel) => { const l = page.locator(sel).first(); if (await l.count()) { await l.click(); return true; } return false; };

// Project Intelligence: toolbar button on desktop/tablet, numbered bottom-bar cell on phones (the toolbar button is hidden <= 767px).
async function openIntelligence(p) {
  for (const sel of ['[data-testid="project-intelligence-btn"]', '[data-testid="bottom-intelligence"]', '[data-testid="rail-intelligence"]']) {
    const l = p.locator(sel).first();
    if (await l.isVisible().catch(() => false)) { await l.click(); break; }
  }
  await p.getByTestId('project-intelligence-drawer').waitFor({ timeout: 8000 }).catch(() => {});
  await wait(700);
}

// ---- cases: { name, auth, path, run?(page, ctx) } -------------------------------------------------------------------
const cases = [
  { name: 'login', auth: false, path: '/login' },
  { name: 'register', auth: false, path: '/register' },
  { name: 'projects', path: '/' },
  { name: 'board', path: BOARD, clock: true, run: async (p) => { await p.locator('.app-container').waitFor(); } },
  { name: 'board-card-drawer', path: BOARD, clock: true, run: async (p) => { await p.locator('[data-testid^="card-"]').first().click(); await wait(500); } },
  { name: 'board-new-task', path: BOARD, clock: true, run: async (p) => { await p.getByTestId('new-task-btn').first().click({ force: true }).catch(async () => { await p.locator('[data-testid^="add-card-btn-"]').first().click(); }); await wait(500); } },
  { name: 'calendar', path: BOARD, clock: true, run: async (p) => { await p.getByTestId('view-switch-calendar').click(); await wait(500); } },
  { name: 'dashboard', path: BOARD, clock: true, run: async (p) => { await p.getByTestId('view-switch-dashboard').click(); await wait(800); } },
  { name: 'intelligence', path: BOARD, clock: true, run: openIntelligence },
  { name: 'search', path: BOARD, clock: true, run: async (p) => { await p.keyboard.press('Control+k'); await wait(400); } },
  { name: 'projects-new', path: '/', run: async (p) => { await p.getByTestId('classic-new-project-cta').click(); await wait(500); } },
  { name: 'projects-generate', path: '/', run: async (p) => { await p.getByTestId('ai-generate-project-cta').click(); await wait(600); } },
  { name: 'team', path: '/team' },
  { name: 'team-add-member', path: '/team', run: async (p) => { await p.getByTestId('team-add-member').click(); await wait(500); } },
  { name: 'ai-studio', path: '/ai-control-center' },
  { name: 'ai-history', path: '/ai-history' },
  { name: 'mobile-menu', path: BOARD, clock: true, only: [375], run: async (p) => { await p.getByTestId('navbar-burger').click(); await wait(400); } },
];
if (MODE === 'stack') {
  const ctxFile = process.env.STACK_CTX; // JSON written by the stack seed step: { email, password, projectId, meetingId }
  const ctx = ctxFile ? JSON.parse(fs.readFileSync(ctxFile, 'utf8')) : null;
  if (ctx) {
    const P = `/projects/${ctx.projectId}`;
    cases.length = 0;
    cases.push(
      { name: 'meetings-list', stack: true, path: `${P}/meetings` },
      { name: 'meetings-new-text', stack: true, path: `${P}/meetings`, run: async (p) => { await p.getByTestId('meeting-new').click(); await wait(300); } },
      { name: 'meetings-new-audio', stack: true, path: `${P}/meetings`, run: async (p) => { await p.getByTestId('meeting-new').click(); if (await clickIf(p, '[data-testid="mode-audio"]')) await wait(300); } },
      { name: 'meeting-detail', stack: true, path: `${P}/meetings/${ctx.meetingId}` },
      { name: 'meeting-analysis', stack: true, path: `${P}/meetings/${ctx.meetingId}`, run: async (p) => { const i = p.locator('[data-testid^="item-"][data-kind]').first(); if (await i.count()) await i.scrollIntoViewIfNeeded(); await wait(300); } },
      { name: 'meetings-empty', stack: true, path: '/projects/mg-p-empty/meetings' },
      { name: 'board-stack', stack: true, path: P },
      { name: 'intelligence-stack', stack: true, path: P, run: openIntelligence },
      { name: 'intelligence-brief', stack: true, path: P, run: async (p) => { await openIntelligence(p); await p.getByTestId('pi-tab-brief').click(); await wait(700); } },
      { name: 'intelligence-knowledge', stack: true, path: P, run: async (p) => { await openIntelligence(p); await p.getByTestId('pi-tab-knowledge').click(); await wait(700); } },
    );
    globalThis.__ctx = ctx;
  }
}

async function login(page, ctx) {
  await page.goto(`${BASE}/login`);
  await page.getByPlaceholder('jmeno@firma.cz').fill(ctx.email);
  await page.locator('input[type="password"]').first().fill(ctx.password);
  await page.getByRole('button', { name: 'Přihlásit se' }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 30000 });
}

const browser = await chromium.launch({ executablePath: CHROMIUM });
const results = [];
fs.mkdirSync(OUT, { recursive: true });
for (const styleKey of STYLES) {
  const [style, theme] = styleKey.split('-');
  for (const width of WIDTHS) {
    for (const c of cases) {
      if (only.length && !only.includes(c.name)) continue;
      if (c.only && !c.only.includes(width)) continue;
      if (style === 'existing' && !REGRESSION.has(c.name)) continue;
      const context = await browser.newContext({ viewport: { width, height: HEIGHT[width] || 900 }, reducedMotion: 'reduce' });
      const page = await context.newPage();
      const errors = [];
      let navigating = true; // fetches aborted by our own navigation (login -> goto) log "Failed to fetch"; only that is ignored, and only while navigating
      page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
      page.on('console', (m) => { if (m.type() === 'error' && !(navigating && /Failed to fetch/.test(m.text())) && !/favicon|Failed to load resource|\/realtime\/v1\/websocket/.test(m.text())) errors.push(`console: ${m.text().slice(0, 200)}`); });
      await page.addInitScript(([s, t]) => { localStorage.setItem('clearspace-theme', t); localStorage.setItem('clearspace-style', s === 'monograph' ? 'monograph' : 'existing'); /* explicit choice: no stored value = Monograph by default */ }, [style, theme]);
      if (c.clock) await page.clock.setFixedTime(SEED_NOW);
      await page.addInitScript(() => { const s = document.createElement('style'); s.textContent = 'nextjs-portal,[data-nextjs-toast],[data-next-badge-root]{display:none !important}'; document.addEventListener('DOMContentLoaded', () => document.head.appendChild(s)); });
      let ok = true, note = '';
      try {
        if (c.stack) await login(page, globalThis.__ctx);
        else if (c.auth !== false) await seedAuth(page);
        await page.goto(`${BASE}${c.path}`, { waitUntil: 'domcontentloaded' });
        await page.waitForLoadState('networkidle').catch(() => {});
        await wait(700);
        navigating = false;
        if (c.run) await c.run(page);
        await wait(300);
        const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth, style: document.documentElement.dataset.style || '', theme: document.documentElement.dataset.theme }));
        if (m.sw > m.iw) { ok = false; note += `overflow ${m.sw}>${m.iw}; `; }
        if (style === 'monograph' && m.style !== 'monograph') { ok = false; note += 'data-style missing; '; }
        if (style === 'existing' && m.style) { ok = false; note += 'data-style present; '; }
        const f = `${styleKey}-${c.name}-${width}.png`;
        await page.screenshot({ path: path.join(OUT, f), fullPage: !['search', 'board-card-drawer', 'board-new-task', 'intelligence', 'intelligence-stack', 'intelligence-brief', 'intelligence-knowledge', 'projects-new', 'projects-generate', 'team-add-member', 'mobile-menu'].includes(c.name) });
      } catch (e) { ok = false; note += `exception: ${String(e.message).split('\n')[0]}; `; }
      if (errors.length) { ok = false; note += errors.slice(0, 3).join(' | '); }
      results.push({ style: styleKey, width, name: c.name, ok, note });
      console.log(`${ok ? 'ok  ' : 'FAIL'} ${styleKey} ${width} ${c.name} ${note}`);
      await context.close();
    }
  }
}
await browser.close();
fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 1));
const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length - bad.length}/${results.length} cases clean (no overflow, no page errors)`);
process.exit(bad.length ? 1 : 0);
