# Release plan — one controlled release of `consolidation/security-foundation`

**Nothing in this plan has been executed against production** (Vercel production, Cloudflare, the Gemini key, `main`). P5 prepared and
verified a release candidate locally and against the NEW Supabase project (see §7). The plan exists so that a single approval can start
one controlled release instead of many fragmented actions. Companion documents: [HOSTED_SUPABASE_READINESS.md](HOSTED_SUPABASE_READINESS.md),
[MIGRATION_RUNBOOK.md](MIGRATION_RUNBOOK.md), [GEMINI_KEY_ROTATION.md](GEMINI_KEY_ROTATION.md),
[RELEASE_READINESS.md](RELEASE_READINESS.md).

## 0. Starting state (all verified except where marked)

| Layer | State |
|---|---|
| Old Supabase `ClearSpace` (`bjycwqfessddbfocrggt`) | **paused, untouched, to be left alone**; the live old build still points at it, so production is inert |
| New Supabase `ClearSpace V1` (`twjlnsxjtuntujarwner`, eu-west-1) | **active**, baseline + migrations 100–300 applied, 400 **pending**, Confirm email ON, empty except one dev account; Realtime publication set; no backups (Free plan, inferred) |
| Vercel project `clearspace` | live **old build** (main @ `ff615c3`), firewall rule *Block legacy AI API* (deny `/api/ai`) **published**; env: `GEMINI_API_KEY`, `GEMINI_MODEL`, `NEXT_PUBLIC_SUPABASE_*` (Production + Preview) |
| Cloudflare | Access app protects `clearspace-origin`; port 3130 closed; launchd agent disabled |
| GitHub `main` | `ff615c3`, **connected to Vercel: any push to any branch deploys** (preview), a push/merge to `main` deploys **production** |
| This branch | HEAD contains the code, four migrations (with preflight), tests, docs, dev tooling. Never merged, never pushed |

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
| D2 | Plan for the Supabase project (Free pauses idle projects, has no backups, and its built-in mailer only reaches org team members) | Pro **and** custom SMTP if the app is to be used by anyone but the owner; otherwise accept Free + manual dumps + owner-only sign-ups. |
| D3 | *Confirm email* ON | **ON — VERIFIED on the new project** (invitations are bound to verified e-mails). |
| D4 | Gemini: new key in a billing-less Google project (hard cap) vs billing + quotas | billing-less (see rotation doc). |
| D5 | Final firewall state after validation | keep deny until public AI is wanted; then replace by "authenticated only" + a rate-limit rule. |

## 3. Sequence

Every step has a **gate**: do not continue unless it holds. "Approve" = explicit owner approval in chat.

