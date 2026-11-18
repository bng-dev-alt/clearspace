# Controlled release of the Intelligence release candidate (B1–B4)

Release candidate: branch `feature/intelligence-v2`, the commit named as `<HEAD>` in each approval (the preflight below was taken at `6a41702`; later commits on the branch only add the release tooling and docs of this file). Goal: production runs the Intelligence code with **AI behind the
existing Vercel firewall and audio disabled**; public AI and Soniox audio stay separate future decisions. Every step that spends credits, changes hosted data, changes
production or moves `main` has its own approval text below; nothing here is executed without it.

## 0. Preflight (2026-11-18, read-only; every item matched the expectation)

| Item | Evidence | Result |
|---|---|---|
| Release candidate | HEAD `6a41702`, working tree clean, branch `feature/intelligence-v2` | OK |
| Remote `main` | `fe3b2e9` (GitHub `bng-dev-alt/clearspace`); `git merge-base --is-ancestor origin/main HEAD` true; the branch is 20 commits ahead, 0 behind: a **clean fast-forward** | OK |
| Deploy guard | `frontend/vercel.json` with `git.deploymentEnabled=false` is on `origin/main` and unchanged on the branch | OK |
| CI | `.github/workflows/ci.yml` runs on push to `main` and on PRs (quality + database); no deploy step | OK (one change: the database job now checks out the full history so scenario G really runs) |
| Production deployment | `dpl_2tSV5NWAHaEweTibxzszh6SMZJ55`, target production, Ready, created 2026-11-17 21:14 CET, still the newest `clearspace` deployment | OK |
| Live site (black box) | `GET /login` 200; `POST` and `GET /api/ai/chat` 403; `POST /api/dev/login` 404 | OK |
| Firewall | `vercel firewall rules list`: exactly one custom rule *Block legacy AI API*, Deny, Enabled (+ managed rules unchanged) | OK |
| Vercel env | names only: `AI_*` limits, `NEXT_PUBLIC_SUPABASE_*`, `GEMINI_API_KEY`, `GEMINI_MODEL`. **No** `STT_*`, `SONIOX_*`, `NEXT_PUBLIC_ENABLE_MEETING_AUDIO`, no dev/demo flags | OK |
| Hosted Supabase (`twjlnsxjtuntujarwner`) | `inspect_hosted.sql`, read-only session: **exactly four markers** (`…000100`, `…200`, `…300`, `…400`), 15 public tables all with RLS, 1 user / 1 profile / 1 project / 5 columns / 0 cards / 0 `ai_requests`, one bucket (`task-resources`, private, empty), no `meetings`/`intelligence_*`/`stt_*` objects (anon probes: 404 PGRST205) | **0400, as expected** |
| Migration 0800 | not needed: no earlier version of 0500-0700 was ever applied there (the repair is only for installations that ran one) | not applied |
| Other projects | only this worktree was written to; sibling worktrees (`V1`, `V1-consolidation`, experiments, `clearspace-v2`) were only read. Pre-existing local changes in `V1` (12), `V1-editorial` (1) and `clearspace-v2` (5) are not mine and were not touched | OK |

Findings to carry (none stops the release):
1. **A4b is DONE (correction of an earlier misreading).** The `created` column of `vercel env ls` (121 days) is the creation date of the variable entry, not of its value. The metadata
   read back read-only (`vercel env ls --format json`, no values) shows `GEMINI_API_KEY` and `GEMINI_MODEL` as type *sensitive*, targets production + preview, **updated 2026-11-17T20:13Z**, one minute before
   production deployment `dpl_2tSV5NWA…` was built, exactly as in the A4b execution record (`docs/APPROVAL_PACKAGE_A4_A6.md`). Not verifiable without reading the secret: that the key differs from V2's old key (asserted by the owner).
2. The local `main` ref of the `V1` worktree is stale (`ff615c3`); irrelevant, B4 pushes `feature/intelligence-v2:main` explicitly.
3. The B2 approval text in `RUN_B_PACKAGE.md` mentions only migration 0500; the texts below replace it.

## B1 — bounded real-Gemini quality run (needs approval; at most 4 real calls)

**Prepared.** `scripts/ai-quality-run.sh` + `e2e/quality-real.spec.ts` (3 synthetic meetings + 1 project brief = **4 calls**, hard cap by `E2E_REAL_MAX_CALLS`, serial,
no retries). This pass added **Czech and English negation probes** to the fixtures (no extra call): "Nebudeme nasazovat novou verzi v pátek", a question answered "Ne, to není možné",
"Nikdo z nás zatím nedokáže potvrdit termín", "We won't ship the PDF layout…, we can't promise the Friday date". The report now also lists, per meeting, the support counts, the number of
`negation_nearby`-flagged items and every decision/action item that is `linked` to a negated sentence. Dry run against the local fake Gemini: 4 tests passed, 4 ledger rows, 0 `AIza` hits.
Data: synthetic only. Supabase: a throwaway local stack with all migrations (never hosted). Audio flags are not set. The key goes into the environment of one local `next dev`
process through a hidden prompt and is never written to argv, a file or a log.

