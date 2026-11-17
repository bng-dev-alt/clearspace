# Release plan — one controlled release of `consolidation/security-foundation`

**Nothing in this plan has been executed.** It exists so that a single approval can start one controlled release instead of
many fragmented actions. Companion documents: [HOSTED_SUPABASE_READINESS.md](HOSTED_SUPABASE_READINESS.md),
[MIGRATION_RUNBOOK.md](MIGRATION_RUNBOOK.md), [GEMINI_KEY_ROTATION.md](GEMINI_KEY_ROTATION.md),
[RELEASE_READINESS.md](RELEASE_READINESS.md).

## 0. Starting state (all verified except where marked)

| Layer | State |
|---|---|
| Hosted Supabase `ClearSpace` (`bjycwqfessddbfocrggt`) | **paused**; host does not resolve; no backups, no PITR |
| Vercel project `clearspace` | live **old build** (main @ `ff615c3`), firewall rule *Block legacy AI API* (deny `/api/ai`) **published**; env: `GEMINI_API_KEY`, `GEMINI_MODEL`, `NEXT_PUBLIC_SUPABASE_*` (Production + Preview) |
| Cloudflare | Access app protects `clearspace-origin`; port 3130 closed; launchd agent disabled |
| GitHub `main` | `ff615c3`, **connected to Vercel: any push to any branch deploys** (preview), a push/merge to `main` deploys **production** |
| This branch | HEAD contains the code, both migrations (with preflight), tests, docs. Never merged, never pushed |

Do not weaken the firewall rule or the Access app at any point before step R11/R12.

## 1. Why a plain merge into `main` must not be the release

- Merge to `main` = automatic **production deployment** of the new code, before the database is ready.
- Reverting only the web app does not roll back: the old app with the new DB breaks invitations/team page, and **re-opens the
  unauthenticated AI routes** (they are only held shut by the firewall rule). New app with old DB degrades safely (AI 503, invitations fail).
- Pushing *any* branch creates a Preview deployment with the Preview env vars (Vercel Authentication protects those URLs, and the firewall rule also covers them — it has no environment condition — but it is still an uncontrolled build against real env).
- Existing pending invitations are invalidated by migration 1 (by design).

### The deploy guard (prepared: `frontend/vercel.json`)

`{"git": {"deploymentEnabled": false}}` tells Vercel's **Git integration** not to deploy any branch. It is read from the commit
being built, so it is in effect on the branch that carries it **and on the merge commit** — a later merge to `main` deploys nothing.
Deployments then happen **only** by explicit CLI command. Facts and caveats:

- Documented in Vercel's *Git configuration* reference (`git.deploymentEnabled`: object of branch → boolean, or a boolean).
- The project's **Root Directory is `frontend`**, so the file must be `frontend/vercel.json` (where it is). That vercel.json is read from the Root Directory is Vercel's documented behaviour for monorepos but **NOT VERIFIED here → step R1 proves it before anything depends on it**. A guard that silently does not work is worse than none.
- CLI deployments (`vercel deploy`) are unaffected by it.
- Because the project has a Root Directory, run the CLI from the **repository root** (not from `frontend/`), otherwise the path is doubled.
- To go back to automatic deployments later: delete the file in a normal commit.
- Settings-level alternatives (not used, they change the Vercel project): *Production Branch* set to a dummy branch; an *Ignored Build Step*; disconnect the Git repository.

## 2. Decisions the owner must make first (they change the sequence)

| # | Decision | Default recommendation |
|---|---|---|
| D1 | Does the data in the old Supabase project matter? | **DECIDED 2026-11-17: Track C** — new empty project `ClearSpace V1` (`twjlnsxjtuntujarwner`) is created and migrated, see [NEW_SUPABASE_PROJECT.md](NEW_SUPABASE_PROJECT.md). Track A (restore the old project) is dropped; the old project is left untouched. R2/R4 and the data part of R6 no longer apply. |
| D2 | Plan for the Supabase project (Free pauses idle projects and has no backups) | Pro if the app is to be used for real; otherwise accept Free + manual dumps. |
| D3 | *Confirm email* ON | **ON** (invitations are bound to verified e-mails). |
| D4 | Gemini: new key in a billing-less Google project (hard cap) vs billing + quotas | billing-less (see rotation doc). |
| D5 | Final firewall state after validation | keep deny until public AI is wanted; then replace by "authenticated only" + a rate-limit rule. |

