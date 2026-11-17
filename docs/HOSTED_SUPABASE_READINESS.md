# Hosted Supabase — identity, compatibility, backup and restore readiness

Status of the production-readiness preparation (P4, phases 1–4). Snapshot: 2026-11-17, branch
`consolidation/security-foundation`. **Nothing here touched the hosted project**: it could not be queried (it is
paused) and resuming it is a production state change that needs approval.

Legend: **VERIFIED** = observed first-hand · **INFERRED** = derived from repo/history · **NOT VERIFIED** = could not be checked ·
**BLOCKED** = needs an approval or an action by the owner first.

## 1. Which project is ClearSpace V1's database

| Fact | Value | Status |
|---|---|---|
| Hosted project | **`ClearSpace`**, ref `bjycwqfessddbfocrggt`, region eu-west-1, created 2026-07-23 | VERIFIED (Supabase CLI project list, owner organisation) |
| Postgres | 17.6.1.147 | VERIFIED (same list) |
| **Status** | **`INACTIVE` — paused.** `bjycwqfessddbfocrggt.supabase.co` and `db.bjycwqfessddbfocrggt.supabase.co` do **not resolve** (empty DNS answer). | VERIFIED |
| Used by | V1 `frontend/.env.local` and the clone under `Vibe Coding Projects` point at it; the **deployed** Vercel build embeds the same host in its public JS (the only Supabase host in all 10 chunks). | VERIFIED |
| Not used by | V2 (`127.0.0.1:54421`) and MicroCRM (`127.0.0.1:54321`) configs are local. MicroCRM has its own hosted projects (`MicroCRM`, `MicroCRM Production`), also `WebAdvisor` and `RAG` exist in the same organisation. **Never run anything from this repository against those.** | VERIFIED (config), INFERRED (no other consumers) |
| Backups | `backups: []`, `pitr_enabled: false` | VERIFIED (CLI) |
| Plan | not shown by the CLI; no backups listed + the project was auto-paused ⇒ almost certainly the Free plan (Free has no automatic backups and is paused after a week of low activity) | INFERRED, confirm in Billing |
| Pause date | unknown. Vercel production last updated 2026-07-30, so the pause probably happened in August. | NOT VERIFIED |

**Consequence 1 — production is inert.** The live site cannot authenticate anybody: the Supabase host does not resolve.
Together with the Vercel firewall rule on `/api/ai/*` and Cloudflare Access on the origin host, nothing of this app
currently works or is exposed. That is a safe state; there is no time pressure to deploy.

**Consequence 2 — "migrate production" may not be possible in place.** Supabase restores paused Free projects only
within a window (the docs disagree: the 2024 changelog says 90 days, the current restore guide says 1 year). Beyond it
the dashboard offers only a *download* of the last logical backup + Storage objects, to be restored into a **new**
project. Upgrading to a paid plan re-enables an expired one-click restore. Open the project in the dashboard to see
which of the three applies.

## 2. Read-only audit of the hosted database (phase 1)

| Item | Status | Why / how to close it |
|---|---|---|
| PostgreSQL version | VERIFIED | 17.6.1.147 (CLI metadata). The test image used for all rehearsals is exactly this version. |
| Schemas, tables, columns, constraints | **BLOCKED** | Project paused. After a restore run `frontend/supabase/inspect_hosted.sql` (below). |
| Existing migrations | **BLOCKED** (INFERRED from history) | The repo only ever had one idempotent script (`supabase_schema.sql`, last change on `main` 2026-07-30, v1.3 workspace-level invitations). The base tables `projects/columns/cards` have **no `CREATE TABLE` in `main`** — they were created outside the repository, so their real definition is unknown. |
| RLS policies, SECURITY DEFINER functions, ownership, default privileges, extensions | **BLOCKED** | same |
| Storage buckets/policies, Realtime publication | **BLOCKED** | same; **not touched by the migrations**, so the migrations cannot break them, but the *app* depends on them (S10 in the readiness checklist). |
| Auth configuration (Confirm email, Site URL, redirect URLs, providers) | **BLOCKED** | Dashboard → Authentication. Public `/auth/v1/settings` is unreachable while paused. |
| Existing invitation records | **BLOCKED** | inspection section 11 gives counts per status and the number of still-plaintext tokens. |

**How to run the audit once the project is running** (metadata and aggregate counts only, no row contents; the session is
read-only, so it cannot change anything):

```bash
# DB_URL = Dashboard → Connect → *Session pooler* string (direct db.<ref> hosts are IPv6-only without the add-on).
# Keep it out of shell history; use a file-descriptor or an env var set for this one command.
docker run --rm -i -e PGOPTIONS='-c default_transaction_read_only=on' -e DB_URL \
  public.ecr.aws/supabase/postgres:17.6.1.147 sh -c 'psql "$DB_URL" -X' \
  < frontend/supabase/inspect_hosted.sql > hosted-inspection-$(date +%Y%m%d).txt
```

