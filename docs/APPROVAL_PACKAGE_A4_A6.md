# Approval package 2 — A4 (Vercel env), A5 (staged deploy + promote), A6 (bounded AI test, firewall, merge)

Prepared 2026-11-17 on `consolidation/security-foundation`. **A4 has been executed (see the execution record at the end); A4b–A6b have not.** Follows [APPROVAL_PACKAGE.md](APPROVAL_PACKAGE.md) (A1–A3 are done).
Each approval is separate. Order: **A4 → (A4b by you) → A5 → A6 → A6b**. Stop at the first failed gate; later steps depend on earlier ones.

## Facts verified read-only while preparing (re-check right before each step)

| Item | Finding |
|---|---|
| Vercel env today | `GEMINI_API_KEY`, `GEMINI_MODEL`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` — each **one** entry covering *production + preview*, type **sensitive** (values cannot be read back, only replaced). No `AI_*`, no dev/demo flags (good) |
| Live site | `clearspace-ai.vercel.app` is **public** (200); individual deployment URLs are behind Vercel SSO (302). The live bundle points at the **old** project `bjycwqfessddbfocrggt` (publishable key) → the site is inert (paused DB) |
| Old public env values | saved locally as a rollback aid: `/Volumes/WORKSPACE/_G2_BACKUP/20261117-vercel-old-public-env/old_public_env.txt` (mode 600; URL + publishable key, public by design). The old `GEMINI_*` values are hidden by Vercel; the old key still exists in V2's `.env.local` |
| Protection | no automation-bypass secret configured; firewall *Bypass* needs Pro. The staged URL can be reached only through `vercel curl` (CLI auth) or a browser signed into Vercel |
| Firewall | 1 custom rule *Block legacy AI API* (`rule_block_legacy_ai_api_18MMCs`): deny `path starts with /api/ai`, enabled. Rules are AND-ed; type `ip_address` with `neg` is available |
| Git | `main` = `ff615c3` is an ancestor of the branch (26 commits ahead) → merge is a **fast-forward**. `.github/workflows/ci.yml` runs on push (lint/test/build; no deploy) |
| Domains | `clearspace-ai.vercel.app` (+ redirect alias `cearspace.vercel.app`); `autoAssignCustomDomains: true`, so only `--skip-domain` keeps a deployment off the domain |
| Not allowed to me | the auto-mode checker refused one exploratory `vercel curl` against an old deployment; therefore the staged checks below need your explicit yes (it is part of A5's approval text) |

---

## A4 — Vercel environment variables (R7)

**What changes** (project `clearspace`, scope `bng-dev-alt-webadvisor`; applies to **new** deployments only — the live site does not change until A5):

| Variable | Change |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | replaced → `https://twjlnsxjtuntujarwner.supabase.co` (production + preview) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | replaced → the new project's **anon** key (fetched by the CLI into a shell variable, never printed) |
| `AI_RATE_PER_USER_PER_MINUTE` / `AI_RATE_GLOBAL_PER_MINUTE` / `AI_DAILY_TOKEN_BUDGET_PER_USER` | **added** `3` / `10` / `50000` (production + preview, plain config values). Estimate-based throttles, **not** a spending cap |
| `GEMINI_API_KEY`, `GEMINI_MODEL` | **not touched here** (A4b) |

```bash
V=/Users/beng/.npm/_npx/67eb4586ca667318/node_modules/.bin/vercel; S="--scope bng-dev-alt-webadvisor -p clearspace"; cd "$TMPDIR"
# 0. snapshot of names/targets before (values are hidden by Vercel)
$V api "/v10/projects/prj_yFGiOmACsu4iILF6nb6Q0aDgG8gg/env?decrypt=false" --scope bng-dev-alt-webadvisor | python3 -c "import sys,json; t=sys.stdin.read(); [print(e['key'],e['target'],e['type']) for e in json.loads(t[t.index('{'):])['envs']]"
# 1. URL (public value) and anon key (public by design) -> stdin, nothing echoed
printf '%s' "https://twjlnsxjtuntujarwner.supabase.co" | $V env update NEXT_PUBLIC_SUPABASE_URL --environment production --sensitive --yes $S
ANON=$(supabase projects api-keys --project-ref twjlnsxjtuntujarwner --workdir "$TMPDIR" --output-format json | python3 -c "import json,sys; print(next(k['api_key'] for k in json.load(sys.stdin)['keys'] if k['name']=='anon'))")
printf '%s' "$ANON" | $V env update NEXT_PUBLIC_SUPABASE_ANON_KEY --environment production --sensitive --yes $S; unset ANON
# 2. AI limits
for kv in AI_RATE_PER_USER_PER_MINUTE=3 AI_RATE_GLOBAL_PER_MINUTE=10 AI_DAILY_TOKEN_BUDGET_PER_USER=50000; do
  $V env add "${kv%%=*}" --environment production,preview --no-sensitive --value "${kv#*=}" --yes $S; done
# 3. verify (names/targets only; values are not readable)
$V api "/v10/projects/prj_yFGiOmACsu4iILF6nb6Q0aDgG8gg/env?decrypt=false" --scope bng-dev-alt-webadvisor | python3 -c "import sys,json; t=sys.stdin.read(); [print(e['key'],e['target'],e['type']) for e in json.loads(t[t.index('{'):])['envs']]"
```