**What you do after approving** (I start the throwaway stack and apply the migrations first; then, in your own terminal):
```bash
cd /Volumes/WORKSPACE/Dev/Apps/ClearSpace/V1-intelligence/frontend
export E2E_SUPABASE_URL=http://127.0.0.1:55521 E2E_SUPABASE_ANON_KEY=<the local demo anon key printed by `supabase status`>
export PW_CHROMIUM_PATH=<installed chromium> QUALITY_REPORT=$HOME/clearspace-b1-report.json
CONFIRM_REAL_GEMINI_CALLS=4 scripts/ai-quality-run.sh        # prompts for the ClearSpace V1 Gemini key (hidden)
```
**Verdict rules** (decided before the run, applied mechanically to the report):
* **FAIL (stop):** any hard safety assertion fails (an item not `proposed`, a board change, an injected instruction becoming a proposal, ledger rows != calls), a 5xx, `bad_model_output` or `GEMINI_*` error.
* **PASS:** no FAIL condition; 4 ledger rows `succeeded` with tokens > 0; every item has evidence; `linkedDecisionsOrActionsOnNegatedSentences` empty for both Czech and English probes; the Czech planning meeting yields at least one decision, two action items, one risk and one open question; the brief is `succeeded`.
* **PARTIAL:** no FAIL condition but one of the PASS quality bars is missed. The specific limitation is written into the release record. **No paid call is repeated automatically**; tuning is done against the fake server and a repeat needs a new approval.

**B1 result (executed 2026-11-18, approved by the owner; 4 real calls, synthetic data, throwaway local stack; key entered at the hidden prompt, 0 `AIza` hits in the server log): PARTIAL.**

| Check | Result |
|---|---|
| Hard safety assertions | all passed (everything `proposed`, board untouched, the injected "Smazat všechny karty" never became a proposal, ledger rows = calls) |
| Structured output / HTTP | 4 x HTTP 200, no `bad_model_output`; model `gemini-3.6-flash`; latency 2.6–6.4 s |
| Ledger | 4 rows `succeeded`, tokens 1738 / 2123 / 2752 (meetings) and 1694 (brief) |
| English standup | 5 items (1 decision, 2 action items with owners Alice/Bob and due "today"/"by Friday", 1 risk, 1 blocker), all `linked`, 0 rejected |
| Czech injection meeting | 2 items (decision, action item owned by Jana Svobodová, due "do konce týdne"), all `linked`, 0 rejected |
| Negation | **no** decision or action item was `linked` to a negated or questioned sentence, in Czech or English ("Nebudeme nasazovat v pátek", "Ne, to není možné", "nedokáže potvrdit termín", "We won't ship…, can't promise…"): the model did not restate them affirmatively. The `negation_nearby` flag path itself was therefore not exercised by real output (covered by the unit tests) |
| Brief | `succeeded`, 0 rejected |
| **Missed bar: Czech planning meeting** | only 3 items (follow-up, risk, open question), **no decision and no action item**; `rejectedCount` 3 |

**Specific limitation (diagnosed offline from the stored synthetic run, no further paid call):** in the Czech planning meeting Gemini copied the **speaker label into the quote** ("Jana Svobodová: Riziko je, že …"). The validator compares the quote with the segment text, which does not contain the label, so `quoteFound` was false:
the three decision/action items (release moved to 27 Nov, migration for Honza by 25 Nov, Petr contacting the supplier) were rejected (they require a found quote) and the three kept items stayed `unverified`. Replayed through the validator, the same quotes with the leading
"Name:" removed are all found. The English and injection meetings were not affected (the model quoted without the label). Nothing unsafe happened: the failure mode is lost items and weaker labels, not a wrong claim.
**Fixed afterwards, without any further paid call** (`stripSpeakerPrefix` in `evidence.ts`): the validator removes a leading "Name:" from a quote only when it is **exactly** the display name or label of **that segment's own speaker** (the name the model saw), followed by one colon; foreign names, "SYSTEM:", other text, other case or punctuation are left alone,
and the remainder must still pass the full check (words, order, negation, question). The stored quote is the literal segment text. Replay of the three stored B1 quotes: before the fix all `quoteFound` false, after it all true (follow-up and risk `linked`; the open question stays `unverified` because "Nevíme zatím" trips the negation guard, conservatively); the rejected decision/action quotes were not persisted and are reconstructed from the same fixture in the regression test
(`evidence.speakerPrefix.test.ts`, 15 tests incl. negation, question, word order, fabricated, false attribution and injection-label protections). A new paid run was **not** done; the B1 verdict stays PARTIAL until the owner decides to repeat it.

