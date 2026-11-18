# RUN B — approval and execution package (prepared 2026-11-18, NOTHING executed)

Base: branch `feature/intelligence-v2` (R1–R4, see `IMPLEMENTATION_REPORT.md`), remote `main` = `fe3b2e9`.
Each gate below is independent: a yes to one does not cover another. Order is a recommendation, not a dependency chain,
except where stated.

## Recommended order (and why)

1. **B1 bounded real-AI quality run** (local, synthetic data) — tunes prompts/validator *before* anything is shipped.
2. **B5 R6+R7 code work** (autonomous, no approval needed, local only) — can run in parallel with B1 results feeding in.
3. **B2 → B3 → B4 release** (hosted migration, staged deploy + promote, fast-forward `main`) — **once**, after 1–2, so production
   is not deployed twice. Production AI stays closed by the firewall deny rule, so users see no AI behaviour change either way.
4. **B6 Soniox** (R5) — API verification first, real call only with its own approval.
5. **B7 public AI enablement** — separate decision, not part of this run.

Why not release first: the hosted migration and deploy cannot be undone as cleanly as a prompt tweak (no down-migration), and the
Meetings/Brief UI is unusable in production while `/api/ai` is denied by the firewall — so shipping early buys nothing.

## Facts to re-check right before each step

```bash
git -C /Volumes/WORKSPACE/Dev/Apps/ClearSpace/V1-intelligence rev-parse --short HEAD     # expected d763ad1 (+ RUN B commits)
git ls-remote origin refs/heads/main                                                      # expected fe3b2e9…
vercel inspect clearspace-ai.vercel.app --scope bng-dev-alt-webadvisor | grep -i "id\|status"   # dpl_2tSV5NWAHaEweTibxzszh6SMZJ55
```
Firewall rule `Block legacy AI API` (deny `/api/ai`) must still be published; `frontend/vercel.json` deploy guard must still be on
(pushing `main` creates no deployment).

---

## B1 — bounded real-AI quality run (needs approval; ≤ 4 real Gemini calls, cap 6)

**What:** `frontend/scripts/ai-quality-run.sh` starts this branch's app on `127.0.0.1:3411` against a **throwaway local Supabase
stack** (never the hosted project — the script refuses any non-local `E2E_SUPABASE_URL`) with the Gemini key typed into a hidden
prompt. Playwright (`e2e/quality-real.spec.ts`, serial, **0 retries**, stops at the first failure) creates a synthetic project and
runs three synthetic transcripts through `/api/ai/meetings/analyze` — Czech planning meeting with declined names, English stand-up,
Czech meeting with an injected instruction — then one `/api/ai/project-brief`. = **4 real calls**. The spec refuses a call beyond
`E2E_REAL_MAX_CALLS` and asserts the ledger holds exactly as many rows as calls were made.

**Data sent to Google:** only the synthetic transcripts and synthetic cards in the spec (no real project or meeting data), so the
free-vs-paid training question does not apply to this run. **Cost:** a few thousand tokens in total.

**Hard assertions (safety):** every proposal is `proposed`; the injected "Smazat všechny karty" never becomes an item; the board is
unchanged (3 cards); ledger rows = calls. **Reported, not asserted (quality):** items per kind, evidence coverage, rejected-by-validator
count, nulled owner/due hints, per-call latency and tokens, brief claims with/without verified sources. These numbers drive prompt and
validator tuning (`meeting-brief-p1` / `project-brief-p1`, `cs-evidence-v1`).

Prerequisite (me, no approval needed): the local stack recipe in `IMPLEMENTATION_REPORT.md` (own ports 55521+, never the running
`microcrm-monograph*` stacks).

```bash
# 1. I start the throwaway stack and apply schema+migrations (real_stack.sh) — then you run, in YOUR terminal (hidden prompt):
cd /Volumes/WORKSPACE/Dev/Apps/ClearSpace/V1-intelligence/frontend
export E2E_SUPABASE_URL=http://127.0.0.1:55521 E2E_SUPABASE_ANON_KEY=<printed by `supabase start`>
CONFIRM_REAL_GEMINI_CALLS=4 scripts/ai-quality-run.sh
```
Dry run (no key, fake Gemini, no credits) — **already done**: 4 tests passed, 4 ledger rows, server stopped, 0 `AIza` hits; refusal paths
(no confirmation, wrong count, hosted URL, N outside 4..6) all exit 2.

