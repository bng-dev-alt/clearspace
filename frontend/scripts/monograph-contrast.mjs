#!/usr/bin/env node
// WCAG contrast gate for the Monograph tokens, computed FROM src/app/monograph.css (not from a copy): text pairs >= 4.5:1, form borders / UI
// graphics >= 3:1. Fails (exit 1) on any violation. Run: node scripts/monograph-contrast.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const css = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/app/monograph.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const tokens = (theme) => {
  const m = css.match(new RegExp(`html\\[data-style="monograph"\\]\\[data-theme="${theme}"\\]\\s*\\{([^}]*)\\}`));
  if (!m) throw new Error(`no ${theme} token block`);
  return Object.fromEntries([...m[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((x) => [x[1], x[2].trim()]));
};
const lum = (hex) => {
  const v = hex.replace('#', '').match(/../g).map((h) => parseInt(h, 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
};
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

// [foreground, background, minimum, why]
const TEXT = 4.5, UI = 3;
const PAIRS = [
  ['--text', '--bg-page', TEXT, 'body'], ['--text', '--surface', TEXT, 'cards'], ['--text', '--surface-2', TEXT, 'insets'], ['--text', '--surface-3', TEXT, 'hover'], ['--text', '--mg-sunken', TEXT, 'rail'],
  ['--text-secondary', '--bg-page', TEXT, 'secondary'], ['--text-secondary', '--surface', TEXT, ''], ['--text-secondary', '--surface-2', TEXT, ''], ['--text-secondary', '--mg-sunken', TEXT, ''],
  ['--text-muted', '--bg-page', TEXT, 'labels'], ['--text-muted', '--surface', TEXT, ''], ['--text-muted', '--surface-2', TEXT, ''], ['--text-muted', '--mg-sunken', TEXT, 'inactive rail tab'], ['--text-muted', '--surface-3', TEXT, ''],
  ['--accent', '--bg-page', TEXT, 'olive text'], ['--accent', '--surface', TEXT, ''], ['--accent', '--surface-2', TEXT, ''], ['--accent', '--accent-soft', TEXT, 'accent badge'], ['--accent', '--mg-sunken', TEXT, 'sub-nav numbers'],
  ['--text-on-accent', '--accent', TEXT, 'primary button'], ['--bg-page', '--text', TEXT, 'hover / active (ink fill)'], ['--bg-page', '--danger', TEXT, 'danger button'],
  ['--danger', '--bg-page', TEXT, ''], ['--danger', '--surface', TEXT, ''], ['--danger', '--danger-soft', TEXT, 'danger badge'],
  ['--warning', '--bg-page', TEXT, ''], ['--warning', '--surface', TEXT, ''], ['--warning', '--warning-soft', TEXT, 'warning badge'],
  ['--mg-input', '--bg-page', UI, 'form border'], ['--mg-input', '--surface', UI, 'form border'], ['--mg-input', '--surface-2', UI, 'form border'],
  ['--border-strong', '--surface', UI, 'form border (token)'], ['--accent', '--bg-page', UI, 'focus ring'], ['--text', '--bg-page', UI, 'ink rule'],
];
let bad = 0, min = { light: 99, dark: 99 };
for (const theme of ['light', 'dark']) {
  const t = tokens(theme);
  for (const [fg, bg, need, why] of PAIRS) {
    if (!t[fg] || !t[bg]) throw new Error(`missing ${fg} or ${bg} in ${theme}`);
    const r = ratio(t[fg], t[bg]);
    if (need === TEXT) min[theme] = Math.min(min[theme], r);
    const ok = r >= need;
    if (!ok) { bad++; console.log(`FAIL ${theme} ${fg} on ${bg} = ${r.toFixed(2)}:1 (need ${need}) ${why}`); }
  }
}
console.log(`${PAIRS.length * 2} pairs checked; lowest text ratio: light ${min.light.toFixed(2)}, dark ${min.dark.toFixed(2)}; violations: ${bad}`);
process.exit(bad ? 1 : 0);
