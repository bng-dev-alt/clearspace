# Release readiness — `consolidation/security-foundation`

Status legend: **READY** = verified and nothing known blocks it · **BLOCKED** = needs an action/decision first ·
**NOT VERIFIED** = could not be checked from here.
Snapshot taken on branch HEAD at the time of the stabilization run (see git log). Nothing is merged, deployed or applied.

| # | Area | Status | Evidence / what is missing |
|---|---|---|---|
| 1 | **Code readiness** | **READY** | ESLint clean (`src e2e`), `tsc --noEmit` clean incl. tests, Vitest 31 files / 184 tests, `next build` OK (21 pages), Playwright demo suite 27/27 (+6 env-gated specs skip by design). |
| 2 | **Database migration readiness** | **BLOCKED** | Migrations pass on a clean DB, on a legacy-data upgrade (also a real local Supabase stack), are idempotent and now run a **preflight that verifies columns, types, helpers and object ownership** (drift scenarios D1–D5). They also pass, together with all 125 SQL assertions, **as the non-superuser `postgres` role on `supabase/postgres:17.6.1.147` — the hosted Postgres version** (scenario E). Blocked on: the hosted project being **paused** (cannot be inspected), a restore/new project, a verified backup, staging rehearsal on a restored copy, owner approval. Real production schema/owners/extensions **NOT VERIFIED**. See [HOSTED_SUPABASE_READINESS.md](HOSTED_SUPABASE_READINESS.md), `MIGRATION_RUNBOOK.md`. |
| 3 | **Authentication readiness** | **READY** (local) / **NOT VERIFIED** (hosted) | Real GoTrue: login, wrong password, refresh, logout revokes refresh token, session survives reload, redirect of anonymous users, sign-up + invitation acceptance with *Confirm email* ON and OFF (Mailpit link). Hosted setting "Confirm email" and redirect allow-list **NOT VERIFIED**. Known UX quirk: failed login empties the e-mail field. |
| 4 | **AI gateway readiness** | **READY** (without provider) / **NOT VERIFIED** (with Gemini) | All 11 routes: 401 anonymous/invalid token, 415, 413, 400, 403 foreign project, 429 + `Retry-After`, 503 fail-closed when the RPC is missing; ledger rows `failed/ai_unavailable`; 8–12 parallel reservations pass exactly the limit. Gemini was never called, so real provider behaviour (model id, structured-output, timeouts, cost) is **NOT VERIFIED**. Not a hard spending cap. |
| 5 | **Public deployment exposure** | **CONTAINED** (not closed) | `clearspace-ai.vercel.app` still serves the **pre-consolidation build**, but since P3 a published Vercel firewall rule (*Block legacy AI API*, deny `/api/ai`) answers **403 at the edge for all 11 AI routes** (GET/POST/OPTIONS, path variants) and `clearspace-origin.luffast.com` is behind Cloudflare Access (port 3130 closed, agent disabled). The site also cannot reach its database: the hosted Supabase project is paused. The hole is held shut only by the firewall rule — **do not remove it before the release plan's validation step**. The Gemini key was never in the public JS (0 key-shaped strings). |
| 6 | **Secrets and Gemini billing** | **BLOCKED** / **NOT VERIFIED** | The Gemini key shared by V1, V2 and the kanban clones is **not rotated**; Google-side usage/billing/ownership **NOT VERIFIED** (no Google access). A rotation plan with a hard-cap recommendation (billing-less project) is in [GEMINI_KEY_ROTATION.md](GEMINI_KEY_ROTATION.md). Exposure was the *capability* (unauthenticated routes), not the secret. No secrets were committed. |
| 7 | **Remaining security findings** | **BLOCKED** (not for merge, for hardening) | Open: S10 storage (public bucket, `upsert`, no type/size checks, no policies in repo); roles (`workspace_role`/`viewer`) not enforced; prompt-injection delimiting not done; CSP lacks `script-src`/`connect-src`; demo mode keeps plaintext passwords in localStorage; AI Studio/budget widgets are still browser-local and the model selector is cosmetic; Realtime and Storage **NOT VERIFIED** with the new policies. |
| 8 | **Test results** | **READY** | Unit 184/184 · DB harness 125 SQL assertions + legacy upgrade + preflight + concurrency · real stack: legacy upgrade, idempotence, 125 SQL assertions, 26 HTTP checks · browser (Supabase mode): 5 specs OFF + 1 spec ON, all pass · demo Playwright 27/27 · build OK. Calendar e2e: root cause fixed (see below). |
| 9 | **Merge readiness** | **READY for review, BLOCKED for deploy** | The branch is technically stable and was cut from `main` (`ff615c3`), which has not moved; conflicts are not expected, but a trial merge was not performed. Merging is safe code-wise; **deploying requires items 2, 6 and the controlled sequence in [RELEASE_PLAN.md](RELEASE_PLAN.md)**; a plain merge into `main` auto-deploys production (use the prepared deploy guard `frontend/vercel.json`, see the plan). Keep `feature/collaboration` as reference; do not delete. |
| 10 | **Hosted Supabase project** | **BLOCKED** | Project `ClearSpace` (`bjycwqfessddbfocrggt`, eu-west-1, Postgres 17.6.1.147) is **paused** (`INACTIVE`, DNS does not resolve), has **no backups and no PITR**; it is the one the deployed build points at (V2/MicroCRM use other/local projects). Resuming it, restoring it or replacing it with a new project is an owner decision (D1/D2 in the plan). Auth settings (*Confirm email*, redirect URLs), Storage and Realtime **NOT VERIFIED**. |

## Root cause of the two calendar e2e failures

`kanban.spec.ts:120` and `:226` fail whenever the machine date is outside July 2026. The calendar opens on the **current
month**, while the demo seed (`INITIAL_COLUMNS`) carries fixed due dates in July 2026, so other months render no cards.
Reproduced identically on an untouched snapshot of `main` (so not a regression of this branch). Fix: the two tests pin
`Date` to 2026-07-15 via `page.clock.setFixedTime` and reload; assertions unchanged. With the pin both pass on `main`
and on this branch; without it they fail on both.

## Production actions requiring approval (not done here)

The consolidated, ordered list with gates and recovery is [RELEASE_PLAN.md](RELEASE_PLAN.md) (section 6). Short form:

1. Take and verify a backup; rehearse on a copy; apply the two migrations (see runbook).
2. Deploy the new build **immediately after** the migration (ordering in the runbook).
3. Enable *Confirm email* in Supabase; add the production redirect URLs.
4. Remove or rotate `GEMINI_API_KEY` on Vercel **now** if the old build is still serving, set a Google quota/budget cap, then set the `AI_*` limits.
5. Remove the Cloudflare hostname route `clearspace-origin` (shared tunnel; not touched here).
6. Decide demo mode (read-only mock vs removed) and the storage-bucket hardening.
