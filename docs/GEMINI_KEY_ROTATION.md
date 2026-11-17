# Gemini key — dependency inventory and rotation plan

**Nothing in this document has been executed.** No key was created, changed, revoked or used; Gemini was never called.
Secret values never appear here, in logs or in commits (not even fingerprints: those are in the owner's private report).

## 1. What was actually exposed

| Question | Finding | How verified |
|---|---|---|
| Was the key itself published? | **No.** It is read only server-side (`process.env.GEMINI_API_KEY` in route handlers/provider code), never `NEXT_PUBLIC_*`. The deployed JS (10 chunks + HTML) contains **0** strings shaped like a Google API key (`AIza…`). | scan of the public bundle |
| What was exposed then? | The **capability**: until the firewall rule, the old build's 11 `/api/ai/*` routes were unauthenticated, so anyone could spend the key's quota. | code audit (earlier phase) + the Vercel firewall now answers 403 on all 11 |
| Was it abused? | **NOT VERIFIED.** Needs Google Cloud usage metrics/billing for the key's project (no Google access from here). Cloudflare analytics for the (never public-serving) origin host showed no POST `/api/ai/*` in 24 h; Vercel request logs for the old deployment were not inspected. | — |

So rotation is **hygiene plus a spending-cap decision**, not an emergency response to a leaked secret — unless the usage
review below shows abuse, in which case revoke the key first and rotate afterwards.

## 2. Where the key lives (presence only)

| Location | Present | Notes |
|---|---|---|
| Vercel project `clearspace`, **Production** and **Preview** | yes (`GEMINI_API_KEY`, `GEMINI_MODEL`) | **Development** has none. A changed value only takes effect with a **new deployment**. |
| V1 `frontend/.env.local` (canonical) and the older clone under `Vibe Coding Projects` | yes | same value as Vercel's? NOT VERIFIED (Vercel values are hidden) |
| ClearSpace V2 `.env.local` | yes, **same key as V1** | V2 runs as a launchd dev server — it would break on revocation until updated |
| Three `kanban_antigravity*` copies | yes, **same key as V1** | old clones; either update or retire them |
| `V1-consolidation` worktree | none | does not load a key; the AI gateway fails closed (503) without one |
| MicroCRM, utilityforge-os, WebAdviser, MetricOS | **different keys** | **unaffected** by rotating the ClearSpace key; do not touch |
| Git history of this repo | no secrets committed (`.env.local` untracked, backups scanned) | — |

**Blast radius of revoking the shared key:** V1 (Vercel + local) **and** V2 **and** the kanban copies. Therefore create a
**separate key for V1** first, leave the old one for V2/kanban, and rotate those later (or retire them).

## 3. Verify ownership and billing first (owner, Google side — NOT VERIFIED from here)

1. Google AI Studio → API keys: note the key's **Google Cloud project**, creation date and whether the project has a **billing account**.
2. Cloud Console → *APIs & Services → Credentials*: key restrictions (API restriction, application restriction), last-used.
3. Cloud Console → *APIs & Services → Enabled APIs → Generative Language API → Metrics*: requests per day/hour for the last 90 days — look for spikes you cannot explain, and for traffic from the dates the public routes were reachable.
4. *Billing → Reports*, filtered to that project / the Generative Language API: any spend at all?

## 4. Recommended target setup

| Control | Recommendation | Why |
|---|---|---|
| **Hard cap** | Create the V1 key in a Google Cloud project that has **no billing account** (free tier). Charges are then impossible; beyond the free quota requests are rejected with 429. Verify this behaviour in AI Studio for the model you use. | A **budget alert is not a spending limit** — it only e-mails. A free-tier project is the only real cap without writing automation. |
| If billing is needed | Set per-minute/day **quota overrides** on the Generative Language API (Quotas page) and a budget with alerts at 50/90/100 %; optionally a Pub/Sub budget notification that disables billing automatically. | Quota overrides *do* cap throughput; alerts do not. |
| API restriction | Restrict the key to **Generative Language API** only. | Limits damage if it ever leaks. |
| Application restriction | Not possible for a server key with changing egress IPs on Vercel; skip (do not use HTTP-referrer restrictions on a server key — they would break it). | — |
| Separate keys | One key per app (V1, V2, each clone). | Independent revocation. |
| App-side limits | Set `AI_RATE_PER_USER_PER_MINUTE`, `AI_RATE_GLOBAL_PER_MINUTE`, `AI_DAILY_TOKEN_BUDGET_PER_USER` on Vercel. Defaults 10 / 60 / 200 000 are generous: start with e.g. 3 / 10 / 50 000 until validated. These are **estimate-based throttles**, not a cap. | defence in depth |

## 5. Rotation sequence (each step needs the owner's approval; nothing is automatic)

Ordering principle: the new key must exist and be wired **before** the old one is revoked, and Vercel only picks it up on a
deployment — which is the single controlled release in [RELEASE_PLAN.md](RELEASE_PLAN.md). The `/api/ai/*` firewall deny
stays on throughout.

1. **Verify** ownership, usage and billing (section 3). If abuse is found, revoke the old key now (V2/kanban will stop working; acceptable).
2. **Create** a new key for V1 in a project that meets section 4. Do not paste it into chat, a terminal history or a file in a repository.
3. **Vercel (Production + Preview)**: replace the value of `GEMINI_API_KEY` (and set the `AI_*` limits) with the dashboard or
   `vercel env` reading the value from stdin. *This replaces env var values* — explicitly approve it; the old value is not recoverable from Vercel, so make sure it still exists elsewhere (V2 holds it) until step 8.
   Add a Development value only if you use `vercel dev`/`env pull`.
4. **Deploy** — folded into the release deployment (no extra deployment just for the key). Until then the old build keeps the old key; it is firewalled.
5. **Local V1**: update `frontend/.env.local`, restart the dev server. (Only the canonical V1 clone is used; stop using or update the older clone.)
6. **Verify with bounded usage** (after the firewall is relaxed for the owner only, release plan R10): at most a handful of requests; confirm the ledger rows (`ai_requests`) show `succeeded` and the Google metrics show the same count. Never run load tests.
7. **V2 and the kanban copies**: coordinate separately — either give V2 its own new key (recommended) and update its `.env.local`, or accept that they stay on the old key until step 8.
8. **Revoke/delete the old key** only after V2/kanban no longer use it **and** it has shown no unexplained traffic for 24–48 h after cut-over (a revoked key cannot be restored; disable-first if the console offers it).
9. Record the date and the new key's owner project in the release record (never the value).

| Action | Needs a new deployment? |
|---|---|
| Change `GEMINI_API_KEY`, `GEMINI_MODEL`, `AI_*` on Vercel | **Yes** (env changes apply to new deployments only) |
| Change local `.env.local` | No (restart the dev server) |
| Revoke the old key at Google | No — but anything still using it fails at once |
| Change the firewall rule | No (takes effect when published) |

## 6. Stop conditions

- You cannot tell which Google project owns the key → do not rotate; ask in AI Studio.
- The usage review shows abuse → revoke first (accept breaking V2/kanban), then rotate.
- V2 is in active use and has no new key ready → create V2's key before revoking the old one.