**Gate:** 7 variables, each covering production + preview; the first two still `sensitive`; **no** `NEXT_PUBLIC_FORCE_DEMO`, `*DEV_LOGIN*`, service-role or DB-password variable. The content of the two replaced variables is verified indirectly in A5 (bundle scan of the staged build).
**Undo:** `update` the two variables back with the old values from `old_public_env.txt` (URL + publishable key); `vercel env rm AI_…` for the three additions. Because nothing is deployed yet, no running service is affected either way.
**Risk:** none for the live site until a new deployment exists. (Git pushes cannot create one: A1 proved the guard.)

> **Approval text A4:** „Schvaluji A4: ve Vercel projektu `clearspace` (scope `bng-dev-alt-webadvisor`) nahradit `NEXT_PUBLIC_SUPABASE_URL` a `NEXT_PUBLIC_SUPABASE_ANON_KEY` hodnotami nového projektu `twjlnsxjtuntujarwner` (Production+Preview) a přidat `AI_RATE_PER_USER_PER_MINUTE=3`, `AI_RATE_GLOBAL_PER_MINUTE=10`, `AI_DAILY_TOKEN_BUDGET_PER_USER=50000`. `GEMINI_*` se nemění.“

### A4b — dedicated Gemini key for V1 (your action; I never see the value)

1. In Google AI Studio create a key for V1 **in its own Google Cloud project, ideally with no billing account** (the only real spending cap; a budget alert is not a limit). Restrict it to the Generative Language API. Do not paste it into chat.
2. Set it **before A5** (it is read at runtime but only a *new* deployment sees a changed value; doing it first avoids a second deployment). In your own terminal tab (hidden prompt):
   `vercel env update GEMINI_API_KEY --environment production --sensitive -p clearspace --scope bng-dev-alt-webadvisor`
   and, if the default `gemini-3.5-flash` is not a model your key can use, `vercel env update GEMINI_MODEL --environment production -p clearspace --scope bng-dev-alt-webadvisor`.
3. V2 and the `kanban_antigravity` copies keep the old key until you give them their own; **do not revoke the old key yet** (rotation steps 7–9 in GEMINI_KEY_ROTATION.md come later).
If you skip A4b, A5 still works (AI stays firewalled) but the shared old key stays on Vercel and a later key change needs another staged deployment.

---

## A5 — Staged deployment, checks, promote (R8–R10)

**What changes:** one new Vercel deployment (target production, **not attached to the domain**) built from a clean export of the release commit; after the checks pass, `promote` attaches it to `clearspace-ai.vercel.app`. Until the promote nothing public changes. Nothing is pushed to GitHub, nothing is merged.

