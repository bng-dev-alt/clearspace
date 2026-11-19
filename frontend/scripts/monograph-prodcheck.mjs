#!/usr/bin/env node
// Checks a PRODUCTION build (`next build` + `next start`, demo auth) for the flag contract. EXPECT=off|on BASE_URL=http://127.0.0.1:3421
//   off: a stored 'monograph' preference is ignored (no data-style), the navbar has no style selector, no rail, fonts are NOT requested
//   on : default is the existing style, the selector exists, choosing Monograph sets data-style + rail, the fonts are requested only then
import { chromium } from 'playwright-core';
const BASE = process.env.BASE_URL || 'http://127.0.0.1:3421', EXPECT = process.env.EXPECT;
const CHROMIUM = process.env.PW_CHROMIUM_PATH || `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell`;
const b = await chromium.launch({ executablePath: CHROMIUM });
let bad = 0; const check = (ok, m) => { console.log(ok ? 'ok  ' : 'FAIL', m); if (!ok) bad++; };
const seed = (page, style) => page.addInitScript((s) => {
  if (s) localStorage.setItem('clearspace-style', s);
  localStorage.setItem('kanban_mock_session', JSON.stringify({ user: { id: 'e2e-user', email: 'e2e@clearspace.test', user_metadata: { display_name: 'E2E Tester' } }, access_token: 'x' }));
  localStorage.setItem('kanban_mock_profiles', JSON.stringify([{ id: 'e2e-user', email: 'e2e@clearspace.test', display_name: 'E2E Tester', created_at: new Date().toISOString() }]));
}, style);
async function visit(style) {
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } }); const page = await ctx.newPage();
  const fonts = []; page.on('request', (r) => { if (r.url().includes('/fonts/monograph/')) fonts.push(r.url().split('/').pop()); });
  await seed(page, style); await page.goto(`${BASE}/team`); await page.waitForTimeout(1500);
  const r = await page.evaluate(() => ({ style: document.documentElement.dataset.style || null, toggle: !!document.querySelector('[data-testid="style-monograph"]'), rail: !!document.querySelector('.mg-rail'), font: getComputedStyle(document.body).fontFamily }));
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
  check(d.style === null && d.toggle && !d.rail, `default = existing; selector present (data-style ${d.style}, toggle ${d.toggle}, rail ${d.rail})`);
  check(d.fonts.length === 0, `existing style downloads no Monograph font (${d.fonts.length})`);
  const m = await visit('monograph');
  check(m.style === 'monograph' && m.rail, `stored monograph applies (data-style ${m.style}, rail ${m.rail})`);
  check(m.fonts.length > 0 && m.fonts.every((f) => /latin/.test(f)), `Monograph fonts requested only now: ${[...new Set(m.fonts)].join(', ')}`);
}
await b.close(); process.exit(bad ? 1 : 0);
