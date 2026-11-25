# Team collaboration and realtime (RUN 01 + RUN 01B)

Branch `feature/run01-collaboration`, cut from `release/rc2-monograph` @ `5a34ed4` (RC5). Migrations
`20261124001000_collaboration.sql` (RUN 01) and `20261125001100_collab_hardening.sql` (RUN 01B), rollbacks in
`frontend/supabase/rollback/`. **Both are applied to the hosted production project (2026-11-25) and the build is live**;
record and results: [PRODUCTION_ROLLOUT.md](PRODUCTION_ROLLOUT.md) §10, acceptance: §11. **RUN 01 status: PASS within the verified scope** (technical evidence and the owner's manual acceptance are listed separately in §11).

## 1. Shape

```
Identity        auth.users -> profiles -> workspace_members (one row per person per workspace owner)
Membership      project_members(project_id, member_id, project_role)
Authorization   project_role(p) / can_edit_project(p) / can_manage_project(p)  -- single source, SQL
                RLS (read = is_project_member) + BEFORE triggers (viewer = no write on every path, incl. definer RPCs)
Contacts        collaborators see only people of projects they share (collab_can_see_member); the owner's address book is private
Events          activity_logs = project/task event log, written by DATABASE TRIGGERS from the trusted operation
Notifications   notifications, created by the same triggers, readable only by the recipient
Realtime        database broadcasts (realtime.send) of content-free SIGNALS on PRIVATE topics:
                  project:<id>:<realtime_key>   members only, key rotated when a member leaves
                  user:<uid>                     the user only (notification signal)
                clients may only track presence; postgres_changes is NOT used for collaboration tables
Presence        Realtime Presence on the same private project topic; ephemeral, no DB writes
Concurrency     cards.version + conditional update + three-way merge; field-level / conditional writes for
                checklists and column names; atomic column reorder; server-assigned card positions
E-mail          server-only SMTP submission (nodemailer), invitation template (cs), delivery bookkeeping
```

## 2. Membership and permissions

| Role (stored) | UI | Read | Edit board | Manage members / invite |
|---|---|---|---|---|
| owner (`projects.user_id`) | Vlastník | yes | yes | yes, any role below owner |
| `admin` | Správce | yes | yes | yes, only Editor/Čtenář; cannot touch admins/owner |
| `member` | Editor | yes | yes | no |
| `viewer` | Čtenář | yes | **no** | no |

Unchanged from RUN 01 (see git history for details): nobody changes their own role, the owner row cannot be demoted,
members only from the project owner's workspace, new projects start shared with the owner only, removal revokes
access immediately.

**Contact privacy (01B).** The old policy let anyone who joined one of an owner's projects read the owner's *whole*
address book (names, e-mails). Now a collaborator sees: their own identity rows, the people on projects they share,
and the owner of those projects. Owners still manage their full address book. Admins invite by e-mail (they do not
need, and no longer get, the owner's contact list). The `cards.assignees` JSON mirror no longer carries e-mails or
account ids (trigger `a_cards_sanitize`).

## 3. Invitations and e-mail

Flow: owner/admin opens *Členové projektu* -> e-mail + role -> `POST /api/collab/invitations` (server) ->
`create_project_invitation` under the caller's RLS -> 256-bit token, only its SHA-256 stored -> the server sends the
Czech e-mail (link = `APP_BASE_URL/accept-invite?token=…`) -> recipient signs in or registers -> the database checks
token, expiry (7 days), single use and the **verified** account e-mail -> project role granted.

* **Resend** (`POST /api/collab/invitations/<id>/resend`): issues a NEW token (the previous link stops working),
  renews validity to 7 days, e-mails again. Throttled: not within 60 s of the last send, max 5 per invitation per 24 h.
* **Duplicates**: a second invitation to the same address of the same project within 60 s is refused (HTTP 429);
  the first invitation and its e-mail stay valid.
* **Revoke**: owner/admin; the link is dead (`used`), the in-app invitation notification is removed.
* **Statuses in the dialog**: čeká na přijetí / přijata / vypršela / zrušena, and the last delivery state:
  `accepted` = *předán poštovnímu serveru* (SMTP acceptance; inbox delivery is NOT claimed), `failed` (with a reason),
  `suppressed` (reserved/test domain or e-mail switched off), none = *e-mail nebyl odeslán*. Copy-link fallback is
  offered right after send/resend (only to the inviter, only in that response).
* **Rate limits**: 20 invitations/hour per inviter (DB), 50 pending per workspace, 30 e-mail sends/hour per inviter.
* **Existing accounts** additionally get an in-app invitation (accept button, verified e-mail required).

E-mail delivery (`frontend/src/lib/email/`): SMTP submission through nodemailer 10 (MIT-0, no dependencies; RUN 01C
replaced the RUN 01B hand-written client): mandatory STARTTLS or implicit TLS, certificate validation, TLS >= 1.2,
plain SMTP only to a loopback capture server, 25 s cap per session, MIME by nodemailer's MailComposer (text + HTML,
UTF-8, folded headers), template with escaped untrusted names and defused links. Retries (3 attempts) ONLY when nothing
can have been submitted (connection/TLS before the message) or after a definite 4xx; 5xx, credentials and certificate
errors are final; a failure during transfer without a server verdict is `smtp_ambiguous`: never retried automatically
(no duplicate invitations) and shown as "server nepotvrdil převzetí, e-mail mohl přesto odejít",
error details sanitised (no tokens/credentials), raw tokens never logged. Delivery bookkeeping goes through
`email_delivery_start/finish`, which require the server secret (`EMAIL_SERVER_SECRET`, SHA-256 in
`server_trust('email')`) *and* that the caller manages the project -- clients cannot forge delivery states.

**Fictional / demo addresses.** `example.com/.org/.net`, `*.example`, `*.test`, `*.invalid`, `*.localhost` are never
sent to a real mail server (`suppressed`). They are delivered only to a loopback capture server when
`EMAIL_ALLOW_RESERVED_DOMAINS=1` (ignored in production). Adding/seeding members never sends anything; only an
explicit invitation does. RUN 00's demo dataset (placeholder members, `example.*` addresses) was loaded on the local
stack: 0 e-mails, 0 notifications, 0 extra events.

Configuration (server-only, see `frontend/.env.example`): `EMAIL_TRANSPORT=smtp`, `SMTP_HOST`, `SMTP_PORT`,
`SMTP_SECURITY`, `SMTP_USER`, `SMTP_PASSWORD`, `EMAIL_FROM`, `EMAIL_REPLY_TO`, `APP_BASE_URL` (https and public in
production; links are never built from the request Host header), `EMAIL_SERVER_SECRET`. Unconfigured = e-mail off,
the dialog says so and offers the link.

## 4. Domain events (activity) -- contract

Unchanged envelope (`id, action_type, workspace_id, project_id, entity_type, entity_id, card_id, actor_id,
actor_name, created_at, source, schema_version, correlation_id, idempotency_key, details`). 01B additions:

* Types: `card_moved_out` (source board, no destination named), `card_moved_in` (destination), `comment_edited`,
  `comment_deleted`, `checklist_item_added/completed/reopened/renamed/removed` (entity_type `checklist`; shown in the
  task history, hidden from the project timeline as noise).
* **Anonymous tooling writes no events**: a write with no user AND no declared source (admin SQL, a demo-data import)
  is not logged -- it would only add "Systém" entries dated today next to imported history. Integrations without a
  user must declare themselves (`set_config('clearspace.event_source', 'gmail', true)`) and are then logged as
  `source='gmail'`, actor "Systém".

## 5. Trusted task history (01B)

The task drawer's *Historie aktivit* is the trusted event log filtered by `card_id` (actor, time and change set by
the database from the persisted change; failed operations leave nothing; duplicates are coalesced/deduplicated as in
§4). `task_activities` (client-written text, pre-01B) is **legacy**: still readable (labelled "Starší záznamy"),
clients can no longer insert/update/delete it -- except inside an AI-history board restore by the owner, which copies
history back from the snapshot.

