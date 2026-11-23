#!/usr/bin/env node
// Checks a PRODUCTION build (`next build` + `next start`, demo auth) for the flag contract. EXPECT=off|on BASE_URL=http://127.0.0.1:3421
//   off: a stored 'monograph' preference is ignored (no data-style), the navbar has no style selector, no rail, fonts are NOT requested
//   on : Monograph is the DEFAULT for a fresh browser (set before <body> exists = no flash); an explicit 'existing' (Classic) is respected and
//        loads no Monograph font; light/dark stays independent of the style
import { chromium } from 'playwright-core';
const BASE = process.env.BASE_URL || 'http://127.0.0.1:3421', EXPECT = process.env.EXPECT;
const CHROMIUM = process.env.PW_CHROMIUM_PATH || `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell`;
const b = await chromium.launch({ executablePath: CHROMIUM });
let bad = 0; const check = (ok, m) => { console.log(ok ? 'ok  ' : 'FAIL', m); if (!ok) bad++; };
const seed = (page, style, theme) => page.addInitScript(([s, t]) => {
  // no-flash probe: which data-style does <html> carry at the moment <body> first appears (before any paint)?
  new MutationObserver((_, o) => { if (document.body) { window.__styleAtBody = document.documentElement.getAttribute('data-style'); o.disconnect(); } })
    .observe(document, { childList: true, subtree: true });
  if (s) localStorage.setItem('clearspace-style', s);
  if (t) localStorage.setItem('clearspace-theme', t);
  localStorage.setItem('kanban_mock_session', JSON.stringify({ user: { id: 'e2e-user', email: 'e2e@clearspace.test', user_metadata: { display_name: 'E2E Tester' } }, access_token: 'x' }));
  localStorage.setItem('kanban_mock_profiles', JSON.stringify([{ id: 'e2e-user', email: 'e2e@clearspace.test', display_name: 'E2E Tester', created_at: new Date().toISOString() }]));
}, [style, theme]);
async function visit(style, theme) {
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } }); const page = await ctx.newPage();
  const fonts = []; page.on('request', (r) => { if (r.url().includes('/fonts/monograph/')) fonts.push(r.url().split('/').pop()); });
  await seed(page, style, theme); await page.goto(`${BASE}/team`); await page.waitForTimeout(1500);
  const r = await page.evaluate(() => ({ atBody: window.__styleAtBody ?? null, theme: document.documentElement.dataset.theme, style: document.documentElement.dataset.style || null, toggle: !!document.querySelector('[data-testid="style-monograph"]'), rail: !!document.querySelector('.mg-rail'), font: getComputedStyle(document.body).fontFamily }));
  await ctx.close(); return { ...r, fonts };
}
if (EXPECT === 'off') {
  const r = await visit('monograph');
  check(r.style === null, `stored 'monograph' ignored (data-style: ${r.style})`);
  check(!r.toggle && !r.rail, 'no style selector and no rail in the navbar');
  check(r.fonts.length === 0, `no Monograph font file requested (${r.fonts.length})`);
  check(!r.font.includes('IBM Plex'), 'body font is the existing one: ' + r.font.slice(0, 40));
} else {
  const d = await visit(null);
  check(d.style === 'monograph' && d.atBody === 'monograph' && d.toggle && d.rail, `fresh browser = Monograph, set before <body> (no flash): at body ${d.atBody}, now ${d.style}, toggle ${d.toggle}, rail ${d.rail}`);
  check(d.fonts.length > 0, `Monograph fonts load for the default (${[...new Set(d.fonts)].length} files)`);
  const c = await visit('existing');
  check(c.style === null && c.atBody === null && c.toggle && !c.rail, `explicit Classic is respected, no flash of Monograph (at body ${c.atBody}, now ${c.style}, rail ${c.rail})`);
  check(c.fonts.length === 0, `Classic downloads no Monograph font (${c.fonts.length})`);
  const m = await visit('monograph');
  check(m.style === 'monograph' && m.rail, `explicit Monograph applies (data-style ${m.style}, rail ${m.rail})`);
  for (const [st, th] of [[null, 'dark'], ['existing', 'dark'], [null, 'light'], ['existing', 'light']]) {
    const v = await visit(st, th);
    check(v.theme === th, `theme independent: style ${st ?? 'default'} + theme ${th} -> data-theme ${v.theme}, data-style ${v.style}`);
  }
}
await b.close(); process.exit(bad ? 1 : 0);