(`psql`/`pg_dump` are not installed on this machine; the cached Supabase Postgres image carries matching 17.6 clients.)
The script was rehearsed on a throwaway 17.6.1.147 container in a read-only session (it ran without a write attempt);
there only four sections reported "relation does not exist" (`auth.identities`, `storage.*`, `supabase_migrations`) because
the throwaway image has no GoTrue/Storage/CLI-history tables — on the hosted project those exist.

## 3. Migration compatibility matrix (phase 2)

Reviewed: `20261117000100_security_foundation.sql`, `20261117000200_restore_project_board.sql`, runbook.
"Hosted" findings are **inferred from the repository history** until section 2 has been run.

| # | Migration assumption | Verdict | Notes |
|---|---|---|---|
| 1 | 13 public tables exist (`profiles, projects, columns, cards, workspace_members, project_members, invitations, activity_logs, task_resources, task_checklists, task_comments, task_activities, card_assignees`) | **NOT VERIFIED** | Preflight lists whatever is missing and changes nothing. `projects/columns/cards` DDL is not in `main`. |
| 2 | Columns the migrations read/write on those tables | **REQUIRES ADAPTATION → done** | Was only partly checked. Preflight now verifies 25 columns (migration 1) and 36 columns (migration 2, whose plpgsql body would otherwise fail only when someone restores a board), the types `projects.id = text`, `profiles.id = uuid`, and the helpers `is_project_owner`/`can_view_workspace`. Tested by drift scenarios D1–D4. |
| 3 | `invitations` is the v1.3 workspace-level shape | **NOT VERIFIED** | Checked by preflight (`workspace_id`, `token`, plus the columns above). History shows the v1.3 refactor had two follow-up fixes (CREATE TABLE IF NOT EXISTS on an existing v1.2 table; project-level policies), so an older shape is plausible. Legacy policies are all dropped by the migration. |
| 4 | `pgcrypto` in schema `extensions` | COMPATIBLE (Supabase default) / NOT VERIFIED | Preflight refuses otherwise. |
| 5 | Function and table **ownership** (the migration runs `ALTER FUNCTION … SET search_path`, `CREATE POLICY`, `CREATE TRIGGER`) | **REQUIRES ADAPTATION → done** | On hosted Supabase the SQL editor/`psql` run as the **non-superuser `postgres`**; the old test harness ran as a superuser, so ownership problems were invisible. Preflight now refuses with `owner:<object>` when the migrating role does not own an object it alters. Scenario D5 (non-owner refused) and **scenario E (everything as `postgres`)** prove both directions. |
| 6 | Default privileges (`ALTER DEFAULT PRIVILEGES … REVOKE … FROM anon`) | COMPATIBLE for objects created by the migrating role; NOT VERIFIED for objects created by `supabase_admin` | Only affects future objects of that role. Inspection section 9 lists the real defaults. |
| 7 | `REVOKE ALL ON ALL TABLES … FROM anon` | COMPATIBLE | The app uses the anon key only to reach GoTrue and the `invitation_preview` RPC; 26 HTTP checks on a real stack passed (run before the preflight-only change; see §4). |
| 8 | Existing pending invitations | **Data impact, by design** | Marked `expired`, plaintext tokens erased; owners must re-invite. The migration now prints the exact number (`Preflight ok. Pending invitations that will be expired: N`). |
| 9 | Storage (public bucket, `upsert`, no policies in repo) | NOT VERIFIED / not a migration dependency | Open hardening item S10. |
| 10 | Realtime (`supabase_realtime` ⊇ `columns, cards, activity_logs`) | COMPATIBLE (INFERRED) | Migrations do not alter publications; Realtime evaluates the same RLS policies for `authenticated`. |
| 11 | Application compatibility | COMPATIBLE | App never reads anonymously, never inserts into `invitations` directly, does not use `.select()` after project insert. Unit 184/184, build, demo e2e and real-stack browser specs passed on this code. |
| 12 | Auth: *Confirm email* ON, redirect URLs, Site URL | **BLOCKED** | Dashboard settings; needed for e-mail-bound invitations. |
| 13 | Hosted PostgREST/GoTrue versions vs local CLI images | NOT VERIFIED | residual risk, covered by the post-deploy smoke tests |

## 4. Rehearsal evidence (phase 4) — all in throwaway containers, never the hosted DB

Run on `supabase/postgres:17.6.1.147` (**the hosted version**), `frontend/supabase/tests/run.sh`:

| Check | Result |
|---|---|
| Fresh DB: baseline → migrations → migrations again, baseline re-run refused | pass |
| SQL suites (RLS isolation 30, invitations 42, AI quota 25, definer hardening 7, restore atomicity 21) as superuser | 125 assertions pass |
| **The same suites as the hosted role model (non-superuser `postgres`), applied twice** | **125 assertions pass** |
| Legacy-data upgrade (plaintext tokens, stray permissive policies, members, boards) with synthetic data | pass; no row lost, plaintext tokens erased, pending invitations expired |
| Drift: dropped `profiles.display_name`, renamed `invitations.expires_at`, dropped `cards.archived`, migration 2 before 1 | each refused with the precise `col:`/`migration:` message, **database unchanged** |
| Non-owner role | refused with `owner:public.…`, database unchanged |
| Missing baseline | refused, nothing created |
| Parallel reservations (12 psql / 8 HTTP) | exactly the limit passes |

