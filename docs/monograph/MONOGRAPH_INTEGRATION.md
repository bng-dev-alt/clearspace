# ClearSpace V1 x Monograph: opt-in design style

Branch `integration/monograph-clearspace` (from `feature/intelligence-v2` @ `d01a523`). Nothing is pushed, merged or deployed.
Everything is behind **`NEXT_PUBLIC_ENABLE_MONOGRAPH=1`**; unset the app renders exactly as before. **With the flag on (RC2), Monograph is the
default for every browser without an explicit choice; choosing "Stávající" (Classic) is stored as `existing` and always respected.** Light/Dark/System stays independent.

## 1. Design source, and why

| | |
|---|---|
| Design authority ("Monograph") | ClearSpace `V1-editorial`, branch `experiment/editorial-execution` @ `aa676ab`, `editorial-preview/` (`src/tokens.css`, `src/styles.css`, `src/ui.tsx`, `src/App.tsx`, `src/screens/*`, `shots/*.png`) |
| Not used | `V1-mission-control` (mint + signal orange, Archivo): **that was the wrong source** for this design. `V1-editorial-japan` and the MicroCRM / Demo Business OS code were read as reference only |
| Reused decisions | Token mapping, contrast fixes, cross-cutting rules, font handling and pitfalls from the Demo Business OS port (`MONOGRAPH_INTEGRATION_REPORT.md`) and MicroCRM v2 (`MONOGRAPH_V2_EXPERIMENT.md` sections 4, 8, 10) |

Design DNA kept: Barlow Condensed (display, sparingly: page identity, column heads, big numbers), IBM Plex Sans 14px body, IBM Plex Mono 11px
uppercase labels (+0.08em), warm paper / charcoal ink, olive accent (primary fill, selection, progress), 1px hairlines, a 2px ink rule opening each
panel/section, square 0 / 2 / 4px corners, no gradients, no glass, shadows only on overlays, 64px indexed vertical rail, numbered sub-nav,
numbered bottom bar at <= 900px, dialogs become bottom sheets at <= 900px. Light and dark are tuned separately (dark is not an inversion: the olive
flips from a dark fill to a pale one).

## 2. How it works (and how to turn it off)

| Piece | File | Behaviour |
|---|---|---|
| Flag | `src/lib/designStyle.ts` | `MONOGRAPH_ENABLED = process.env.NEXT_PUBLIC_ENABLE_MONOGRAPH === '1'` (inlined at build). `resolveDesignStyle(stored, enabled)`: `'monograph'` only if the flag is on **and** the stored value is `'monograph'`; everything else is `'existing'`. Monograph is never the default |
| Persistence | `src/contexts/ThemeContext.tsx` | New `designStyle` / `setDesignStyle` next to the theme; stored in `localStorage['clearspace-style']`; sets/removes `<html data-style="monograph">`. Light/dark stays `data-theme`; Monograph follows the existing theme toggle (so: Existing, Monograph Light, Monograph Dark) |
| No flash | `themeNoFlashScript` | Flag off: the script is **character-for-character the old one** (unit-tested). Flag on: the old script plus a one-liner that sets `data-style` before first paint |
| Selector | `Navbar.tsx` `StyleToggle` | "Stávající / Monograph" segmented control rendered **only** when the flag is on, in the existing appearance area (desktop bar and mobile menu). Flag off: not in the DOM |
| Styles | `src/app/monograph.css` (imported once in `layout.tsx`) | Every rule is under `html[data-style="monograph"]` (test-enforced). Overrides the **existing** custom properties first, then a few cross-cutting rules |
| Navigation | `components/layout/MonographNav.tsx` | Rendered by `Navbar` only in Monograph. Takes the **same `navItems`** as the classic bar and mobile menu and only groups/numbers them |

**Rollback:** unset `NEXT_PUBLIC_ENABLE_MONOGRAPH` (and redeploy): no selector, stored preferences ignored, rail not rendered. To remove the style entirely:
delete the `import "./monograph.css"` line in `layout.tsx` (the rest is dead code behind the constant). Nothing else (data, routes, API, DB) was touched.

## 3. Token mapping (existing ClearSpace token <- editorial token)