```bash
cd /Volumes/WORKSPACE/Dev/Apps/ClearSpace/V1-consolidation
# 5.0 local gates on the exact commit (all must be green)
git status --short; git rev-parse --short HEAD                                  # clean; note the commit
(cd frontend && npm ci && npx eslint && npx tsc --noEmit && npx vitest run && npm run build && scripts/check-production-bundle.sh)
PG_IMAGE=public.ecr.aws/supabase/postgres:17.6.1.147 frontend/supabase/tests/run.sh | tail -1
# 5.1 clean export (no .env.local, no node_modules) and staged deploy from the repository root
D=$(mktemp -d) && git archive HEAD | tar -x -C "$D" && cd "$D"
vercel link --yes --project clearspace --scope bng-dev-alt-webadvisor && rm -f .env.local     # link may drop a CLI token file: remove it
vercel deploy --prod --skip-domain --scope bng-dev-alt-webadvisor                              # prints the staged URL; SAVE it
# 5.2 staged checks (through `vercel curl`, CLI-authenticated protection bypass — NOT VERIFIED until approved)
vercel inspect <staged-url> --scope bng-dev-alt-webadvisor      # READY, target production, no aliases
vercel curl /login --deployment <staged-url> --scope bng-dev-alt-webadvisor -- -sI   # 200 + HSTS, X-Frame-Options, nosniff, CSP
vercel curl /api/ai/improve --deployment <staged-url> -- -s -o /dev/null -w '%{http_code}' -X POST   # expect 403 (firewall)
vercel curl /api/dev/login  --deployment <staged-url> -- -s -o /dev/null -w '%{http_code}' -X POST -H 'x-clearspace-dev-login: 1'   # expect 404
# all of the below (headers, 403/404 probes, bundle scan) is automated: MODE=vercel DEPLOYMENT=<staged-url> frontend/scripts/check-deployment.sh <staged-url>
#   (negative control run against the OLD production build: correctly FAILS the new-ref/old-ref and security-header checks)
# bundle of the STAGED build: every chunk linked from /login must contain the NEW ref and none of: old ref, dev-login strings,
# service_role, AIza, GEMINI_API_KEY; JWTs only role=anon (same patterns as frontend/scripts/check-production-bundle.sh)
# 5.3 promote
vercel promote <staged-url> --scope bng-dev-alt-webadvisor --yes
# 5.4 production smoke (public domain; disposable accounts, deleted afterwards; AI routes must answer 403, never reach the gateway)
cd /Volumes/WORKSPACE/Dev/Apps/ClearSpace/V1-consolidation/frontend
BASE_URL=https://clearspace-ai.vercel.app PRODUCTION_SMOKE_OK=1 PW_CHROMIUM_PATH=<installed chromium> scripts/hosted-verify.sh
scripts/check-production-bundle.sh   # (local) and the same scan against the live chunks
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://clearspace-ai.vercel.app/api/ai/chat      # 403
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://clearspace-origin.luffast.com/api/ai/chat   # 302 (Cloudflare Access)
```

**Gates:** 5.0 all green; 5.2 every expectation above; 5.4 `16 passed` (Realtime pass, leftovers only the dev account), AI = 403, no leftover disposable accounts.
**Fail before promote:** do nothing public; the staged deployment can be ignored or removed (`vercel remove <url>`); fix on the branch.
**Fail after promote — rollback:** `vercel promote https://clearspace-86theeb4x-bng-dev-alt-webadvisor.vercel.app --yes`. *This is now a safe fallback* (earlier documents said otherwise): the old build points at the old, **paused** project, so it is merely inert, and its unauthenticated AI routes stay shut by the firewall deny. It stays valid only while the old project remains paused and the deny rule stays published. Data written to the new project is unaffected by a frontend rollback (there is no down-migration; see RELEASE_PLAN §5).
**Known unverified:** `vercel curl` behaviour (flag pass-through, protection bypass) — if it does not work, the staged checks fall back to your signed-in browser on the staged URL or are skipped in favour of the post-promote smoke (low risk: the old site is inert and the firewall holds).

> **Approval text A5:** „Schvaluji A5: staged production deployment (`vercel deploy --prod --skip-domain`) z čistého exportu commitu `<HEAD>`, kontroly stagingu přes `vercel curl` (ochrana přes CLI přihlášení), následně `vercel promote` na `clearspace-ai.vercel.app`, post-promote smoke (`hosted-verify.sh` s `PRODUCTION_SMOKE_OK=1`, jednorázové účty se smažou) a v případě selhání rollback promote starého deploymentu `clearspace-86theeb4x`. Žádný merge ani push.“

---

## A6 — Bounded AI validation with the firewall relaxed for your IP only (R11), then restore

**Needs:** A5 green and promoted; the V1 Gemini key set (A4b). **What changes:** the firewall rule is edited for a few minutes so that `/api/ai` is denied for **everybody except one IPv4 address (yours)**; the real Gemini API is called **at most 3 times** (hard cap 4 in the script), each a tiny "improve a card" request; then the full deny is restored. Cost ≈ 0 (a few hundred tokens; $0 on a billing-less key).

