#!/usr/bin/env node
// Keyboard pass for Monograph (demo-mode app): tabs through the first N stops of the board page and of an open dialog and checks that every stop has a
// visible focus indicator (>= 2px outline, or a focus ring from box-shadow), that the skip link comes first and that every nav destination is reachable
// by keyboard (rail tabs, sub-nav, bottom bar). Also checks Escape closes the dialog. BASE_URL=http://127.0.0.1:3421 node scripts/monograph-keyboard.mjs
import { chromium } from 'playwright-core';
const BASE = process.env.BASE_URL || 'http://127.0.0.1:3421';
const CHROMIUM = process.env.PW_CHROMIUM_PATH || `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell`;
const browser = await chromium.launch({ executablePath: CHROMIUM });
let bad = 0;
const fail = (m) => { bad++; console.log('FAIL', m); };
const describe = () => {
  const el = document.activeElement; if (!el || el === document.body || el.tagName === 'NEXTJS-PORTAL') return { tag: 'dev', name: 'next dev tools (dev only)', ring: 'skip', skip: true };
  const cs = getComputedStyle(el); const w = parseFloat(cs.outlineWidth) || 0;
  const ring = cs.outlineStyle !== 'none' && w >= 2 ? `outline ${cs.outlineWidth}` : (cs.boxShadow && cs.boxShadow !== 'none' ? 'box-shadow' : null);
  const name = (el.getAttribute('aria-label') || el.textContent || el.getAttribute('placeholder') || el.id || '').trim().replace(/\s+/g, ' ').slice(0, 40);
  return { tag: el.tagName.toLowerCase(), name, ring, testid: el.getAttribute('data-testid'), dbg: cs.outlineWidth + ' ' + cs.outlineStyle + ' fv=' + el.matches(':focus-visible') };
};
async function stops(page, n) {
  const out = [];
  for (let i = 0; i < n; i++) { await page.keyboard.press('Tab'); await page.waitForTimeout(180); // outline transitions (120ms) must settle before measuring
    const d = await page.evaluate(describe); if (d && !d.skip) out.push(d); }
  return out;
}
for (const theme of ['light', 'dark']) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.addInitScript((t) => {
    localStorage.setItem('clearspace-theme', t); localStorage.setItem('clearspace-style', 'monograph');
    localStorage.setItem('kanban_mock_session', JSON.stringify({ user: { id: 'e2e-user', email: 'e2e@clearspace.test', user_metadata: { display_name: 'E2E Tester' } }, access_token: 'mock-jwt-token-e2e-user' }));
    localStorage.setItem('kanban_mock_profiles', JSON.stringify([{ id: 'e2e-user', email: 'e2e@clearspace.test', display_name: 'E2E Tester', created_at: new Date().toISOString() }]));
  }, theme);
  await page.goto(`${BASE}/projects/project-default`);
  await page.locator('.app-container[data-hydrated="true"]').waitFor();
  await page.waitForTimeout(800);
  const s = await stops(page, 18);
  const first = s[0];
  if (!first || !/Přeskočit/.test(first.name)) fail(`${theme}: skip link is not the first tab stop (got ${first && first.name})`);
  const names = s.map((x) => x && x.name).join(' | ');
  for (const want of ['Projekty', 'Board', 'Tým', 'AI', 'Project Intelligence']) if (!s.some((x) => x && x.name.includes(want))) fail(`${theme}: "${want}" not reached in the first 18 tab stops`);
  const noRing = s.filter((x) => x && !x.ring);
  if (noRing.length) fail(`${theme}: stops without a visible focus ring: ${noRing.map((x) => x.tag + ':' + x.name).join(', ')}`);
  console.log(`${theme}: ${s.length} stops, ${s.filter((x) => x && x.ring).length} with visible ring; order: ${names}`);
  // dialog: new task
  await page.locator('[data-testid^="add-card-btn-"]').first().click();
  await page.waitForTimeout(400);
  const d = await stops(page, 8);
  const dRing = d.filter((x) => x && !x.ring);
  if (dRing.length) fail(`${theme}: dialog stops without focus ring: ${dRing.map((x) => x.tag + ':' + x.name + ' [' + x.dbg + ']').join(', ')}`);
  console.log(`${theme}: dialog 8 stops, ${d.filter((x) => x && x.ring).length} with visible ring`);
  await page.keyboard.press('Escape'); await page.waitForTimeout(300);
  const open = await page.locator('.modal-overlay').count();
  if (open) fail(`${theme}: Escape did not close the dialog`);
  await ctx.close();
}
// bottom bar reachable by keyboard at 375
const ctx = await browser.newContext({ viewport: { width: 375, height: 812 } });
const page = await ctx.newPage();
await page.addInitScript(() => {
  localStorage.setItem('clearspace-style', 'monograph');
  localStorage.setItem('kanban_mock_session', JSON.stringify({ user: { id: 'e2e-user', email: 'e2e@clearspace.test', user_metadata: { display_name: 'E2E Tester' } }, access_token: 'mock-jwt-token-e2e-user' }));
  localStorage.setItem('kanban_mock_profiles', JSON.stringify([{ id: 'e2e-user', email: 'e2e@clearspace.test', display_name: 'E2E Tester', created_at: new Date().toISOString() }]));
});
await page.goto(`${BASE}/team`);
await page.waitForTimeout(1200);
const m = await stops(page, 40);
for (const want of ['Projekty', 'Board', 'Tým', 'AI']) if (!m.some((x) => x && x.tag === 'a' && x.name.replace(/^\d+\s*/, '').startsWith(want))) fail(`375: bottom bar "${want}" not reachable within 40 tab stops`);
if (m.some((x) => x && !x.ring)) fail('375: a stop without focus ring: ' + m.filter((x) => x && !x.ring).map((x) => x.name).join(', '));
console.log('375: bottom bar reachable, all stops ringed');
await browser.close();
console.log(bad ? `\n${bad} keyboard problem(s)` : '\nkeyboard pass OK');
process.exit(bad ? 1 : 0);
