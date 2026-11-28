#!/usr/bin/env node
// RUN 11 UX audit capture (before/after) against a LOCAL stack app with the DEV login (?login=auto). Zero paid calls.
// Per case: full-page screenshot, page-level horizontal overflow, console/page errors, axe-core WCAG 2 A/AA violations (counts + ids).
//   BASE_URL=http://127.0.0.1:3481 OUT=../docs/run11/screens/before PROJECT=project-collab-demo node scripts/run11-shots.mjs \
//     [--only=board,settings] [--widths=1440,1024,768,375] [--styles=existing-light,existing-dark,monograph-light,monograph-dark] [--set=core|hub]
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:3481';
const OUT = path.resolve(process.env.OUT || '../docs/run11/screens/before');
const P = `/projects/${process.env.PROJECT || 'project-collab-demo'}`;
const CHROMIUM = process.env.PW_CHROMIUM_PATH || `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell`;
const AXE = fs.readFileSync(new URL('../node_modules/axe-core/axe.min.js', import.meta.url), 'utf8');
const arg = (n, d) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || '').split('=')[1] || d;
const only = arg('only', '').split(',').filter(Boolean);
const WIDTHS = arg('widths', '1440,1024,768,375').split(',').map(Number);
const STYLES = arg('styles', 'existing-light,existing-dark,monograph-light,monograph-dark').split(',');
const SET = arg('set', 'core');
const HEIGHT = { 1440: 900, 1280: 800, 1024: 768, 768: 1024, 375: 812 };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const click = async (p, sel) => { const l = p.locator(sel).first(); if (await l.isVisible().catch(() => false)) { await l.click(); await wait(500); return true; } return false; };
const firstVisible = async (p, sels) => { for (const s of sels) if (await click(p, s)) return true; return false; };

const core = [
  { name: 'login', auth: false, path: '/login' },
  { name: 'register', auth: false, path: '/register' },
  { name: 'projects', path: '/' },
  { name: 'board', path: P },
  { name: 'card-drawer', path: P, overlay: true, run: (p) => click(p, '[data-testid^="card-"]') },
  { name: 'new-task', path: P, overlay: true, run: (p) => firstVisible(p, ['[data-testid="new-task-btn"]', '[data-testid^="add-card-btn-"]']) },
  { name: 'calendar', path: P, run: (p) => click(p, '[data-testid="view-switch-calendar"]') },
  { name: 'dashboard', path: P, run: (p) => click(p, '[data-testid="view-switch-dashboard"]') },
  { name: 'intelligence', path: P, overlay: true, run: (p) => firstVisible(p, ['[data-testid="project-intelligence-btn"]', '[data-testid="bottom-intelligence"]', '[data-testid="rail-intelligence"]']) },
  { name: 'project-team', path: P, overlay: true, run: (p) => click(p, '[data-testid="toolbar-manage-team-btn"]') },
  { name: 'notifications', path: P, overlay: true, run: (p) => click(p, '[data-testid="notifications-bell"]') },
  { name: 'user-menu', path: P, overlay: true, run: (p) => firstVisible(p, ['[data-testid="navbar-avatar-btn"]', '[data-testid="navbar-burger"]']) },
  { name: 'search', path: P, overlay: true, run: async (p) => { await p.keyboard.press('Control+k'); await wait(400); return true; } },
  { name: 'meetings', path: `${P}/meetings` },
  { name: 'meeting-new', path: `${P}/meetings`, run: (p) => click(p, '[data-testid="meeting-new"]') },
  { name: 'team', path: '/team' },
  { name: 'settings', path: '/settings' },
  { name: 'ai-studio', path: '/ai-control-center' },
  { name: 'ai-history', path: '/ai-history' },
  { name: 'about', path: '/about' },
];
const hub = [
  { name: 'hub-settings', path: '/settings' },
  { name: 'hub-integrations', path: P, overlay: true, run: (p) => firstVisible(p, ['button:has-text("Komunikace")', '[aria-label*="Slack"]', 'button:has-text("Integrace")']) },
  { name: 'hub-communication', path: P, run: (p) => click(p, '[data-testid="activity-tab-communication"]') },
];
const cases = SET === 'hub' ? hub : core;
if (process.env.MEETING_ID) cases.push({ name: 'meeting-detail', path: `${P}/meetings/${process.env.MEETING_ID}` });