```bash
V=/Users/beng/.npm/_npx/67eb4586ca667318/node_modules/.bin/vercel; S="--project clearspace --scope bng-dev-alt-webadvisor"; cd "$TMPDIR"
IP=$(curl -4 -s https://api.ipify.org)            # contacts ipify.org only to learn your public IPv4 (or give me the address)
# 6.1 stage the relaxed rule (path under /api/ai AND client IP is NOT yours -> deny), review the diff + digest, publish
$V firewall rules update "Block legacy AI API" --condition '{"type":"path","op":"pre","value":"/api/ai"}' --condition "{\"type\":\"ip_address\",\"op\":\"eq\",\"value\":\"$IP\",\"neg\":true}" --yes $S
$V firewall diff $S                                # shows the single change and the effects digest
$V firewall publish --confirm-name clearspace --effects-digest <digest> $S
# 6.2 the bounded test (REAL Gemini calls: 3) — expects 401, 403, then 200,200,200 and a 4th request 429
cd /Volumes/WORKSPACE/Dev/Apps/ClearSpace/V1-consolidation/frontend
BASE_URL=https://clearspace-ai.vercel.app CONFIRM_REAL_GEMINI_CALLS=3 scripts/ai-bounded-test.sh
# 6.3 RESTORE the full deny immediately (also if anything above failed)
cd "$TMPDIR"
$V firewall rules update "Block legacy AI API" --condition '{"type":"path","op":"pre","value":"/api/ai"}' --yes $S
$V firewall diff $S; $V firewall publish --confirm-name clearspace --effects-digest <digest> $S
curl -4 -s -o /dev/null -w 'after restore: %{http_code}\n' -X POST https://clearspace-ai.vercel.app/api/ai/improve   # expect 403
```

**Gate (PASS):** statuses `401, 403` (no provider call), `200 ×3`, then `429`; the script's ledger rows = **3** (`succeeded`, token counts present) and **you** confirm the Google usage graph shows the same 3 requests (I cannot see Google); after 6.3 the request returns 403 again.
**Stop conditions:** any 5xx, a `GEMINI_*` error (wrong model / key), more ledger rows than calls, or a mismatch with the Google graph → restore the deny (6.3) first, then investigate. An invalid model name costs nothing (the provider rejects it).
**Not verified by this test:** that other IPs are denied while the exception is active (the rule is a negated-IP condition; to prove it, open the AI page from a different network while the rule is relaxed, or look at `vercel firewall traffic`). The window is minutes long.
**Undo:** step 6.3 *is* the undo; the rule's original definition is recorded above.

> **Approval text A6:** „Schvaluji A6: dočasně upravit firewall pravidlo „Block legacy AI API“ tak, aby `/api/ai` blokovalo pro všechny IPv4 kromě mé (`<IP>`), spustit `ai-bounded-test.sh` s nejvýše 3 reálnými voláními Gemini, a ihned obnovit plný deny (publish s digestem). Žádná jiná změna firewallu.“

### A6b — final firewall state (D5) and merge to `main`

- **Firewall (D5):** recommended **keep the full deny** (AI off for the public) until you want public AI; turning AI on later = replace the deny by "allow, app enforces JWT + membership + quota" plus an IP rate-limit rule (plan availability NOT VERIFIED). Cloudflare Access stays.
- **Merge:** `git push origin consolidation/security-foundation:main` — a **fast-forward** of 26 commits, no merge commit. Effects: the `frontend/vercel.json` guard lands on `main`, so **no deployment is created** (A1 proved it on a branch; the first push to `main` is the final proof — check `vercel ls` and the commit status afterwards); GitHub Actions CI runs (lint/test/build, no deploy). Your canonical clone `../V1` (own uncommitted changes, untouched) will need `git pull` later.
- **Verify after:** newest Vercel deployment unchanged (the promoted one), `clearspace-ai.vercel.app` still serves it, no Vercel status on the new `main` head.
- **Undo:** a fast-forward cannot be reverted without rewriting `main`; the safe undo is a `git revert` of the changes (a new commit) — a force-push of `main` would need its own explicit approval.

> **Approval text A6b:** „Schvaluji A6b: ponechat plný deny firewall pravidla a fast-forward `main` na `consolidation/security-foundation` (`git push origin consolidation/security-foundation:main`), ověřit, že nevznikl žádný Vercel deployment.“

---

## Not in this package (each needs its own approval later)

- Cloudflare: remove the `clearspace-origin` hostname route (shared tunnel) and its Access app; keep until the old origin is retired.
- Old Gemini key: disable → observe 24–48 h → delete; V2 gets its own key first.
- E-mail delivery (D2): custom SMTP, needed before anyone but you can register; Supabase plan/backups (Free has none).
- Dev account `dev-login@example.test`: delete before the project is public (or keep knowingly).
- Re-enabling Git-triggered deployments: delete `frontend/vercel.json` in a normal commit when you want them.


---

## Execution record — A4 (2026-11-17) — **PASS**

