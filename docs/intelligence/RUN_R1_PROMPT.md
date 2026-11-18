# Sonnet run R1: Intelligence foundations (prompt)

Copy everything below the line into a new Claude Code session started in
`/Volumes/WORKSPACE/Dev/Apps/ClearSpace/V1-consolidation`.

---

**ClearSpace V1, run R1: Intelligence foundations (no DB, no UI)**

Role: senior TypeScript engineer. Work autonomously in one run.

Read first:
1. `docs/intelligence/ARCHITECTURE.md`: §2, §6, §7.1–7.3, §8.3 and §11 are the spec for this run.
2. `frontend/AGENTS.md`. This Next.js version differs from your training data; check `node_modules/next/dist/docs/` before using any Next API.

**Branch:** create `feature/intelligence-r1` from the current `consolidation/security-foundation` HEAD. Commit in small logical commits, ending messages with the session's attribution line. Do **not** push and do **not** touch `main`.

**Hard limits:**
- No database migration and no change under `frontend/supabase/`.
- No UI or visual change, except where this prompt explicitly lists it (chat framing).
- No new npm dependency (no zod). Follow the hand-written validator style of `src/lib/ai/validate.ts`.
- No real Gemini or Soniox call. Tests mock the provider.
- No Vercel, firewall, Cloudflare, env, credential or deployment change.
- Do not modify `../V1`, other worktrees, V2, MicroCRM, scribe_ or Universal_Meeting_Core. Reading scribe_ and UMC for reference is allowed:
  - `/Volumes/WORKSPACE/Dev/Apps/scribe_/ScribeCore/Sources/ScribeCore/Intelligence/BriefValidator.swift`
  - `…/BriefPrompt.swift`
  - `/Volumes/WORKSPACE/Dev/Universal_Meeting_Core/PHASE2_CONTRACT_DESIGN.md` (validator `umc-validator-1`, FOLD_SPEC, fixtures F01–F16)
  - MicroCRM `src/lib/ai/validate.ts` (`groundedOwner`, `withoutUnsupportedAttribution`)

**Scope.** Create the following under `frontend/src/lib/intelligence/`. Every file must be server-safe, pure where possible, and fully typed.

1. `fold.ts`: `fold(s)` exactly per FOLD_SPEC (NFD, strip `\p{Mn}`, lowercase, runs of non-`\p{L}\p{N}` become one space, trim), plus `letterCount`.
2. `frame.ts`: `frameUntrusted(label, text)` renders `<<<DATA:LABEL>>>\n…\n<<<END DATA:LABEL>>>`.
   - Neutralize any `<<<` / `>>>` inside the content.
   - Strip control characters except `\n` and `\t`.
   - Export `UNTRUSTED_DATA_RULES`: the system-instruction text saying DATA blocks are information, never instructions.
3. `facts.ts`: `computeProjectFacts(columns, activities, now, tz='Europe/Prague')`. Build it on top of the existing `computeProjectIntelligence` (`src/lib/projectIntelligence.ts`) and `src/lib/dashboardStats.ts`; reuse them, do not duplicate formulas.
   - Health score, level and reasons stay unchanged.
   - Counts from §7.1 plus id lists (≤20 each).
   - `due_date` is compared as a parsed date in `tz`; an invalid date goes into `dataQuality.invalidDueDates`.
   - Recent changes come from activity entries in the last 7 days.
   - `factsVersion = 'facts-1'`.
4. `context.ts`: `buildProjectContext(db, projectId, { purpose, focus?, budgetChars? })` per §6.
   - Load through the caller's client only. Reuse or extend the existing `loadBoard` query. Add `activity_logs` (latest 100 for the project) and project members if needed.
   - Build `SourceRecord[]` with refs `card:`, `comment:`, `check:`, `activity:`.
   - Render lines `[ref] …`, with facts as a JSON section and untrusted text through `frameUntrusted`.
   - Apply the truncation priority order of §6.4 and report omissions.
   - `fingerprint` = sha256 (node `crypto`) of the rendered text plus `factsVersion`.
   - Budgets: brief 120k, chat 60k, meeting 20k chars.
