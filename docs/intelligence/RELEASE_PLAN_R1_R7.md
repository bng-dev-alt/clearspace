# ClearSpace Intelligence R1–R7: combined release plan

> **Superseding note (hardening run):** the trust model, P1 dispositions, test counts and external gates are in `HARDENING_RELEASE_CANDIDATE.md`; where this plan differs (STT write RPCs, retention, budgets, privacy), that document is current.


Status: **prepared 2026-11-18, nothing applied.** Branch `feature/intelligence-v2` (worktree `V1-intelligence`), base `origin/main` = `fe3b2e9`.
Every step below that touches hosted Supabase, Vercel, a firewall, a provider account or `main` needs the owner's explicit approval (gates B1–B7 in
`RUN_B_PACKAGE.md`). This document is the single reference for *what ships, in which order, with which settings, how it is verified, and how it is undone*.

## 1. What ships

| Run | Scope | Feature flag / gate | Production effect with the firewall as it is today |
|---|---|---|---|
| R1 | Project Context Engine, evidence validator, deterministic facts | none (internal) | none visible |
| R2 | `meetings`, transcripts, runs, items, approve/apply/undo RPCs | none | tables exist; UI shows "Porady" |
| R3 | Meeting Intelligence (text): paste / TXT / MD / SRT / VTT, evidence-validated proposals, human approval | AI routes closed by firewall | meetings can be created and read; **Analyze answers "AI vypnuta"** |
| R4 | Project Brief, knowledge from meetings, cited chat | AI routes closed by firewall | brief panel visible, generation answers "AI vypnuta" |
| R5 | Soniox audio transcription (consent, private bucket, async state machine, retention) | `STT_ENABLED` (server) **and** `NEXT_PUBLIC_ENABLE_MEETING_AUDIO` (build-time) **and** firewall | **invisible** (flag off by default) |
| R6 | Column roles, transcript revisions, evidence v2, Czech date/name help, freshness stamp, quotas, ledger-backed usage view, consistent AI errors | none | roles/revisions/quotas/usage are live (no AI needed) |
| R7 | Daily brief, AI PM, risk, capacity, improve, chat on the shared context engine; deterministic PM health | AI routes closed by firewall | none visible until AI is enabled |

## 2. Database migrations (order matters; all additive and idempotent)

| # | File | State on hosted `twjlnsxjtuntujarwner` | Contents |
|---|---|---|---|
| 1 | `20261117000100_security_foundation` | applied | RLS hardening, invitations, AI ledger + quota RPCs |
| 2 | `20261117000200_restore_project_board` | applied | atomic board restore |
| 3 | `20261117000300_least_privilege_table_grants` | applied | no TRUNCATE/TRIGGER/REFERENCES for `authenticated` |
| 4 | `20261117000400_task_resources_storage` | applied | private `task-resources` bucket |
| 5 | `20261118000500_intelligence_core` | **pending** | 4 tables, 5 RPCs, state-machine trigger |
| 6 | `20261118000600_intelligence_quality` | **pending** | `columns.role` (+ one-time backfill from names), transcript lineage, quotas, `project_intelligence_stamp` |
| 8 | `20261118000800_stt_stabilization_repair` | **pending, optional on a fresh database** | GENERATED (`supabase/tools/build_0800.sh`): verbatim re-assertion of 0500/0600/0700 + data repair. **Required only for an installation that already applied an EARLIER version of 0500-0700** (its tooling will not re-run them); idempotent and harmless otherwise |
| 7 | `20261118000700_meeting_audio` | **pending** | consent + audio + STT columns on `meetings`, private `meeting-audio` bucket + 3 policies, `server_trust` + server-secret-gated trusted STT RPCs, `stt_jobs` (per-attempt provider job + cleanup state), orphan-audio queue, `ai_requests` audio/cost/`billing_state` columns |