const browser = await chromium.launch({ executablePath: CHROMIUM });
const results = [];
fs.mkdirSync(OUT, { recursive: true });
// one signed-in storage state (DEV login sets a real Supabase session in localStorage/cookies)
const authCtx = await browser.newContext();
const ap = await authCtx.newPage();
await ap.goto(`${BASE}/?login=auto`);
await ap.waitForFunction(() => !location.search.includes('login=auto') && !location.pathname.startsWith('/login'), null, { timeout: 60000 }).catch(() => {});
await ap.waitForLoadState('networkidle').catch(() => {});
await wait(1500);
const state = await authCtx.storageState();
await authCtx.close();

for (const styleKey of STYLES) {
  const [style, theme] = styleKey.split('-');
  for (const width of WIDTHS) {
    for (const c of cases) {
      if (only.length && !only.includes(c.name)) continue;
      const context = await browser.newContext({ viewport: { width, height: HEIGHT[width] || 900 }, storageState: c.auth === false ? undefined : state });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(`pageerror: ${e.message.slice(0, 160)}`));
      page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource|realtime\/v1\/websocket|Failed to fetch/.test(m.text())) errors.push(`console: ${m.text().slice(0, 160)}`); });
      await page.addInitScript(([s, t]) => { localStorage.setItem('clearspace-theme', t); localStorage.setItem('clearspace-style', s); }, [style, theme]);
      await page.addInitScript(() => { const s = document.createElement('style'); s.textContent = 'nextjs-portal,[data-nextjs-toast],[data-next-badge-root]{display:none !important}'; document.addEventListener('DOMContentLoaded', () => document.head.appendChild(s)); });
      let ok = true, note = '', axe = null, overflow = null;
      try {
        await page.goto(`${BASE}${c.path}`, { waitUntil: 'domcontentloaded' });
        await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {});
        await wait(600);
        if (c.run && !(await c.run(page))) note += 'entry-point not found; ';
        await wait(400);
        const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth, style: document.documentElement.dataset.style || 'existing' }));
        if (m.sw > m.iw) { ok = false; overflow = m.sw; note += `overflow ${m.sw}>${m.iw}; `; }
        if (m.style !== style) note += `style=${m.style}; `;
        await page.addScriptTag({ content: AXE });
        axe = await page.evaluate(async () => {
          const r = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] }, resultTypes: ['violations'] });
          return r.violations.map((v) => ({ id: v.id, impact: v.impact, n: v.nodes.length, sample: v.nodes.slice(0, 2).map((x) => x.target.join(' ')) }));
        }).catch((e) => [{ id: 'axe-error', n: 0, sample: [String(e).slice(0, 80)] }]);
        await page.screenshot({ path: path.join(OUT, `${styleKey}-${c.name}-${width}.png`), fullPage: !c.overlay });
      } catch (e) { ok = false; note += `exception: ${String(e.message).split('\n')[0]}; `; }
      if (errors.length) { ok = false; note += errors.slice(0, 3).join(' | '); }
      results.push({ style: styleKey, width, name: c.name, ok, overflow, note, axe });
      const ax = (axe || []).map((v) => `${v.id}:${v.n}`).join(',');
      console.log(`${ok ? 'ok  ' : 'FAIL'} ${styleKey} ${width} ${c.name} ${note}${ax ? ` axe[${ax}]` : ''}`);
      await context.close();
    }
  }
}
await browser.close();
fs.writeFileSync(path.join(OUT, `results-${SET}.json`), JSON.stringify(results, null, 1));
const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length - bad.length}/${results.length} cases clean (no overflow, no page errors)`);
