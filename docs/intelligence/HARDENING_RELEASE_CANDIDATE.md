# Intelligence hardening and release candidate

Branch `feature/intelligence-v2`, starting HEAD `383cf20` (release review: CONDITIONAL PASS, no P0). This document records what the hardening run
changed, what each finding became, how it was verified, and what is still open. Nothing was pushed, deployed, applied to a hosted database or sent to a
real provider; no real Gemini or Soniox call was made; all runs used synthetic data, local fakes and throwaway local stacks.

## 1. Trust model after hardening

| Question | Answer |
|---|---|
| Who may write the STT ledger, provider job ids, the machine transcript or the budgets? | Only the **server**: every trusted RPC (`stt_reserve`, `stt_attach_job`, `stt_mark_unknown`, `stt_resolve_unknown`, `stt_fail`, `stt_complete`, `stt_cleanup_result`) takes `p_server_secret` and checks its SHA-256 against `server_trust` (`require_server_secret`) **in addition to** project membership. A member JWT alone is refused (`42501`, HTTP 403); the old secret-less signatures no longer exist (HTTP 404). |
| Where is the secret? | Plaintext only in the server environment (`STT_SERVER_SECRET`, >= 32 chars). The database stores only the hash. No service-role key is in the app. Without the secret every STT route answers 503 (fail closed). |
| Who picks the budgets? | The server (`STT_DAILY_AUDIO_MIN_*` env); the client never sends them. |
| Is local state exactly-once? | Yes, per attempt (row lock + unique attempt reference). |
| Is the provider's billing exactly-once? | **No.** Soniox has no idempotency key. The paid POST is never repeated automatically; an uncertain outcome is reconciled by listing the provider's jobs by `client_reference_id` and the estimate stays in the budget until it is resolved. |
| Is a deletion promised on a schedule? | **No.** There is no scheduler on the target hosting. Deletion happens when a project member opens the meetings pages (sweep) or manually. |
| Is audio on by default? | No: `STT_ENABLED` (server) and `NEXT_PUBLIC_ENABLE_MEETING_AUDIO` (build time) are both off; the production firewall also still blocks `/api/ai`. |

**Owner step (not done, needs approval).** Generate a secret, put it into the server environment as `STT_SERVER_SECRET`, and register only its hash. Compute the hash
**locally**, so the plaintext never reaches the SQL editor or its history:

```bash
S="$(openssl rand -hex 32)"            # keep it for the server environment (Vercel, Sensitive); do not paste it anywhere else
printf %s "$S" | shasum -a 256 | cut -d' ' -f1   # prints the 64-hex hash
```
```sql
INSERT INTO public.server_trust (purpose, secret_sha256) VALUES ('stt', '<the 64-hex hash>')
ON CONFLICT (purpose) DO UPDATE SET secret_sha256 = EXCLUDED.secret_sha256;   -- SQL editor, as the project owner
```
Rotating = a new secret + the same statement. The secret is only length-checked (>= 32 chars); `openssl rand -hex 32` gives 256 bits. Until the hash is registered every trusted STT function refuses.

## 2. P1 register: disposition of each finding

Status words: **FIXED** = changed and covered by a test that fails without the change; **REDUCED** = the promise was reduced to what is true; **BLOCKED** = needs an external decision.