| ClearSpace token | Light | Dark | Editorial source |
|---|---|---|---|
| `--bg-page` | `#f3f0e8` | `#151512` | `--bg` paper / charcoal |
| `--surface` (+ `--surface-1`, glass tokens) | `#f9f7f1` | `#1c1c18` | `--surface` |
| `--surface-2` / `--surface-3` | `#eeeadf` / `#e9e5d8` | `#22221d` / `#262620` | derived row/inset levels (reference only has `--sunken`) |
| `--mg-sunken` (rail, table heads) | `#e9e5d8` | `#10100e` | `--sunken` |
| `--text` / `--text-secondary` / `--text-muted` | `#171715` / `#45453d` / `#66665b` | `#ece8dc` / `#bdb9ab` / `#8f8c7f` | `--ink`, `--ink-2`, `--ink-3` |
| `--border` | `#d5d0c4` | `#34342b` | `--line` |
| `--border-strong`, `--mg-input` (form borders) | `#8a8576` | `#74735f` | **derived**: the reference uses `--line` (2.4:1); darkened to reach 3:1 on every surface |
| `--mg-rule` (2px rules) | `#171715` | `#ece8dc` | `--line-strong` |
| `--accent` / `--accent-hover` / `--accent-soft` | `#41472d` / `#171715` / `#e4e3d0` | `#a9ae78` / `#ece8dc` / `#272a1b` | `--accent`, ink, `--accent-soft` |
| `--text-on-accent` | `#f3f0e8` | `#151512` | `--on-accent` |
| `--success` (= accent), `--warning` / soft | `#41472d`, `#7a540f` / `#efe4c6` | `#a9ae78`, `#d6a84e` / `#352a12` | `--accent`, `--warn` |
| `--danger` / soft | `#9c3b26` / `#efdcd3` | `#e0876a` / `#3a2119` | `--danger` |
| `--accent-yellow` (logo dot, live dot) | `#7a540f` | `#d6a84e` | `--warn` |
| radii | `--radius-sm/md/button` 2px, `--radius-card` 0, `--radius-dialog` 4px, `--radius-full/pill` 2px | same | `--r-0/1/2` |
| shadows / glass | `none`; `--shadow-lg` only for overlays; `--glass-blur: none` | same | `--e-1/--e-2` |
| fonts | `--font-sans` IBM Plex Sans, `--font-serif` -> Barlow Condensed, `--font-mono` IBM Plex Mono | same | `--font-body/display/mono` |

The existing legacy aliases (`--dark-navy`, `--gray-text`, `--blue-primary`, `--purple-secondary`, `--bg-card`, `--border-color` ...) are defined as
`var(--text)` etc. on the same element, so overriding the base tokens re-themes ~1,700 `var()` usages without touching a component.

Cross-cutting rules (instead of editing dozens of call sites): all existing uppercase labels (`.form-label`, `.stat-label`, `.card-meta-*`, `.cs-label`,
`.cs-badge`, `.calendar-weekday` ...) become mono; panels (`.app-toolbar`, `.stat-card`, `.board-panel-card`, `.cs-card`, `.project-card`, `.calendar-panel`)
get the 2px ink top rule; one square-corner rule for class-based radii; inline `border-radius` pills (>= 6px) and initials discs are normalised with
attribute selectors (the only `!important` besides form borders and the focus ring; each is commented in the file).

**Contrast gate:** `node scripts/monograph-contrast.mjs` parses the tokens from `monograph.css` and checks 68 pairs (34 per theme): text pairs >= 4.5:1
(lowest: light 4.61, dark 4.51), form borders / focus ring / ink rule >= 3:1. Fails the build of the check on any violation.

## 4. Fonts, licence, payload

Self-hosted woff2 in `public/fonts/monograph/` (copied from `@fontsource` v5.3.0, **no npm dependency added**): Barlow Condensed 500/600/700, IBM Plex Sans
400/500/600, IBM Plex Mono 400/500, each in `latin` and `latin-ext` (Czech: r, u, e, s, c, z ...) = 16 files, 312 kB on disk. All three families are
**SIL Open Font License 1.1**; the licence texts are shipped as `public/fonts/monograph/LICENSE-*.txt` (a test checks they exist).
`@font-face` uses `font-display: swap` and `unicode-range`, and is lazy by nature: with the style off **no font file is requested** (verified on a
production build: 0 requests; with Monograph on, the Team page requests 7 files, about 130 kB). The existing Sora/Fraunces (`next/font`) still load in
both styles (unchanged; dropping them in Monograph would need a layout change and was left out on purpose).
CSS cost when the flag is off: `monograph.css` is 44 kB raw / 8.7 kB gzip of inert rules, plus a few kB of dead JS branches (`MonographNav`).

## 5. What is integrated, per screen

Information architecture is ClearSpace's real one; nothing invented.

