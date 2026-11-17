# Approval package — first three production-affecting steps (R1, R2, R6)

Prepared 2026-11-17 for branch `consolidation/security-foundation`. **Nothing below has been executed.** Each approval is independent
(a yes to A1 does not cover A2 or A3) and has: what changes, the exact commands, the gate, how to undo it, and a sentence you can paste to approve it.
Order: **A1 → A2 → A3**. A2 and A3 do not depend on A1 and can be approved in any order, but A1 must pass before anything is pushed to GitHub (§ "After A3").

## Baseline captured read-only just before writing this (re-check right before each step)

| Item | Value |
|---|---|
| Vercel project | `bng-dev-alt-webadvisor/clearspace` (scope `bng-dev-alt-webadvisor`); newest deployment `clearspace-86theeb4x` (Production, 111 days old) |
| GitHub remote | `https://github.com/bng-dev-alt/clearspace.git`; `main` = `ff615c3` |
| New Supabase project | `twjlnsxjtuntujarwner`: migrations 100/200/300 applied, 15 tables all RLS, 0 buckets, Realtime = `activity_logs, cards, columns`, 1 user (dev account), Confirm email ON (`mailer_autoconfirm=false`), sign-ups enabled |
| Protections | Vercel firewall deny `/api/ai` → 403, Cloudflare Access → 302, port 3130 closed, launchd origin agent disabled |

Pre-flight for every step: `git status` clean on the branch, HEAD = the commit you approved, `npm test` green (216 tests), `frontend/supabase/tests/run.sh` green (290 assertions).

---

## A1 — Prove the deploy guard (R1)

**Why first:** `frontend/vercel.json` (`git.deploymentEnabled=false`) is what makes pushing/merging safe. It is Vercel-documented but **not yet proven** for this project
(Root Directory `frontend`). Until proven, every push to this GitHub repo can deploy (any branch → Preview, `main` → Production).

**What changes:** one new throwaway branch `guard-test-tmp` on GitHub containing a single file, `frontend/vercel.json`. No code, no secrets. Deleted afterwards.
If the guard does *not* work, Vercel would try to build that branch as a Preview; with no `package.json` in `frontend/` the build fails and uses no code — harmless, and the firewall/Vercel Authentication still apply.

```bash
# 1. Build the one-file orphan branch in a temp dir (nothing from the worktree is touched)
T=$(mktemp -d) && cd "$T" && git init -q -b guard-test-tmp && mkdir frontend \
  && cp /Volumes/WORKSPACE/Dev/Apps/ClearSpace/V1-consolidation/frontend/vercel.json frontend/ \
  && git add . && git -c user.name=guard -c user.email=guard@localhost commit -qm "guard test: vercel.json only"
# 2. Push it (the ONLY outward action)
git push https://github.com/bng-dev-alt/clearspace.git guard-test-tmp
# 3. Wait ~2 minutes, then look for any deployment of that commit
V=/Users/beng/.npm/_npx/67eb4586ca667318/node_modules/.bin/vercel
$V ls clearspace --scope bng-dev-alt-webadvisor | head -8        # newest must still be clearspace-86theeb4x
gh api repos/bng-dev-alt/clearspace/commits/guard-test-tmp/statuses --jq '.[].context'   # no "Vercel" status expected
# 4. Remove the throwaway branch
git push https://github.com/bng-dev-alt/clearspace.git --delete guard-test-tmp
```

**Gate (PASS):** no new deployment in `vercel ls` and no Vercel status on the commit. → the guard works; later pushes/merges deploy nothing.
**FAIL:** a deployment (even a failed one) appears → the guard does **not** work. Then: delete the branch, **do not push or merge anything else**, and the plan switches to a settings-level guard
(separate approval, changes the Vercel project: Production Branch → dummy, or an Ignored Build Step).
**Undo:** the branch is deleted in step 4; nothing else changed.

> **Approval text:** „Schvaluji A1: push jednorázové větve `guard-test-tmp` (jen `frontend/vercel.json`) na GitHub `bng-dev-alt/clearspace`, kontrolu Vercelu a následné smazání větve. Žádný jiný push.“

---

## A2 — Supabase Auth URL configuration (R2) on the NEW project only

**What changes:** two Auth settings of `twjlnsxjtuntujarwner` (not the old project, not MicroCRM): Site URL and the redirect allow-list. Today they are the defaults (`localhost:3000`), so confirmation / recovery
links would point at localhost.

| Setting | New value |
|---|---|
| Site URL | `https://clearspace-ai.vercel.app` |
| Redirect URLs (allow-list) | `https://clearspace-ai.vercel.app/**` (nothing else) |
| Confirm email | stays **ON**; sign-ups enabled; email provider only |

**How (pick one):**
- *Dashboard (no credentials from me):* Authentication → URL Configuration → set both → Save.
- *Me via the Management API* (needs your yes to use the Supabase CLI login token for this one call):
  `PATCH https://api.supabase.com/v1/projects/twjlnsxjtuntujarwner/config/auth` with `{"site_url":"https://clearspace-ai.vercel.app","uri_allow_list":"https://clearspace-ai.vercel.app/**"}`; the token stays in a shell variable, is never printed.

**Gate:** read the config back (`GET …/config/auth` or the dashboard) and `curl …/auth/v1/settings` still shows `mailer_autoconfirm:false`, sign-up not disabled.
**Undo:** set Site URL back to `http://localhost:3000` and clear the allow-list (same call).

