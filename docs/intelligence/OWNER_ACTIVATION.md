# Owner-only activation of Meeting Intelligence (Soniox + Gemini)

Status 2026-11-19: **implemented and tested locally; NOT deployed, nothing activated in production.** Production is still `dpl_Ff8CV7zK6sM3WcwezdmsgdFPGaRi`, the Vercel firewall rule *Block legacy AI API* (`path starts with /api/ai` → deny) is untouched, STT/audio and the Soniox/owner variables do not exist in production.

## 1. What was built (local code, commit on `feature/intelligence-v2`)

| Piece | Where | Behaviour |
|---|---|---|
| Owner allowlist | `src/lib/ai/owner.ts` | `AI_OWNER_USER_IDS` = comma-separated Supabase **user UUIDs** (immutable id, not e-mail). **Fail closed:** unset/empty/only-garbage = nobody. `AI_ALLOW_ALL_AUTHENTICATED=1` is a local/test opt-in and is **ignored when `VERCEL_ENV=production`**. |
| Server-side enforcement | `authenticate()` in `src/lib/ai/gateway.ts` | The single entry of every AI and STT route. After the JWT is verified (`auth.getUser`), a non-owner gets **403 `ai_owner_only`** *before* any project read, quota reservation, Storage access or provider call. Anonymous/invalid token: 401. Client flags (`NEXT_PUBLIC_*`) never authorize. |
| Routes outside the firewalled prefix | `src/app/api/intelligence/{meetings/{transcribe,sync,analyze,purge,sweep},project-brief,chat,access}` | The five meeting routes and the brief were **moved** (same handlers). `chat` is a one-line re-export of the existing feature. `/api/ai/*` is unchanged and stays denied by the firewall (and is owner-gated too). |
| UX capability | `POST /api/intelligence/access` → `{aiOwner, stt}`; `meetingService.aiAccess()`; `NewMeetingForm` | The "Zvuk" option appears only when the server says this account is the owner and STT is on. Purely cosmetic; denial is server-side. |
| Error text | `ai_owner_only` in `errors.ts` / `clientErrors.ts` | "AI funkce jsou zatím dostupné jen vlastníkovi instalace." |
| Checks | `scripts/check-deployment.sh` (anonymous POST `/api/intelligence/*` → 401, GET → 405, legacy `/api/ai/*` → 403), `check-production-bundle.sh` (`AI_OWNER_USER_IDS` must not be in the bundle), `staged-intelligence-smoke.*` (accepts the owner-only message) | |

### Why not just open the firewall?
A blanket *deny `/api/ai`* cannot coexist with a browser calling `/api/ai/*`. Options:
1. **(chosen) New prefix, firewall unchanged.** The 17 legacy `/api/ai/*` routes stay denied at the edge. The owner routes are public URLs guarded by the verified-login + allowlist. Zero firewall change, trivial rollback (promote the previous deployment). Residual: anonymous/garbage requests reach the app (401, no provider cost); a valid non-owner JWT costs one Supabase `getUser` call.
2. Firewall exception for the 8 owner paths (`path starts with /api/ai AND NOT path in {…}` → deny) plus an `Authorization` header precondition. Needs a **separate approval of a firewall change**; the allowlist would still be the real control. Not needed now.
3. Remove the deny rule: rejected (weakens the protection for the 12 legacy features that are not owner-reviewed).

Consequence of 1: only Meeting Intelligence, the Project Brief and the Project Intelligence chat work for the owner. The other legacy AI features (daily brief, generate project/backlog/sprint, risk, capacity, voice, resource QA) keep answering "AI disabled".

