<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

<!-- BEGIN:clearspace-dev-login-standard -->
# ClearSpace DEV LOGIN standard (applies to EVERY development RUN)

Every local ClearSpace app you start for a RUN or test MUST be reachable with one link and no credentials. Do not ask the user to find
passwords, read temporary files or type a login. Start isolated apps with `frontend/scripts/collab-stack.sh app` (directly or through
`drive-stack.sh` / `google-live.sh` / RUN 03 `gmail-stack.sh` (port 3451) / `gmail-live.sh`): it starts the stack, re-creates the synthetic accounts, enables the DEV login for that process and
prints `http://127.0.0.1:<port>/?login=auto` (signed in as `alice@collab.test`, owner of `project-collab-demo`; `DEV_LOGIN_AS=bob|vera`).
Hand the user that single link. Reuse the existing mechanism (`src/lib/devLogin.ts`); never add another auth layer, never enable it for
production/preview builds, never put credentials in the client bundle. Full rule: `docs/LOCAL_DEV.md` ("DEV LOGIN STANDARD").
<!-- END:clearspace-dev-login-standard -->
# RUN CLEANUP standard (applies to EVERY development RUN)

A RUN is not finished until it has stopped everything it started: dev servers, mocks, loopback proxies, background jobs and its
own Docker/Supabase stacks (`docker stop` / `supabase stop` WITHOUT `--no-backup`). Data the RUN still needs stays (volumes, dumps).
Delete a RUN's test stack (`collab-stack.sh down` = `supabase stop --no-backup`, volume/image removal) only after (1) `pg_dump -Fc`
to `/Volumes/WORKSPACE/_G2_BACKUP/<date>-<run>/` with SHA256SUMS and a verified restore, and (2) confirming the stack can be rebuilt
from migrations + seed (`*-stack.sh up` + `seed`). Never touch other projects' containers, public demo services or tunnels; never
`docker system prune -a --volumes`. Destructive deletions of data-bearing resources go to the owner as ONE consolidated list.
