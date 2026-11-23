import { describe, test, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

/** The local login preflight must refuse every non-local Auth target BEFORE anyone tries to log in (docs/LOCAL_DEV.md). No network is used for these cases. */
const run = (env: Record<string, string>) =>
  spawnSync(process.execPath, [path.resolve(__dirname, '../../scripts/local-auth-preflight.mjs')], { env: { PATH: process.env.PATH ?? '', ...env } as unknown as NodeJS.ProcessEnv, encoding: 'utf8' });

describe('local-auth-preflight', () => {
  test('refuses the hosted project, naming it by reference only', () => {
    const r = run({ NEXT_PUBLIC_SUPABASE_URL: 'https://twjlnsxjtuntujarwner.supabase.co', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'x', DEV_LOGIN_EMAIL: 'a@example.test', DEV_LOGIN_PASSWORD: 'p' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('HOSTED project twjlnsxjtuntujarwner');
    expect(r.stderr + r.stdout).not.toContain('a@example.test');
  });
  test('refuses demo mode (browser-local mock accounts)', () => {
    const r = run({ NEXT_PUBLIC_FORCE_DEMO: '1' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('mock accounts');
  });
  test('refuses any other non-loopback host and a missing URL', () => {
    expect(run({ NEXT_PUBLIC_SUPABASE_URL: 'http://10.0.0.5:54321', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'x' }).status).toBe(1);
    expect(run({}).stderr).toContain('missing or invalid');
  });
  test('a loopback target without a dev identity is refused before any request', () => {
    const r = run({ NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:55521', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'x' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('DEV_LOGIN_EMAIL');
  });
});