## 6. Comments

* Ordinary inserts: author, author name and time are **always** server-set (the RUN 01 "owner may backdate by > 5 min"
  rule is gone). Edit: own comments only, previous text kept in `task_comment_revisions` (who/when), shown under
  "(upraveno)". Delete: author, owner or admin; logged as an event.
* `origin`: `app` (verified), `import` (copied back by a board restore, or written by tooling), `legacy` (before RUN 01,
  no verified author). Imports keep the recorded name, never get an account, mentions or notifications, are never
  dated in the future and cannot be edited; the UI marks them "(importováno)" / "(starší záznam)".
* An import is recognised only (a) inside `restore_project_board_v2`, which sets a transaction setting clients cannot
  set, or (b) for rows under a column (re)created in the same transaction -- only a board-rebuilding RPC can do that;
  both additionally require the project owner.

## 7. Realtime (01B)

* One private channel per project and tab: `project:<id>:<realtime_key>` carries the database's signals
  (`change` -> `{t:'card', op:'upsert'|'removed', id, v, r}`, `{t:'column', ...}`, `{t:'membership'}`; `activity` ->
  the event row) and the presence of the members. The key is readable only by members (RLS on `projects`).
* Signals carry no task content; the client re-reads the entity under its own RLS and applies it only if
  `(version, child_rev)` is newer -- echoes, duplicates and out-of-order deliveries are dropped.
