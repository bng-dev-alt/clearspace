# Intelligence R1–R4: implementation report

Branch `feature/intelligence-v2` (worktree `V1-intelligence`), based on `origin/main` `fe3b2e9`.
Nothing was deployed, pushed, merged, or applied to a hosted database. No real Gemini or Soniox call was made.

## What was built

| Phase | Result |
|---|---|
| **R1** Foundations | `src/lib/intelligence/`: `fold` (FOLD_SPEC), `frame` (untrusted DATA blocks), `facts` (deterministic, timezone-aware), `context` (Project Context Engine: sources with refs, budgeted and truncated by priority, fingerprint), `evidence` (deterministic validators for meeting briefs and project briefs). Gateway: context is loaded under the caller's RLS **before** quota is reserved, reservation uses the real prompt size, optional `prepare`/`finalize` hooks, single server model constant, chat board data moved out of the system instruction. |
| **R2** Data model | Migration `20261118000500_intelligence_core.sql` (additive): `meetings`, `meeting_transcripts` (immutable revisions), `intelligence_runs`, `intelligence_items`; composite FKs, RLS, `persist_meeting_run` / `persist_project_brief` (definer, atomic, evidence-checked, exactly-once), `review_/apply_/undo_intelligence_item` (invoker), state-machine trigger. |
| **R3** Meeting Intelligence (text) | Parsers for paste/TXT/MD/SRT/VTT; `/api/ai/meetings/analyze`; Meetings list and detail UI; evidence navigation; create-card / link / accept / reject / undo with duplicate prevention. Nothing reaches the project before a human confirms. |
| **R4** Project Intelligence 2.0 | Persistent Project Brief (`/api/ai/project-brief`) with per-claim sources, fingerprint freshness, meeting-derived knowledge; cited chat; drawer tabs Přehled / Brief / Znalosti (existing behaviour kept). |

## Test results (all local, mocked or fake AI)

| Gate | Result |
|---|---|
| Vitest | **474 passed** (baseline 216): intelligence units, gateway, feature, component tests |
| ESLint, `tsc --noEmit` | clean |
| `npm run build` | passes; bundle check (`scripts/check-production-bundle.sh`) clean; `GEMINI_BASE_URL` not in the client bundle |
| Isolated DB suite (`supabase/tests/run.sh`) | **522 SQL assertions** (baseline 290): fresh install, repeated apply, legacy upgrade, drift/ownership preflight, hosted non-superuser role, 12-way and 8-way concurrency incl. exactly-once persist and approval |
| Real local Supabase stack (`real_stack.sh`) | `REAL-STACK TESTS PASSED` (SQL suites with real GoTrue + 26 HTTP checks) |
| Playwright, new, real stack + fake Gemini | `e2e/meetings.spec.ts` **8 passed**, `e2e/project-intelligence.spec.ts` **7 passed** |
| Playwright, existing | demo-mode suite **27 passed**; `supabase-runtime.spec.ts` (auth, gateway rate limit and ledger, invitations) **5 passed** on the local stack |
| Secret scan of the branch diff | 0 findings; no tracked `.env*` |

## New database migration

`frontend/supabase/migrations/20261118000500_intelligence_core.sql` (idempotent, additive; no existing object changed).
**Not applied to hosted Supabase.** Applying it follows the A3 pattern (fresh backup + restore test, owner approval).

## New routes and UI

- Routes (both under `/api/ai`, so the production firewall deny keeps them closed): `POST /api/ai/meetings/analyze`, `POST /api/ai/project-brief`. `POST /api/ai/chat` now returns verified `citations`.
- Pages: `/projects/[id]/meetings`, `/projects/[id]/meetings/[meetingId]`; a "Porady" link in the project view switch.
- Components: `components/meetings/*` (form, list, detail, transcript, item card), `components/intelligence/*` (brief panel, knowledge panel, source chips); `ProjectIntelligenceDrawer` gained tabs when `projectId` is passed.
- Services: `meetingService`, `intelligenceService`.

## Existing functionality preserved

All 216 earlier unit tests pass unchanged except one assertion deliberately updated (a foreign project is now refused by the RLS read **before** any quota row is written; the guarantee got stronger). Existing endpoints keep their request and response shapes (chat adds `citations`). Demo mode is untouched; Meetings and Brief require Supabase and say so.

## Local E2E recipe (throwaway, nothing hosted)