Rules for the hosted apply (same pattern as A3): fresh backup **and a restore proof into a throwaway container** first; apply each file as role `postgres`
in **one transaction** (`psql -v ON_ERROR_STOP=1 --single-transaction`); verify; stop on the first error. Each migration refuses (changes nothing) when its
predecessor's marker row in `clearspace_migrations` is missing. 5 → 6 → 7 can be applied in one maintenance window, one file at a time. **Hosted is at 0400, so it takes 5 → 6 → 7 and does not need 8.** Any other database that ever ran an earlier 0500-0700 (a local/dev database, a previous pilot) takes **only 8**: it drops the obsolete secret-less `stt_*` overloads that `CREATE OR REPLACE` leaves callable by any member, re-asserts every definition and repairs legacy rows. Scenario G of `supabase/tests/run.sh` proves old-state + 8 == fresh install (identical catalog snapshot) and that the old state really was exploitable.

Verification after each file (all must hold): marker row present; new tables have RLS on; `anon` has no grants on them; definer functions have a pinned
`search_path` and `anon` cannot execute them; row counts of the old tables unchanged; for 7 additionally `storage.buckets` row `meeting-audio` is private with
`file_size_limit = 52428800` and an audio-only MIME list, and `storage.objects` has the three `meeting_audio_*` policies.

PostgREST detail learned on the real stack: only some SQLSTATEs reach the client with their message. Quota errors therefore use PostgREST's custom code
**`PT429`** (HTTP 429 with the Czech message). State errors such as `55000` arrive as HTTP 500 with a generic body, so the server routes read `error.code`
from the RPC and never rely on the HTTP status.

### Rollback (tested only on throwaway databases)

`supabase/rollback/` holds `…000800_stt_stabilization_repair.down.sql` (removes only its marker; the repair adds no objects of its own and its data corrections are deliberately not reverted), then `…000700_meeting_audio.down.sql`, `…000600_intelligence_quality.down.sql`, `…000500_intelligence_core.down.sql`, in that order (not part of `supabase/migrations`, never auto-applied; each refuses while a later one is applied).
They **refuse while data would be lost** (consent/audio rows, `stt_jobs` provider job ids, queued orphan audio, STT ledger history, a registered `server_trust` hash, a non-empty `meeting-audio` bucket, explicit column roles, transcript edits) unless
`SET clearspace.force_rollback = 'on'`. Scenario F of `supabase/tests/run.sh` proves: refusal with data, clean removal without, no leftover object,
the 0500 suite still passes, and the migrations apply again. The bucket and its objects are removed through the **Storage API** on a real project.
A frontend rollback never needs a database rollback: old builds ignore the new tables and columns (verified by design; the old app never selects them).

## 3. Environment variables

| Variable | Where | Required for | Default / note |
|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Vercel Production+Preview | everything | already set (new project) |
| `GEMINI_API_KEY` | server, **Sensitive** | any AI feature | already set (dedicated V1 key); **paid tier must be confirmed before real meeting text is analysed** |
| `GEMINI_MODEL` | server | AI | `gemini-3.6-flash` |
| `AI_RATE_PER_USER_PER_MINUTE`, `AI_RATE_GLOBAL_PER_MINUTE`, `AI_DAILY_TOKEN_BUDGET_PER_USER` | server | AI limits | 10 / 60 / 200 000. A budget alert at Google is **not** a spending cap |
| `STT_ENABLED` | server | audio **transcription** | unset = off (`transcribe` and `sync` answer 503 `stt_disabled`). It does **not** switch off deleting audio: the browser deletes through Supabase directly and the `purge`/`sweep` routes work without it |
| `NEXT_PUBLIC_ENABLE_MEETING_AUDIO` | **build-time** | audio UI | unset = off; changing it needs a new deployment |
| `STT_SERVER_SECRET` | server, **Sensitive**, never `NEXT_PUBLIC_` | audio | none; >= 32 characters (generate with `openssl rand -hex 32`). **Owner step:** register only its SHA-256 in `server_trust` (compute it locally, see `HARDENING_RELEASE_CANDIDATE.md` §1); without it every trusted STT RPC refuses (fail closed) |
| `SONIOX_API_KEY` | server, **Sensitive**, never `NEXT_PUBLIC_` | audio | none; the bundle check fails the build if the name appears client-side |
| `SONIOX_MODEL` | server | audio | `stt-async-v6` (`v5` is deprecated, removed 2026-12-15) |
| `SONIOX_REGION` | server | audio | `us`; `eu`/`jp`/`in` need Console approval, their own project and key |
| `STT_DAILY_AUDIO_MIN_PER_USER`, `STT_DAILY_AUDIO_MIN_GLOBAL`, `STT_RETENTION_DAYS` | server | audio limits | 120 / 600 / 7 (1–30) |
| `GEMINI_BASE_URL`, `SONIOX_BASE_URL` | **tests only** | local fakes | **ignored when `NODE_ENV=production`**, so a key can never be sent elsewhere |

