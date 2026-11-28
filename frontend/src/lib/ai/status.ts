import { policyFor, UNLIMITED_AUDIO_MS, UNLIMITED_TOKENS } from './policy';
import type { AiTier } from './owner';
import { serverModel } from '../../services/ai/model';

type Env = Record<string, string | undefined>;

/**
 * RUN 11 (D3): what the CALLER's own account may do with AI, computed from the same policy the server enforces (policyFor) – never a
 * second copy of the numbers. Only the caller's own limits; no owner/demo/pilot lists, keys or other accounts. `null` limit = no app limit.
 */
export interface AiStatus {
  available: boolean;
  tier: 'owner' | 'demo' | 'dev' | null;
  model: string | null;
  dailyTokens: number | null;
  perMinute: number | null;
  /** live/async transcription minutes per day for this account; null = no app limit; 0 = transcription not allowed */
  sttMinutesPerDay: number | null;
}

export function aiStatusFor(tier: AiTier | null, env: Env = process.env): AiStatus {
  if (!tier) return { available: false, tier: null, model: null, dailyTokens: null, perMinute: null, sttMinutesPerDay: 0 };
  const p = policyFor(tier, env);
  return {
    available: true,
    tier,
    model: env.GEMINI_API_KEY ? (env.GEMINI_MODEL || serverModel()) : null,
    dailyTokens: p.dailyTokenBudget >= UNLIMITED_TOKENS ? null : p.dailyTokenBudget,
    perMinute: p.perMinute,
    sttMinutesPerDay: !p.stt.allowed ? 0 : p.stt.userDailyMs >= UNLIMITED_AUDIO_MS ? null : Math.round(p.stt.userDailyMs / 60_000),
  };
}