**Decision that comes with A2 — e-mail delivery (D2).** The built-in mailer only reaches members of your Supabase organisation and is rate-limited; the Auth service also refuses addresses on non-existent domains.
- *Owner-only release (default, free):* works; only your own organisation e-mail can register. Anyone else cannot get a confirmation mail.
- *Public release:* needs custom SMTP (a mail provider such as Resend/Postmark/SES plus its credentials, entered by **you** in Authentication → SMTP; I will not handle those credentials) and a plan that allows it.

**Side effect to know:** until the new build is promoted, the live old site is still the old app on the old project; a confirmation link generated for the new project would open that old site. Do not register real users before R10.

> **Approval text:** „Schvaluji A2: nastavit Site URL `https://clearspace-ai.vercel.app` a redirect URL `https://clearspace-ai.vercel.app/**` v Auth projektu `twjlnsxjtuntujarwner` (způsob: dashboard / Management API — škrtni). Confirm email zůstává zapnuté. D2: vydání nejdřív jen pro vlastníka (vestavěný mailer).“

---

## A3 — Apply migration `20261117000400_task_resources_storage.sql` (R6) to the new project

**What changes (additive, one transaction):** creates the private bucket `task-resources` (10 MiB, MIME allow-list without SVG/HTML/script), the function `public.can_access_task_file`, three policies on `storage.objects`
(select/insert/delete for members of the card's project), and the marker row in `public.clearspace_migrations`. No existing table, row or user is touched. A rolled-back probe already proved `postgres` may do this on this project.

```bash
cd /Volumes/WORKSPACE/Dev/Apps/ClearSpace/V1-consolidation
DB="host=aws-0-eu-west-1.pooler.supabase.com port=5432 user=postgres.twjlnsxjtuntujarwner dbname=postgres sslmode=require"
IMG=public.ecr.aws/supabase/postgres:17.6.1.147
PW() { security find-generic-password -s "ClearSpace V1 – Supabase Database" -a "postgres.twjlnsxjtuntujarwner" -w; }   # Keychain, never printed

# 0. pre-check (read-only; the script sets its own session read-only)
PGPASSWORD=$(PW) docker run --rm -e PGPASSWORD -v "$PWD/frontend/supabase:/w:ro" $IMG psql "$DB" -X -f /w/inspect_hosted.sql | grep -A4 "== 15\."
# 1. apply (preflight aborts everything with a clear message if a precondition is missing)
PGPASSWORD=$(PW) docker run --rm -i -e PGPASSWORD -v "$PWD/frontend/supabase:/w:ro" $IMG \
  psql "$DB" -X -v ON_ERROR_STOP=1 -q --single-transaction -f /w/migrations/20261117000400_task_resources_storage.sql
# 2. verify
PGPASSWORD=$(PW) docker run --rm -e PGPASSWORD $IMG psql "$DB" -X -At -c \
  "select id||' public='||public||' limit='||file_size_limit from storage.buckets; select count(*) from pg_policies where schemaname='storage'; select version from public.clearspace_migrations order by 1"
# 3. end-to-end: the previously skipped hosted Storage test must now run and pass (creates + deletes its own disposable accounts)
(cd frontend && npm run dev -- -p 3410 -H 127.0.0.1 &) ; sleep 8; (cd frontend && PW_CHROMIUM_PATH=<installed chromium> scripts/hosted-verify.sh)
```

**Gate:** bucket row `task-resources public=false limit=10485760`; 3 storage policies; four migration markers (100–400); `hosted-verify.sh` ends `16 passed` (Storage test no longer skipped), `leftovers` shows only the dev account's 1 project.
**Undo (if ever needed):** the migration is additive. `DROP POLICY task_resources_files_{select,insert,delete} ON storage.objects; DROP FUNCTION public.can_access_task_file(text); DELETE FROM public.clearspace_migrations WHERE version='20261117000400_task_resources_storage';`
and delete the (empty) bucket through the Storage API/dashboard — SQL deletes on Storage tables are blocked by Supabase. Without the bucket the app falls back to a loud upload error, nothing else breaks.
**Failure mode:** a failing statement rolls the whole transaction back — nothing changes.

> **Approval text:** „Schvaluji A3: aplikovat migraci `20261117000400_task_resources_storage.sql` na projekt `twjlnsxjtuntujarwner` (jedna transakce, role postgres) a spustit ověřovací harness, který si vytvoří a smaže jednorázové účty.“

---

## After A3 — what comes next (separate packages, nothing to approve yet)

| Next | Needs | Depends on |
|---|---|---|
| **A4 Vercel env** (R7): `NEXT_PUBLIC_SUPABASE_URL/ANON_KEY` → new project, `AI_*` limits (3/10/50000); Production + Preview; replaces values (old hidden values are not recoverable — the old project's URL/anon key are known and recorded here: ref `bjycwqfessddbfocrggt`) | your yes | A1 PASS recommended |
| **A4b Gemini** (R7/R13): you create a key for V1 in its own Google project (ideally billing-less) and supply it to Vercel yourself or via a stdin prompt; V2 keeps the old key | your Google-side action | — |
| **A5 Staged deploy + promote** (R8–R10): local `npm run build` + `scripts/check-production-bundle.sh`, `vercel deploy --prod --skip-domain` from a clean checkout at the repo root, staged smoke (protection bypass NOT VERIFIED), `vercel promote` | A1, A2, A3, A4 | all of them |
| **A6 Bounded AI test + firewall state** (R11–R12) and **merge to `main`** | A5 green, Gemini key | A5 |

Do **not** merge to `main` or push this branch before A1 has passed.