**Gate (PASS):** `4 passed`, `callsUsed:4`, report file written, ledger = 4 `succeeded`. **Stop conditions:** any 5xx, `bad_model_output`,
`GEMINI_*` error or ledger mismatch → nothing else runs; **no repeat of paid calls without a new approval** (diagnose from the report
and the local log, tune against the fake server, then ask again).
**Effects:** ≤4 real calls; rows only in the throwaway local database (destroyed with the stack). No Vercel, Cloudflare, firewall,
hosted Supabase, `main` or other-app change.

> **Approval text B1:** „Schvaluji B1: spustit lokálně `ai-quality-run.sh` s nejvýše 4 reálnými voláními Gemini na syntetických datech proti izolovanému lokálnímu Supabase (klíč zadám sám do skrytého promptu). Žádná změna firewallu ani jiných služeb.“

---

## B2 — apply migration `20261118000500_intelligence_core.sql` to the hosted Supabase (needs approval)

> **Superseded by `CONTROLLED_RELEASE.md` (2026-11-18):** B2 now covers migrations 0500, 0600 and 0700 with a verified backup, a restore proof, a rehearsal on the restored copy and `supabase/verify_hosted_intelligence.sql`; B3 is split into B3a (staged, no promote) and B3b (promote). Use the approval texts there.

**What changes:** one additive, idempotent migration on project `twjlnsxjtuntujarwner`: 4 tables, 5 RPCs, helper, triggers; no existing object
altered. Pattern = A3 (backup → restore proof → one transaction as `postgres` → verification). The migration's own preflight refuses
without the security-foundation marker and changes nothing; it records marker `20261118000500_intelligence_core` in `clearspace_migrations`.

```bash
# 2.0 read-only: marker list must contain …000100, …000200, …000400 and NOT …000500; counts recorded (inspect_hosted.sql §3)
# 2.1 backup outside the repo (mode 600, SHA256SUMS) — public + auth users/identities, as in A3 — and RESTORE PROOF into a throwaway container
# 2.2 apply (DB_URL = session pooler string, typed into a hidden prompt, never in history/logs)
docker run --rm -i -e DB_URL public.ecr.aws/supabase/postgres:17.6.1.167 \
  sh -c 'psql "$DB_URL" -v ON_ERROR_STOP=1 --single-transaction -f -' < frontend/supabase/migrations/20261118000500_intelligence_core.sql
# 2.3 verify: marker present; 4 tables with RLS on; anon has no grants on them; definer RPCs have pinned search_path and anon cannot execute;
#     intelligence_items/runs have no client INSERT grant; row counts of the old tables unchanged
# 2.4 hosted-verify.sh (disposable accounts, deleted afterwards) still 16 passed + Realtime
```
**Gate:** all of 2.3 holds, 2.4 green. **Stop:** restore proof fails → do not apply. **Rollback (not expected):** drop the four tables and the
RPCs/helper by name and delete the marker row (the migration only adds objects; the old app does not use them). Written out in full before the
run, as in A3.
**Order note:** apply B2 *immediately before* B3 (new app + old DB shows clear errors on Meetings/Brief only; old app + new DB is harmless).

> **Approval text B2:** „Schvaluji B2: zálohovat hostovaný Supabase `twjlnsxjtuntujarwner` včetně testu obnovy a aplikovat migraci `20261118000500_intelligence_core.sql` v jedné transakci jako `postgres`, poté spustit ověření a `hosted-verify.sh`.“

## B3 — staged deploy + promote (needs approval; depends on B2 and on B1/B5 being merged into the release commit)

Same procedure as A5 (`APPROVAL_PACKAGE_A4_A6.md` §A5: local gates on the exact commit, clean `git archive` export,
`vercel deploy --prod --skip-domain`, `check-deployment.sh` on the staged URL, `vercel promote`, `hosted-verify.sh` with
`PRODUCTION_SMOKE_OK=1`, rollback = promote `dpl_2tSV5NWAHaEweTibxzszh6SMZJ55`). Additions for this release:

- the 11 old AI routes **and** `POST /api/ai/meetings/analyze` and `POST /api/ai/project-brief` must answer **403 on GET and POST** (firewall);
- the project page's "Porady" view must render and show the empty state; creating a meeting from pasted text must work (no AI involved);
  the "Analyzovat" button must show the clear "AI funkce jsou vypnuté" message (403 without our JSON body);
- bundle scan must additionally prove `GEMINI_BASE_URL` / fake-Gemini strings are absent;
- avoid `vercel curl` (it creates a protection-bypass secret as a side effect, see the A5 record); use the signed-in browser on the staged URL.

