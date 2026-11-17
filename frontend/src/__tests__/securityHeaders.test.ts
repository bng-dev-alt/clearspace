import { describe, test, expect, vi, afterEach } from 'vitest';

describe('security headers (next.config.ts)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function load() {
    vi.resetModules();
    const mod = await import('../../next.config');
    const rules = await mod.default.headers!();
    return Object.fromEntries(rules[0].headers.map((h: { key: string; value: string }) => [h.key, h.value]));
  }

  test('applies to every path', async () => {
    const mod = await import('../../next.config');
    const rules = await mod.default.headers!();
    expect(rules[0].source).toBe('/:path*');
  });

  test('framing, sniffing, referrer and CSP basics are set', async () => {
    const h = await load();
    expect(h['X-Frame-Options']).toBe('DENY');
    expect(h['X-Content-Type-Options']).toBe('nosniff');
    expect(h['Referrer-Policy']).toBe('strict-origin-when-cross-origin');
    expect(h['Content-Security-Policy']).toContain("frame-ancestors 'none'");
    expect(h['Content-Security-Policy']).toContain("object-src 'none'");
  });

  test('microphone stays available to the app itself (voice copilot), camera/geolocation off', async () => {
    const h = await load();
    expect(h['Permissions-Policy']).toContain('microphone=(self)');
    expect(h['Permissions-Policy']).toContain('camera=()');
    expect(h['Permissions-Policy']).toContain('geolocation=()');
  });

  test('HSTS is production-only so localhost development is not locked to HTTPS', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    expect((await load())['Strict-Transport-Security']).toBeUndefined();
    vi.stubEnv('NODE_ENV', 'production');
    expect((await load())['Strict-Transport-Security']).toContain('max-age=');
  });
});