## 2. Tests (all local, no provider credit)
* `vitest` 66 files / 1036 tests: owner allowlist (garbage entries never widen access, allow-all ignored on Vercel production), `authenticate()` gate, **every owner route + legacy chat refuse a non-owner before any DB/storage/provider access**, access endpoint, UI hides audio for non-owners.
* `frontend/scripts/owner-e2e.sh` (throwaway local Supabase + fake Gemini + fake Soniox; run twice, both green): **Run 1 owner-only mode** (`AI_OWNER_USER_IDS` set, no allow-all): `owner-access.spec` 8/8 (anonymous 401; a *real invited project member* who is not the owner → 403 `ai_owner_only` everywhere, no provider call, no ledger row; member UI: no audio option and the owner-only message; owner UI: audio option; cross-project: owner cannot analyze/transcribe/brief another user's project; owner analysis works with exactly one ledger row; legacy `/api/ai/chat` refused) + `meeting-flow.spec` 5/5 **as the owner** (audio+consent → Soniox transcript with 2 speakers → speaker names → Gemini structured analysis → evidence validation → accept/reject → task with human assignee+date → Project Intelligence). **Run 2 regression** (local allow-all): `meetings`, `project-intelligence`, `meeting-audio` 33/33 (audio validation, consent, STT state machine, retries, uncertain provider outcomes, no duplicate paid job, retention, deletion, key never in the bundle).
* `tsc`, `eslint` clean. SQL suites unchanged (no database change in this work).

## 3. Rollout (needs ONE explicit approval; every step below is separately gated and reversible)

Hard limits kept: no firewall change, no Cloudflare change, no key rotation, no public AI/audio.

| # | Step | Writes | Rollback |
|---|---|---|---|
| A | `CONFIRM_OWNER_ACTIVATION=1 frontend/scripts/owner-activation.sh` **in your terminal**: asks your account e-mail (resolves to the id, read-only), hidden prompt for the Soniox key (checked with the free `GET /v1/files?limit=1`, region `us`), generates `STT_SERVER_SECRET` in memory, registers **only its SHA-256** in `server_trust` (1 row), sets Production variables from stdin. | hosted DB: 1 row; Vercel Production env: `AI_OWNER_USER_IDS`, `SONIOX_API_KEY`, `STT_SERVER_SECRET` (Sensitive) + `STT_ENABLED=1`, `NEXT_PUBLIC_ENABLE_MEETING_AUDIO=1`, `SONIOX_REGION=us`, `SONIOX_MODEL=stt-async-v6`, `STT_DAILY_AUDIO_MIN_PER_USER=30`, `STT_DAILY_AUDIO_MIN_GLOBAL=30`, `STT_RETENTION_DAYS=3` | `… owner-activation.sh remove` (env); the hash is harmless alone. Env changes affect only NEW deployments, the live one is immutable. |
| B | Staged deployment of the exact commit (`vercel deploy --prod --skip-domain`, clean export, `--meta releaseCommit`) | nothing live | delete the staged deployment |
| C | Staged checks: `check-deployment.sh` (staged mode), `check-production-bundle.sh`, `hosted-verify.sh`, `staged-intelligence-smoke.sh` (disposable **non-owner** accounts: owner-only message, no audio panel, no provider call, accounts deleted afterwards) | disposable accounts, deleted | – |
| D | **Your first real use on the staged URL** (Vercel-protected; you log in as the owner): one real recording ≤ 2 min with consent → real Soniox → real Gemini analysis → approve a task → Project Intelligence. This is the real-provider validation (≈ $0.01–0.02). | 1 meeting in your own project | delete the meeting (audio, transcript, provider copy are removed) |
| E | Promote the staged deployment, production smoke (anonymous 401/403, legacy `/api/ai/*` 403, non-owner disposable account denied, bundle scan) | production = new deployment | `vercel promote dpl_Ff8CV7zK6sM3WcwezdmsgdFPGaRi` (instant) |
| F | Fast-forward `main` (separate step, only after E) | Git | revert commit |

**Initial budget:** 30 audio minutes/day total and per user (≈ $0.05/day at the S1 rate of ≈ $0.1/audio hour), Gemini: existing `AI_DAILY_TOKEN_BUDGET_PER_USER` + `AI_RATE_*` (B1: ~2–3k tokens per meeting analysis), audio kept 3 days then deleted, hard stops built in (ledger, per-user and global caps, no automatic retries of a paid POST, uncertain outcomes are never re-sent).

**Provider data and privacy (unchanged limits, state them before real use):** Soniox region `us` (content data stays in the US; EU/JP/IN need Console approval and a separate key). Soniox keeps async audio/transcripts up to 30 days unless deleted; ClearSpace deletes the transcription and file at the provider right after the transcript is stored (S1 verified: provider answered 404 afterwards) and retries pending cleanups. Soniox states no training on customer data. **DPA/subprocessor list were not verified** (Console → Security & compliance) and the legal basis for recording participants is the user's own declaration in the consent box, not a guarantee. Gemini receives the transcript text (not audio) for analysis. Use only recordings you may process.

## 4. Open risks / blockers
1. **Real Gemini quality is only PARTIAL** (B1: speaker-label-in-quote bug, fixed offline and unit-tested, never re-run with the real model). Step D is that re-validation; expect to review proposals by hand anyway (nothing is applied without approval).
2. **Speech quality is unproven on real speech** (see S1 findings in `CONTROLLED_RELEASE.md`); needs your real recording in step D.
3. Vercel default function limit: analysis calls measured 2.6–6.4 s with Gemini; if a real call exceeds the plan's default duration the page shows the retryable "AI neodpověděla včas" and nothing is billed twice (ledger idempotency). Raise `maxDuration` only if observed.
4. Anonymous/garbage traffic reaches the new owner routes (401). No provider cost; if abuse appears, add the path-specific firewall design (option 2) under its own approval.
5. Soniox DPA/region legal review, no exactly-once provider billing, no scheduler (cleanup runs when a project's meeting list is opened).