Never set in production: `NEXT_PUBLIC_FORCE_DEMO`, `GEMINI_BASE_URL`, `SONIOX_BASE_URL`.

## 4. Provider configuration

**Gemini.** One server model via `GEMINI_MODEL`; per-feature output caps and timeouts are in code. Real project or meeting text goes to Gemini only on a paid-tier
key (owner confirmation, release gate). Prompts are unvalidated against the real model until gate B1 has run.

**Soniox** (verified from the public docs on 2026-11-18, see `SONIOX_API_VERIFICATION.md`; **no account contact, no key, no call was made**).
Async API on `https://api.soniox.com/v1` (EU `api.eu.soniox.com`), `Authorization: Bearer`, model `stt-async-v6`, `audio_url` accepted, diarization and language ID bundled,
about US$0.10 per audio hour, Soniox keeps data 30 days unless deleted (we delete right after the transcript is stored; a failed deletion stays pending and is retried), no training on customer data, GDPR/SOC 2 listed (a DPA is **not** confirmed: external gate). No member, speaker, meeting or project name is sent to Soniox.
Open before the first real call: (a) does Soniox fetch a **Supabase signed URL** (query token) reliably, (b) per-minute rate limits, (c) DPA / subprocessor list and whether the EU
region should be used for production data, (d) `<end>`/`<fin>` markers in async output (the normaliser drops them defensively), (e) cost of the `context` object.
The account must be funded (no free credits for new accounts since 2025-10-27); a 402 is shown to users as "dočasně nedostupné", never as billing detail.

## 5. Storage policies

| Bucket | Path | Policies (all `authenticated`) | Limits |
|---|---|---|---|
| `task-resources` | `tasks/<card>/<file>` | select / insert / delete if member of the card's project | 10 MiB, document/image MIME list |
| `meeting-audio` | `<project>/<meeting>/<uuid>.<ext>` | select / delete if member; **insert additionally requires recorded consent** | 50 MiB, audio-only MIME list, private |

No UPDATE policies (files are immutable). `anon` has nothing. Reads use signed URLs (2 h for the Soniox fetch because the provider queue is not bounded).
Verified on a real Storage stack by `meeting_audio_real_stack.sh`: upload before consent refused, non-member cannot upload/read/sign/delete, wrong project path refused,
text/HTML and video MIME refused, tampered signed URL refused, Range request served (used for server-side content sniffing), "deleted" cannot be recorded while the object exists.

## 6. Auth and permission model

* Every route authenticates a Supabase JWT and builds a **per-request RLS client**; no service-role key exists in the app.
* Meetings, transcripts, runs, items: readable and writable by **project members** only (`is_project_member`); a project owner may delete any meeting, a creator their own.
* AI output enters only through SECURITY DEFINER RPCs that re-check membership and validate evidence; clients have **no** INSERT on runs/items and **cannot forge** a machine transcript
  (`source='soniox'` is accepted only inside `stt_complete`, enforced by a trigger and tested).