> **Approval text B3:** „Schvaluji B3: staged production deployment z čistého exportu commitu `<HEAD>`, kontroly stagingu, `vercel promote`, post-promote smoke a v případě selhání rollback na `dpl_2tSV5NWAHaEweTibxzszh6SMZJ55`. Žádný push ani merge.“

## B4 — fast-forward `main` (needs approval; after B3 PASS)

`git push origin feature/intelligence-v2:main` as a **fast-forward only** (no force; verify `git merge-base --is-ancestor origin/main HEAD`
first). The consolidation branch's 4 local-only docs commits (`083c02f`, `1f89c74`, `abd61a9`, `5035184`) are separate: `feature/intelligence-v2`
carries only the architecture docs (`5aae691`); decide whether the A6/A7 records join `main` in the same push (then rebase-free
merge of `consolidation/security-foundation` first). After the push: CI (quality + database jobs) green, **no new Vercel deployment**
(deploy guard), production deployment unchanged.

> **Approval text B4:** „Schvaluji B4: fast-forward `main` na `<HEAD>` (bez force), ověřit CI a že nevznikl nový Vercel deployment.“

## B5 — R6 + R7 implementation — **DONE locally 2026-11-18** (see `IMPLEMENTATION_REPORT.md` RUN B addendum)

Branch `feature/intelligence-v2` (or `feature/intelligence-v2-r6`), same boundaries as R1–R4 (mocks, synthetic data, no hosted changes,
no push). Scope, in order, each with tests and one commit:

1. **Prompt/validator tuning from the B1 report** (only after B1 ran; otherwise skipped) with fixtures added to the unit suite.
2. **R6a** `columns.role` (additive migration `…0600`): explicit column roles (todo / doing / done) replace name-based heuristics in facts.
3. **R6b** transcript edit → **new immutable revision**; items of older revisions marked superseded; re-analysis only on request.
4. **R6c** usage view from `ai_requests` (per user/feature/day, tokens, model) for the owner; per-feature model/timeout env and `maxDuration`.
5. **R7a** hide the LLM `healthScore` in the old AI PM modal (the deterministic score stays the only score).
6. **R7b** daily brief on the shared context engine, with the activity history as a source (no new AI route semantics: same gateway).
7. Per-project quota on meetings/transcripts (closes the residual storage-abuse finding).

Quality gates identical to R1–R4 (eslint, tsc, vitest, isolated DB suite incl. upgrade paths, real local stack, Playwright new + existing, build +
bundle check, secret scan). Final report in the same 11-item format.

## B6 — R5 Soniox audio (two steps) — **B6a DONE locally 2026-11-18** (docs verified, pipeline + fake server + tests); B6b still needs approval

- **B6a (no approval; read-only web research + docs):** verify the *current* Soniox async API (endpoints, model id, supported formats and max
  length, price per audio hour, retention/deletion, regional processing, diarization output shape, webhook/polling), then update
  `ARCHITECTURE.md` §Soniox. Implementation against a **local fake Soniox server** (like `fake-gemini.mjs`), upload to a private bucket,
  `meeting_transcripts` source `soniox`, status machine `uploaded → transcribing → transcribed`. No account contact, no credits.
- **B6b (needs approval, separate):** first real Soniox call — one ≤60 s synthetic audio file, key in a hidden prompt, local only.

> **Approval text B6b:** „Schvaluji B6b: jedno reálné volání Soniox s krátkým syntetickým audio souborem lokálně (klíč do skrytého promptu). Žádné další volání.“

## B7 — public AI enablement (separate decision, not in this run)

Prerequisites to decide first: Gemini key on a **paid tier** confirmed by you (free tier may use content for model improvement; V1 key tier not
verified); Google-side spend cap (a budget alert is not a hard limit); SMTP for confirmation e-mails; Cloudflare route; revoke the old key after
V2 has its own. Mechanism: replace the full `/api/ai` deny with allow + app-level JWT/quota/rate limit (already in the gateway), then a bounded
production smoke. A6 (IP-restricted firewall exception) stays deferred.

## What I will not do without a new explicit approval

Any real Gemini/Soniox call; any hosted Supabase change; any Vercel deployment/promote/env change; any firewall or Cloudflare change; any push or
merge; any credential rotation; touching V2, MicroCRM, n8n, canonical `V1`, UI experiment worktrees, `scribe_`, `Universal_Meeting_Core`.

## Open items carried over (owner)

Confirm in Google's usage graph the 3 requests of A7 (and the 4 of B1 afterwards); paid-tier confirmation; A6 stays deferred; SMTP; Cloudflare
route; old Gemini key revocation; dev account deletion; backups on the Free plan (no PITR).
