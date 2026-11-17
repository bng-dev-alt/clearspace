# Migration runbook — ClearSpace V1 security foundation

Applies to branch `consolidation/security-foundation`. **Nothing in this runbook has been run against a real
(hosted) Supabase project.** Everything below was verified on throwaway local databases only (see
[What was and was not verified](#what-was-and-was-not-verified)).

Files, in this order:

| # | File | Purpose |
|---|---|---|
| 0 | `frontend/supabase_schema.sql` | **Baseline.** Only for a new database, or the one-time catch-up of an unversioned one. Refuses to run once the migrations below exist. |
| 1 | `frontend/supabase/migrations/20261117000100_security_foundation.sql` | profiles/anon lockdown, `SECURITY DEFINER` hardening, forced-membership guards, hashed invitations (RPCs), AI ledger + quota RPCs |
| 2 | `frontend/supabase/migrations/20261117000200_restore_project_board.sql` | atomic, owner-only board restore RPC |

## 1. What changes for users and operators

| Change | Effect |
|---|---|
| **Pending invitations are expired and their plaintext tokens erased** | Every owner must invite again. Accepted/revoked rows are kept. No row is deleted. |
| Invitation links are shown **once**, at creation | The team page can no longer copy an old link; "invite again" replaces the pending one. |
| Invitations bound to the **verified** e-mail of the account | Enable *Confirm email* in Supabase (both settings were tested; ON is the recommended one). |
| `anon` (the public key) has **no** table access; `profiles` only readable by their owner | Any client that read other users' profiles or invitations directly stops working (the app does not). |
| AI endpoints need a signed-in Supabase user | No AI in demo mode; **without migration 1 the AI gateway fails closed (HTTP 503)**. |
| Per-user / global rate limit and daily token budget | Defaults 10 / 60 per minute, 200 000 tokens per user per day (`AI_*` env vars). An **estimate**-based throttle, not a spending cap. |
| AI History restore replaces one project's board only (owner only) | Restoring an AI-created project deletes exactly that project. |
| Removed: password-reset modal, "Vlastník" invite role; OAuth buttons only with `NEXT_PUBLIC_ENABLE_OAUTH=1` | These never worked. |

## 2. Prerequisites

- A **staging** Supabase project or local copy restored from a production backup (section 4). Rehearse there first.
- Database owner access (the `postgres` role used by the SQL editor / CLI). The `ALTER FUNCTION … SET search_path`
  statements require that the role owns the functions — check with the query in section 5.
- `pgcrypto` installed in the `extensions` schema (Supabase default). The migration's preflight refuses otherwise.
- The deployed schema must be the v1.3 baseline (`invitations.workspace_id`, `accepted_at`, `token`). The
  preflight lists anything missing and changes nothing.
- Decide the maintenance window (see section 6, *ordering*).
- `GEMINI_API_KEY` quota/budget at Google set independently (the in-app limit is not a cap).

## 3. Backups (required, verified before anything else)

1. Supabase dashboard: confirm a recent backup / Point-in-Time-Recovery window exists, **or** make a manual dump:
   ```bash
   # DB_URL = the project's *session pooler* connection string (direct db.<ref> hosts are IPv6-only).
   # Keep it out of shell history and logs. psql/pg_dump are not installed on the dev machine: use the
   # same-version client from the cached image (see HOSTED_SUPABASE_READINESS.md section 5).
   docker run --rm -e DB_URL -v "$BACKUP_DIR:/out" public.ecr.aws/supabase/postgres:17.6.1.147 \
     sh -c 'pg_dump "$DB_URL" --format=custom --no-owner --schema=public --schema=auth --file=/out/clearspace-pre-migration.dump'
   docker run --rm -v "$BACKUP_DIR:/out" public.ecr.aws/supabase/postgres:17.6.1.147 pg_restore --list /out/clearspace-pre-migration.dump | head   # readable?
   shasum -a 256 "$BACKUP_DIR/clearspace-pre-migration.dump"
   ```
   `auth` must be included: `profiles` and `workspace_members` reference `auth.users`.
2. Store the dump **outside the repository**. Never commit it (it contains user data).
   Storage **objects** are not part of a database dump; copy them separately if the project has any.
3. Record row counts for the post-check (`frontend/supabase/inspect_hosted.sql`, section 3, gives exact counts, read-only): `profiles, workspace_members, projects, columns, cards, task_*, project_members, invitations, activity_logs, task_resources`.
4. **Stop condition:** if you cannot restore the dump into a scratch database successfully, do not proceed.

## 4. Rehearsal on a copy

Restore the dump into a scratch database (local Postgres / throwaway Supabase) and run sections 5–7 there.
For a local stack you can use the recipe in [Runtime verification stack](#runtime-verification-stack).

## 5. Pre-checks (read-only queries on the target)

Run `frontend/supabase/inspect_hosted.sql` first (metadata and counts only, read-only session). The migrations'
own **preflight** then refuses, changing nothing, when a required column/type/helper is missing or when the
migrating role does not own the objects it alters; it prints how many pending invitations will be expired.
The queries below remain the manual cross-check.

```sql
-- schema matches the baseline?  (all rows must exist)
select to_regclass('public.invitations'), to_regclass('public.task_resources'), to_regclass('public.activity_logs');
select column_name from information_schema.columns where table_schema='public' and table_name='invitations' order by 1;
-- expect: accepted_at, created_at, email, expires_at, id, invited_by, role, status, token, workspace_id   (NO project_id)

-- pgcrypto location (must be extensions)
select extname, extnamespace::regnamespace from pg_extension where extname = 'pgcrypto';

-- function ownership (must be the role that runs the migration, normally postgres)
select proname, proowner::regrole from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public' and proname in ('handle_new_user','is_project_owner','is_project_member','can_view_workspace','accept_workspace_invitation');

-- policies that will be replaced; anything unexpected here is a stop condition to understand first
select tablename, policyname, cmd, qual from pg_policies where schemaname='public' and tablename in ('profiles','invitations') order by 1,2;

-- what will be expired
select status, count(*) from public.invitations group by 1;

-- e-mail confirmation requirement: Authentication > Providers > Email > "Confirm email" must be ON (dashboard setting, not SQL)
```

## 6. Apply

**Ordering.** The new app and the migrations depend on each other:

- new app + old DB: AI gateway answers 503 (fail closed), invitation creation/acceptance fail (RPCs missing). Nothing destructive.
- old app + new DB: invitation creation (direct INSERT) and the team page listing (`select *`) fail because clients may no
  longer read `token_hash` or insert into `invitations`; **the old AI routes are still unauthenticated**, so reverting only
  the app does not restore a working state (and re-opens the hole).

So: backup → migration → deploy the new app straight after → verify. Accept a few minutes of degraded invitations/AI.

```bash
# one transaction per file; stops at the first error and leaves the database unchanged
psql "$DB_URL" -v ON_ERROR_STOP=1 --single-transaction -f frontend/supabase/migrations/20261117000100_security_foundation.sql
psql "$DB_URL" -v ON_ERROR_STOP=1 --single-transaction -f frontend/supabase/migrations/20261117000200_restore_project_board.sql
```

In the Supabase SQL editor paste **one file at a time** and check the result before the next. The files contain no
`BEGIN/COMMIT` (so they also work with `--single-transaction`); if your editor does not wrap a batch in a transaction,
use `psql`. Both migrations are idempotent: a second run changes nothing (tested). **Never re-run `supabase_schema.sql`
afterwards** — it raises on purpose.

## 7. Verification queries (all must hold)

```sql
select version from public.clearspace_migrations order by 1;                    -- both versions
select count(*) from information_schema.role_table_grants
 where table_schema='public' and grantee='anon';                                -- 0
select status, count(*) as n, count(token) as plaintext_tokens
  from public.invitations group by 1;                                           -- plaintext_tokens = 0 everywhere; no 'pending' rows from before
select policyname, cmd from pg_policies where schemaname='public' and tablename='profiles'; -- own SELECT + own UPDATE only
select p.proname, p.proconfig from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public' and p.prosecdef;                                      -- every row has search_path=public, pg_temp
select has_function_privilege('anon','public.accept_workspace_invitation(text,text)','EXECUTE'); -- false
select has_function_privilege('anon','public.invitation_preview(text)','EXECUTE');               -- true (the only anonymous RPC)
-- row counts equal to the pre-migration numbers (section 3.3), except invitations' statuses
```

Black-box checks (the public anon key only; these are plain GETs):

```bash
curl -s -o /dev/null -w '%{http_code}\n' -H "apikey: $ANON" "$SUPABASE_URL/rest/v1/profiles?select=email"   # 401 or 403, never 200 with rows
curl -s -o /dev/null -w '%{http_code}\n' -H "apikey: $ANON" "$SUPABASE_URL/rest/v1/invitations?select=id"   # 401 or 403
```

App smoke test (with a test account): sign in, reload (session persists), sign out; open the board; create an
invitation and accept it from a second account with the invited address; call one AI feature once;
AI History restore on a scratch project.

## 8. Rollback and recovery

**There is no down-migration, deliberately.** Reversing the SQL would re-open the vulnerabilities and cannot undo the data changes.

| Item | Reversible with SQL? | Notes |
|---|---|---|
| Policies, grants, function bodies/`search_path`, the member-identity trigger, `restore_project_board`, `ai_*` functions | Technically yes | Only as an emergency measure; it **re-exposes** profiles/invitations and the forced-membership hole. |
| New objects: `ai_requests`, `clearspace_migrations`, `invitations.token_hash` | Yes (drop) | `ai_requests` history would be lost. Dropping `token_hash` makes invitations unusable. |
| **Plaintext invitation tokens erased** | **No** | Only a backup restore brings them back. They were `Math.random()` tokens; restoring them is not desirable. |
| **Pending invitations marked `expired`** | **No** (status history) | Re-create invitations instead. A backup restore would also restore the weak tokens. |
| Anything written by users after the migration | n/a | A **backup / PITR restore discards all data written since the restore point.** |

Recovery decision:

1. Prefer **fix-forward** (a corrective migration) — most failures are fixed by a policy/function change.
2. Restore a backup/PITR **only** if data was corrupted or lost. That is an outage and loses every write after the restore
   point; export what you can first. Restore into a *new* project/database when possible and switch over, instead of in place.
3. Reverting only the web deployment is **not** a rollback (see section 6).

## 9. Stop conditions

Stop (and do not continue to the next step) when any of these happens:

- The backup/dump cannot be restored into a scratch database.
- The preflight raises (its message lists what is missing).
- A pre-check returns an unexpected policy/column, or the functions are owned by a role other than the one you migrate with.
- The migration errors (it is transactional — nothing was changed; fix the cause on staging first).
- A verification query deviates, row counts differ, or `anon` can read any table.
- *Confirm email* is OFF and you intend to rely on e-mail-bound invitations.
- Staging rehearsal was skipped.

## What was and was not verified

| Check | How | Status |
|---|---|---|
| Clean install, idempotent re-apply, baseline guard, preflight failure | isolated plain Postgres (`supabase/tests/run.sh`), 125 SQL assertions | verified |
| Upgrade of a database with legacy data (plaintext tokens, stray permissive policies) | isolated Postgres **and** real local Supabase stack (users created through real GoTrue) | verified, incl. a mutation run |
| RLS / invitations / AI quota / restore atomicity | SQL suites on both, plus 26 HTTP checks through GoTrue + PostgREST | verified |
| 12 parallel quota reservations (psql) and 8 parallel HTTP reservations | both | exactly the limit passed |
| Login, session persistence, logout, invitation accept in a browser; *Confirm email* ON and OFF; Mailpit link | Playwright against the local stack | verified |
| AI gateway auth/limits at runtime **without any Gemini key** | dev server on the local stack | verified (provider step fails closed, ledger rows `failed/ai_unavailable`) |
| Drifted schema (missing/renamed columns), non-owner role | drift scenarios D1–D5 | verified: refused with a precise message, database unchanged |
| Baseline + migrations + all SQL suites as the hosted role model (non-superuser `postgres`) on `supabase/postgres:17.6.1.147` | scenario E | verified |
| The real production/staging schema, owner roles, extension placement, Dashboard settings | — | **NOT VERIFIED** (the hosted project is paused; run section 5 after it is restored) |
| Supabase **Realtime** with the changed policies, **Storage** bucket policies | not part of the local stack | **NOT VERIFIED** |
| `ALTER DEFAULT PRIVILEGES … REVOKE … FROM anon` effect for objects created by roles other than the migrating one | — | **NOT VERIFIED** on hosted Supabase |
| Hosted PostgREST/GoTrue versions differ from the local CLI images | — | residual risk |

## Known behaviours worth knowing

- **Do not add `.select()` after inserting a project.** PostgREST then applies the SELECT policy to the new row, and
  `is_project_member()` (a `STABLE` function) cannot see a row of the statement that is still running → HTTP 403. The app inserts
  without RETURNING (pre-existing). Same idea for invitations: `PATCH … return=representation` would need `SELECT` on `token_hash`.
- The login form remounts after a *failed* login (the global `isLoading` flag swaps in the loader), so the e-mail field comes back empty. Pre-existing UX quirk.
- The demo seed has fixed July 2026 due dates (cards look overdue in other months). Pre-existing.

## Runtime verification stack

Local, throwaway, never a hosted project. `supabase start` binds to `0.0.0.0`: use it only for the test and stop it afterwards.

```bash
mkdir /tmp/cs-sb && cd /tmp/cs-sb && supabase init
# supabase/config.toml: project_id = "cs-v1-p2test"; ports api 55421, db 55422, shadow 55420, studio 55423,
# inbucket 55424, pooler 55429, analytics disabled; [auth] site_url = "http://127.0.0.1:3405",
# additional_redirect_urls = ["http://127.0.0.1:3405/**"]; [auth.email] enable_confirmations = true|false
supabase start -x studio,imgproxy,realtime,storage-api,edge-runtime,logflare,vector,postgres-meta,supavisor
# SQL + HTTP suites (applies baseline + migrations to that stack, creates users in it):
DB_CONTAINER=supabase_db_cs-v1-p2test API_URL=http://127.0.0.1:55421 ANON_KEY=<printed anon key> \
  SERVICE_ROLE_KEY=<printed service key> frontend/supabase/tests/real_stack.sh
# browser specs: start the app on loopback WITHOUT a Gemini key
cd frontend && NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:55421 NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon> \
  AI_RATE_PER_USER_PER_MINUTE=3 npx next dev -p 3405 -H 127.0.0.1
E2E_SUPABASE_URL=http://127.0.0.1:55421 E2E_SUPABASE_ANON_KEY=<anon> PLAYWRIGHT_TEST_BASE_URL=http://127.0.0.1:3405 \
  npx playwright test e2e/supabase-runtime.spec.ts        # Confirm email OFF
E2E_CONFIRM_EMAILS=1 E2E_SERVICE_ROLE_KEY=<service> E2E_MAILPIT_URL=http://127.0.0.1:55424 ... \
  npx playwright test e2e/supabase-confirm-email.spec.ts  # Confirm email ON
supabase stop --no-backup
```
