import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

/**
 * Monograph musí být inertní bez <html data-style="monograph">: každé pravidlo v monograph.css musí mít VŠECHNY selektory pod tímto atributem
 * (kromě @font-face, který se stahuje až při použití rodiny, a @media, jehož vnitřek se kontroluje stejně). Žádné @import, @keyframes ani :root.
 */
const SCOPE = 'html[data-style="monograph"]';
const css = fs.readFileSync(path.join(__dirname, '../app/monograph.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

function* rules(src: string): Generator<{ prelude: string; body: string }> {
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1) return;
    const prelude = src.slice(i, open).trim();
    let depth = 1, j = open + 1;
    while (j < src.length && depth) { if (src[j] === '{') depth++; else if (src[j] === '}') depth--; j++; }
    yield { prelude, body: src.slice(open + 1, j - 1) };
    i = j;
  }
}

/** Rozdělí selektor podle čárek na nejvyšší úrovni (čárky uvnitř :is(), :not(), [attr] se ignorují). */
function splitSelectors(prelude: string): string[] {
  const out: string[] = [];
  let depth = 0, cur = '';
  for (const ch of prelude) {
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

function check(src: string, out: string[], inMedia = false) {
  for (const { prelude, body } of rules(src)) {
    if (prelude.startsWith('@font-face')) { if (inMedia) out.push('@font-face v @media'); continue; }
    if (prelude.startsWith('@media')) { check(body, out, true); continue; }
    if (prelude.startsWith('@')) { out.push(`nepovolený at-rule: ${prelude}`); continue; }
    for (const sel of splitSelectors(prelude)) {
      if (!sel.startsWith(SCOPE)) out.push(`neohraničený selektor: ${sel.slice(0, 80)}`);
    }
  }
}

describe('monograph.css je inertní bez data-style="monograph"', () => {
  it('každé pravidlo je pod html[data-style="monograph"]', () => {
    const problems: string[] = [];
    check(css, problems);
    expect(problems).toEqual([]);
  });
  it('kontrola skutečně chytá neohraničené selektory (negativní test)', () => {
    const problems: string[] = [];
    check('.card { color: red } html[data-style="monograph"] .a, .b { color: red } @media (max-width: 1px) { :root { --x: 1 } }', problems);
    expect(problems).toHaveLength(3);
  });
  it('obsahuje pravidla (test neprochází na prázdném souboru) a jen @font-face jako neohraničené at-rule', () => {
    expect([...rules(css)].length).toBeGreaterThan(100);
    expect(css).not.toMatch(/@import|@keyframes|:root/);
  });
  it('fonty: font-display swap, latin + latin-ext, soubory existují a jsou OFL (licence přiložena)', () => {
    const faces = [...css.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((m) => m[1]);
    expect(faces.length).toBe(16);
    for (const f of faces) {
      expect(f).toContain('font-display: swap');
      const file = f.match(/url\('\/fonts\/monograph\/([^']+)'\)/)![1];
      expect(fs.existsSync(path.join(__dirname, '../../public/fonts/monograph', file))).toBe(true);
    }
    for (const l of ['barlow-condensed', 'ibm-plex-sans', 'ibm-plex-mono']) {
      expect(fs.readFileSync(path.join(__dirname, `../../public/fonts/monograph/LICENSE-${l}.txt`), 'utf8')).toMatch(/SIL Open Font License/);
    }
  });
});
