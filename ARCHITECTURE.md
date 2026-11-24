# Architecture

A condensed technical overview of clearspace. Full rationale lives in the per-release reviews (`21`–`29_*_review.md`).

## High-level shape

```
Next.js App Router (React 19, TS)
│
├── app/                    routes: board, projects, ai-control-center, ai-history, auth
│   └── api/ai/*            server-side AI proxy (Gemini key stays server-side)
│
├── components/            presentational + feature components (board, toolbar, ai, layout…)
├── hooks/                 useKanbanBoard, useDragAndDrop, useAuth, useColumnRename…
├── contexts/             AuthContext, ThemeContext
│
├── services/             the "backend" seam
│   ├── kanbanService      projects / columns / cards / membership (dual-path)
│   ├── workspaceService   workspace members / identity (dual-path)
│   ├── storage/localStore local (demo) persistence
│   ├── persistence        transparent sync-error reporting
│   └── ai/*               provider factory, prompt builder, schemas, history, analytics
│
└── utils/, types/, data/  pure helpers, domain types, seed data
```

## Persistence: one seam, two modes

Every data operation goes through a service (`kanbanService` / `workspaceService`) that runs in one of two modes, chosen once by `hasSupabaseConfig`:

- **Supabase mode** — Postgres with Row-Level Security; the source of truth.
- **Demo mode** — `localStorage` + mock auth, so the app runs with zero configuration.

Two principles keep this honest (established in Release 21, the "Data Foundation" stabilization):

- **No silent split-brain.** In Supabase mode the app never quietly falls back to `localStorage` on error. Failures are surfaced through a small `persistence` status module and shown in the UI, rather than pretending the write succeeded.
- **Single source of truth for mapping.** DB rows ⇄ app model conversion lives in one place per entity, so schema changes touch mapping functions, not twenty scattered objects.

## Data model (relational)

Release 23 normalized an interim JSONB prototype into a proper relational model with foreign keys, cascades, and RLS. The identity chain — previously three disconnected concepts — is now unified:

```
profiles (auth account)
   │  1:1 (owner)
   ▼
workspace_members ──(profile_id)  identity, scoped per workspace owner
   │  M:N via project_members
   ▼
projects → columns → cards
                        │  M:N via card_assignees
                        ▼
                     workspace_members
```

- `workspace_members` — the single identity for a person; `profile_id` links a real account (null = placeholder contact, ready for future invites). `workspace_role` prepared for permissions.
- `project_members` — which members belong to a project (join table; replaces a `member_ids` JSONB array, which is kept as a denormalized read-cache).
- `card_assignees` — multi-assignee join table with position; the card row keeps a legacy primary assignee for AI prompts and fast reads.
- Assignees are **resolved on read** against the current project members, so identity edits propagate and removed members drop off automatically — no cross-table cascade writes needed for the common case.

The schema is a single idempotent SQL file (`frontend/supabase_schema.sql`), safe to re-run, including a backfill migration from the old JSONB shape.

## Collaboration (RUN 01)

Roles (owner / admin / editor / viewer), viewer read-only enforced in the database on every write path, project
invitations, a trusted project event log written by database triggers, in-app notifications, comments with
@mentions, realtime board sync (Supabase Realtime as a signal, the database stays authoritative), presence on private
channels and optimistic concurrency on cards (`version` + three-way merge). Full description, contracts, security
boundaries, rollback and extension points: [docs/collaboration/COLLABORATION.md](docs/collaboration/COLLABORATION.md).

## AI layer

- **Server-side proxy.** All AI calls go through `/api/ai/*`; the `GEMINI_API_KEY` never reaches the client.
- **Provider factory.** `providerFactory` is a clean seam over the model vendor, so swapping/upgrading models is localized.
- **Structured output.** Responses are constrained by `responseSchema`, and errors are normalized to domain codes (`GEMINI_TIMEOUT`, `GEMINI_RATE_LIMIT`, …) with user-friendly messages.
- **Prompt builder + history.** Prompts are assembled in one place from card/board context; every AI action is logged to an AI History (with restore) and a usage/analytics view. Graceful degradation when no key is set.

Features: Generate Tasks, Generate Project, AI Sprint Planner, AI Risk Analysis.

## Theme system

- Centralized **design tokens** in `globals.css` (`:root` / `[data-theme="dark"]`): color, surface, border, text, accent, state, elevation, radius. Legacy variable names are aliased onto the new tokens so the whole app themes automatically.
- **Light / Dark / System** via `ThemeContext`, persisted to `localStorage`, applied to `<html data-theme>` with a no-flash inline script; transitions are suppressed during the switch for a crisp change.
- Components consume tokens only — no hardcoded colors — so a palette change is a one-file edit (e.g. the dark theme is an "ocean" teal palette).

## Layout & scrolling

Document-level vertical scroll: the board and calendar grow with content and the page scrolls (no per-column internal scroll). Columns are equal-height; the hero compresses responsively on short (laptop) viewports.

## Testing & quality

- **Vitest + Testing Library** — 92 tests: kanban service (project isolation, seeding), drag-&-drop routing regression, workspace/project membership, assignee resolution, AI prompt compatibility, auth, productivity filters, AI history/generation.
- **Zero-warning lint**, production build type-checks, and each release is verified in the browser before it's called done.
- Heavy AI modals are code-split (`next/dynamic`); pure components are memoized.

## Notable decisions & honest limits

- **JSONB → relational** was done deliberately in stages, not up front — prototype fast, normalize once the shape is proven (R21 → R23).
- **Demo-first.** The app is verified at runtime in demo mode; the Supabase relational paths are verified by types/build/tests (not a live DB) — stated plainly rather than overclaimed.
- **Known limitation:** stat cards classify columns partly by name with an id-position fallback (works for default boards); a fully explicit column-type model is deferred to avoid an out-of-scope data change.