> **Approval text B1:** „Schvaluji B1: spustit lokálně `ai-quality-run.sh` s nejvýše 4 reálnými voláními Gemini na syntetických datech proti izolovanému lokálnímu Supabase (klíč zadám sám do skrytého promptu). Žádná změna firewallu, Vercelu ani jiných služeb.“

## B2 — hosted migrations 0500, 0600, 0700 (needs approval)

**Prepared and verified without touching hosted data.**
* **Backup:** `/Volumes/WORKSPACE/_G2_BACKUP/20261118-v1-pre-intelligence-migration/clearspace-pre-intelligence.dump` (custom format, `public` + `auth`, mode 600, outside the repo),
  SHA-256 `e4d584ba96f7b099aeb903d102b339d0c7c65c24acc3e6d65984c64ff95e86aa`, 42 table-data entries, listed with `pg_restore --list`. Storage has no objects to copy.
* **Restore proof (isolated container):** the dump was restored into a clean database; counts are identical to hosted (profiles 1, projects 1, columns 5, workspace_members 1, auth.users 1, cards 0,
  ai_requests 0, markers 4; 15 tables, all with RLS, 25 policies). Note: the hosted server (17.12) writes `ALTER COLUMN … SET (pg_attver=…)` options that the cached 17.6 image does not know; they were filtered
  from the text restore (they are Supabase-internal column options). A restore onto a real project must use the same server version.
* **Rehearsal on the restored copy, as role `postgres`:** 0500, 0600, 0700 each applied in one transaction, re-applied (idempotent) without error, then the verification below passed.
* **Verification script:** `frontend/supabase/verify_hosted_intelligence.sql` (read-only session, metadata and counts only; every `GATE` line must say `PASS`).
* **Exact plan** (database password read from the macOS Keychain inside the command, never printed; same pattern as A3):
```bash
cd /Volumes/WORKSPACE/Dev/Apps/ClearSpace/V1-intelligence
DB="host=aws-0-eu-west-1.pooler.supabase.com port=5432 user=postgres.twjlnsxjtuntujarwner dbname=postgres sslmode=require"; IMG=public.ecr.aws/supabase/postgres:17.6.1.147
export PGPASSWORD="$(security find-generic-password -s 'ClearSpace V1 – Supabase Database' -a 'postgres.twjlnsxjtuntujarwner' -w)"
git status --short; git rev-parse --short HEAD                                    # clean, = the release commit
# 2.0 re-check right before (read-only): exactly the 4 markers, counts as in §0
docker run --rm -e PGPASSWORD -v "$PWD/frontend/supabase:/w:ro" $IMG psql "$DB" -X -f /w/inspect_hosted.sql | grep -A8 "== 15\."
# 2.1 apply, one file at a time, each in ONE transaction (a failing statement changes nothing); stop at the first error
for m in 20261118000500_intelligence_core 20261118000600_intelligence_quality 20261118000700_meeting_audio; do
  docker run --rm -i -e PGPASSWORD -v "$PWD/frontend/supabase:/w:ro" $IMG psql "$DB" -X -v ON_ERROR_STOP=1 -q --single-transaction -f /w/migrations/$m.sql || { echo "STOP at $m"; break; }
done
# 2.2 verify (read-only): every GATE must say PASS
docker run --rm -e PGPASSWORD -v "$PWD/frontend/supabase:/w:ro" $IMG psql "$DB" -X -f /w/verify_hosted_intelligence.sql
unset PGPASSWORD
# 2.3 application smoke against the hosted database with the OLD production build still live: hosted-verify.sh (disposable accounts, deleted afterwards)
```
* **Exact final command** (a guarded wrapper of the steps above; **run only after the written B2 approval**):
```bash
cd /Volumes/WORKSPACE/Dev/Apps/ClearSpace/V1-intelligence
CONFIRM_B2_HOSTED_MIGRATIONS=twjlnsxjtuntujarwner frontend/scripts/apply-b2-hosted.sh
```
  The script refuses (before any hosted write) unless: the confirmation names the project; the working tree is clean; the backup matches its SHA256SUMS; the three migrations (`14cde02e…adb8b`, `ebe53cfa…79b2`, `c0777a18…d7cf`) and the verification script (`4d0d85a1…fd65`) have the rehearsed checksums;
  hosted holds exactly the four markers 0100-0400 and none of the new objects. It then applies the three files one by one (one transaction each, stop at the first failure and print the rollback), runs `verify_hosted_intelligence.sql` and exits non-zero if any `GATE` is not `PASS`.
  It never applies 0800, never registers an STT secret and touches nothing outside the database. Afterwards, separately: `hosted-verify.sh` against the still-live old build.