```bash
# 1. isolated Supabase stack on its own ports (do NOT reuse a running stack of another project)
mkdir -p "$TMPDIR/cs-intel-sb" && cd "$TMPDIR/cs-intel-sb" && supabase init --force
# edit supabase/config.toml: ports api 55521, db 55522, shadow 55520, pooler 55529, studio 55523, smtp 55524, analytics 55527,
#   site_url http://127.0.0.1:3405, enable_confirmations = false
supabase start -x studio,imgproxy,realtime,storage-api,edge-runtime,logflare,vector,postgres-meta,supavisor
DB_CONTAINER=supabase_db_cs-intel-sb API_URL=http://127.0.0.1:55521 ANON_KEY=<printed> SERVICE_ROLE_KEY=<printed> frontend/supabase/tests/real_stack.sh
# 2. fake Gemini + app
node frontend/e2e/support/fake-gemini.mjs 55590 &
cd frontend && NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:55521 NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon> GEMINI_API_KEY=fake GEMINI_BASE_URL=http://127.0.0.1:55590 \
  GEMINI_MODEL=fake-gemini AI_RATE_PER_USER_PER_MINUTE=30 npx next dev -p 3405 -H 127.0.0.1
# 3. specs
E2E_SUPABASE_URL=http://127.0.0.1:55521 E2E_SUPABASE_ANON_KEY=<anon> E2E_SUPABASE_SERVICE_KEY=<service> E2E_FAKE_GEMINI_URL=http://127.0.0.1:55590 \
  PLAYWRIGHT_TEST_BASE_URL=http://127.0.0.1:3405 npx playwright test e2e/meetings.spec.ts e2e/project-intelligence.spec.ts --workers=1
```
`GEMINI_BASE_URL` is a test seam: it is ignored when `NODE_ENV=production` (unit-tested).

## Known limitations

1. **Prompts are unvalidated against the real model.** Every AI call in the tests is a mock or the fake server. Prompt wording and validator strictness (for example Czech declension of owner names, quote matching) need a bounded real run before relying on them.
2. **Hosted database is behind.** Until migration 0500 is applied, the Meetings and Brief UI show a clear error, while chat and the other AI features keep working (the context loader tolerates the missing table; unit-tested).
3. **Freshness is an approximation.** The "Zastaralé" badge compares deterministic facts, the newest card `updated_at` and the set of accepted conclusions. Comment-only changes are not detected; the server-side fingerprint (full context) still prevents paying twice for an identical input.
4. **Duplicate hints are heuristic** (folded-text hash in the DB, title token overlap in the UI). They only warn; the human decides.
5. **The old AI PM modal still shows an LLM `healthScore`** (R7 in the roadmap). The new Brief shows only the deterministic score.
6. **No audio, no Soniox, no Drive/Gmail** (R5 and later, as designed). Text transcripts only; one transcript revision per meeting is analysed at a time.
7. **UI is information architecture only**: no visual design pass and no accessibility audit beyond semantic roles and labels.
8. **`ai_requests` was not extended** (`prompt_version`, fingerprints live on `intelligence_runs`).
9. Meetings/Brief are not live (no Realtime subscription); they refresh on actions and reload.

## Security findings

- **Fixed by design:** (a) data is now read under RLS before quota is reserved, so a non-member gets 403 without a ledger row; (b) chat no longer puts board content in the system message; (c) all AI output enters through definer RPCs that check membership explicitly and validate evidence against the stored transcript; clients have no INSERT on runs or items; (d) AI-produced fields (kind, evidence, owner/due hints) are immutable after creation; owner, assignee and due date are only ever set by a human.
- **Residual, low:** a project member can create unlimited meetings or transcripts (storage abuse; no per-project quota); a member can write an `assignee_member_id` for a workspace member they cannot see (only usable through the RLS-checked apply RPC, which then refuses it); the AI can propose a verbatim-quoted but malicious instruction as an item (needs human acceptance, which is the control).
- **Open gate (owner decision):** real meeting or project text must only go to Gemini on a **paid-tier** key (free tier may use content for training); the tier of the V1 key is not verified.
- **Unchanged:** firewall, Cloudflare, Vercel, credentials, `main` (`fe3b2e9`). New AI routes sit under `/api/ai` and are therefore blocked in production by the existing deny rule.

## Remaining blockers

- Approval needed to apply migration 0500 to hosted Supabase and to deploy.
- The paid-tier Gemini confirmation (above) before any real analysis.
- Push of this branch to the remote needs approval (not pushed).

## Recommended RUN B

1. **Release path (approvals):** backup + apply migration 0500 to hosted (A3 pattern), staged deploy, promote, fast-forward of the branch; production AI stays behind the firewall.
2. **Bounded real-AI quality run** (local, key in a hidden prompt, ≤6 calls) on synthetic Czech and English transcripts and a synthetic project: tune `meeting-brief-p1` / `project-brief-p1` and the validator; keep UMC-style fixtures F01–F16.
3. **R5 Soniox async audio**, starting with verification of the current async API, model id, price and retention; first real call only with a separate approval.
4. **R6 + R7:** `columns.role`, transcript edit → new revision, usage view from `ai_requests`, per-feature model/timeout env and `maxDuration`, hide the LLM health score, daily brief with activity history.
5. **Public AI enablement plan** (firewall rule replacement, rate limit, SMTP, Google spend cap) as its own decision.
