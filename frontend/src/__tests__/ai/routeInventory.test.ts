import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// Structural guard: every handler under /api/ai and /api/intelligence must go through the owner-gated gateway
// (runAi / runStt / runSttDelete -> authenticate()), re-export one that does, or be the explicit capability check.
// A new route that talks to a provider without one of these fails here instead of shipping ungated.
const API = join(__dirname, '../../app/api');
const GATED = /\b(runAi|runStt|runSttDelete)\b/;
// RUN 10: the live-transcription route gates itself: owner/demo tier via authenticate(req) (gate ON), then the meeting pilot list,
// then the tier's STT permission -- all before any provider call. Checked explicitly below.
const SELF_GATED = new Set(['intelligence/meetings/live/route.ts']);
const REEXPORT = /export \{ POST \} from '(\.\.\/)+ai\/[a-z-]+\/route'/;
const ALLOWED_OTHER = new Set(['intelligence/access/route.ts']); // authenticate(req,{gate:false}); answers only {aiOwner, stt}

function routes(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? routes(p) : n === 'route.ts' ? [p] : [];
  });
}

describe('AI/STT route inventory', () => {
  const files = routes(API).map((f) => relative(API, f)).filter((f) => f.startsWith('ai/') || f.startsWith('intelligence/'));

  it('finds the expected routes', () => {
    expect(files.length).toBeGreaterThanOrEqual(18);
  });

  it.each(files)('%s is owner-gated', (f) => {
    if (ALLOWED_OTHER.has(f) || SELF_GATED.has(f)) return;
    const src = readFileSync(join(API, f), 'utf8');
    expect(GATED.test(src) || REEXPORT.test(src)).toBe(true);
  });

  it('access route uses authenticate with the gate off and nothing else', () => {
    const src = readFileSync(join(API, 'intelligence/access/route.ts'), 'utf8');
    expect(src).toContain('authenticate(req, { gate: false })');
    expect(src).not.toMatch(/runAi|runStt|fetch\(/);
  });

  it('live route: authenticate with the gate ON, pilot + STT permission checked before the provider client is created', () => {
    const src = readFileSync(join(API, 'intelligence/meetings/live/route.ts'), 'utf8');
    expect(src).toContain('await authenticate(req);');
    expect(src).not.toContain('gate: false');
    const auth = src.indexOf('await authenticate(req)');
    const pilot = src.indexOf('inLivePilot(cfg, auth.user.id)');
    const stt = src.indexOf('!policy.stt.allowed');
    const provider = src.indexOf('new SonioxClient(');
    expect(auth).toBeGreaterThan(0);
    expect(pilot).toBeGreaterThan(auth);
    expect(stt).toBeGreaterThan(pilot);
    expect(provider).toBeGreaterThan(stt);
    expect(src).not.toMatch(/fetch\(/);
  });

  it('no rewrites or middleware can route around the handlers', () => {
    const root = join(__dirname, '../..');
    expect(readFileSync(join(root, '../next.config.ts'), 'utf8')).not.toMatch(/rewrites\s*\(/);
    for (const m of ['middleware.ts', 'proxy.ts']) expect(() => statSync(join(root, m))).toThrow();
  });
});