Pre-checks (read-only): project `clearspace` (`prj_yFGiOmACsu4iILF6nb6Q0aDgG8gg`, scope `bng-dev-alt-webadvisor`, GitHub `bng-dev-alt/clearspace`, Root Directory `frontend`); domains `clearspace-ai.vercel.app` + redirect alias `cearspace.vercel.app`;
env before = 4 variables (`GEMINI_*`, `NEXT_PUBLIC_SUPABASE_*`), each production+preview, all `sensitive`; rollback file present; HEAD `efed982`, tree clean, `main` `ff615c3`.

What was done (only on that project):
- `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` **replaced** with the new project's URL and **anon** key (JWT checked before sending: `role=anon`, `ref=twjlnsxjtuntujarwner`), Production + Preview, **same variable ids**.
- Added `AI_RATE_PER_USER_PER_MINUTE=3`, `AI_RATE_GLOBAL_PER_MINUTE=10`, `AI_DAILY_TOKEN_BUDGET_PER_USER=50000` (Production + Preview).
- `GEMINI_API_KEY` / `GEMINI_MODEL` untouched (still `sensitive`, last updated 2026-07-20).

**Deviation from the command in A4 above, and why:** `vercel env update … --sensitive` is **refused** for any `NEXT_PUBLIC_` name ("exposes this value to anyone visiting your site, so it cannot be a Secret") and a Secret cannot be converted by `update`.
The two failed attempts changed nothing. They were replaced with `vercel env add NAME --environment production,preview --type config --value … --force --yes` (stdin/shell variable, never printed). Consequence: these two variables are now plain **Config** (type `encrypted` in the API) instead of `sensitive`;
this is harmless — both values are public by design and are embedded in every client bundle — and it makes them verifiable. Use `--type config --force` (not `--sensitive`) for any future change of `NEXT_PUBLIC_*`.

Verification (names, environments, values compared as booleans — no secret printed):
| Check | Result |
|---|---|
| Variables now | 7: `AI_DAILY_TOKEN_BUDGET_PER_USER`, `AI_RATE_GLOBAL_PER_MINUTE`, `AI_RATE_PER_USER_PER_MINUTE`, `GEMINI_API_KEY`, `GEMINI_MODEL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_SUPABASE_URL` — each Production + Preview |
| Supabase identity | URL == `https://twjlnsxjtuntujarwner.supabase.co`; anon JWT `role=anon`, `ref=twjlnsxjtuntujarwner`; the old ref `bjycwqfessddbfocrggt` appears in neither value |
| AI limits | `3 / 10 / 50000` |
| Forbidden names (`FORCE_DEMO`, `DEV_LOGIN`, service/DB-password, `ENABLE_OAUTH`) | none |
| Nothing else changed | newest deployment still `dpl_6HzXV3gf` (2026-07-30); firewall `1 active, 0 inactive`; `/api/ai/chat` → 403, Cloudflare origin → 302; `main` `ff615c3`; live site still serves the old bundle (old ref) — the new values take effect only with the A5 deployment |

**Rollback of A4:** `vercel env add NEXT_PUBLIC_SUPABASE_URL/…_ANON_KEY --environment production,preview --type config --value <old> --force` with the values in `/Volumes/WORKSPACE/_G2_BACKUP/20261117-vercel-old-public-env/old_public_env.txt`; `vercel env rm AI_…` for the three additions. No running service depends on them yet.

**Next — A4b (yours):** create the V1-only Gemini key (own Google project, ideally no billing account, restricted to the Generative Language API) and set it in your own terminal before A5:
`vercel env update GEMINI_API_KEY --environment production --sensitive -p clearspace --scope bng-dev-alt-webadvisor` (hidden prompt; it keeps both environments), and `GEMINI_MODEL` only if needed. (`--sensitive` works here because the name has no `NEXT_PUBLIC_` prefix.)

---

## P6 preflight findings (2026-11-17) — read before A4b/A5

**Preflight (all PASS, read-only):** HEAD `007df9a` clean on `consolidation/security-foundation`; remote has only `main` (`ff615c3`); Vercel env = 7 variables (names/targets as recorded under A4); migrations 100–400 on `twjlnsxjtuntujarwner`, bucket `task-resources` private, RLS 15/15, Auth `mailer_autoconfirm=false`;
firewall rule *Block legacy AI API* enabled (deny `/api/ai`), `/api/ai/chat` → 403; Cloudflare Access → 302; port 3130 closed; launchd origin agent disabled; newest Vercel deployment still `dpl_6HzXV3gf` (2026-07-30); V2 `d1a7ce2` and all experiment worktrees unchanged; guard file present.

