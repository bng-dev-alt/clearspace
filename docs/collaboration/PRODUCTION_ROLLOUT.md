# Collaboration (RUN 01 + 01B) -- production rollout plan

Status: **prepared, not executed.** Nothing below has been applied to hosted infrastructure. Every step that touches
production needs the owner's explicit approval (one consolidated approval is listed at the end).

## 1. Current state (inspected 2026-11-24, read-only, no credentials)

| Item | Finding | How |
|---|---|---|
| Production site | `https://clearspace-ai.vercel.app/login` -> 200 | public GET |
| Supabase project of the live bundle | `twjlnsxjtuntujarwner` (anon key in the public bundle) | public JS chunks |
| Live app version | RC5 (`dpl_HHk26E8s`, commit `12f7738`) per `docs/RELEASE_DECISION.md` / git log; not re-verified against Vercel | repo docs |
| Hosted migration state | expected `…000900` applied (docs: B2 + H1); **NOT VERIFIED** (needs the DB password, not available to this run) | -- |
| Auth | sign-ups enabled, e-mail confirmation ON (`mailer_autoconfirm=false`), e-mail provider on; SMTP = Supabase default mailer (docs) | public `/auth/v1/settings` |
| Realtime | anonymous **public** channel join: SUBSCRIBED (public channels allowed); anonymous **private** join: refused ("Unauthorized") | read-only join probe, no data |
| Backups | Free plan: no PITR/backups per `docs/APPROVAL_PACKAGE*.md`; RUN 00 took a `pg_dump` of `public` before its write | repo docs |
| RUN 00 demo data | being written to this project in parallel by RUN 00; compatible (see §4) | local replay |

## 2. Release blockers

1. **Owner approval** for: database migration, Realtime setting change, Vercel env change + deploy.
2. **Transactional e-mail provider** (SMTP credentials) and a **sending domain you control** (SPF/DKIM/DMARC).
   `clearspace-ai.vercel.app` cannot be used as a sender domain. Without it, invitations work by copy-the-link only.
3. **Supabase Auth SMTP**: with e-mail confirmation ON and the default mailer (sends only to project-team addresses,
   rate-limited), a *new* invitee cannot confirm their account. Configure the same SMTP provider in Supabase Auth
   (Authentication -> SMTP) -- or the new-account invitation path is blocked in production.
4. **Hosted verification** after the migration (§6) -- in particular public/private channel isolation, which was only
   verified locally.

## 3. Order of operations

1. Freeze writes that matter (announce a short window; RUN 00 must not be writing during step 3).
2. Backup: `pg_dump --schema=public` of `twjlnsxjtuntujarwner` (or confirm the RUN 00 dump is recent enough).
3. Pre-checks (read-only SQL, see §4) -> all must pass.
4. Apply `20261124001000_collaboration.sql` (one transaction, as `postgres`, via the existing guarded scripts style:
   checksum-pinned, e.g. adapt `scripts/apply-b2-hosted.sh`).
5. Apply `20261125001100_collab_hardening.sql` (one transaction).
6. Register the e-mail server secret (hash only; the secret itself goes only to Vercel):
   `INSERT INTO public.server_trust (purpose, secret_sha256) VALUES ('email', '<sha256 hex of EMAIL_SERVER_SECRET>')
    ON CONFLICT (purpose) DO UPDATE SET secret_sha256 = EXCLUDED.secret_sha256, rotated_at = now();`
   (compute locally: `printf %s "$EMAIL_SERVER_SECRET" | shasum -a 256`).
7. Realtime settings: **disable public channel access** (Realtime -> Settings -> "Allow public access" off, i.e.
   private channels only).
8. Vercel env (Production): `APP_BASE_URL=https://clearspace-ai.vercel.app`, `EMAIL_TRANSPORT=smtp`, `SMTP_HOST`,
   `SMTP_PORT=587`, `SMTP_SECURITY=starttls`, `SMTP_USER`, `SMTP_PASSWORD` (Sensitive), `EMAIL_FROM="ClearSpace
   <pozvanky@<your-domain>>"`, optional `EMAIL_REPLY_TO`, `EMAIL_SERVER_SECRET` (Sensitive). Do NOT set
   `EMAIL_ALLOW_RESERVED_DOMAINS`.
9. Deploy the branch build as a staged (preview) deployment, run §6 against it, then promote.
   Between steps 5 and 9 the RC5 client keeps working but **without live updates** (it used postgres_changes) --
   keep this window short.
10. Post-promote smoke (§6, short form) and the live e-mail acceptance test (§7).

## 4. Existing-data compatibility checks (read-only, before step 4)