| Step | Action | Gate / expected result | If it fails |
|---|---|---|---|
| **R0** | Decisions D1–D5. Fresh `git status` clean, HEAD known; `npm ci && npm test && npm run build` + `frontend/supabase/tests/run.sh` on the release commit. | all green | fix before anything else |
| **R1** | **Guard test.** *Approve* pushing one throwaway branch that contains only `frontend/vercel.json`. Check Vercel deployments of the project (`vercel ls clearspace`): **no new deployment** appears. Delete the throwaway branch afterwards. | no deployment was created | guard does not work → do **not** push this branch or merge to `main`; use the settings-level alternative with approval, or deploy the branch by CLI only |
| **R2** | **Supabase Auth configuration** (*approve*, dashboard, new project only): Site URL `https://clearspace-ai.vercel.app`; redirect URLs `https://clearspace-ai.vercel.app/**` only; keep *Confirm email* ON; no unused providers. Decide SMTP (D2): the built-in mailer reaches only org team members and is rate-limited. | settings as listed (re-read `/auth/v1/settings` afterwards) | nothing else has changed |
| **R3** | **Read-only inspection** of the new project (`inspect_hosted.sql`; it makes its own session read-only): must show migrations 100–300, 15 tables with RLS, no non-dev users. | as in NEW_SUPABASE_PROJECT.md §4 | investigate before anything else |
| **R4** | ~~Backup~~ — Track C: the target is empty (only the dev account). If it has been used by then, take a dump first (runbook §8; Free plan has no managed backups). | — | — |
| **R5** | ~~Rehearse on a restored copy~~ — replaced by P5's local rehearsal (plain Postgres 17.6.1.147 incl. non-superuser, real local stack with Storage + Realtime) and the hosted verification harness. Re-run `run.sh`, `real_stack.sh`, `storage_real_stack.sh` on the release commit. | all green | fix forward in the worktree |
| **R6** | **Apply the remaining migration** (*approve*): `20261117000400_task_resources_storage.sql` as role `postgres` through the session pooler, single transaction (a rolled-back probe proved `postgres` may create the bucket and `storage.objects` policies on this project). Then: `inspect_hosted.sql`, `scripts/hosted-verify.sh` (the Storage test un-skips and must pass), confirm `supabase_realtime` still lists `cards, columns, activity_logs`. | bucket private, 10 MiB, 3 policies; verify script green; leftovers 0 | transactional: nothing changed; fix on the local stack first |
| **R7** | **Vercel env** (*approve*; Production **and** Preview) — exact list in §7.1. The firewall deny **stays**. | names present, values not echoed | revert the env change; no deployment has happened yet |
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
- [ ] security headers present; `frontend/scripts/check-production-bundle.sh` after the build (no dev-login code, no `service_role`/`AIza`, only `anon` JWTs, no retired project ref)
- [ ] `POST /api/dev/login` on the deployment → 404
- [ ] drag a card to another column, reload: it stayed (regression of the lazy-updater bug)
- [ ] attach a PNG to a task, reload, open it (signed URL); a second account cannot open it; an `.html` or 11 MB file is refused
- [ ] two sessions on one board: a change in one appears in the other (Realtime)

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
2. Supabase Auth URL configuration and the SMTP decision on the **new** project (R2) — plus a paid plan if chosen.
3. Apply migration `20261117000400` to the new project (R6).
4. Change Vercel env vars incl. the new Gemini key (R7); this replaces values.
5. `vercel deploy --prod --skip-domain` and `vercel promote` (R8, R10).
6. Temporarily relax, then restore, the firewall rule (R11); the final firewall state (R12).
7. Merge to `main` and push (R12).
8. Revoke the old Gemini key, update V2 (R13); remove the Cloudflare hostname route.
9. Delete (or keep, knowingly) the `dev-login@example.test` account in the new project before it is public.

## 7. Release configuration and P5 verification

### 7.1 Vercel environment variables (project `clearspace`, **Production and Preview**; Development none)

| Variable | Value | Notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | `https://twjlnsxjtuntujarwner.supabase.co` | public; replaces the old project's URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | the project's **anon** key (Dashboard → API keys) | public by design; the bundle check proves only `anon` JWTs ship |
| `GEMINI_API_KEY` | a **new key created for V1 only** (§7.4) | server-only; set it last, never paste into chat/files |
| `GEMINI_MODEL` | an available model id | default in code is `gemini-3.5-flash`; **NOT VERIFIED** that Google serves it under that name — confirm in AI Studio before the bounded AI test |
| `AI_RATE_PER_USER_PER_MINUTE`, `AI_RATE_GLOBAL_PER_MINUTE`, `AI_DAILY_TOKEN_BUDGET_PER_USER` | start at `3`, `10`, `50000` | estimate-based throttles, **not a spending cap** |

**Must NOT exist on Vercel:** `NEXT_PUBLIC_FORCE_DEMO`, `NEXT_PUBLIC_DEV_LOGIN`, `CLEARSPACE_DEV_LOGIN`, `DEV_LOGIN_EMAIL`, `DEV_LOGIN_PASSWORD`,
any service-role key, the database password, `NEXT_PUBLIC_ENABLE_OAUTH` (until providers are enabled). Env changes apply only to a **new** deployment.

### 7.2 Supabase Auth (new project)

Site URL `https://clearspace-ai.vercel.app` (the default is still `localhost:3000`, so confirmation/recovery links would point there until this is set);
redirect URLs `https://clearspace-ai.vercel.app/**`; *Confirm email* ON (verified); sign-ups enabled; email provider only.
**SMTP:** the built-in mailer delivers only to organisation team members and is rate-limited, and the Auth service validates the address domain
(`@example.test` is refused on sign-up). Anyone else cannot register until custom SMTP is configured — an **owner-only release works without it, a public one does not.**

### 7.3 Database state and remaining changes

| Item | State |
|---|---|
| Migrations on the new project | 100, 200, 300 applied; **400 (task attachments bucket + policies) pending** → R6 |
| Realtime publication | `cards`, `columns`, `activity_logs` — VERIFIED on the project; behaviour VERIFIED (member receives changes, stranger/anon receive no row data) |
| Storage | bucket does not exist yet (VERIFIED: hosted Storage test skips); behaviour of the migration VERIFIED on a real local stack (private, 10 MiB, MIME allow-list, member-only, signed URLs, no upsert); creating bucket/policies as `postgres` on this project VERIFIED by a rolled-back probe |
| Hosted default privileges | `postgres` creates tables with grants to the API roles (inspect §9); migrations rely on that and then revoke `anon` and TRUNCATE/TRIGGER/REFERENCES. A project without those defaults would have unusable tables — the local CLI stack lacks them, which is why `storage_real_stack.sh` installs them first |
| Dev account | `dev-login@example.test` exists (confirmed, owns one seeded default project). Remove it or keep it knowingly before the project is public |

