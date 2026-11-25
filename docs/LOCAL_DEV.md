# Local development: one command, no login

```bash
cd frontend && scripts/local-dev.sh          # stack up (if needed) + seed + Auth preflight + fake AI/STT + next dev on 127.0.0.1:3421
```

Open <http://127.0.0.1:3421>. You are signed in as the synthetic dev owner **`dev-local@example.test`** and land in the app: no form, no password.

## What it is (and is not)

| | |
|---|---|
| Auth | The **isolated local** Supabase stack (`scripts/s1-local-stack.sh`, GoTrue on `127.0.0.1:55521`). Real accounts do not exist there and are never copied there. |
| Session | A **real JWT** from that GoTrue: the server performs a normal password grant for the synthetic identity (`/api/dev/login`, marker `auto`) and the browser gets an ordinary Supabase session. RLS, project membership and the AI owner gate are unchanged. |
| Identity + data | `scripts/local-dev.sh seed` (part of the default run): creates the identity on the local stack, or resets its password to the one in `$S1_STACK_DIR/dev-identity.env` (mode 600, outside the repo; generated once). Idempotent. On first sign-in the app seeds the identity's default project and board itself (per user, idempotent). The identity is the AI owner of this local instance; Gemini and Soniox are local **fakes** (no key, no credit). Richer meeting/analysis data: `scripts/monograph-stack.sh shots` (separate fixed owner). |
| Refresh | Every page load checks the stored session against the local GoTrue (`getUser`); a dead token (stack reset) is replaced automatically. supabase-js refreshes live tokens. |

## Guards (all must hold; any failure = the normal login page, the route answers 404)

1. **Development build only.** `AuthContext` loads `lib/devAutoLogin.ts` behind `process.env.NODE_ENV === 'development'` (a build-time constant): a production build contains neither the code nor the route URL. `scripts/check-production-bundle.sh` fails on `api/dev/login`, `clearspace-dev-autologin`, `DEV_AUTO_LOGIN`. The route itself refuses `NODE_ENV !== development`.
2. **Explicit local enablement:** `CLEARSPACE_DEV_LOGIN=1` + `CLEARSPACE_DEV_AUTO_LOGIN=1` (server) and `NEXT_PUBLIC_DEV_AUTO_LOGIN=1` (client). Only `local-dev.sh` sets them; `.env.local` does not.
3. **Never on Vercel:** refused when `VERCEL` or `VERCEL_ENV` is set (production and protected staging).
4. **Loopback only:** server bound to `127.0.0.1`; request `Host`, `Origin`, `X-Forwarded-*` must be loopback; tunnel/CDN headers (`cf-*`, `x-vercel-*`, `forwarded`) refuse; cross-site fetches refuse; the client also requires a loopback page host.
5. **Isolated Auth only:** the auto variant refuses unless `NEXT_PUBLIC_SUPABASE_URL` is a loopback URL, so a dev server pointed at the hosted project **never** auto-signs-in.
6. **Startup preflight:** `scripts/local-auth-preflight.mjs` runs before `next dev` and exits 1 when the Auth target is hosted/non-loopback, demo mode is on, the local GoTrue is down, or the identity cannot sign in. `scripts/local-dev.sh preflight` runs it alone; add `APP_URL=http://127.0.0.1:3421` to check a running app too. **Run it before any local login attempt.**

No service-role key reaches the browser (it is used only by the shell script for the local admin API); RLS and production authentication are untouched.

## Explicit-login test mode

- One tab: **log out** (stays logged out in that tab) or open `/login?login=manual`; `?login=auto` re-enables. A fresh browser/tab auto-logs-in again.
- Whole server: `DEV_AUTO_LOGIN=0 scripts/local-dev.sh` (the manual "Dev přihlášení" button stays).
- Playwright suites (`e2e/*.spec.ts`) start their own servers without these flags, so login/logout/registration/unauthorised tests are unaffected.

## Why your real password is rejected locally ("Neplatný e-mail nebo heslo.")

- `NEXT_PUBLIC_FORCE_DEMO=1` (demo/visual-QA servers): mock accounts in the browser's localStorage, no Supabase at all. That exact message comes from the mock login.
- Local stack (`127.0.0.1:55521`): isolated; your account is not there, by design.