* **Order note:** the new migrations are additive. Old app + new database is harmless (the old build never selects the new objects); new app + old database shows clear errors on Meetings/Brief only.
  Therefore B2 may run **before** B3 and stays safe if B3 is delayed.
* **Gate:** every `GATE` line PASS; `hosted-verify.sh` green (16 passed + Realtime); old-table counts unchanged.
* **Stop conditions:** a changed marker list or counts at step 2.0; any error in 2.1 (nothing was changed by the failing file; do not continue); any GATE not PASS.
* **Rollback strategy** (written before the run): the migrations only add objects and the new tables are empty at that moment, so the down scripts apply without data-loss guards:
  `frontend/supabase/rollback/20261118000700_meeting_audio.down.sql`, then `…000600…`, then `…000500…` (each as role `postgres`, one transaction, in that order). The `meeting-audio` bucket is removed
  through the Storage API (`DELETE /storage/v1/bucket/meeting-audio`; SQL deletes on Storage tables are blocked by Supabase). If the dump is ever needed, it restores `public` + `auth` as of the backup.
  A frontend rollback never needs a database rollback.
* **Not done in B2:** migration 0800 (not needed), registering `STT_SERVER_SECRET`'s hash, any Vercel change.

> **Approval text B2:** „Schvaluji B2: na hostovaném Supabase `twjlnsxjtuntujarwner` aplikovat migrace `20261118000500_intelligence_core.sql`, `20261118000600_intelligence_quality.sql` a `20261118000700_meeting_audio.sql` (postupně, každou v jedné transakci jako `postgres`, záloha `20261118-v1-pre-intelligence-migration` s ověřeným obnovením už existuje), poté spustit `verify_hosted_intelligence.sql` a `hosted-verify.sh`. Bez migrace 0800, bez registrace tajemství pro přepis, bez změny Vercelu.“

* **B2 RESULT — PASS (2026-11-18, owner approval received):** `apply-b2-hosted.sh` ran from HEAD `a00d257` (clean tree, backup and checksums verified, hosted held exactly markers 0100–0400 and none of the new objects).
  Applied, each in one transaction, in this order: `20261118000500_intelligence_core`, `20261118000600_intelligence_quality`, `20261118000700_meeting_audio` (all three succeeded, only "does not exist, skipping" notices from the idempotent DROP IF EXISTS).
  `verify_hosted_intelligence.sql`: all 10 GATEs PASS (re-run once more afterwards, identical); markers now 0100–0700; old-table counts unchanged (profiles=1 projects=1 columns=5 cards=0 workspace_members=1 invitations=0 ai_requests=0 users=1).
  `hosted-verify.sh` against the live OLD build (`https://clearspace-ai.vercel.app`, `PRODUCTION_SMOKE_OK=1`): Realtime 3/3 ok, Playwright 16/16 passed, the 3 disposable accounts deleted (200), leftovers = none (projects=1 as before).
  Not done: migration 0800, STT secret, any Vercel / Cloudflare / firewall / deployment / Git change. After the run: production is still `dpl_2tSV5NWAHaEweTibxzszh6SMZJ55`, live `POST /api/ai/chat` = 403, `origin/main` = `fe3b2e9`.
  Note: `hosted-verify.sh` needs a gitignored `frontend/.env.local` with only `NEXT_PUBLIC_SUPABASE_URL=https://twjlnsxjtuntujarwner.supabase.co` and the project's anon key (no Gemini key). `V1/frontend/.env.local` points at a different Supabase project (`bjycwq…`) and must not be reused.

## B3a — staged deployment (no promote; needs approval; after B2 gates passed)

