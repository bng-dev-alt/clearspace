#!/usr/bin/env node
// "Existing must stay existing": compares the app WITHOUT the flag (this branch) against a BASELINE build of the commit before the integration
// (git archive d01a523), same demo data, same viewport, light + dark. Two independent checks per screen:
//   1. computed-style fingerprint of EVERY element (all properties) -- identical or the differing elements are listed
//   2. pixel equality of the screenshots (byte-identical PNG)
// Both apps run in demo mode (NEXT_PUBLIC_FORCE_DEMO=1), so no backend is involved.
//   BASELINE_URL=http://127.0.0.1:3422 CURRENT_URL=http://127.0.0.1:3423 node scripts/monograph-regression.mjs
import { chromium } from 'playwright-core';
import crypto from 'node:crypto';

const A = process.env.BASELINE_URL, B = process.env.CURRENT_URL;
const CHROMIUM = process.env.PW_CHROMIUM_PATH || `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell`;
const SCREENS = [['login', '/login', false], ['projects', '/', true], ['board', '/projects/project-default', true], ['team', '/team', true]];
const VIEWPORTS = [[1440, 900], [375, 812]];
const uid = 'e2e-user';
const seed = (page) => page.addInitScript((u) => {
  localStorage.setItem('kanban_mock_session', JSON.stringify({ user: { id: u, email: 'e2e@clearspace.test', user_metadata: { display_name: 'E2E Tester' } }, access_token: 'mock-jwt-token-' + u }));
  localStorage.setItem('kanban_mock_profiles', JSON.stringify([{ id: u, email: 'e2e@clearspace.test', display_name: 'E2E Tester', created_at: '2026-01-01T00:00:00.000Z' }]));
}, uid);

async function capture(browser, base, [name, p, auth], [w, h], theme) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  await page.addInitScript((t) => localStorage.setItem('clearspace-theme', t), theme);
  await page.addInitScript(() => localStorage.setItem('clearspace-style', 'monograph')); // flag is OFF in both apps: must be ignored
  await page.clock.setFixedTime(new Date('2026-07-15T12:00:00'));
  if (auth) await seed(page);
  await page.goto(base + p, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(1200);
  await page.addStyleTag({ content: 'nextjs-portal,[data-nextjs-toast],[data-next-badge-root]{display:none !important} *{caret-color:transparent !important} *,*::before,*::after{animation:none !important;transition:none !important}' });
  const rows = await page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('body, body *')) {
      if (el.closest('nextjs-portal') || el.tagName === 'SCRIPT') continue;
      const cs = getComputedStyle(el);
      const parts = []; // custom properties are enumerated in hash order, so sort before fingerprinting
      // next/font derives its family names from the project path (e.g. __Sora_a1b2c3), so two checkouts differ by design: normalise that one token
      for (let i = 0; i < cs.length; i++) parts.push(cs[i] + ':' + cs.getPropertyValue(cs[i]).replace(/__[A-Za-z_]+_[0-9a-f]{6,}(_Fallback_[0-9a-f]+)?/g, 'NEXTFONT') + ';');
      const s = parts.sort().join('');
      const r = el.getBoundingClientRect();
      // `auth-card` is the only class the integration adds to existing markup (no rule matches it without data-style): ignored in the element key
      out.push([el.tagName + '.' + String(el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className).trim().replace(/\s+/g, '.').replace(/\.auth-card/, '').slice(0, 80), s, `${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.width)},${Math.round(r.height)}`]);
    }
    return { out, attr: document.documentElement.getAttribute('data-style') };
  });
  const png = await page.screenshot({ fullPage: true });
  await ctx.close();
  return { rows: rows.out, attr: rows.attr, png };
}

const browser = await chromium.launch({ executablePath: CHROMIUM });
let bad = 0, total = 0;
for (const theme of ['light', 'dark']) for (const vp of VIEWPORTS) for (const sc of SCREENS) {
  const a = await capture(browser, A, sc, vp, theme), b = await capture(browser, B, sc, vp, theme);
  total++;
  const n = Math.min(a.rows.length, b.rows.length);
  const diffs = [];
  for (let i = 0; i < n; i++) if (a.rows[i][1] !== b.rows[i][1] || a.rows[i][2] !== b.rows[i][2] || a.rows[i][0] !== b.rows[i][0]) {
    const pa = Object.fromEntries(a.rows[i][1].split(';').map((x) => [x.slice(0, x.indexOf(':')), x.slice(x.indexOf(':') + 1)])), pb = Object.fromEntries(b.rows[i][1].split(';').map((x) => [x.slice(0, x.indexOf(':')), x.slice(x.indexOf(':') + 1)]));
    const props = [...new Set([...Object.keys(pa), ...Object.keys(pb)])].filter((k) => pa[k] !== pb[k]).slice(0, 3).map((k) => `${k}: ${String(pa[k]).slice(0, 60)} -> ${String(pb[k]).slice(0, 60)}`);
    if (!props.length && a.rows[i][1] !== b.rows[i][1]) { let k = 0; while (a.rows[i][1][k] === b.rows[i][1][k]) k++; props.push('raw@' + k + ': ' + a.rows[i][1].slice(Math.max(0, k - 40), k + 60) + ' -> ' + b.rows[i][1].slice(Math.max(0, k - 40), k + 60)); }
    diffs.push(a.rows[i][0] + ' vs ' + b.rows[i][0] + (a.rows[i][2] !== b.rows[i][2] ? ` rect ${a.rows[i][2]} -> ${b.rows[i][2]}` : '') + (props.length ? ' [' + props.join('; ') + ']' : ''));
  }
  const same = a.rows.length === b.rows.length && diffs.length === 0;
  const px = crypto.createHash('sha1').update(a.png).digest('hex') === crypto.createHash('sha1').update(b.png).digest('hex');
  const ok = same && px && !a.attr && !b.attr;
  if (!ok) bad++;
  console.log(`${ok ? 'identical' : 'DIFF     '} ${theme} ${vp[0]} ${sc[0]}: ${a.rows.length}/${b.rows.length} elements, computed-style diffs ${diffs.length}, pixels ${px ? 'identical' : 'DIFFER'}, data-style attr ${b.attr ?? 'absent'}${diffs.length ? ' e.g. ' + diffs.slice(0, 3).join(' | ') : ''}`);
}
await browser.close();
console.log(`\n${total - bad}/${total} screens identical to the baseline (flag unset)`);
process.exit(bad ? 1 : 0);