* Joining and receiving: `realtime.messages` policy `clearspace_topic_read` (member + current key, or own user topic).
  Sending: clients may only write **presence** (`clearspace_topic_presence_write`); broadcasts come only from the
  database (verified: a member's forged broadcast is not delivered).
* `cards, columns, activity_logs, notifications, project_members` are no longer in the `supabase_realtime`
  publication. Reason (verified on the RUN 01 code): Supabase cannot apply RLS or filters to DELETE events, so an
  outsider subscribed to `cards` received the id of every deleted card of every project. Now an outsider receives
  nothing, not even DELETE ids (verified).
* Cross-project move: the source topic gets `removed`, the destination `upsert`; members of only one side receive no
  metadata of the other; assignees who are not members of the destination are unassigned.
* Reconnect: after an interruption the next `SUBSCRIBED` (and `online`) triggers a silent full re-read, including the
  current key.

## 8. Presence and access revocation

Presence lives on the private project topic. When a member is removed (or leaves) the database rotates the key in the
same transaction and broadcasts a content-free `membership` signal on the old topic; members re-read the key and
rejoin the new topic (the app does this automatically).

Revocation, measured with a deliberately NON-cooperative client (keeps its socket and channel, never re-reads):

| Channel of information | After removal |
|---|---|
| REST / database reads | refused immediately (RLS) |
| New signals / activity broadcasts | none: they go to the new topic (verified) |
| Re-joining (old or new key) | refused (verified) |
| Presence | the stale snapshot it already had (names/colours of members online at removal time); it gains nobody new (verified) |
| The socket itself | stays open until it disconnects or its JWT expires (Supabase default 1 h); carries nothing new |

Residual: the stale presence snapshot (LOW). If a member's client is offline during the rotation it joins the new
topic on reconnect (the re-read includes the key).

## 9. Concurrent editing

| Entity | Strategy |
|---|---|
| Card fields | `version` check + three-way merge; same-field conflict -> notice in the drawer, keep theirs / overwrite mine |
| Checklist toggle | field-level write (`completed` only); two toggles = last one wins (boolean, visible) |
| Checklist text | conditional on the text when editing began; otherwise "Položku checklistu mezitím přejmenoval kolega…", their text shown |
| Checklist item deleted meanwhile | edit refused, item removed, notice |
| Column name | conditional on the name when editing began; otherwise a Czech notice, their name shown |
| Column order | `reorder_columns` RPC: atomic, serialized per project, refused (HTTP 409) when the column set changed; board re-read |
| Card order on insert/move | server-assigned (append, serialized per column) -- no duplicate positions |
| Card moves between columns | last writer wins (reversible, both clients converge) |
| Comments | own-only edits with revision history |

Rate-limit and conflict errors use PostgREST codes `PT429` / `PT409` (HTTP 429/409): SQLSTATE `54000` surfaced as a
generic HTTP 500, and `40001` is retried by PostgREST until the gateway times out (both found in testing).

## 10. Migrations and rollback

Apply in order after `20261118000900`, each as one transaction. Both are additive and idempotent; preflights refuse
(and change nothing) when the predecessor is missing. 1100 does not redefine 1000's functions; it adds new ones and
re-points triggers.

Rollback in reverse order:
* `20261125001100…down.sql` refuses while comment edit history or delivery records exist, unless
  `SET clearspace.rollback_allow_data_loss = 'on'`; otherwise restores the 1000 catalog exactly (verified) -- and
  re-opens the RUN 01 behaviour (owner address book visible to collaborators, postgres_changes with DELETE ids).
* `20261124001000…down.sql` refuses while admin/viewer roles or pending project invitations exist.

## 11. Tests

| Layer | Where | Result (local) |
|---|---|---|
| DB harness (all scenarios incl. hosted role, rollbacks) | `supabase/tests/run.sh` | 2158 SQL assertions PASS |
| Collaboration SQL (committed transactions) | `collab/90_collaboration.sql`, `collab/91_hardening.sql` | 120 + 78 |
| Real stack HTTP | `supabase/tests/real_stack.sh` | 46 + 29 PASS |
| Multi-user realtime (adversarial) | `supabase/tests/collab_realtime.mjs` | 64/64 |
| Hosted-style realtime check | `supabase/tests/realtime_check.mjs` (used by `scripts/hosted-verify.sh`) | 9/9 |
| Invitation e-mail lifecycle (real SMTP -> Mailpit) | `supabase/tests/invite_email.mjs` | 41/41 (01C, nodemailer) |
| New person with e-mail confirmation ON (as hosted) | `e2e/collaboration-01c-confirm.spec.ts` | PASS |
| Production, live (2026-11-25): staged + promoted build; realtime 9/9, presence, public channels refused, 16/16 hosted UI, invitation acceptance with two disposable accounts | `scripts/hosted-verify.sh`, `scripts/hosted-collab-accept.sh` (`e2e/collaboration-01c-hosted.spec.ts`) | PASS |
| Manual production acceptance by the owner (real inbox delivery, registration, confirmation, acceptance, realtime) | PRODUCTION_ROLLOUT.md §11 | user-confirmed PASS (DB trace: account confirmed, invitation accepted, 1 SMTP delivery recorded) |
| Production copy: 0900 schema identical, 1000+1100 as `postgres`, rollback to 0900, RUN 00 verify/dry-run | `scripts/apply-collab-hosted.sh` rehearsal | PASS |
| Browser, two/three users | `e2e/collaboration.spec.ts`, `e2e/collaboration-01b.spec.ts` | PASS (repeated) |
| Unit | `src/__tests__/**` | 1205/1205 |

Local stack: `frontend/scripts/collab-stack.sh up|seed|app|env|mail|down` (Realtime + Mailpit, loopback only).

## 12. Known limitations

1. SMTP gives no delivery confirmation: the app shows "předán poštovnímu serveru", never "doručeno". Bounces arrive at
   the sender address; provider webhooks (delivered/bounced) are an extension point (add statuses to
   `invitation_deliveries`).
2. Presence: a removed, non-cooperative client keeps the snapshot it had (§8).
3. Hosted Realtime: "Allow public access" was switched off on 2026-11-25 (`private_only = true`). Private/public isolation and
   presence are verified on hosted (PRODUCTION_ROLLOUT.md §10). Re-check after any Supabase platform change to Realtime settings.
4. Workspace-level (Team page) invitations still use copy-the-link (no e-mail); project invitations send e-mail.
5. Card moves between columns, checklist toggles and column roles are last-writer-wins by design.
6. Rate limit of the RELEASED 0100 function (50 pending workspace invitations) still raises `54000` (HTTP 500 in the
   UI); left untouched (released code).

## 13. Extension points for the next runs

As in RUN 01 (Drive / Gmail / Calendar / Slack / Telegram / Meeting Intelligence / Integrations Hub), plus:
* signals for any new entity: add a `z_collab_broadcast_*` trigger calling `collab_send(collab_project_topic(p), …)`
  with a content-free payload; never publish the table to `supabase_realtime`;
* server-side integrations writing without a user MUST set `clearspace.event_source`, otherwise their writes are not
  logged (§4);
* transactional e-mail is a generic `sendEmail()` with templates per kind; delivery state per kind follows
  `invitation_deliveries`.
