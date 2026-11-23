import { describe, expect, test } from 'vitest';
import { aiTier, aiAccessAllowed } from '../../lib/ai/owner';
import { policyFor, UNLIMITED_AUDIO_MS, UNLIMITED_TOKENS } from '../../lib/ai/policy';

const OWNER = '0e2e0000-0000-4000-8000-000000000001';
const DEMO = '0e2e0000-0000-4000-8000-0000000000d1';
const OTHER = '0e2e0000-0000-4000-8000-0000000000aa';
// Production values at the time of the incident: a 50k daily token budget, 3/min per user, 10/min global, 30 STT min/day.
const PROD = { AI_OWNER_USER_IDS: OWNER, AI_DAILY_TOKEN_BUDGET_PER_USER: '50000', AI_RATE_PER_USER_PER_MINUTE: '3', AI_RATE_GLOBAL_PER_MINUTE: '10', STT_DAILY_AUDIO_MIN_PER_USER: '30', STT_DAILY_AUDIO_MIN_GLOBAL: '30' };

describe('tier resolution is server-side, by user id only', () => {
  test('owner / demo / nobody', () => {
    const env = { ...PROD, AI_DEMO_USER_IDS: DEMO };
    expect(aiTier(OWNER, env)).toBe('owner');
    expect(aiTier(DEMO, env)).toBe('demo');
    expect(aiTier(OTHER, env)).toBeNull();
    expect(aiAccessAllowed(OTHER, env)).toBe(false);
    expect(aiTier(OWNER.toUpperCase(), env)).toBe('owner');
  });
  test('nothing configured: closed for everybody, including a would-be owner (fail closed)', () => {
    expect(aiTier(OWNER, {})).toBeNull();
    expect(aiTier(OWNER, { AI_OWNER_USER_IDS: 'not-a-uuid, ,*', AI_DEMO_USER_IDS: 'admin@example.com' })).toBeNull();
  });
  test('an id on BOTH lists gets the stricter tier (demo)', () => {
    expect(aiTier(OWNER, { AI_OWNER_USER_IDS: OWNER, AI_DEMO_USER_IDS: OWNER })).toBe('demo');
  });
  test('allow-all is a local-dev tier only: ignored on production and whenever an allowlist exists', () => {
    expect(aiTier(OTHER, { AI_ALLOW_ALL_AUTHENTICATED: '1' })).toBe('dev');
    expect(aiTier(OTHER, { AI_ALLOW_ALL_AUTHENTICATED: '1', VERCEL_ENV: 'production' })).toBeNull();
    expect(aiTier(OTHER, { AI_ALLOW_ALL_AUTHENTICATED: '1', AI_OWNER_USER_IDS: OWNER })).toBeNull();
    expect(aiTier(OTHER, { AI_ALLOW_ALL_AUTHENTICATED: '1', AI_DEMO_USER_IDS: DEMO })).toBeNull();
  });
});

describe('policy per tier', () => {
  test('owner: no application daily token budget and no daily STT cap, whatever the shared env says; per-minute limits stay', () => {
    const p = policyFor('owner', PROD);
    expect(p.dailyTokenBudget).toBe(UNLIMITED_TOKENS);
    expect(p.stt).toMatchObject({ allowed: true, userDailyMs: UNLIMITED_AUDIO_MS, globalDailyMs: UNLIMITED_AUDIO_MS, retentionDays: 7 });
    expect(p.perMinute).toBe(3);
    expect(p.globalPerMinute).toBe(10);
  });
  test('owner may opt into an explicit own cap', () => {
    expect(policyFor('owner', { ...PROD, AI_OWNER_DAILY_TOKEN_BUDGET: '2000000' }).dailyTokenBudget).toBe(2_000_000);
    expect(policyFor('owner', { ...PROD, AI_OWNER_DAILY_TOKEN_BUDGET: 'garbage' }).dailyTokenBudget).toBe(UNLIMITED_TOKENS);
  });
  test('demo: strict own budgets, never the owner budget; STT off unless explicitly enabled', () => {
    const p = policyFor('demo', PROD);
    expect(p.dailyTokenBudget).toBe(20_000);
    expect(p.perMinute).toBe(2);
    expect(p.stt.allowed).toBe(false);
    const on = policyFor('demo', { ...PROD, AI_DEMO_STT_DAILY_AUDIO_MIN_PER_USER: '5' });
    expect(on.stt).toMatchObject({ allowed: true, userDailyMs: 300_000, globalDailyMs: 300_000 });
  });
  test('demo traffic can never take the owner\'s last per-minute slot: demoGlobal + ownerPerUser <= ownerGlobal', () => {
    for (const [perUser, global, demoGlobal] of [[3, 10, 100], [3, 4, 50], [5, 5, 9], [1, 1, 3], [10, 60, 999]]) {
      const env = { AI_OWNER_USER_IDS: OWNER, AI_RATE_PER_USER_PER_MINUTE: String(perUser), AI_RATE_GLOBAL_PER_MINUTE: String(global), AI_DEMO_RATE_GLOBAL_PER_MINUTE: String(demoGlobal) };
      const d = policyFor('demo', env), o = policyFor('owner', env);
      expect(d.globalPerMinute, JSON.stringify(env)).toBeLessThanOrEqual(Math.max(1, o.globalPerMinute - o.perMinute));
      expect(d.perMinute).toBeLessThanOrEqual(o.perMinute);
    }
  });
  test('demo cannot be configured above the hard ceiling', () => {
    expect(policyFor('demo', { AI_DEMO_DAILY_TOKEN_BUDGET: '999999999' }).dailyTokenBudget).toBe(20_000); // out of range -> default
  });
  test('dev tier keeps the legacy shared-env behaviour', () => {
    expect(policyFor('dev', PROD).dailyTokenBudget).toBe(50_000);
    expect(policyFor('dev', {}).dailyTokenBudget).toBe(200_000);
  });
});