Same procedure as A5 (`docs/APPROVAL_PACKAGE_A4_A6.md` §A5), with these specifics:
```bash
cd /Volumes/WORKSPACE/Dev/Apps/ClearSpace/V1-intelligence
# 3.0 local gates on the exact commit (all green): tsc, eslint, vitest, NEXT_PUBLIC_ENABLE_MEETING_AUDIO unset npm run build, scripts/check-production-bundle.sh, supabase/tests/run.sh, secret scan
# 3.1 clean export + staged deploy (NOT attached to the domain); audio flags and STT variables are not set
D=$(mktemp -d) && git archive HEAD | tar -x -C "$D" && cd "$D"
V=/Users/beng/.npm/_npx/67eb4586ca667318/node_modules/.bin/vercel
$V link --yes --project clearspace --scope bng-dev-alt-webadvisor && rm -f .env.local
$V deploy --prod --skip-domain --scope bng-dev-alt-webadvisor --meta releaseCommit=$(git -C /Volumes/WORKSPACE/Dev/Apps/ClearSpace/V1-intelligence rev-parse --short HEAD)
# 3.2 staged checks: MODE=vercel DEPLOYMENT=<staged-url> frontend/scripts/check-deployment.sh <staged-url>   (headers, 403 on every /api/ai route incl. /meetings/analyze and /project-brief on GET and POST,
#     /api/dev/login 404, bundle: new Supabase ref only, no dev-login / service_role / AIza / GEMINI_* / SONIOX_* / STT_SERVER_SECRET / fake-provider strings)
$V inspect <staged-url> --scope bng-dev-alt-webadvisor     # READY, target production, NO aliases; the live domain must still serve dpl_2tSV5NWA…
```
Browser checks on the staged URL (signed-in browser; `vercel curl` only if you allow it, it creates a protection-bypass secret as a side effect): login, project load, board, Porady page renders,
creating a meeting from pasted text works, "Analyzovat" shows the clear "AI vypnuta" message (403 without our JSON), project brief panel renders with the same message.
**Gate:** every item above; the hosted database from B2 behind it. **Fail:** nothing public changed; ignore or remove the staged deployment and fix on the branch.

> **Approval text B3a:** „Schvaluji B3a: staged production deployment (`vercel deploy --prod --skip-domain`) z čistého exportu commitu `<HEAD>` s `--meta releaseCommit`, kontroly stagingu (`check-deployment.sh`, `vercel inspect`, prohlížeč přihlášený k Vercelu). Bez promote, bez push, bez merge, bez změny firewallu.“

* **B3a RESULT — PARTIAL (2026-11-18): staged deployment is fine, but the smoke found a database defect that blocks B3b.**
  Staged deployment `dpl_GQL6xxm4SMAJHv1Q5XQ5PUNnKywb` (`clearspace-7yz64bf51-bng-dev-alt-webadvisor.vercel.app`, target production, READY, **no alias**, Vercel Authentication on, `releaseCommit=d0cef6a`); the live domain still serves `dpl_2tSV5NWAHaEweTibxzszh6SMZJ55`.
  Passed: local gates (tsc, eslint 0 errors, 991 tests, build, bundle check, secret scan); `check-deployment.sh` (59 ok, 0 FAIL: headers, all 17 AI/STT routes x GET and POST = 403, `/api/dev/login` 404, bundle = new ref only, no forbidden strings, JWT roles = anon); `hosted-verify.sh` against the staged URL (Realtime 3/3, Playwright 16/16);
  Intelligence smoke on the staged URL (login, board, Porady page, creating a meeting from pasted text, "Analyzovat" and the project brief both show "AI funkce jsou v této instalaci zatím vypnuté" after a firewall 403, audio panel absent, no AI run or ledger row, RLS: stranger sees no meetings, no direct INSERT into `intelligence_items`, `stt_*` RPCs not callable, anon refused).
  (The first `check-deployment.sh` run had 2 transient FAILs — one 302 and one 401 through the `vercel curl` bypass — both answered correctly on repeats and the full re-run was clean.)
  **DEFECT (migration 0500, applied to hosted):** `meetings.created_by` is `REFERENCES profiles(id) ON DELETE SET NULL`, but the `guard_meeting_identity` trigger raises 42501 on ANY change of `created_by`. Deleting a user who ever created a meeting therefore fails
  (GoTrue admin delete -> HTTP 500 "Database error deleting user"; reproduced in a rolled-back SQL transaction). Consequence: account erasure is impossible for anyone with a meeting. Other new tables (`meeting_transcripts`, `intelligence_runs`) have no such guard.
  Why the tests missed it: no SQL/E2E scenario deleted a user who owned a meeting. The same guard text is re-asserted in 0800.
  Test data of this run was removed (the test meeting by exact id, then the user): hosted is back to users=1, projects=1, meetings=0.
  **Proposed fix (NOT applied, needs its own approval):** a new migration that lets the guard accept `NEW.created_by IS NULL` when `OLD.created_by IS NOT NULL` (the FK action only), plus a SQL scenario "delete a user who created a meeting" and the same in the upgrade test; then rehearse on the restored backup copy before touching hosted.

## RECOVERY after the B3a finding (2026-11-18): H1 hotfix → H2 new staged deployment → B3b → B4 → S1 real Soniox test

The staged deployment `dpl_GQL6xxm4SMAJHv1Q5XQ5PUNnKywb` (commit `d0cef6a`) is **superseded**: it must not be promoted. Its frontend is functionally what production needs, but the final `HEAD` differs from it (a dormant, non-production Soniox test seam, tests, scripts), and the
rule is "what is promoted is what is pushed". H2 below creates a new protected staged deployment from the final commit; the old one is simply left unpromoted.

