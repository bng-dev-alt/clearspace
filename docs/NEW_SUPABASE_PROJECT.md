# New Supabase project for ClearSpace V1 (decision D1 = new project)

Snapshot 2026-11-17. The owner chose a **new, clean project** instead of restoring the old one. The old project
`ClearSpace` (`bjycwqfessddbfocrggt`) was **not touched** (still `INACTIVE`, not resumed, nothing read from it).

Legend: **VERIFIED** observed first-hand · **INFERRED** derived · **NOT VERIFIED** could not be checked.

## 1. Was there a reason to keep the old database? — read-only search

| Source searched | Finding |
|---|---|
| Old project contents | **NOT VERIFIED — cannot be inspected while it is paused (DNS dead). It is not claimed to be empty.** |
| Local dumps / backups | `_G2_BACKUP/*` holds dumps of local Docker databases of **V2** and **MicroCRM** and unrelated SQLite files only. **No dump of the hosted V1 database exists anywhere locally.** No `.sql/.dump/.csv` export of ClearSpace data in the repositories, Downloads, Desktop or Documents. |
| Git history (all branches) | Only schema, migrations, tests and the in-code demo seed (`seedBoard.ts`); no data files were ever committed. |
| Project docs (review notes 21–24) | The app was developed **demo-first on `localStorage`**; the Supabase path was added and verified by types/build/tests, with "one manual smoke test after deploying the schema" as the stated follow-up. Earlier phases of this work found the persistence layer even silently fell back to `localStorage` when writes failed. → points to a portfolio/demo database, but this is **INFERRED**, not proof. |
| Supabase backups | `backups: []`, PITR off (Free plan, inferred) → nothing to restore from if the old project's data was lost. |

Conclusion: **no evidence of irreplaceable data**, but it cannot be excluded. The old project stays as it is, so nothing
is lost by this decision. If it is ever needed it can still be resumed (or restored from the last pause backup within
Supabase's restore window) — that remains an owner action. Do not delete it until the new release has run for a while.

## 2. The new project

| Fact | Value |
|---|---|
| Name / ref | **`ClearSpace V1`**, ref `twjlnsxjtuntujarwner` (public identifier; it appears in every client bundle anyway) |
| Organisation | `bng-dev-alt` (same org as the other Supabase projects; no other project was touched; `MicroCRM Production` stayed `ACTIVE_HEALTHY`) |
| Region / Postgres | eu-west-1 / 17.12 — **VERIFIED** |
| Cost | Created with no compute-size override. Dashboard export of 2026-08-31 showed the org on the **Free plan** (nano compute); the org currently has 2 active projects (the Free limit). **Plan not re-verified today** — confirm in Billing that no charge appears. |
| Secrets | DB password generated locally, stored only in the session scratchpad (mode 600), never printed or committed → **reset it in the dashboard (Database → Settings) and keep it in your password manager.** The anon key is public by design; the service-role key was not retrieved or used. |
| Data | **empty** before the migrations (11 MB, 0 users, 0 tables) — VERIFIED with `inspect_hosted.sql` |

## 3. What was applied (this is a new, owner-authorised, empty project — not the old production database)

Baseline `supabase_schema.sql` → `20261117000100_security_foundation` → `20261117000200_restore_project_board` →
`20261117000300_least_privilege_table_grants`, each in one transaction through the session pooler, as the hosted
non-superuser role `postgres`. All three markers are in `public.clearspace_migrations`. Nothing else was written
(no users, no rows).

## 4. Verified on the real hosted project

| Check | Result |
|---|---|
| 15 public tables, RLS enabled on all | VERIFIED |
| `anon` has **no** table privilege; Data API `GET` on 8 tables as anon → `42501 permission denied` | VERIFIED |
| `restore_project_board`, `is_project_owner`, `can_view_workspace` not callable as anon (`PGRST202`) | VERIFIED |
| `invitation_preview` is the only anonymous RPC; a junk token returns `state: invalid`, no data | VERIFIED |
| Every SECURITY DEFINER function pins `search_path` | VERIFIED |
| Auth: email provider only, **Confirm email ON** (`mailer_autoconfirm=false`), sign-ups enabled | VERIFIED (public `/auth/v1/settings`) |
| **Finding fixed:** the hosted default privileges gave `authenticated` TRUNCATE/TRIGGER/REFERENCES on 12 tables (TRUNCATE ignores RLS). Local shims did not reproduce it. Fixed by migration 300 (+ test `60_…`, applied here, re-checked) | VERIFIED |
| **Finding fixed:** the pooler drops `PGOPTIONS`, so the "read-only" inspect session was not actually read-only. `inspect_hosted.sql` now sets the session read-only itself; a write attempt is refused | VERIFIED |

**Not verified on the hosted project:** RLS behaviour for signed-in users (needs real confirmed users — that is covered by
the SQL suites in the local role-faithful database and by the `real_stack` run, not by hosted accounts, because creating
accounts would send e-mails); Storage (no buckets are used); Realtime publication (empty; the app's realtime tables are
not in it yet — check against the feature before release); Auth redirect URLs / Site URL (still the Supabase defaults —
must be set to the final site URL at release); SMTP (the default Supabase mailer is rate-limited, fine for a demo only).

## 5. What changes in the release plan

* D1 is decided: the release uses `twjlnsxjtuntujarwner`. Steps R2 (resume/restore), R4 (production dump) and the
  "apply migrations to existing data" part of R6 **are no longer needed**; the old data path is dropped.
* Still separate approvals: Vercel env vars (`NEXT_PUBLIC_SUPABASE_URL/ANON_KEY` → new project, Gemini key), the staged
  deploy and promote, firewall changes, merge to `main`, Auth URL configuration, custom SMTP if wanted.
* The old project's host stays baked into the **currently deployed** build until that new deployment replaces it.