| # | Finding | Disposition | What changed | Verification |
|---|---|---|---|---|
| P1-1 | Forged `<<<END DATA:PROJECT>>>` via FACTS (member names, card ids) | **FIXED** (`07a6fab`) | FACTS strings pass `sanitizeDeep`/`sanitizeUntrusted` and are length-capped; one closing marker only | `context.test.ts`, `intelligenceFacts.test.ts`: forged names/ids leave exactly one closing marker (probe reproduced, then closed) |
| P1-2 | Citation could "verify" the opposite meaning (`budeme` inside `nebudeme`) | **FIXED** (`07a6fab` + SQL) | Whole-word, in-order matching (JS `evidence.ts`, SQL `fold_text`/`quote_in_text` with parity test); `negation_nearby` flag keeps the item `unverified`; UI label is **"Citace nalezena"** (not "Ověřeno"), brief claims use `sourced` | `evidence.test.ts` (CZ/EN adversarial: word boundary, order, negation), `meetingsUi.test.tsx`, DB `83_intelligence_hardening` (parity), original probe now returns false |
| P1-3 | Docs claimed members cannot forge machine transcripts / budgets are hard | **FIXED + docs corrected** | Became true through P1-5; `IMPLEMENTATION_REPORT`/`RELEASE_PLAN` rewritten to the trust model above | DB `82_meeting_audio` (member calls refused), real-stack probes, Playwright `AUDIT PROBES` |
| P1-4 | Re-analysis silently superseded **accepted** conclusions | **FIXED** | `persist_meeting_run` keeps `accepted`/applied items; only unreviewed proposals are superseded; accepted items from an earlier run show an "earlier run" badge; re-analysis copy says exactly this | DB `80`/`83` (accepted survives re-analysis), concurrency scenario (accept while re-analysing never loses the item), `meetingsUi.test.tsx` |
| P1-5 | Write `stt_*` RPCs callable by any member; limits were caller parameters | **FIXED** | `server_trust` + `require_server_secret` in every trusted RPC; budgets chosen by the server; legitimate member workflows (upload, consent, attach, read, delete) unchanged | DB `82` (forged secret, member direct calls, stranger), real stack `meeting_audio_real_stack.sh` (11 `PROBE` checks over real PostgREST), Playwright `AUDIT PROBES`, `routes.test.ts` (fail closed without secret; secret never from the request) |
| P1-6 | Cancel/failure zeroed the ledger; replacing the file reset the attempt counter | **FIXED** | Ledger `billing_state` (reserved/uncertain/estimated/actual/not_billed) counted in daily budgets unless `not_billed`; cancel books the estimate; attempts are cumulative per meeting (3); replacing the file never resets them | DB `82` (cancel keeps cost, budget still exceeded, 4th attempt refused after file replacement), real stack ledger check, Playwright "cancel keeps the cost" |
| P1-7 | Double billing / orphan job after a timeout or crash around the paid POST | **FIXED locally; provider side not exactly-once (documented)** | New `unknown` state; POST never auto-repeated; reconciliation by `client_reference_id` listing (<= 10 pages); `absent` only if the listing was complete and > 10 min old; explicit user "abandon" keeps the estimate | `pipeline.test.ts` (lost response, 5xx, timeout, attach failure -> exactly one POST; adopt, absent, incomplete listing, listing error), DB `82`, concurrency, Playwright "UNCERTAIN provider answer" (one paid request in the fake's log) |
| P1-8 | Lost handle for provider-side cleanup | **FIXED** | `stt_jobs` row per attempt keeps `provider_job_id` and an own `cleanup_state` (pending/done/abandoned, attempts, last error, due time); survives meeting/project deletion; retried on sync and sweep, also for failed/cancelled meetings | DB `82` (ids never forgotten, survive deleted meeting), `pipeline.test.ts` (retry/done, still-running -> retry), Playwright cancel flow |
| P1-9 | Retention text did not match behaviour | **REDUCED + fixed where possible** | `audio_delete_after` is set at **upload** (so failed/cancelled/abandoned meetings also have a deadline); deletion on open/sweep or manually; texts say exactly that; Storage and Soniox deletions are independent and retryable; no cron claimed | DB `82` (failed meeting has a deadline), `pipeline.test.ts` (purge independence, retention for failed/none), Playwright retention + cancel; **BLOCKED** for a guaranteed schedule (section 5) |
| P1-10 | Member names to Soniox; consent checkbox read as legal compliance; US default region | **FIXED in code; legal parts BLOCKED** | Provider context is only `{general:[{key:'domain',value:'Project meeting'}]}` (no member/speaker/meeting/project names); consent text now says it is the user's own statement and does not itself satisfy legal duties; audio stays off by default | `pipeline.test.ts` PRIVACY test, Playwright (no `Honza`/title/project in the provider request), UI text; DPA/region/subprocessors/consent basis stay **BLOCKED** |

## 3. P2 items

| Item | Disposition |
|---|---|
| Client-forged `quoteFound`/quote text in `persist_meeting_run` | **FIXED**: the database recomputes support and flags from the stored transcript (`validate_intelligence_item`); forged "linked" items are stored as `unverified` or refused; per-item catch narrowed to the one expected SQLSTATE so real errors abort (DB `83`) |
| Project brief marked a claim `linked` with only one real ref | **FIXED** (`07a6fab`): brief-only status `sourced`, never "verified" |
| Chat accepts forged `assistant` turns | **FIXED**: earlier turns are sent as framed untrusted `HISTORY` data inside the user message, never as model roles (`aiGateway.test.ts`; fails on the old builder) |
| Precompute routes were not rate-limited | **FIXED**: they take the per-minute slot and leave a 0-token ledger row (`r7Context.test.ts`, E2E `r6-quality`) |
| `loadBoard` failed when 0600 was not applied | **FIXED**: tolerant select (context already tolerated a missing `intelligence_items`) |
| Re-applying 0600 after 0700 overwrote shared functions | **FIXED**: single definition of `intelligence_limits()` and `validate_transcript_lineage()` (in 0600); catalog snapshot after reverse/mixed re-apply is identical (scenario F) |
| Backfilled column roles made 0600.down always refuse; 0700.down deleted ledger rows unguarded; rollback checks weaker than documented | **FIXED**: guards added, `rollback.sh` compares the full catalog; 0500 now has its own down script |
| Orphan Storage objects after direct meeting delete / cascade | **FIXED**: `BEFORE DELETE` trigger queues orphan paths; members can delete orphan objects; sweep removes them; per-meeting object cap 4 |
| Placeholder AI routes (`generate_sprint`, `generate_backlog`, `voice_action`, `analyze_resource`) put data unframed in the user message | **NOT CHANGED** (output reaches the board only after a click; same behaviour as before this branch) |
| Content sniff reads only 32 bytes; extension/content match checked only in the client | **NOT CHANGED** (the server sniffs before any cost; accepted residual) |
| Missing tests listed by the review | **ADDED** (forged FACTS frame, negation, supersede of accepted, crash between POST and attach, cancel-and-retry, direct member `stt_*` calls) |

## 4. Migrations and rollback

Migrations `20261118000500`, `…0600`, `…0700` were **not applied anywhere** (hosted still at 0400), so they were corrected in place instead of adding a 0800;
file names and order are unchanged. Hosted apply is still gated by the release plan (backup + restore proof, one file at a time).

* `0500`: `fold_text`/`quote_in_text`, DB-recomputed evidence in `validate_intelligence_item`, accepted items survive re-analysis, guard trigger, delete policy, conditional grants.
* `0600`: single definitions of shared limit/lineage functions, role source, user quota lock.
* `0700`: `server_trust`, `require_server_secret`, `stt_jobs`, orphan queue + trigger, new trusted RPC signatures, `billing_state` ledger, server-chosen budgets.
* Rollback scripts: `supabase/rollback/{0500,0600,0700}.down.sql`; they refuse while data would be lost (consent/audio rows, non-empty bucket, explicit roles, transcript edits, STT ledger rows, `stt_jobs`) unless `SET clearspace.force_rollback = 'on'`.

**Data-loss considerations:** the 0700 down removes `stt_jobs` (provider job ids and their pending-deletion state) and the orphan queue; run the provider cleanup first
(`stt_cleanup_pending` must be empty) and empty the `meeting-audio` bucket through the Storage API. A frontend rollback never needs a database rollback (old builds ignore the new tables).

## 5. External gates (BLOCKED: not verified, not guessed)

1. **Soniox DPA, subprocessor list, region.** Default region is US; EU needs approval in the Soniox Console and a separate project/key. Not verifiable from here.
2. **Legal basis for recording participants** (consent, notice, retention period) is the owner's/counsel's decision; the checkbox is only a record of the member's statement.
3. **Soniox fetching a Supabase signed URL** (query token) with the real API, real rate limits, cost of billing for `context`: only a real call can show this (the contract was verified from public docs and a fake).
4. **Scheduled deletion.** A guaranteed schedule needs a privileged scheduler (Vercel Cron / GitHub Actions / `pg_cron`) holding a credential. **Not enabled.** Until then, retention is best-effort on page open.
5. **Hosted behaviour** of the new policies, definer functions and Storage bucket; **Vercel env wiring** (`STT_SERVER_SECRET`, flags); function duration limits.
6. **Gemini on a paid tier** and real-model prompt quality (gate B1).

## 6. Verification (all local; numbers are from the FINAL stabilization run unless marked)

| Check | Command | Result |
|---|---|---|
| Types | `npx tsc --noEmit -p .` (in `frontend/`) | 0 errors |
| Lint | `npx eslint .` | 0 errors; 2 warnings in untouched `supabase/tests/http_regression.mjs` and `realtime_check.mjs` (pre-existing) |
| Unit/integration | `npx vitest run` (sandbox off: tests bind local ports) | 61 files, **976 passed** |
| Database | `PG_IMAGE=public.ecr.aws/supabase/postgres:17.6.1.167 supabase/tests/run.sh` | **1533 SQL assertions passed**: scenarios A (fresh), B (legacy upgrade), C (preflight), D (drift/ownership), E (hosted non-superuser role), F (rollback + order independence), **G (upgrade from the pre-stabilization state, 0800 repair)**, concurrency; includes the check that `0800` is in sync with 0500/0600/0700 |
| Real Supabase stack (throwaway, ports 55521+) | `real_stack.sh`, `storage_real_stack.sh`, `meeting_audio_real_stack.sh` | all passed (audio script: 69 checks, incl. the secret-less / forged-secret / old-signature probes and the cancel/unknown/abandon window checks over real PostgREST) |
| Playwright, real stack + fake Gemini + fake Soniox | `meetings`, `project-intelligence`, `r6-quality`, `meeting-audio` specs | **40 passed** (audio spec: 18) |
| Playwright, keyless runtime | `supabase-runtime.spec.ts` | 5 passed |
| Playwright, demo mode | `npx playwright test` | 27 passed, 68 real-stack specs skipped without env |
| Build + bundle | `NEXT_PUBLIC_ENABLE_MEETING_AUDIO=1 npm run build`, `scripts/check-production-bundle.sh` | passes; also scans for `STT_SERVER_SECRET`/`p_server_secret` |
| Secret scan | grep of the branch diff and untracked files for key patterns | 0 findings |

Original failure probes re-run against the final code (before -> after): F2 (200 + unreadable body) `stt_fail(none)` + retry allowed -> `stt_mark_unknown`, one POST; F3 (cancel while submitting, retry) attempt 2 started and its job id lost -> state `unknown`, retry `unknown_outcome`, abandon `too_early`, late id attaches to its own attempt; F1 old secret-less `stt_reserve` with member budgets `started` -> function does not exist (404); G1 forged `source='soniox'` with a self-set session flag allowed -> refused (42501); A1-A3 "není", "nejde", question/answer, ellipsis over "ale ne" accepted unflagged -> flagged or unsupported (control quote stays clean).

Not run in this pass: `hosted_fidelity.sh` standalone (its scenarios D/E run inside `run.sh`).
A pre-existing flake in the real-stack scripts was fixed earlier: the "tampered signed URL" check changed the last base64 character, which can carry unused padding bits; it now changes a middle character.

## 6b. Final stabilization (review of `3c25e9c`)

The independent review of `3c25e9c` reproduced further release findings. They are fixed in the commits after `3c25e9c`; the migrations 0500-0700 were edited in place
(still unapplied on hosted) and the forward-only repair **`20261118000800_stt_stabilization_repair`** was added for installations that already ran an earlier version.

| Finding | Disposition | What changed | Regression evidence |
|---|---|---|---|
| **F1** obsolete secret-less `stt_*` overloads survive an upgrade | **FIXED** | 0700 drops the five pre-hardening signatures and the previous hardened ones explicitly; 0800 re-asserts everything on an old install; test: every `public.stt_*` function takes `p_server_secret` first | Scenario G (old state really exploitable -> after 0800 the catalog equals a fresh install; second path "old state + re-applied 0500-0700" converges too); `84_stt_stabilization`; real-stack probes (old signatures answer 404); Playwright AUDIT PROBES |
| **F2** a 2xx answer with an unreadable body was booked "not billed" | **FIXED** | `definitelyNotCreated` is true only for a genuine 4xx rejection; 2xx/5xx/no status = uncertain -> `unknown`, estimate stays booked | `pipeline.test.ts` (unit + the mock-provider mode `create_200_bad_body`), Playwright (job exists, exactly one paid POST, adopted by reconciliation) |
| **F3** cancel during `submitting` + retry = two paid jobs and a lost job id | **FIXED** | cancel of a submitting attempt moves it to `unknown` (also enforced inside `stt_fail`); `stt_reserve` refuses while unknown; abandoning is refused inside the submission window (`too_early`); every job id is bound to its ORIGINAL attempt (`stt_attach_job`/`stt_fail`/`stt_mark_unknown` take `p_attempt`; reconciliation reads the attempt from `client_reference_id`); a late id for an older attempt is kept for deletion and never touches the live attempt | SQL `82` + `84` (late attach, stale calls, window), `pipeline.test.ts`, Playwright "cancelling while the POST is in flight" |
| **A1-A3** porous negation guard | **FIXED (best effort, lexical)** | Czech/English negation lexicon with explicit exclusions, clause-aware windows before/after every occurrence, questions flagged, ellipsis gaps bounded and scanned | `evidence.negation.test.ts` (>60 positive, >20 negative lexicon cases, Q/A across segments, ellipsis); the label stays "Citace nalezena": **lexical matching is not semantic entailment** |
| **B1** approved knowledge could drop out of the 200-item pool | **FIXED** | approved (accepted/applied) items have their own query and limit; proposals are a separate bounded pool | `knowledgePool.test.ts` (250 newer proposals + older accepted decisions) |
| **C1** deleting audio depended on STT flags / the `/api/ai` firewall | **FIXED** | deletion runs in the browser directly against Supabase (Storage + `mark_audio_deleted`); `purge`/`sweep` routes no longer need `STT_ENABLED`, the secret or the provider key; provider-side cleanup is a separate, retryable job state | `audioCleanup.test.ts`, `routes.test.ts`, Playwright (deletes with `/api/ai` answering 403; failed meeting past its deadline is deleted on open) |
| **C2** project deletion left audio and provider data unreachable | **FIXED for audio; provider data honestly limited** | `deleteProject` first removes every audio object of the project (and aborts the deletion if that fails); provider jobs that could not be deleted before the project went away are removed by Soniox itself within 30 days (stated in the delete warning) | Playwright (Storage failure keeps the project; success removes audio first), `audioService.test.ts` |
| G1 `app.stt_persist` was client-settable | **FIXED** | provenance is a token row for the current transaction id in `machine_persist_tokens` (no member grants) written only by `stt_complete` | `84` (forged `source='soniox'` insert refused even with the old flag set), real-stack probe |
| Unattached uploads had no deadline | **FIXED** | `list_project_audio` + sweep remove never-attached uploads after a 24 h grace period; deadline for audio is set at upload | `84`, `audioCleanup.test.ts` |
| Docs/wording | **FIXED** | consent label is the member's statement, retention text names the deadline and the absence of a scheduler, `0700.down` really enforces the `server_trust` guard and the order guard for 0800, secret registration steps, `earlier-run` badge test | `audioUi.test.tsx`, `meetingsUi.test.tsx`, rollback scenario F |

What is still **not** guaranteed: Soniox has no idempotency key, so provider billing is not exactly-once (an uncertain POST is reconciled, never repeated, and its estimate stays booked);
provider data of a deleted project depends on Soniox's own 30-day deletion; there is no scheduler, so retention happens when a project member opens the meetings pages.

## 7. Recovery notes

| Situation | Action |
|---|---|
| STT misbehaves / costs | unset `STT_ENABLED` or `STT_SERVER_SECRET` (all routes fail closed); rotate by registering a new hash |
| Meeting stuck in `unknown` | page offers "Ukončit (cena zůstane započtena)"; the estimate stays in the budget, the provider job (if any) is deleted by cleanup when found |
| Provider data not yet deleted | `stt_jobs.cleanup_state = 'pending'`; retried on every sync/sweep; Soniox auto-deletes after 30 days regardless |
| Orphan audio | queued in `meeting_audio_orphans`; removed by the next sweep or manually by any project member |