## 3. Sequence

Every step has a **gate**: do not continue unless it holds. "Approve" = explicit owner approval in chat.

| Step | Action | Gate / expected result | If it fails |
|---|---|---|---|
| **R0** | Decisions D1–D5. Fresh `git status` clean, HEAD known; `npm ci && npm test && npm run build` + `frontend/supabase/tests/run.sh` on the release commit. | all green | fix before anything else |
| **R1** | **Guard test.** *Approve* pushing one throwaway branch that contains only `frontend/vercel.json`. Check Vercel deployments of the project (`vercel ls clearspace`): **no new deployment** appears. Delete the throwaway branch afterwards. | no deployment was created | guard does not work → do **not** push this branch or merge to `main`; use the settings-level alternative with approval, or deploy the branch by CLI only |
| **R2** | **Supabase target.** Track A: dashboard → restore/resume the old project (or download backup + restore into a new project if the window passed; upgrading re-enables expired restore). Track C: create a new project (EU region) and note the new ref. Auth: *Confirm email* ON, Site URL `https://clearspace-ai.vercel.app`, redirect URLs `https://clearspace-ai.vercel.app/**` only, no unused providers. | project `ACTIVE_HEALTHY`; settings as listed | stop; nothing else has changed |
| **R3** | **Read-only inspection** (`frontend/supabase/inspect_hosted.sql`, read-only session). Compare with the matrix in HOSTED_SUPABASE_READINESS §3; run runbook §5 pre-checks. | no surprise: tables/columns present, owners are `postgres`, pgcrypto in `extensions`, policies as expected | adapt the migration **in the worktree** and rehearse again (R5); never edit on the target |
| **R4** | **Backup** (Track A only): `pg_dump` (public + auth), `pg_restore --list`, `shasum`, Storage objects if any. Store outside every repository. **Restore into a scratch container and compare row counts.** Track C: record "empty target". | restore proof OK, counts equal | **stop condition** (runbook §9) |
| **R5** | **Rehearse on the restored copy** (Track A): preflight + both migrations + runbook §7 queries + `run.sh` scenarios against that copy (as role `postgres`). | preflight ok, assertions pass, row counts equal except invitation statuses | fix forward in the worktree, repeat |
| **R6** | **Apply migrations to the target** (*approve*), one file at a time as the owning role: `psql "$DB_URL" -v ON_ERROR_STOP=1 --single-transaction -f …` (runbook §6). Read the `Preflight ok … Pending invitations that will be expired: N` notice. Then runbook §7 verification + `inspect_hosted.sql` again. Track C: baseline first, then the two migrations. | every verification query holds; `anon` has 0 table grants | a failed migration is transactional (nothing changed). Fix the cause on the rehearsal copy first |
| **R7** | **Vercel env** (*approve*; Production **and** Preview): Track C → `NEXT_PUBLIC_SUPABASE_URL/ANON_KEY`; new `GEMINI_API_KEY` (rotation doc §5); conservative `AI_RATE_PER_USER_PER_MINUTE`, `AI_RATE_GLOBAL_PER_MINUTE`, `AI_DAILY_TOKEN_BUDGET_PER_USER`. The firewall deny **stays**. | values present (names only) | revert the env change; no deployment has happened yet |
| **R8** | **Staged production build** (*approve*): from a **clean checkout of the release commit**, at the repository root: `vercel deploy --prod --skip-domain` (builds with Production env, is **not** attached to the production domain). | build succeeds; staged URL answers; `/api/ai/*` → 403 (firewall); security headers present | live site untouched; delete/ignore the staged deployment |
| **R9** | **Staged smoke** on the staged URL (Vercel Authentication: use a signed-in browser or the CLI's protection bypass — **NOT VERIFIED**): sign up/sign in with a test account, create a project, board CRUD, reload keeps the session, logout. Black-box: anon `GET /rest/v1/profiles` and `/rest/v1/invitations` → 401/403 (runbook §7). | all pass | do not promote; fix forward |
| **R10** | **Promote** (*approve*): `vercel promote <staged-url>`. **Production smoke**: login/reload/logout; invitation created on the team page, opened logged-out, accepted by a second test account whose e-mail was **confirmed**; expired/used link states; AI History restore on a scratch project; Realtime updates between two sessions; Storage upload if the app uses it. Security headers (HSTS, frame, nosniff). | all pass | **fast app rollback = promote the previous deployment** — but it is only compatible with the *old* DB (see §5): prefer fix-forward; if the new app is broken and the DB is fine, re-promote is **not** safe. Keep the firewall deny |
| **R11** | **AI bounded validation** (*approve* the rule change): edit the firewall rule to *deny `/api/ai` unless the client IP equals the owner's* (condition `path starts with /api/ai` AND `ip_address` negated-equal owner IP), publish. Send **≤ 5** requests with a test account; check HTTP status, `ai_requests` rows (`succeeded`, tokens), and the Google usage graph show the same number. Then restore the full deny rule. | ledger and Google agree; no 5xx | restore the full deny immediately; AI stays off |
| **R12** | **Final firewall/Access state** (D5). Cloudflare Access stays. If public AI is wanted: replace deny-all by a rule that allows `/api/ai` (app enforces auth) + a rate-limit rule per IP (rate limiting may need a paid plan: **NOT VERIFIED**). Keep the guard file until the owner decides to re-enable automatic deployments. Merge the branch to `main` only now (the guard makes the merge deploy nothing). | — | — |
| **R13** | **Aftercare**: Gemini key rotation steps 7–9; V2 coordination; monitor 48 h (Vercel logs, `ai_requests`, Google metrics, Supabase auth logs). Remove the Cloudflare hostname route `clearspace-origin` (shared tunnel — separate approval). | — | — |

## 4. Smoke-test checklist (copy into the release record)

- [ ] `GET /` and `/login` → 200; `/team` anonymous → redirected to `/login`
- [ ] sign-up with *Confirm email* ON: no session before the link is opened; link lands signed in
- [ ] sign-in → reload keeps session → sign-out revokes it
- [ ] anon REST: `profiles`, `invitations` → 401/403 (never rows)
- [ ] invitation: create (link shown once) → preview (masked e-mail) → accept with the confirmed invitee → used link shows "used"
- [ ] a stranger cannot read another user's project (second account)
- [ ] AI History restore on a scratch project: replaces that board only
- [ ] `/api/ai/*` → 403 from the firewall until R11
- [ ] R11: ≤ 5 AI requests; 401 without a token, 403 for a foreign project, 429 after the limit; ledger = Google metrics
- [ ] security headers present; no secret in the public JS (`AIza…` scan = 0)

## 5. Recovery

| Failure | Action |
|---|---|
| Migration error | transactional → nothing changed; fix on the rehearsal copy, re-apply |
| Verification query deviates after the migration | **fix forward** with a corrective migration (policy/function change); keep the firewall deny |
| App broken, DB fine | fix forward and redeploy a new staged build; do **not** promote the old build (incompatible with the new DB; it also has the unauthenticated AI routes, held only by the firewall) |
| Data corrupted/lost | restore the R4 dump **into a new project** and switch `NEXT_PUBLIC_SUPABASE_*`; every write after the dump is lost; Storage objects separately |
| Auth misbehaves (cannot sign in) | check Confirm email/redirect URLs first; no data rollback is needed |
| Unexpected AI traffic or cost | restore the full deny rule at once (no deployment needed), revoke the key at Google, review `ai_requests` |
| Any doubt about isolation | stop; never run destructive tests against the hosted DB |

**Rollback limitations (be honest about them):** there is no down-migration; plaintext invitation tokens and the pending
statuses cannot be restored except from the dump (and the old tokens were weak, so restoring them is not desirable);
a backup restore discards everything written after the dump; the old app is not a valid fallback; the Gemini key swap
is not reversible once the old key is deleted at Google.

## 6. Approvals required (each is a separate yes)

1. Push a throwaway branch for the guard test (R1).
2. Resume/restore the old Supabase project, or create a new one, and change its Auth settings (R2) — plus a paid plan if chosen.
3. Take the production dump (private user data) and store it (R4, Track A).
4. Apply the two migrations to the target (R6).
5. Change Vercel env vars incl. the new Gemini key (R7); this replaces values.
6. `vercel deploy --prod --skip-domain` and `vercel promote` (R8, R10).
7. Temporarily relax, then restore, the firewall rule (R11); the final firewall state (R12).
8. Merge to `main` and push (R12).
9. Revoke the old Gemini key, update V2 (R13); remove the Cloudflare hostname route.
