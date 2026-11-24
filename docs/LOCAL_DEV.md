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