| Rail | Destination | Sub-nav |
|---|---|---|
| 01 Projekty | `/` | |
| 02 Board | last opened project `/projects/:id` | `02.1 Board`, `02.2 Kalendář`, `02.3 Dashboard` (the page's existing view switch, re-skinned and moved under the bar with CSS counters) and `02.4 Porady` (`/projects/:id/meetings`; on the meetings routes the sub-nav comes from `MonographSubNav`) |
| 03 Tým | `/team` | |
| 04 AI (owner/admin only, as before) | `/ai-control-center` | `04.1 AI Studio`, `04.2 AI History` |
| rail foot / bottom `Intel` | Project Intelligence drawer (project pages) | |

The top bar keeps wordmark, search (Cmd-K), AI model, appearance selector, theme toggle, account menu. Keyboard/AT: a skip link ("Přeskočit na obsah", first tab stop,
target `#mg-content` right after the bar and sub-nav), the rail precedes the top bar in DOM order, `aria-current="page"` on rail, sub-nav and bottom bar, the
hamburger menu is unchanged. <= 900px: numbered bottom bar (4 cells + Intel). On phones the sub-nav is shown (the base hides the view switch there, which left
"Porady" unreachable on a phone).

Screens (all verified in a real browser, see section 7): Login and Register (olive identity panel with display type, ruled form), Projects overview and
the New project / AI project studio dialogs, Board (hero, toolbar, stats, columns with display heads and hairlines, cards with a left edge, task drawer,
new-task dialog, add-column and delete dialogs inherit), Calendar, Dashboard (velocity, burndown, workload, executive summary), Meetings list, New meeting
(text mode and audio mode with consent), Meeting detail (audio panel, machine-transcript note, speaker names, long transcript, revisions), Meeting analysis
(evidence-backed proposals: citation found, accepted / rejected / used states, owner and date hints, assignee + date on create, duplicate warning),
Project Intelligence drawer (Overview / Brief / Knowledge tabs, chat, citations), Team and member dialog, AI Studio, AI History, global search, mobile menu,
empty states (meetings, AI), loading/error states inherit through tokens.

## 6. Pre-existing issues found (not caused by this change)

- `existing` style at 768px: the board page overflows horizontally (917 px) and the Team page too (866 px). Monograph passes at 768 (no overflow). Left as is.
- The Project Intelligence tablist (Overview / Brief / Knowledge) uses the class `pi-mode-switch`, which the base CSS hides at <= 767px together with the
  drawer position switch, so Brief and Knowledge are not reachable on phones. Fixed **only inside Monograph** (the existing style is "must not change").
- Meeting transcripts with an unbroken string (URL) widen the page. Fixed in Monograph (`overflow-wrap: anywhere`); not touched in the existing style.
- Login/Register hide the left panel at <= 900px (existing behaviour), so on phones Monograph shows the ruled form without the olive identity block.
- Not-focus-visible date inputs: Chromium puts focus on the inner segment, so `:focus-visible` never matches the `<input>`; Monograph draws the ring with `:focus-within`.

## 7. Verification (real numbers)

All runs on this branch, Chromium (headless shell) via `playwright-core`, local only: throwaway Supabase stack on `127.0.0.1:55521`, FAKE Gemini and FAKE
Soniox (zero paid calls, no real key anywhere), app on port 3421.

| Check | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| `npx eslint src` | clean (0 errors, 0 warnings) |
| `npx vitest run` | **70 files, 1069 tests passed** (1058 existing + 11 new: selector logic, flag off ignores a stored `monograph`, no-flash script identical to the old one when off, `monograph.css` scoping guard incl. a negative test, fonts + OFL licences present, rail/bottom-bar grouping and `aria-current`) |
| `node scripts/monograph-contrast.mjs` | 68 pairs, **0 violations**; lowest text ratio light 4.61, dark 4.51; form borders >= 3:1 |
| `npm run build`, flag unset and `NEXT_PUBLIC_ENABLE_MONOGRAPH=1` | both compile (29 static pages, no warnings) |
| `scripts/check-production-bundle.sh` | 21 ok / 0 FAIL on both builds (no secret, no `service_role`, JWT roles: none) |
| `scripts/monograph-prodcheck.mjs` on the production builds | off: stored `monograph` ignored, no selector, no rail, 0 Monograph font requests; on: default is existing, selector present, Monograph applies, fonts requested only then (7 files, about 130 kB on `/team`) |
| **Existing must stay existing** (`monograph-regression.mjs`: this branch, flag unset, with `clearspace-style=monograph` planted in localStorage, vs a build of `d01a523`) | **16/16 screens identical**: login, projects, board, team x light/dark x 1440/375; per screen computed style of every element (43 / 117 / 557 / 271 elements) identical **and** screenshots byte-identical. The only markup difference is the `auth-card` class on the login/register card, which no rule matches without `data-style` |
| Visual QA, demo mode, `monograph-shots.mjs` | 110 cases (16 screens x 3 widths x Monograph light/dark, plus the phone menu, plus 12 existing-style references): **108 clean, all 98 Monograph cases clean** (zero page-level horizontal overflow, zero page errors). The 2 failures are the existing style at 768px (board 917 px, team 866 px wide): pre-existing, section 6 |
| Visual QA, real stack, `monograph-stack.sh shots` | 60 cases (meetings list, new meeting text + audio, meeting detail with 21 min transcript and a long unbroken URL, analysis with evidence-backed proposals, empty meetings, board, Project Intelligence overview / brief / knowledge, x 3 widths x light/dark): **60/60 clean** |
| Keyboard pass (`monograph-keyboard.mjs`) | skip link is the first stop; then rail 01-04, Intelligence, wordmark, search, model, style, theme, account; 17/17 stops have a visible 2px ring in light and dark; new-task dialog 8/8 stops ringed, Escape closes it; at 375px the bottom bar is reachable and all stops are ringed |
| Playwright e2e **with the style set to Monograph** (`monograph-stack.sh e2e`, owner-only mode, app built with the flag) | **14 passed**: `monograph-style` (proves the run is really Monograph, fonts apply) + `owner-access` (8) + `meeting-flow` (5: audio with consent -> transcript -> speaker names -> analysis -> accept / reject / create task with assignee + date -> Project Intelligence) |
| Playwright e2e, flag unset, existing style (`APP_PORT=3421 scripts/owner-e2e.sh`) | **13 + 33 passed** (owner-only run; regression run: meetings, project-intelligence, meeting-audio) |

**What was actually looked at vs assumed.** I opened the PNGs for: login (light/dark 1440, light 375), register (light 1440), projects (light 1440), board (light/dark
1440, light 768, light/dark 375), task drawer (light 1440, dark 375), new-task dialog (375), calendar (light 1440, 375), dashboard (light 1440 and dark 768 before the final fix, light 768 after it; dark 768 after the fix only by assertion), Project Intelligence (light/dark 1440, light/dark 375, brief dark 1440, stack light 1440/375), Team (light/dark 1440/375, member
dialog), AI Studio (light 1440), AI project studio dialog, mobile menu, meetings list / new meeting audio / detail (light 1440/375, dark 1440/375) / empty. All
other combinations (AI History, search, most dark 768 screens, forms at 768) were checked by the overflow / page-error assertions and the token contrast gate only,
**not by eye**.

**Defects found and fixed during QA:** style selector text clipped; rail drawn above the dialog scrim; dotted hero texture and glass left over; uneven calendar
columns; sub-nav right-aligned and "Porady" clipped at 375; **meeting transcript with a long URL widened the page to 977 px** (and a long revision `<select>` to
508 px at 375); revision card stretched to the transcript height; raw (unstyled) inputs, links and file input in the meetings forms; Project Intelligence
header overflow ("Fullscreen" clipped); **Project Intelligence tabs unreachable on phones**; **no visible focus on the account avatar and date inputs**; dashboard gutters off by
24px at tablet and the empty chart text overlapping the axis; dark form border at 2.92:1 (now 3:1+); login headline accent colliding with the line above.
Tooling defects: intelligence button hidden on phones (script now uses the bottom-bar cell), seed priority casing, aborted-fetch console noise while navigating.

Not run: VoiceOver / other screen readers, Safari and Firefox, a hosted/staged deployment, any paid provider call.

## 8. Screenshots

CURATED: `docs/monograph/screens/` (<= 30 PNGs, 1440 / 768 / 375, light and dark, plus existing-style references). Full sets are gitignored
(`docs/monograph/shots-full/`), regenerate with the scripts in section 9.

| File | What |
|---|---|
| `monograph-{light,dark}-login-1440`, `-dark-login-375` | login (olive identity panel, ruled form) |
| `monograph-light-projects-1440` | projects overview |
| `monograph-{light,dark}-board-1440`, `-light-board-768`, `-{light,dark}-board-375` | board with rail / bottom bar, numbered sub-nav, columns, cards |
| `monograph-light-board-card-drawer-1440` | task detail drawer |
| `monograph-light-calendar-1440`, `-light-dashboard-1440`, `-dark-dashboard-768` | calendar, dashboard |
| `monograph-dark-intelligence-brief-1440`, `-light-intelligence-knowledge-1440`, `-dark-intelligence-375` | Project Intelligence drawer (brief, knowledge, phone) |
| `monograph-light-meetings-list-1440`, `-meetings-new-audio-1440`, `-meetings-empty-1440` | meetings list, new meeting (audio mode), empty state |
| `monograph-{light,dark}-meeting-detail-1440`, `-light-meeting-detail-375`, `-dark-meeting-detail-768` | meeting detail: audio panel, transcript with speakers, evidence-backed proposals |
| `monograph-light-team-1440`, `-light-ai-studio-1440`, `-light-search-1440`, `-light-mobile-menu-375` | team, AI Studio, global search dialog, phone menu |
| `existing-light-board-1440`, `-board-375`, `-login-1440` | the existing style, for comparison (unchanged) |

## 9. How to reproduce

```bash
cd frontend
# demo mode (mock auth + seeded board): login, projects, board, drawer, calendar, dashboard, intelligence, team, AI, dialogs
NEXT_PUBLIC_FORCE_DEMO=1 NEXT_PUBLIC_ENABLE_MONOGRAPH=1 npx next dev -p 3421 -H 127.0.0.1 &
node scripts/monograph-shots.mjs                 # 3 widths x (monograph-light, monograph-dark, existing-light subset); asserts no overflow / page errors
node scripts/monograph-keyboard.mjs              # tab order + visible focus, dialog, bottom bar
node scripts/monograph-contrast.mjs              # token contrast gate

# real stack (throwaway local Supabase + FAKE Gemini/Soniox, zero paid calls): meetings, analysis, intelligence
S1_STACK_DIR=<stack project> scripts/s1-local-stack.sh up
scripts/monograph-stack.sh shots                 # seeds owner + audio meeting + analysis, captures MODE=stack cases
scripts/monograph-stack.sh e2e                   # monograph-style + owner-access + meeting-flow with the style set to Monograph (E2E_STYLE=monograph)
scripts/s1-local-stack.sh down

# regression: flag unset vs the commit before this branch (git archive d01a523 into another folder, both in demo mode)
BASELINE_URL=http://127.0.0.1:3422 CURRENT_URL=http://127.0.0.1:3423 node scripts/monograph-regression.mjs
# production contract of the flag (needs `next build` + `next start`)
EXPECT=off|on BASE_URL=http://127.0.0.1:3421 node scripts/monograph-prodcheck.mjs
```

## 10. Known limitations

- **Restyle, not re-layout, for the long tail.** Shared primitives, shell, board, drawers, dialogs, meetings and the intelligence drawer are deliberately
  Monograph; very component-specific inline-styled UIs (Generate sprint / capacity planner / risk analysis modals, AI history cards) inherit through tokens
  and the cross-cutting rules and look coherent but are less "editorial". Inline colours that encode data (member colours in pickers, tag swatches) stay.
- Sora and Fraunces (existing `next/font`) are still downloaded in Monograph.
- Screen readers: semantics were checked by script (landmarks, `aria-current`, skip link, tab order) and by the keyboard pass, **not with VoiceOver**.
  axe-core is not a declared dependency of this project, so it was not used (it is installed transitively; adding it as a dev dependency is a one-line follow-up).
- Pages have no single `<main>` landmark (pre-existing); the skip link targets an anchor placed after the bar.
- The task detail / dialog Escape and focus-trap behaviour is the existing one (Escape closes dialogs; the pass confirms it, no new trap was added).
- Safari/Firefox were not tested (Chromium only). `body:has(.mg-rail)` needs `:has()` (Safari 15.4+, Chrome 105+, Firefox 121+).
- The local Supabase stack runs without Realtime, so the board's websocket error is filtered in the shots script (environmental).
- `next build` fetches the existing Google Fonts (Sora/Fraunces) at build time, as before.

## 11. Rollout plan

1. Merge the branch (flag unset => zero visible change, verified section 7). No migrations, no env needed in production.
2. Staged deployment: set `NEXT_PUBLIC_ENABLE_MONOGRAPH=1` (build-time variable, so a separate staging build), sign in, choose "Monograph" in the bar; review light and dark.
3. Decide: keep as an opt-in appearance, make it the staged default for new users (change `resolveDesignStyle` default), or drop it.
4. Rollback at any step: unset the variable (rebuild) or remove the one CSS import.