Dev builds show which Auth backend the login page talks to (`data-testid="auth-backend"`). Do not point local development at production to "fix" a login.

## Claude Browser / agents

`.claude/launch.json` (workspace root) has `clearspace-local` (this worktree) / `clearspace-rc2-local` (release worktree): `preview_start` it and open the URL; no credentials needed. One-time per machine: create the stack project (`docs/intelligence/IMPLEMENTATION_REPORT.md`, "Local E2E recipe": `supabase init` in `$S1_STACK_DIR`, ports 55520-55529, `site_url` 127.0.0.1).

## Collaboration stack (two users, Realtime)

The default local stack runs without Realtime. For collaboration work use the separate isolated stack
(`frontend/scripts/collab-stack.sh`, ports 55530-55539, loopback only, Realtime on): `up`, `seed` (synthetic
alice/bob/vera accounts and a shared project; the password is generated into `$COLLAB_STACK_DIR/collab-accounts.env`),
`app` (http://127.0.0.1:3431). Open two browser profiles (or one normal + one private window) and sign in as two
different accounts. Details: [collaboration/COLLABORATION.md](collaboration/COLLABORATION.md).

## DEV LOGIN STANDARD for every isolated RUN stack (binding for all future ClearSpace development RUNs)

**Rule:** a person must never need a hunted-down password, a temporary credentials file or a manual login form to open a local
ClearSpace app. Every isolated app started for a RUN ships with a working login, whatever the worktree, port or Supabase stack.

| Need | How |
|---|---|
| Start the app of any isolated collab/drive-style stack | `scripts/collab-stack.sh app` (also used by `drive-stack.sh app` and `google-live.sh app`). It starts the stack if it is down, **re-creates the synthetic accounts idempotently** (`seed`), enables the DEV login for that server process only, runs `local-auth-preflight.mjs` and prints the one link. |
| Link | `http://127.0.0.1:<port>/?login=auto` (any loopback port; deep links such as `/settings?login=auto` work too). Signed in automatically as `alice@collab.test`, the **owner** of the seeded project `project-collab-demo`. |
| Other identity | `DEV_LOGIN_AS=bob` (editor) or `vera` (viewer) before the command; one server = one dev identity. For multi-user tests open `/login?login=manual` in another profile. |
| Button instead of auto | `DEV_AUTO_LOGIN=0` (the "Dev přihlášení (jen lokálně)" button stays). |
| Credentials | Generated once per stack into `$COLLAB_STACK_DIR/collab-accounts.env` (mode 600, outside the repository) and passed to the server process as env; never printed, never in the client bundle. You do not need to read them. |
| New RUN / new worktree / new stack | Copy nothing: branch from a commit that contains `scripts/collab-stack.sh` (or merge it) and run the same command; give the stack its own `COLLAB_STACK_DIR`, ports and `COLLAB_STACK_NAME` (see `drive-stack.sh` as the template). A reset stack heals itself on the next `app`. |

It is the **existing** mechanism (`lib/devLogin.ts`, `lib/devAutoLogin.ts`, `/api/dev/login`, guards above) -- no new auth layer: the server
performs a normal password grant against the isolated local GoTrue, the browser holds an ordinary JWT session, RLS, Realtime, project
roles and the later Google OAuth flow behave exactly as for a typed login. All guards above apply unchanged: development build only,
explicit env enablement (set by the launcher for that process only, never in `.env.local`), never on Vercel/previews, loopback Host/Origin
only, tunnel headers refuse, Auth must be a loopback instance. Verified by `e2e/dev-login-stack.spec.ts` (fresh browser context, one link,
real session + RLS + Realtime, spoofed host / tunnel header / missing marker -> 404).

**E2E suites against a stack app:** run them against an app started with `DEV_AUTO_LOGIN=0` (the button stays). Specs that register or accept an invitation in a FRESH browser context (`collaboration-01b`, `collaboration-01c-*`, `supabase-runtime`) expect no session, and the auto-login would sign that context in as alice (found in RUN 02B: `collaboration-01b` failed with auto-login on, passes with it off). Hand-testing keeps the default (auto).

**Production builds:** never build with these flags in the environment; `scripts/check-production-bundle.sh` fails on the dev-login strings.
