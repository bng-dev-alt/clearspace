<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

<!-- BEGIN:clearspace-dev-login-standard -->
# ClearSpace DEV LOGIN standard (applies to EVERY development RUN)

Every local ClearSpace app you start for a RUN or test MUST be reachable with one link and no credentials. Do not ask the user to find
passwords, read temporary files or type a login. Start isolated apps with `frontend/scripts/collab-stack.sh app` (directly or through
`drive-stack.sh` / `google-live.sh`): it starts the stack, re-creates the synthetic accounts, enables the DEV login for that process and
prints `http://127.0.0.1:<port>/?login=auto` (signed in as `alice@collab.test`, owner of `project-collab-demo`; `DEV_LOGIN_AS=bob|vera`).
Hand the user that single link. Reuse the existing mechanism (`src/lib/devLogin.ts`); never add another auth layer, never enable it for
production/preview builds, never put credentials in the client bundle. Full rule: `docs/LOCAL_DEV.md` ("DEV LOGIN STANDARD").
<!-- END:clearspace-dev-login-standard -->