Earlier (before the preflight-only change, see commit `85abc08`): real local Supabase stack (GoTrue + PostgREST),
legacy upgrade + 26 HTTP checks, and browser specs with *Confirm email* ON and OFF. The preflight change adds checks
only and alters no behaviour, so those were **not** re-run; re-run `real_stack.sh` once more if you want the full chain on
the final commit. The runbook's stack recipe is current.

**Differences from the hosted environment that remain (NOT VERIFIED):** the real column definitions of
`projects/columns/cards` (the baseline reconstructs them from application code), real policy leftovers, real data volume and
data quality, Storage and Realtime, Auth dashboard settings, GoTrue/PostgREST versions.

## 5. Backup and restore readiness (phase 3)

| Question | Answer |
|---|---|
| Managed backups / PITR? | **None** (`backups: []`, `pitr_enabled: false`). Free-plan projects have no automatic backups; Supabase itself recommends exporting with the CLI and keeping off-site copies. |
| Consistent logical backup possible? | Yes, once the database is reachable: `pg_dump` takes a consistent snapshot (single transaction). It needs the project to be **running** (resume/restore first). |
| Auth | `auth.users`/`auth.identities` live in the `auth` schema, which `supabase db dump` **excludes by default**. `public.profiles`, `workspace_members` reference `auth.users`, so a restore of `public` alone is not usable. Use `pg_dump --schema=public --schema=auth` (runbook §3) and rehearse the restore. |
| Storage | **Not in any database dump** — only metadata rows are. Objects must be copied separately (dashboard download, Storage API, or the CLI). Check inspection section 13 for the object count first; if it is zero, nothing to back up. |
| Paused-project path | Dashboard offers "Download backup" (latest logical backup taken just before the pause + Storage objects) when in-place restore has expired. This is a **data export of private records: only the owner should trigger it**, and it must be stored outside the repository. |
| Integrity check | `pg_restore --list` readable, `shasum -a 256` recorded, and — the real proof — **restore into a scratch database and compare the row counts** from inspection section 3. |
| Isolated staging copy | **Yes, locally**: restore the dump into the `supabase/postgres:17.6.1.147` container (same version as hosted) and run the runbook §5–7 + `run.sh` assertions against that copy. Option 2: a second hosted project (new, empty) — only if a dashboard-level rehearsal is wanted. |
| What was done | Only non-sensitive work: nothing was dumped, no private record was read, no existing backup (e.g. `_G2_BACKUP/20261117-044619-v1-consolidation-preflight`, **code only**, manifest re-verified) was touched. |

### Procedure (owner runs it; commands never print the connection string)

```bash
# 0. Resume/restore the project in the dashboard (or download the backup if the window has passed) — owner action.
# 1. Read-only inspection (section 2 above). Stop if it differs from the matrix.
# 2. Logical dump (custom format, public + auth), taken with the same-version client:
docker run --rm -e DB_URL -v "$BACKUP_DIR:/out" public.ecr.aws/supabase/postgres:17.6.1.147 \
  sh -c 'pg_dump "$DB_URL" --format=custom --no-owner --schema=public --schema=auth --file=/out/clearspace-pre-migration.dump'
# 3. Integrity + restore proof into a THROWAWAY container (never the hosted DB):
docker run --rm -v "$BACKUP_DIR:/out" public.ecr.aws/supabase/postgres:17.6.1.147 pg_restore --list /out/clearspace-pre-migration.dump | head
shasum -a 256 "$BACKUP_DIR/clearspace-pre-migration.dump"
#    restore into a scratch DB (as in frontend/supabase/tests/run.sh: newdb + pg_restore), compare row counts with inspection section 3.
# 4. Storage objects: copy separately if section 13 shows any.
```

`BACKUP_DIR` must be outside every repository. Expect some `already exists` errors when restoring `auth`/`extensions` into a
Supabase-flavoured database; review them, they are normally harmless, but **a restore into the scratch database that has
errors you cannot explain is a stop condition** (runbook §9).

**Recovery after a failed release** is in [RELEASE_PLAN.md](RELEASE_PLAN.md#recovery): fix forward first; restore the dump into
a *new* project rather than in place, and accept that writes after the dump are lost.

**Alternative that avoids all of this:** if the data in the old project does not matter (it was a portfolio/dev project), create a
**new empty project**, apply `supabase_schema.sql` + the two migrations, and point Vercel to it. No legacy invitations, no
preflight surprises, and a backup of nothing is trivially restorable. This is the recommended default unless the owner confirms
that the old data must be kept (decision D1 in the release plan).