### H1 — hosted hotfix: migration `20261118000900_meeting_creator_erasure` (needs approval; the ONLY hosted write of this step)
* **Fix:** `guard_meeting_identity()` keeps refusing every change of `project_id`, `source_kind` and `created_by`, EXCEPT `created_by: <uuid> → NULL` while that profile no longer exists (= the state in which `ON DELETE SET NULL` runs). SECURITY DEFINER with a pinned `search_path`, no EXECUTE for PUBLIC/anon/authenticated
  (GoTrue's role cannot read `profiles`, which the existence check needs). Authenticated users additionally have no UPDATE privilege on `created_by` (column grant, tested over HTTP). 0800 is regenerated so it ends with the same guard (it can never reintroduce the defect, in any order).
  Trade-off: an operator with table-owner rights could still null `created_by` by deleting a profile first - which is exactly erasure.
* **Reproduced, then fixed:** SQL suite `85_delete_meeting_creator` fails on 0700 with the hosted error (`guard_meeting_identity()` 42501 from the FK update) and passes with 0900 (22 assertions: author, transcript, run, reviewed item and consent are nulled, content survives, the guard still refuses reassigning/moving/wiping, the owner still manages an orphaned meeting);
  scenario **H** (hosted 0700 state without 0800, files pinned by checksum): defect reproduced, 0900 alone → catalog identical to a fresh install, idempotent, refuses without 0700, suites 40/80–85 pass, rollback restores the exact 0700 catalog; scenario **G** (older state + 0800) extended; scenario **E** (hosted role `postgres`) runs 0900 and suite 85;
  real GoTrue over HTTP: user who created a meeting → `DELETE /auth/v1/admin/users/<id>` = 200 (before: 500), a deleted member's meeting stays with `created_by = null`, a user cannot PATCH `created_by`.
* **Evidence about THIS hosted project (read-only):** catalog snapshot of hosted vs the rehearsed 0700 state: identical except 11 Supabase-managed Storage triggers (`pg_get_functiondef` etc. normalised for the local `auth.uid()` shim) - md5 `2af129a4d386111d1456bba9d127fecf lines=2151` is pinned in the script;
  rehearsal on a **restore of a fresh dump of the real hosted data** (`/Volumes/WORKSPACE/_G2_BACKUP/20261118-v1-pre-hotfix-0900/`, SHA-256 `18df86dc…e6622`, `pg_dump -Fc -n public -n auth`, 50 table-data entries): deleting the author's profile fails before 0900 and succeeds after it (project and meeting cascade away, no error);
  restored `public` counts equal hosted (profiles 1, projects 1, columns 5, cards 0, workspace_members 1, 7 markers, meetings 0). Limit (same as B2): `auth.users` does not restore into the local image because its `auth` schema is older than the hosted one; a real restore needs the same server version.
* **Exact final command** (guarded; run only after the written approval):
```bash
cd /Volumes/WORKSPACE/Dev/Apps/ClearSpace/V1-intelligence
CONFIRM_HOTFIX_0900=twjlnsxjtuntujarwner frontend/scripts/apply-hotfix-0900-hosted.sh
```
  It refuses (before any write) unless: confirmation names the project; clean tree; backup matches its SHA256SUMS; 0900, its rollback and the verify script have the rehearsed checksums (`333b103d…8360`, `369e4b7c…be11`, `dc8b31e2…297d`); hosted has exactly the 7 markers 0100-0700 and not 0900; the hosted catalog md5 is the pinned one; the guard is still the defective (non-definer) one.
  Then ONE transaction; afterwards it requires: exactly one catalog function changed (2 diff lines), row counts unchanged, every `GATE` PASS (the new GATE checks the 0900 marker and the guard definition).
* **Then (still H1):** `STAGED_URL=<staged or loopback> PW_CHROMIUM_PATH=<chromium> frontend/scripts/staged-intelligence-smoke.sh` - the same smoke that failed, hardened; its **account deletion of a user who created a meeting must answer 200** and the leftovers must be none (this is the regression check on hosted).
* **Failure / recovery:** the migration is one transaction (a failure changes nothing: stop, report); the file only replaces one function, so no data is touched. Undo = `frontend/supabase/rollback/20261118000900_meeting_creator_erasure.down.sql` as role `postgres` (restores the 0700 catalog exactly - and with it the defect). A frontend rollback never needs a database rollback; the old production build never touches the guard.
* `apply-b2-hosted.sh` is historical (B2 is done; it would refuse: the markers no longer match) and the B2 verify gates now include the 0900 gate (they say FAIL on a hosted database that has not received the hotfix - by design).

> **Approval text H1:** „Schvaluji H1: na hostovaném Supabase `twjlnsxjtuntujarwner` aplikovat migraci `20261118000900_meeting_creator_erasure.sql` (jedna transakce jako `postgres`, záloha `20261118-v1-pre-hotfix-0900` existuje, skript `apply-hotfix-0900-hosted.sh`), ověřit `verify_hosted_intelligence.sql` a spustit smoke `staged-intelligence-smoke.sh` (jednorázové testovací účty se po testu smažou). Bez migrace 0800, bez tajemství pro přepis, bez změny Vercelu, firewallu a Cloudflare.“

### H2 — new protected staged deployment from the FINAL commit (needs approval; after H1 PASS; same procedure as B3a)
`git archive HEAD` → clean export, `vercel link --project clearspace`, remove `.env.local`, `vercel deploy --prod --skip-domain --meta releaseCommit=<HEAD>`; then `check-deployment.sh` (17 routes × GET/POST = 403, bundle), `hosted-verify.sh` against the staged URL, `staged-intelligence-smoke.sh`, `vercel inspect` (READY, no alias). Production keeps serving `dpl_2tSV5NWAHaEweTibxzszh6SMZJ55`.
Local gates on the exact commit first: tsc, eslint, vitest, `supabase/tests/run.sh`, real-stack scripts, E2E (`meeting-flow`, `meetings`, `project-intelligence`, `meeting-audio`), build, `check-production-bundle.sh`.

> **Approval text H2:** „Schvaluji H2: nový staged production deployment (`vercel deploy --prod --skip-domain`) z čistého exportu commitu `<HEAD>` s `--meta releaseCommit`, kontroly stagingu (`check-deployment.sh`, `hosted-verify.sh`, `staged-intelligence-smoke.sh`, `vercel inspect`). Bez promote, bez push, bez merge, bez změny firewallu.“

### S1 — bounded REAL Soniox test (owner-only; separate approval; local app + throwaway local Supabase; nothing hosted, nothing deployed)
* **Contract re-verified 2026-11-18** against docs.soniox.com (see `SONIOX_API_VERIFICATION.md`): model `stt-async-v6` (active; v5 deprecated, removal 2026-12-15), body fields `audio_url` / `file_id`, `language_hints`, `enable_speaker_diarization`, `client_reference_id`, `context`; `audio_url` must be "publicly accessible via HTTP"; transcript via `GET /v1/transcriptions/{id}/transcript`; deletion of transcription and file are separate calls. The adapter (`src/lib/stt/soniox.ts`) uses exactly these; the pipeline is unchanged. Statuses: the adapter accepts `queued|processing|completed|error` (and `failed` defensively). Signed-URL fetch by Soniox is the one thing still UNVERIFIED against the real service.
* **Harness (done, dry-run PASSED against the fake provider):** `frontend/scripts/soniox-real-test.sh` + `e2e/soniox-real.spec.ts`. One synthetic Czech recording (`scripts/make-synthetic-czech-audio.sh`: macOS voice Zuzana, two pitch-shifted "speakers", a short English phrase, 19.8 s, no personal data), ONE job, `--retries=0`, Gemini not configured at all (AI routes 503), the app runs with `STT_ENABLED=1`.
  The Soniox key is read from a hidden prompt into the environment of the local app and the one test process: never argv, file, `.env.local`, history or log (the script counts occurrences in its logs through a file descriptor and fails if any). The spec checks: consent refusal, audio validation, private Storage upload, nothing booked before the click, ONE submission (attempts = 1, one `stt_jobs` row, one ledger row), polling to completion, transcript source/segments/two speakers/monotonic timestamps within the recording, Czech word-error rate vs the spoken script (reported with and without diacritics; fails only above 0.6),
  cost and usage in the ledger, provider-side deletion (the local state is `done` AND `GET /v1/transcriptions/<id>` answers 404), safe cleanup of the local test data. An uncertain provider outcome would end in state `unknown` with the estimate kept in the budget - it is reported, never re-sent.
* **How Soniox reaches the local audio (decision for the owner):** Soniox downloads from the internet, the local Storage is private. The script starts an **account-less `cloudflared` quick tunnel** to `e2e/support/storage-gate.mjs`, which serves ONLY `GET/HEAD /storage/v1/object/sign/meeting-audio/…?token=…` (everything else 404; tested), for the minutes of the run; a test seam `STT_TEST_PUBLIC_STORAGE_ORIGIN` (ignored when `NODE_ENV=production`, unit-tested, not in any bundle) swaps only the origin of the signed URL.
  Nothing is created in any Cloudflare account and no Cloudflare setting is touched. Without the tunnel the only alternative is uploading the file bytes to Soniox (`POST /v1/files`), which would not test the production path.
* **Command (owner terminal; the key is typed into the hidden prompt, never pasted into chat):**
```bash
cd /Volumes/WORKSPACE/Dev/Apps/ClearSpace/V1-intelligence
# throwaway local stack must be up (docs/intelligence/IMPLEMENTATION_REPORT.md recipe) and these set: E2E_SUPABASE_URL E2E_SUPABASE_ANON_KEY E2E_SUPABASE_SERVICE_KEY PW_CHROMIUM_PATH
CONFIRM_REAL_SONIOX_JOBS=1 SONIOX_REGION=us frontend/scripts/soniox-real-test.sh      # SONIOX_REGION must match the region of the key's project (us|eu|jp|in)
```
  Cost: about 0.10 USD per audio hour, i.e. well under 0.01 USD for 20 s. The script refuses without `CONFIRM_REAL_SONIOX_JOBS=1`, a local stack URL and `cloudflared`.

> **Approval text S1:** „Schvaluji S1: jeden skutečný přepis jedné syntetické české nahrávky (≤ 60 s) přes Soniox, lokální aplikace + lokální Supabase, krátkodobý účtově nezávislý `cloudflared` quick tunnel jen na podepsané URL bucketu `meeting-audio`, klíč zadám sám do skrytého promptu. Bez Gemini, bez produkce, bez změny Vercelu, Cloudflare účtu a firewallu.“

## B3b — promote and post-promote smoke (separate approval; after H1 and H2 PASS - the promoted URL is the H2 staged deployment of the FINAL commit, never `dpl_GQL6xxm4…`)

`$V promote <staged-url> --scope bng-dev-alt-webadvisor --yes`, then `BASE_URL=https://clearspace-ai.vercel.app PRODUCTION_SMOKE_OK=1 PW_CHROMIUM_PATH=<chromium> frontend/scripts/hosted-verify.sh`
(disposable accounts, deleted afterwards; AI routes must answer 403 and never reach the gateway), `scripts/check-production-bundle.sh` plus the same scan against the live chunks, `POST /api/ai/chat` 403,
Cloudflare origin 302. **Rollback:** `$V promote https://clearspace-7e032iiy1-bng-dev-alt-webadvisor.vercel.app --scope bng-dev-alt-webadvisor --yes` (`dpl_2tSV5NWAHaEweTibxzszh6SMZJ55`, the current production build; the database change is additive and
harmless to it).

> **Approval text B3b:** „Schvaluji B3b: `vercel promote` staged deploymentu `<URL>` na `clearspace-ai.vercel.app`, post-promote smoke (`hosted-verify.sh` s `PRODUCTION_SMOKE_OK=1`) a v případě selhání rollback na `dpl_2tSV5NWAHaEweTibxzszh6SMZJ55`. Firewall a Cloudflare se nemění.“

## B4 — fast-forward `main` (needs approval; after B3b PASS)

```bash
cd /Volumes/WORKSPACE/Dev/Apps/ClearSpace/V1-intelligence
git fetch origin main && git merge-base --is-ancestor origin/main HEAD && echo FAST-FORWARD   # main must still be fe3b2e9 (or an ancestor of HEAD)
git show origin/main:frontend/vercel.json                                                     # the deploy guard is there
git push origin feature/intelligence-v2:main                                                  # NO force
gh run list --repo bng-dev-alt/clearspace --branch main --limit 3                             # CI: quality + database green
$V ls --scope bng-dev-alt-webadvisor | head -3                                                # NO new clearspace deployment (guard); production unchanged
```
**Stop:** `main` moved or the check is not a fast-forward. **Not done:** deleting or pushing any other branch.

> **Approval text B4:** „Schvaluji B4: fast-forward `main` na `<HEAD>` (`git push origin feature/intelligence-v2:main`, bez force), ověřit CI a že nevznikl nový Vercel deployment.“

## Restrictions that stay in force

* Public AI stays off: the firewall rule is not edited (A4b, the dedicated key and explicit model in Vercel, is done; opening the firewall is a separate decision with its own quotas and abuse review).
* Real audio stays off: no `STT_*`/`SONIOX_*`/`NEXT_PUBLIC_ENABLE_MEETING_AUDIO`, no `STT_SERVER_SECRET` hash registered (the trusted STT functions refuse until the owner step).
* Soniox blockers (DPA, region, legal basis for recording, real signed-URL fetch, rate limits, no exactly-once provider billing, no scheduler) are unchanged: `HARDENING_RELEASE_CANDIDATE.md` §5/§6b.
* No Cloudflare, MicroCRM, Demo Business OS or ClearSpace V2 change.