* Project changes by AI features need a human: items stay `proposed`; owner, assignee and due date are only ever set by a person; the due-date suggestion from text is prefill only.
* The three STT routes answer an identical **404** for a foreign or non-existent meeting and never touch the provider before the database reserved the job.
* Consent is stored on the meeting (who, when), is required by the Storage insert policy, by `attach_meeting_audio` and by `stt_reserve`.

## 7. Feature flags and kill switches

| Switch | Effect | Takes effect |
|---|---|---|
| Vercel firewall rule `Block legacy AI API` (deny `/api/ai`) | closes **every** AI and STT route (now 13 AI + 3 STT) | immediately |
| `STT_ENABLED` unset/0 | STT routes answer 503 | next deployment (env change) |
| `NEXT_PUBLIC_ENABLE_MEETING_AUDIO` unset | audio UI hidden | next **build** |
| remove `SONIOX_API_KEY` | STT answers "nedostupné" (503), no request leaves | next deployment |
| `AI_DAILY_TOKEN_BUDGET_PER_USER`, `STT_DAILY_AUDIO_MIN_*` | hard per-user / global caps in the database | next deployment |

## 8. Production firewall dependencies

* All new routes live under `/api/ai/**`: `meetings/analyze`, `project-brief`, `meetings/transcribe`, `meetings/sync`, `meetings/purge`. Today's deny rule keeps them at **403** (the UI recognises a 403 without our JSON body as "vypnuto").
* Enabling AI means replacing the deny with *allow + JWT + quota + rate limit* (B7). That decision also opens the STT routes **but they stay off until `STT_ENABLED=1`**.
* Soniox fetches the audio **from Supabase Storage** (outbound from Soniox), independent of the Vercel firewall. Cloudflare Access on the legacy origin is untouched.
* A6 (IP-restricted firewall exception) stays deferred; real-model quality is checked locally (B1) instead.

## 9. Deployment sequence (each step needs its gate)

1. **Local gates on the exact commit** (all green, see §10). 2. **B1** bounded real-AI quality run on synthetic data (≤4 calls) and prompt tuning, if wanted before release.
3. **B2** backup + restore proof → migrations 5, 6, 7 one at a time → catalog checks → `hosted-verify.sh`.
4. **B3** clean `git archive` export → `vercel deploy --prod --skip-domain` (flag **off**: do not set `NEXT_PUBLIC_ENABLE_MEETING_AUDIO`) → `check-deployment.sh` on the staged URL
   (all 16 AI/STT routes 403 on GET and POST; bundle scan incl. `SONIOX_*`, `api.soniox.com`, `fake-*`) → signed-in smoke (Porady empty state, paste a transcript, column role selector, usage page) → `vercel promote`.
5. **B4** fast-forward `main`; CI green; no new Vercel deployment (deploy guard).
6. Later, separately: **B7** AI enablement; **B6b** first real Soniox call (one ≤60 s synthetic file, local, key in a hidden prompt) → then Soniox account funding/region/DPA, `SONIOX_API_KEY` as Sensitive,
   `STT_ENABLED=1`, rebuild with `NEXT_PUBLIC_ENABLE_MEETING_AUDIO=1`, one supervised real meeting.
Avoid `vercel curl` (it creates a protection-bypass secret as a side effect); use the signed-in browser on the staged URL.

## 10. Validation (what was run for this branch, locally, all mocks/fakes)

