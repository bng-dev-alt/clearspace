# AI / STT budget policy (tiers)

Decided on the **server** from the verified JWT's immutable `user.id` (`lib/ai/owner.ts` → `aiTier`, numbers in `lib/ai/policy.ts`). No e-mail, claim, `user_metadata`/`app_metadata`, header, body field or client flag can change a tier (tested in `e2e/tier-budgets.spec.ts`).

| Tier | Who | Daily AI tokens | Daily STT minutes | Per-minute limits |
|---|---|---|---|---|
| **owner** | `AI_OWNER_USER_IDS` | **no application budget** (`ai_reserve` gets INT max); optional `AI_OWNER_DAILY_TOKEN_BUDGET` | **none** (`stt_reserve` gets MAX_SAFE_INTEGER) | `AI_RATE_PER_USER_PER_MINUTE` / `AI_RATE_GLOBAL_PER_MINUTE` stay |
| **demo** | `AI_DEMO_USER_IDS` (explicit) | `AI_DEMO_DAILY_TOKEN_BUDGET` (20 000) per user | off unless `AI_DEMO_STT_DAILY_AUDIO_MIN_PER_USER` > 0 | own per-user and global caps, clamped so demo + the owner's per-user limit ≤ the owner's global limit |
| **dev** | local only (`AI_ALLOW_ALL_AUTHENTICATED=1`, ignored on production and whenever an allowlist exists) | `AI_DAILY_TOKEN_BUDGET_PER_USER` | env | env |
| everybody else | – | AI closed (403 `ai_owner_only`) | closed | – |

An id on both lists gets the stricter tier (demo). New plans = a new `AiTier` value and a row in `policyFor`.

**Unchanged for every tier:** JWT check, project membership (`is_project_member` inside `ai_reserve`), per-minute rate limit, advisory-lock serialisation (parallel requests cannot all pass one check), usage/cost ledger, Soniox consent and retention, idempotent STT start, no automatic retry of an uncertain paid request (a Gemini timeout/504 is never retried; only an explicit 503/UNAVAILABLE rejection gets one retry).

**Window:** the daily budget is a rolling 24 h over `ai_requests` (not calendar midnight): a booking older than 24 h stops counting.

**Known limit (needs a migration, not done):** there is no aggregate *daily* demo token budget across all demo users (SQL only sums per user); the demo global exposure is bounded by (number of listed demo ids × `AI_DEMO_DAILY_TOKEN_BUDGET`) and by the demo per-minute clamp. The provider-side quota stays the hard cap.

**Root cause of the 2026-11-23 incident:** production env `AI_DAILY_TOKEN_BUDGET_PER_USER=50000` (set as a launch precaution) vs. the owner's rolling-24 h usage of 45 791 tokens; the next AI Studio reservation (~5k+) exceeded 50k → `ai_reserve` returned `budget_exceeded`. Not the provider, not the global rate limit.