### 7.4 Gemini credential separation (not rotated in P5; nothing contacted)

V1 reads `GEMINI_API_KEY` server-side only. The consolidation worktree has **no** key and the gateway fails closed (HTTP 503 `ai_unavailable`, ledger row `failed`, no key text in the
body) — VERIFIED at runtime against the hosted project. Model and limits are chosen by the server, not the client; 26 gateway tests cover credentials, validation, isolation, limits,
provider failures with a mock provider. Independence from V2: create the V1 key in its own Google project (ideally billing-less, [GEMINI_KEY_ROTATION.md](GEMINI_KEY_ROTATION.md)) and set it only on Vercel and
in V1's `.env.local`; V2 keeps the old key until it gets its own. Real-key behaviour (valid model id, quota, latency) is **NOT VERIFIED** and needs the bounded test in R11.

### 7.5 Firewall transition

Keep *Block legacy AI API* (deny `/api/ai`) and Cloudflare Access until R10 is green. R11 relaxes the rule for the owner's IP only, for ≤ 5 requests; the full deny is restored right after.
Final state (D5): keep deny-all until public AI is wanted; then allow `/api/ai` (the app enforces JWT + project membership + quota) together with an IP rate-limit rule (plan availability NOT VERIFIED).

### 7.6 Deployment strategy

Branch stays on `consolidation/security-foundation`. R1 proves `frontend/vercel.json` (no Git-triggered deployments). Then, from a clean checkout at the repository root:
`vercel deploy --prod --skip-domain` → staged smoke (§4) → `vercel promote`. Run `frontend/scripts/check-production-bundle.sh` on the build first. Merge to `main` only after promotion. No flag in the repository can enable
the dev login on a deployment: the component is excluded from production bundles and the endpoint answers 404 unless `NODE_ENV=development`, loopback host, no tunnel headers, flag set, not on Vercel.

### 7.7 What P5 verified, and how

| Area | Evidence | Level |
|---|---|---|
| Login, session persistence, logout, protected routes, wrong password, unconfirmed account refused | `e2e/supabase-hosted.spec.ts` (real browser, real UI) | **hosted** |
| Workspace + project creation, task create/edit/move (drawer and drag&drop), checklist, comment, assignee, calendar, dashboard, Project Intelligence, project creation, team page, invitation (UI + RPC accept) | same spec, database re-read after each action | **hosted** |
| Cross-user isolation (read, update, delete, insert, restore RPC), invitation grants no project access, AI History restore atomic + owner-only | same spec | **hosted** |
| AI gateway without a key: 401/503, ledger | same spec | **hosted** (no Gemini contact) |
| All browser traffic went only to `twjlnsxjtuntujarwner.supabase.co` | same spec; bundle scan: old ref absent | **hosted** |
| Realtime | `supabase/tests/realtime_check.mjs` | **hosted** and local stack |
| Registration with e-mail delivery + link | `supabase-confirm-email.spec.ts` on the local stack (Mailpit); **not possible on the hosted project** (see §7.2) | local only |
| Storage API behaviour | `supabase/tests/storage_real_stack.sh` (26 checks) | local real stack only |
| RLS/definer/quota SQL suites incl. non-superuser, legacy upgrade, drift, concurrency | `supabase/tests/run.sh` (290 assertions), `real_stack.sh` (+ 26 HTTP regression checks) | local |
| Deterministic Project Intelligence calculations | unit tests; rendered from hosted data in the spec | unit + hosted render |
| Gemini | mock provider in unit tests only | mocked |

### 7.8 Bugs found against the hosted database and fixed in this branch

Seeding deleted columns/cards and raced (409/403); drag&drop, edit-card, checklist and add-card persistence read values assigned inside a lazily run state updater (writes silently skipped);
demo columns were shown before the DB board loaded (cards added early failed RLS); new real accounts' projects started with demo member ids (nobody assignable); `inspect_hosted.sql` was not read-only through the pooler;
`authenticated` held TRUNCATE/TRIGGER/REFERENCES; the attachments bucket did not exist and the old code used public URLs.