| Gate | Command | Result 2026-11-18 |
|---|---|---|
| Types | `npx tsc --noEmit` | clean |
| Lint | `npx eslint src e2e` | clean |
| Unit/component | `npx vitest run` | **767 passed** (58 files; baseline before R1: 216) |
| Isolated DB | `PG_IMAGE=… supabase/tests/run.sh` | **all passed**: 986 SQL assertions (incl. rollback scenario F) + legacy upgrade + hosted-role scenario + concurrency (exactly-once persist/approve/start/complete) + rollback scenario F |
| Real local stack | `real_stack.sh` | passed (SQL suites on real GoTrue + 26 HTTP checks) |
| Real Storage | `meeting_audio_real_stack.sh` | passed |
| E2E demo mode | `npx playwright test` | 27 passed (59 real-stack specs skipped without env) |
| E2E real stack + fake Gemini/Soniox | `meetings`, `project-intelligence`, `r6-quality`, `meeting-audio`, `supabase-runtime` specs | all passed (runtime spec on a keyless instance, as designed) |
| Production build | `NEXT_PUBLIC_ENABLE_MEETING_AUDIO=1 npm run build` + `scripts/check-production-bundle.sh` | passes; no key/host/test-seam strings in the client bundle |
| Secret scan | grep of the branch diff | 0 findings; only `.env.example` is tracked |

Recipe for the real-stack runs: `IMPLEMENTATION_REPORT.md` (own ports 55521+, never the running microcrm stacks); for audio start the stack **without** excluding `storage-api`,
run `node e2e/support/fake-soniox.mjs 55591` and `fake-gemini.mjs 55590`, start the app with `STT_ENABLED=1 NEXT_PUBLIC_ENABLE_MEETING_AUDIO=1 SONIOX_API_KEY=fake-soniox-key SONIOX_BASE_URL=http://127.0.0.1:55591/v1`.

Not verifiable locally (stay open): real Gemini prompt quality (B1), Soniox reading a Supabase signed URL, hosted-project behaviour of the new policies, Vercel runtime env wiring, function duration limits on the real plan.

## 11. Recovery strategy

| Problem | Action |
|---|---|
| Bad frontend | `vercel promote dpl_2tSV5NWAHaEweTibxzszh6SMZJ55` (previous production build). Safe: the old build ignores the new tables; AI stays shut by the firewall |
| Bad migration | restore from the pre-migration dump into a scratch DB first; for 5–7 use the down scripts (data-guarded) or fix forward (all migrations are idempotent) |
| AI misbehaves / cost | firewall deny stays/returns; lower `AI_DAILY_TOKEN_BUDGET_PER_USER`; revoke the key at Google |
| Soniox misbehaves / cost | remove `SONIOX_API_KEY`, `STT_SERVER_SECRET` or `STT_ENABLED` (transcription stops; users can still delete audio; provider-side cleanup resumes when the configuration is back); stop at Soniox Console; per-user/global daily audio caps already bound spend; leftover provider data auto-deletes after 30 days or via Console |
| Orphan audio | the app deletes audio on "Smazat zvuk", when a project member opens the meetings pages after the deadline (`audio_delete_after`, set at upload, also for failed/cancelled meetings; **no scheduler**) and before a meeting is deleted; orphaned Storage objects are queued and swept; `stt_jobs.cleanup_state = 'pending'` marks provider data still to delete; manual purge route exists |
| Stuck / uncertain transcription | page shows "check again / cancel"; an uncertain POST outcome (`unknown`) is **never re-sent**: it is reconciled by listing the provider's jobs by `client_reference_id` (`<meeting>:<attempt>`) and the estimate stays in the budget; if nothing is found after 10 min with a complete listing it is released, otherwise the user explicitly ends it (cost stays booked). Attempts are cumulative per meeting (max 3) |

## 12. Approvals still required

B1 real-AI quality run · B2 hosted migrations 5–7 · B3 staged deploy + promote · B4 fast-forward `main` · B6b first real Soniox call · B7 public AI enablement · Gemini paid-tier confirmation ·
Soniox account, region, DPA, funding · Google spend cap · SMTP, Cloudflare route, old Gemini key revocation, dev-account deletion, Free-plan backup decision (carried over).