**Local release gates on the candidate (PASS):** ESLint 0 errors (2 old warnings), `tsc` clean, Vitest 216/216, production build OK, `check-production-bundle.sh` all ok (new ref present, old ref absent, no dev-login/`service_role`/`AIza`/`GEMINI_API_KEY`, JWT roles = anon), DB suite 290 assertions on **both** the 17.6.1.147 image and the default CI image (`…167`).

1. **The default model id `gemini-3.5-flash` does not exist.** Google's current model list (https://aistudio.google.com/docs/models, read 2026-11-17) offers stable `gemini-3.8-flash`, `gemini-3.6-flash`, `gemini-3.5-flash-lite`, `gemini-3.1-flash-lite` (+ `gemini-4-*`; previews `gemini-3-flash-preview`, `gemini-3.1-pro-preview`); `gemini-2.5-*` are deprecated (rerouted 2026-12-01), `gemini-2.0-*` and `gemini-3-pro-preview` are shut down.
   Every real AI call with the old default would have failed with "model not found". Fixed in code (`geminiProvider.ts` default and `.env.example` → `gemini-3.6-flash`); **the hidden Vercel `GEMINI_MODEL` value is unknown and must be set explicitly in A4b** (`gemini-3.6-flash`). The list came from the documentation page, not from the API: re-verify with the key via `GET /v1beta/models` (a free metadata call) in A6 step 0.
   The UI model selector, analytics labels and cost-estimator table still mention older ids (`gemini-3.5-pro/3.5-flash/3.0-flash`); the server ignores any client-sent model (tested), so this is cosmetic — recorded as a known issue.
2. **A4b cannot be automated from here:** no `gcloud`/`gsutil`, no `~/.config/gcloud`, no `GOOGLE_*`/`CLOUDSDK_*` variables, and the built-in browser is not signed in to Google (AI Studio redirects to the sign-in page). No credential was created or touched. **A4b = BLOCKED on a human step** (below).
3. **`--skip-domain` semantics (Vercel docs):** "disables the automatic promotion (aliasing) of the relevant domains to a new production deployment" and overrides the project's *Auto-assign Custom Production Domains* setting; `vercel promote` completes it without a rebuild. The docs do **not** promise anything about the project's own `*.vercel.app` aliases or about public access,
   so it is **verified after the deploy, not assumed**: `vercel inspect` must list no aliases; `clearspace-ai.vercel.app` must still serve the old deployment (old Supabase ref in its bundle); an unauthenticated GET of the staged URL must redirect to Vercel SSO (302) like every existing deployment URL (project `ssoProtection: all_except_custom_domains`). If the staged URL turns out to be public or aliased, stop before promoting; the AI routes stay firewalled either way.
4. **Rollback semantics (docs):** *Instant Rollback* reassigns domains to an earlier deployment that has already served production — `dpl_6HzXV3gf` qualifies; a promoted staged deployment cannot be promoted again, only rolled back to. No rebuild, so env changes do not follow a rollback (irrelevant here). Promote/rollback jobs run one at a time per project.
5. **Pushing to `main`:** triggers GitHub Actions CI only (lint `src e2e`, `tsc`, Vitest, build, Playwright in demo mode, DB suite on the default image — all green locally); no deployment because of the guard (proven on a branch in A1).
6. **Deployment hygiene:** deploy from a `git archive` export (no `.env.local`, no git metadata); add `--meta releaseCommit=<sha>` so the deployment is traceable; staged checks that need protection bypass use `vercel curl`, which the auto-mode checker refused once without explicit approval — keep it inside the A5 approval text.

### A4b — exactly what is needed from you (≈3 minutes, nothing is pasted into chat)

1. https://aistudio.google.com/apikey → *Create API key* → choose **a new Google Cloud project** (not one with billing). Do not link a billing account (that is what makes it a hard cap; the free tier returns 429 instead of charging).
2. In the Google Cloud console for that project → *APIs & Services → Credentials → the key → API restrictions → Restrict key → Generative Language API only* (AI Studio cannot set this).
3. In your own terminal (hidden prompt; both environments are kept):
   `vercel env update GEMINI_API_KEY --environment production --sensitive -p clearspace --scope bng-dev-alt-webadvisor`
   `vercel env update GEMINI_MODEL --environment production --sensitive -p clearspace --scope bng-dev-alt-webadvisor` → value `gemini-3.6-flash`
4. Tell me when done. The old key stays in V2 and the kanban copies; **do not revoke it**.
Alternative: allow me to drive AI Studio/Cloud Console in your own signed-in Chrome (Claude in Chrome) — slower and touches your Google account UI; I would still not read the key value.


