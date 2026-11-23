import { sttLimitsFromEnv, type SttLimits } from '../stt/pipeline';
import type { AiTier } from './owner';

/**
 * Serverová politika limitů podle úrovně uživatele (tier). Jediné místo, kde se rozhoduje, kolik který účet smí; plány předplatného
 * (budoucí) přidají další hodnotu `AiTier` a řádek v `policyFor`, nic dalšího se nemění. Oprávnění k projektu, rate limity, ledger
 * a odhad ceny zůstávají stejné pro všechny úrovně (řeší je ai_reserve / stt_reserve v databázi).
 *
 *  owner  vlastník (AI_OWNER_USER_IDS): BEZ aplikačního denního rozpočtu tokenů a BEZ denního limitu minut přepisu. Zůstávají per-minutové
 *         limity, souběžnost/idempotence, rozpočty poskytovatele a ledger. (Volitelně AI_OWNER_DAILY_TOKEN_BUDGET jako vlastní strop.)
 *  demo   výslovně vyjmenované demo účty (AI_DEMO_USER_IDS): přísné vlastní rozpočty, přepis zvuku vypnutý, dokud se výslovně nezapne.
 *  dev    jen lokální vývoj (AI_ALLOW_ALL_AUTHENTICATED): původní chování podle AI_DAILY_TOKEN_BUDGET_PER_USER.
 */
type Env = Record<string, string | undefined>;

/** Horní mez INTEGERu v ai_reserve(p_daily_token_budget): "bez aplikačního limitu" bez změny schématu. */
export const UNLIMITED_TOKENS = 2_147_483_647;
/** Horní mez, kterou stt_reserve(BIGINT) bezpečně přijme z JSON čísla. */
export const UNLIMITED_AUDIO_MS = Number.MAX_SAFE_INTEGER;

export interface AiPolicy {
  tier: AiTier;
  perMinute: number;
  /** Per-minutový strop CELKOVÉHO provozu všech účtů, jak ho vidí tento požadavek (viz clamp u demo). */
  globalPerMinute: number;
  dailyTokenBudget: number;
  stt: SttLimits & { allowed: boolean };
}

const int = (env: Env, name: string, fallback: number, min: number, max: number) => {
  const n = Number.parseInt(env[name] ?? '', 10);
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
};

export function policyFor(tier: AiTier, env: Env = process.env): AiPolicy {
  const perMinute = int(env, 'AI_RATE_PER_USER_PER_MINUTE', 10, 1, 1000);
  const globalPerMinute = int(env, 'AI_RATE_GLOBAL_PER_MINUTE', 60, 1, 100000);
  const stt = sttLimitsFromEnv(env);

  if (tier === 'owner') {
    const cap = int(env, 'AI_OWNER_DAILY_TOKEN_BUDGET', 0, 1_000, UNLIMITED_TOKENS);
    return {
      tier, perMinute, globalPerMinute,
      dailyTokenBudget: cap || UNLIMITED_TOKENS,
      stt: { ...stt, userDailyMs: UNLIMITED_AUDIO_MS, globalDailyMs: UNLIMITED_AUDIO_MS, allowed: true },
    };
  }
  if (tier === 'demo') {
    // Demo provoz nikdy nesmí zablokovat vlastníka: vlastníkův per-minutový strop (globalPerMinute) se počítá přes VŠECHNY účty, takže
    // demo smí dohromady zabrat nejvýš (globalPerMinute - perMinute vlastníka) a vlastník vždy najde volné místo.
    const room = Math.max(1, globalPerMinute - perMinute);
    const demoPerMin = Math.min(int(env, 'AI_DEMO_RATE_PER_USER_PER_MINUTE', 2, 1, 1000), perMinute);
    const demoUserMin = int(env, 'AI_DEMO_STT_DAILY_AUDIO_MIN_PER_USER', 0, 0, 100_000);
    const demoGlobalMin = int(env, 'AI_DEMO_STT_DAILY_AUDIO_MIN_GLOBAL', demoUserMin, 0, 10_000_000);
    return {
      tier,
      perMinute: demoPerMin,
      globalPerMinute: Math.min(int(env, 'AI_DEMO_RATE_GLOBAL_PER_MINUTE', 4, 1, 100000), room),
      dailyTokenBudget: int(env, 'AI_DEMO_DAILY_TOKEN_BUDGET', 20_000, 1_000, 1_000_000),
      stt: { ...stt, userDailyMs: Math.max(1, demoUserMin) * 60_000, globalDailyMs: Math.max(1, demoGlobalMin) * 60_000, allowed: demoUserMin > 0 },
    };
  }
  return { tier, perMinute, globalPerMinute, dailyTokenBudget: int(env, 'AI_DAILY_TOKEN_BUDGET_PER_USER', 200_000, 1_000, 100_000_000), stt: { ...stt, allowed: true } };
}
