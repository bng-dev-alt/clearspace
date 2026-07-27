# clearspace — AI Workspace

A calm, premium **AI workspace** for the work that moves your team forward — a Kanban project tool with an AI studio, workspace collaboration, and a real relational data layer.

> **Portfolio note.** This project was built by *directing an AI coding agent across ~29 documented releases*. My role was the engineering lead and product owner: architecture, auditing, QA, and the product decisions — not typing every line. The story of how it was built is as much the point as the product itself → see **[STORY.md](STORY.md)**.

**Live demo:** https://clearspace-ai.vercel.app/ · **Deep dive:** [ARCHITECTURE.md](ARCHITECTURE.md) · [STORY.md](STORY.md) · per-release notes in [`21`–`29_*_review.md`](.)

---

## What it does

- **Kanban board** — columns, cards, priorities, tags, due dates, checklists, comments, activity log; robust HTML5 drag & drop.
- **Calendar view** — a second per-project view of cards by due date, sharing the same task detail drawer.
- **Workspace collaboration** — two membership levels: *Workspace members* (identity) and *Project members* (a subset). Tasks can be assigned only to project members; multi-assignee with cascade updates.
- **Real accounts** — the signed-in profile becomes a first-class workspace member (owner), linked via a relational model.
- **AI Studio** (Google Gemini) — Generate Tasks, Generate Project, AI Sprint Planner, AI Risk Analysis, plus an AI History with restore and a usage/analytics view. The API key never leaves the server.
- **Theme system** — Light / Dark / System, instant switching, persisted, with a centralized design-token system (no hardcoded colors in components).
- **Two run modes** — works against a real **Supabase** backend, *or* fully in a zero-config **demo mode** (localStorage + mock auth) so it runs anywhere with no setup.

## Tech stack

| Area | Choice |
|---|---|
| Framework | Next.js 16 (App Router), React 19, TypeScript |
| Backend | Supabase (Postgres, Auth, Row-Level Security) |
| AI | Google Gemini via a server-side proxy (`/api/ai/*`) |
| Styling | CSS design tokens (light/dark), no CSS framework |
| Icons | lucide-react |
| Tests | Vitest + Testing Library (92 tests) |

## Getting started

```bash
cd frontend
npm install
npm run dev            # http://localhost:3000
```

That's it — with **no environment variables** the app runs in **demo mode** (local mock auth + `localStorage` persistence), so you can click through every feature immediately. Create an account on the register screen (stored only in your browser).

### Optional: run against real services

Copy `frontend/.env.example` → `frontend/.env.local` and fill in:

```dotenv
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
GEMINI_API_KEY=...            # enables the AI Studio features
GEMINI_MODEL=gemini-2.5-flash
```

- **Supabase:** run [`frontend/supabase_schema.sql`](frontend/supabase_schema.sql) in your project's SQL editor (idempotent, safe to re-run). The app auto-switches to Supabase persistence when the two `NEXT_PUBLIC_SUPABASE_*` vars are present.
- **AI:** without `GEMINI_API_KEY`, the AI features degrade gracefully with a clear message; everything else works.

## Scripts

```bash
npm run dev      # dev server
npm run build    # production build (also type-checks)
npm run start    # serve the production build
npm run lint     # eslint (0 warnings policy)
npm run test     # vitest (92 tests)
```

## Deployment (Vercel)

1. Import the repository into Vercel.
2. Set the **Root Directory** to `frontend`.
3. Environment variables are **optional** — deploying with none gives a working **demo-mode** app. Add the Supabase/Gemini vars above to enable the real backend and AI.

Next.js 16 deploys on Vercel with no extra configuration.

## How it was built

This isn't a hand-typed codebase — it's the result of me **steering an AI agent** through a disciplined, release-by-release process, with a review document written for every release (`*_review.md` in this folder). The interesting decisions were the human ones: running an architectural audit, **stopping feature work to pay down real technical debt** (Release 21), fixing a bug at its root cause instead of with a workaround, normalizing a JSONB prototype into a relational model, and being honest about limits. See **[STORY.md](STORY.md)**.

## License

Personal portfolio project. Not licensed for redistribution.
