# ClearSpace V1: release decision (RC1 Intelligence, RC2 Monograph), 2026-11-23

## State

| | Deployment | Commit | Alias | Notes |
|---|---|---|---|---|
| **Production (live)** | `dpl_Ff8CV7zK6sM3WcwezdmsgdFPGaRi` | `25ffce6` | `clearspace-ai.vercel.app` | unchanged by this work |
| **RC1 Intelligence** | `dpl_HHh8yPGmyFvQBR73NeanPyeGvxNh` (`clearspace-1cvztwamq-…`) | `0ab25df` (`feature/intelligence-v2`) | none, protected | owner-only Meeting + Project Intelligence, classic design; Monograph flag NOT set |
| **RC2 Monograph** | `dpl_CVDa4bxycKUX44AiTaqm9fhKVo88` (`clearspace-2zfrhubzr-…`) | `c686c1a` (`release/rc2-monograph`) | none, protected | RC1 + Monograph, built with `NEXT_PUBLIC_ENABLE_MONOGRAPH=1` (per-deployment `--build-env`; project env unchanged). Default style = classic; each user may choose Monograph Light/Dark |

Later commits on both branches are tooling/docs only (`fdbd86f` idempotent project-member sync is in RC2 `c686c1a` and on `feature/intelligence-v2`; RC1 `0ab25df` predates it: the bug only shows a false "save failed" banner, see "Known").
`origin/main` (`5c80dcf`) → RC1 → RC2 is a fast-forward chain. No hosted schema change is needed for either RC (no migration since production).

## Shortest safe sequence (each step needs the owner's explicit go)

1. **Promote RC2** (it contains RC1; with the flag on, the default look is still classic and pixel-identical to RC1 when nobody opts in):
   `vercel promote dpl_CVDa4bxycKUX44AiTaqm9fhKVo88 --scope bng-dev-alt-webadvisor`
   *Alternative if Monograph should not be selectable yet:* promote RC1 `dpl_HHh8yPGmyFvQBR73NeanPyeGvxNh` first, RC2 later.
2. **Verify production** (no paid call):
   `scripts/check-deployment.sh https://clearspace-ai.vercel.app` and
   `BASE_URL=https://clearspace-ai.vercel.app PRODUCTION_SMOKE_OK=1 scripts/hosted-verify.sh`;
   the owner signs in once, sees the Northstar meeting and Project Intelligence (existing data), switches Monograph Light/Dark and back to "Stávající".
3. **Sync Git** after a verified production release: fast-forward `main` to the promoted commit (`git push origin <commit>:main`, no force).

## Rollback (each step separately reversible, no data touched)

| Undo | Command | Effect |
|---|---|---|
| RC2 / RC1 promote | `vercel promote dpl_Ff8CV7zK6sM3WcwezdmsgdFPGaRi --scope bng-dev-alt-webadvisor` | previous production build back instantly |
| Monograph only | `vercel promote dpl_HHh8yPGmyFvQBR73NeanPyeGvxNh` | Intelligence stays, selector disappears, stored preferences ignored |
| Owner-only AI config | `CONFIRM_OWNER_ACTIVATION=1 scripts/owner-activation.sh remove` + redeploy | AI/STT closed for everybody (fail closed) |

Approved meeting results, cards and knowledge live in the hosted database and are not touched by any of these.

## Evidence

- Intelligence quality (no paid call): real Northstar transcript fixture; the 2 dropped tasks are kept, due dates classified, unresolved people never assigned (`northstar.test.ts`, `meetingsUi.test.tsx`, `dates.test.ts`, `evidence.negation.test.ts`).
- Local: tsc, eslint, vitest 1106/1106 (RC2), SQL suite 1960 assertions, real local stack 29 HTTP checks, Playwright on the local stack with fake providers: owner mode 13/13, multi-user 39 + 11, demo 27, Monograph-style 14/14.
- Staging (both RCs): `check-deployment.sh` 77 ok, owner-only smoke PASS, `/api/dev/login` 404, hosted data counts unchanged; RC1 hosted-verify 16/16.
- Monograph: 60/60 real-stack and 108/110 demo screenshot cases clean (the 2 are pre-existing classic-style overflow at 768 px), keyboard pass OK, 68 contrast pairs 0 violations, flag-off 16/16 screens identical to RC1, production flag contract OK.

## Known, not blocking

- Classic style at 768 px: board and team pages are wider than the viewport (pre-existing, unchanged).
- Project Intelligence drawer at 768 px: the model selector wraps to 3 lines (cosmetic).
- RC1 `0ab25df` can show a false "Nepodařilo se uložit… (uložení členů projektu)" banner on a brand-new project's first open (fixed in `fdbd86f`, included in RC2). Promote RC2, or redeploy RC1 from `fdbd86f`, to avoid it.
- Not run: real Soniox/Gemini (owner's earlier real run stands: validator/prompt changes affect only NEW analyses), VoiceOver, Safari/Firefox engines, hosted migrations (none needed).
