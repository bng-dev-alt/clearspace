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