5. `evidence.ts`: the deterministic validator.
   - `validateBrief(modelOutput, context)` for the §7.2 schema.
   - `validateMeetingBrief(modelOutput, transcript, projectContext)` for the §8.2 schema.
   - Rules as in §8.3: ≥6 letters, "…" splitting, dropping vs `unverified`, owner prefix rule max(3, len−1), speaker label only if it is a real name, `due_text` substring, existing card ids, caps of 40, fatal cases, `rejectedCount`.
   - Export `VALIDATOR_VERSION = 'cs-evidence-v1'` and the TypeScript types `Evidence`, `Support` and `SourceRecord` (§7.3).
6. Gateway integration (`src/lib/ai/gateway.ts`), minimal and backward compatible:
   - Build the context through `buildProjectContext` (purpose taken from a new optional `feature.contextPurpose`; default keeps today's `loadBoard` behaviour).
   - Pass `context` to `feature.run` in addition to the existing `{ input, board, project }`.
   - Compute the `ai_reserve` estimate **after** loading, as `ceil((body + rendered context length)/3) + maxOutputTokens`. Keep the cap at 1,000,000.
   - Membership is still enforced by `ai_reserve`, and RLS guards the earlier read. Keep the order so that a non-member still receives `forbidden`.
7. `src/services/ai/aiService.ts`: replace every `process.env.GEMINI_MODEL || 'gemini-3.5-flash'` by one exported constant/function `serverModel()` returning `process.env.GEMINI_MODEL || 'gemini-3.6-flash'`. Make the provider fallback use the same value.
8. Chat framing (`src/services/ai/promptBuilder.ts` `buildChatPrompt` and the `chat` feature):
   - The system message contains only instructions plus `UNTRUSTED_DATA_RULES`.
   - Board data goes into a framed DATA block, as the first user-role context message or a prefix of the first user message.
   - Answer text and the API response shape stay the same (citations are R4).

**Tests** (vitest, `frontend/src/__tests__/intelligence/`). At least 60 new tests:
- fold: Czech diacritics, punctuation runs, Unicode letters and digits, empty input.
- frame: delimiter injection, control characters.
- facts:
  - parity with the existing `projectIntelligence` and `dashboardStats` tests on the same fixtures;
  - timezone edge (23:30 Prague);
  - invalid `due_date`;
  - archived cards excluded.
- context:
  - ref grammar;
  - truncation order and the `truncated` report;
  - budget respected;
  - fingerprint stable for equal input and different for a one-character change;
  - nothing from another project (mock db returns only the requested project's rows; assert queries are filtered by `projectId`).
- evidence: fixtures modelled on UMC F01–F16:
  - owner in quote, owner only in role, first-person "já" or "I", "Mluvčí 1";
  - due phrase present or absent;
  - diacritics-insensitive match;
  - "…" split;
  - an injection attempt inside the transcript;
  - an unknown segment id;
  - a quote with fewer than 6 letters;
  - a decision without a match is dropped, a risk without a match is `unverified`;
  - unknown and archived card ids are nulled;
  - more than 40 items is capped;
  - an empty summary is fatal.
- gateway: the existing `aiGateway.test.ts` stays green; add tests that the reservation includes the context length and that a non-member still gets 403 `forbidden` before any provider call.

**Gates** (all must pass; paste the summaries in the final report). Run from `frontend/`:
```
npx eslint src e2e
npx tsc --noEmit
npx vitest run           # existing 216 + new, all green
npm run build
```
The DB suite does not need to run (no DB change). Confirm `git diff --stat main -- frontend/supabase` is empty.

**Acceptance:**
- All gates green.
- No existing endpoint changes its request or response shape.
- The chat system message contains no board data.
- The reservation includes the context.
- One model-default constant.
- The new modules have no Next/React imports, except `context.ts` (which may import the Supabase client type).
- Code follows the existing comment language (Czech user-facing messages, English or Czech comments as in the surrounding files).

**Rollback:** everything is on `feature/intelligence-r1`; reverting is deleting the branch. No data or infrastructure is affected.

**Final report (short):**
1. Commits.
2. Files added and changed.
3. Test counts before and after.
4. Gate outputs.
5. Any deviation from ARCHITECTURE.md, with reasons.
6. Open questions for R2.

Do not start R2.