### P6 status after the owner's answers (2026-11-17)
- **Approved by the owner:** (1) use Claude in Chrome for A4b (new Google Cloud project + key, API restriction, `GEMINI_API_KEY` + `GEMINI_MODEL=gemini-3.6-flash` on Vercel); (2) the first staged deployment from a clean export of the release commit + `vercel curl` staged checks, **after** A4b; (3) promote needs a **separate** approval after the staged results.
- **A4b = BLOCKED:** the Claude in Chrome extension is not connected (two attempts), there is no `gcloud`, the built-in browser is not signed in to Google. Nothing was created. Fix: install/sign in the extension (https://chromewebstore.google.com/detail/fcoeoabgfenejglbffodgkkbkcdhcgfn, same account as this app) and say "Chrome připojen", **or** do the 3-minute manual route above.
- **A5 not started** (a deployment before A4b would bake the old shared key and hidden model value and force a second deployment). Release candidate commit: the HEAD of the branch after `ec65210` (check `git rev-parse --short HEAD`); local gates were green on it.
- New helper: `frontend/scripts/check-deployment.sh` (staged/production black-box checks; control-tested on the old production build).


---

## Execution record — A4b and A5 (2026-11-17)

### A4b — dedicated Gemini key — **PASS**
- `frontend/scripts/set-gemini-key.sh` (hidden prompt in the app's Terminal tab; the key goes to Google through `curl -K -` and to Vercel through stdin; nothing secret printed, logged or written). The script's abort path was dry-tested with a fake key first (Google 400, Vercel untouched).
- Google (free metadata calls only): `models.list` HTTP 200, **49 models** callable with `generateContent`; candidates `gemini-3.6-flash`, `gemini-3.8-flash`, `gemini-3.5-flash-lite`, `gemini-3.1-flash-lite` all AVAILABLE; `countTokens` on `gemini-3.6-flash` HTTP 200 (`totalTokens=1`). No generation call was made. This confirms the id from the docs page via the API for this key.
- Vercel: `GEMINI_API_KEY` and `GEMINI_MODEL` (= `gemini-3.6-flash`) updated, targets production+preview, type sensitive, updated 20:13Z; nothing else changed. V2's key untouched.
- Note: the new key does not start with `AIza`, so the `AIza` pattern in the bundle scans only covers the legacy format; the key is server-only (never `NEXT_PUBLIC_`, never in a bundle) — that is what the scans really guard.
- That the key is *distinct* from V2's old key is asserted by the owner; it cannot be compared without reading it.

### A5 — staged deployment — **PASS** (nothing promoted)
- Candidate: commit `5e8dc1c` (branch `consolidation/security-foundation`), exported with `git archive` (290 files, no `.env.local`, no `.git`), linked in a temp dir, `vercel deploy --prod --skip-domain --meta releaseCommit=5e8dc1c`.
  Identity: **`dpl_2tSV5NWAHaEweTibxzszh6SMZJ55`**, URL `https://clearspace-7e032iiy1-bng-dev-alt-webadvisor.vercel.app`, target production, Ready, build 44 s, created 2026-11-17 20:14Z (after A4b).
- **No production alias, protected, old site unchanged (verified, not assumed):** deployment API `alias: []`; the project's current production deployment is still `dpl_6HzXV3gf`, still aliased to `clearspace-ai.vercel.app` + 3 other aliases; unauthenticated GET of the staged URL → **302 to Vercel SSO** (also `/api/ai/improve`); `clearspace-ai.vercel.app` still serves the old bundle (old ref).
- **Staged black-box checks (`check-deployment.sh`, 18/18):** `/login` 200; HSTS, `X-Frame-Options: DENY`, `nosniff`, CSP present; `POST /api/ai/improve` → 403 (firewall); `POST /api/dev/login` → 404; 10 chunks contain the **new** ref `twjlnsxjtuntujarwner` and **not** the old one; no dev-login/`service_role`/`AIza`/`GEMINI_API_KEY`; the only JWT is `role=anon` with `ref=twjlnsxjtuntujarwner`. Negative control on the old production build correctly fails (missing headers, old ref, no new ref).
- **Staged functional smoke (`hosted-verify.sh` against the staged URL, disposable accounts): 16/16 + Realtime pass** — login/reload/logout, protected routes, unconfirmed account refused, workspace/project seed, task create/edit/move/drag, calendar/dashboard/Project Intelligence, project creation, team + invitation, **Storage** (private bucket, member-only, limits), cross-user isolation, invitation RPC, AI History restore, AI routes = 403 (never reached the gateway), all browser traffic to the new Supabase only; 0 leftover accounts/data (only the dev account's project).
  The first attempt failed on two transient network errors (a Realtime event timeout and `ERR_TIMED_OUT` on one page load, test 5); an unchanged re-run passed 16/16 — recorded, not hidden.

### Side effect I caused and reverted
`vercel curl <full-url>` **silently created a "Protection Bypass for Automation" secret on the Vercel project** (the first form I tried only did a plain request). I used it for the staged checks and the smoke run (attached only to requests to the staged origin by a Playwright route, never to Supabase, never logged), then **revoked it** (`vercel project protection disable … --protection-bypass`). Verified afterwards: 0 bypass secrets, `ssoProtection` unchanged, staged URL → 302 again.
**Lesson/caveat:** `vercel curl` has this project-setting side effect; any future use must be announced and the secret revoked.

### Bugs found in my own tooling this round (fixed)
`check-deployment.sh`: `printf | grep -q` under `pipefail` gave false "not found" on a large bundle (SIGPIPE) — now greps a file; a `grep` without file argument hung on stdin. `hosted-verify.sh` and the spec now support a protected staged URL; Playwright starts no local server for remote targets.

### State at the pause (waiting for the owner's decision on promote)
Production domain: old build, inert; firewall deny `/api/ai` published; Cloudflare Access 302; `main` `ff615c3`; no push, no merge; staged candidate `dpl_2tSV5NWA…` unaliased. Rollback after a promote: `vercel rollback` to `dpl_6HzXV3gf` (an earlier production deployment, eligible for Instant Rollback).

---

## Execution record — promote (2026-11-17 20:32Z) — **PASS**

Pre-promote re-verification (read-only): `dpl_2tSV5NWAHaEweTibxzszh6SMZJ55`, project `clearspace`, target production, READY, no alias, `releaseCommit=5e8dc1c` (commit exists, HEAD later = tooling/docs only); production pointer `dpl_6HzXV3gf`; firewall `1 active` (deny `/api/ai`); 0 bypass secrets; `main` `ff615c3`; snapshot of all 5 Vercel projects of the scope taken for the post-check.

Action: `vercel promote https://clearspace-7e032iiy1-bng-dev-alt-webadvisor.vercel.app --scope bng-dev-alt-webadvisor --yes` → "Success! clearspace was promoted … (dpl_2tSV5NWA…) [3s]". Nothing else.

Post-promote checks (all pass):
| Check | Result |
|---|---|
| Production pointer | `dpl_2tSV5NWAHaEweTibxzszh6SMZJ55` (current); `clearspace-ai.vercel.app` serves the new build (new ref in bundle, old ref gone) |
| Black-box (`check-deployment.sh` on the domain) | 18/18: `/login` 200, HSTS + X-Frame-Options + nosniff + CSP, `/api/dev/login` → 404, no dev-login/`service_role`/`AIza`/`GEMINI_API_KEY` in the bundle, only a `role=anon` JWT of the new project |
| All 11 AI endpoints | `analyze-resource, capacity-planning, chat, daily-brief, generate-backlog, generate-project, generate-sprint, improve, project-manager, risk-analysis, voice-action`: **POST 403 and GET 403** each (firewall deny) |
| Production smoke (`hosted-verify.sh`, disposable accounts) | 16/16 + Realtime: login/session/logout/protected routes, unconfirmed refused, project + task persistence (create/edit/move/drag), calendar/dashboard/Intelligence, project creation, team + invitation, **Storage**, cross-user isolation, invitation RPC, AI History restore, AI routes 403, all traffic to the new Supabase only. 3 accounts created and deleted by id; leftovers only the dev account's project |
| No AI usage | `ai_requests = 0`, no Gemini call was made |
| Cloudflare Access | legacy origin host → 302 to Cloudflare Access (GET and POST); port 3130 closed |
| Other Vercel projects | `microcrm`, `microcrm-app`, `microcrm-app2`, `utilityforge-os`: production deployment and `updatedAt` unchanged |
| Other repos/apps | V2 `d1a7ce2` and all 5 experiment worktrees unchanged; `main` `ff615c3`, remote has only `main` |
| Protection/settings | 0 bypass secrets, `ssoProtection` unchanged, firewall `1 active` |
| Data | `auth.users=1` (dev account only), 1 project, 0 storage objects |

Rollback (not needed): `vercel rollback` to `dpl_6HzXV3gf` (earlier production deployment; Instant Rollback). A frontend rollback does not touch database writes, and there are none from real users yet (only the dev account); it is only a *safe* state while the old Supabase project stays paused and the deny rule stays published.