```sql
-- roles: only owner/member exist today (1000 allows owner/admin/member/viewer)
select project_role, count(*) from public.project_members group by 1;
-- legacy rows with project_role='owner' on a NON-owner row are treated as editors (never as owners)
select count(*) from public.project_members pm join public.workspace_members wm on wm.id = pm.member_id
join public.projects p on p.id = pm.project_id where pm.project_role = 'owner' and wm.profile_id is distinct from p.user_id;
-- pending invitations stay valid (they become workspace-level invitations without a project)
select status, count(*) from public.invitations group by 1;
-- comments without a verified author become origin='legacy' (shown as "starší záznam"), e.g. RUN 00 demo comments
select count(*) from public.task_comments;
-- cards with e-mails in the assignees JSON mirror (1100 strips them; version bump only, no events)
select count(*) from public.cards where assignees::text like '%@%';
-- realtime publication today
select tablename from pg_publication_tables where pubname = 'supabase_realtime';
```

RUN 00 compatibility (replayed locally with RUN 00's own seeder, `apply` + `verify` + `cleanup`): rows load unchanged,
demo comments are marked `import`/`legacy`, no e-mail, no notification, no extra event (anonymous tooling writes no
events). Re-seeding after the migration works; RUN 00's `cleanup` keeps any non-manifest row it finds (e.g. events
written by real users later), as designed.

## 5. E-mail provider and DNS (needs you)

* Any SMTP submission provider with domain authentication works (no SDK, no new dependency): e.g. Amazon SES, Brevo,
  Postmark, Resend (SMTP), Mailgun. Pick one you already have an account with; check current pricing yourself --
  invitation volume is tiny (tens per month), so free/entry tiers are normally sufficient. This run did not create
  any account, did not pay for anything and did not send any real e-mail.
* DNS on your sending domain (exact values come from the provider): SPF (`TXT v=spf1 include:<provider> ~all` or a
  provider-specific record), DKIM (provider CNAME/TXT), DMARC (`TXT _dmarc v=DMARC1; p=none; rua=mailto:…` to start).
* Use the same SMTP for Supabase Auth (blocker 3) so confirmation e-mails and invitations come from one domain.
* Keep it separate from personal/Gmail inboxes (RUN 03 Gmail integration is unrelated to transactional mail).

## 6. Verification on hosted (after step 5; disposable users only)

1. `scripts/hosted-verify.sh` (includes `supabase/tests/realtime_check.mjs`, now the broadcast model: member gets the
   signal, stranger/anon refused, postgres_changes delivers nothing).
2. Public/private isolation (after step 7): a public join must now be refused; additionally run a one-off variant of
   `collab_realtime.mjs` against hosted with disposable `@example.test`-style users **only if** you approve creating and
   deleting test accounts there.
3. SQL: `select version from public.clearspace_migrations order by 1` shows both new versions;
   `select count(*) from public.server_trust where purpose = 'email'` = 1.
4. Smoke in the UI (two browsers): owner opens a project -> *Členové projektu* -> invite your own second address ->
   e-mail arrives -> accept -> both see each other in "také zde"; create/move a task -> appears live; comment with
   @mention -> bell; remove the second account -> "nemáte přístup" appears live.

## 7. Live e-mail acceptance test (needs your addresses)

Give the recipient addresses you want to use. Then: invite address 1 as Editor (new account path), address 2 as
Čtenář (existing account path), resend once after a minute, revoke one pending invitation, check the dialog states
(*předán poštovnímu serveru* / *přijata* / *zrušena*), check spam folder placement, and that links point to
`https://clearspace-ai.vercel.app/accept-invite?token=…`.

## 8. Rollback

1. Promote the previous deployment (RC5 `dpl_HHk26E8s`) in Vercel.
2. `psql --single-transaction -f frontend/supabase/rollback/20261125001100_collab_hardening.down.sql`
   (refuses while comment edit history / delivery records exist; `SET clearspace.rollback_allow_data_loss = 'on'` to
   accept losing them). This restores postgres_changes, which RC5 needs for live updates.
3. `psql --single-transaction -f frontend/supabase/rollback/20261124001000_collaboration.down.sql` (refuses while
   admin/viewer roles or pending project invitations exist -- resolve those first; a viewer would otherwise become an
   editor).
4. Remove the e-mail env vars and the `server_trust('email')` row; re-enable public Realtime only if something else
   needs it.

## 9. Consolidated approval request

> Schvaluji pro projekt `twjlnsxjtuntujarwner` / `clearspace-ai.vercel.app`: (1) zálohu `public`, (2) aplikaci migrací
> `20261124001000` a `20261125001100` v tomto pořadí, (3) registraci hashe `EMAIL_SERVER_SECRET` v `server_trust`,
> (4) vypnutí veřejných Realtime kanálů, (5) nastavení e-mailových proměnných ve Vercelu (hodnoty zadám sám),
> (6) staged nasazení větve `feature/run01-collaboration`, ověření dle §6 a promote, (7) živý test pozvánek na adresy:
> ____________.
