# Team collaboration and realtime (RUN 01)

Branch `feature/run01-collaboration`, cut from `release/rc2-monograph` @ `5a34ed4` (RC5, the promoted production state).
Migration `frontend/supabase/migrations/20261124001000_collaboration.sql`, rollback
`frontend/supabase/rollback/20261124001000_collaboration.down.sql`. **Not applied to any hosted project.**

## 1. Shape

```
Identity        auth.users -> profiles (signup trigger) -> workspace_members (one row per person per workspace owner)
Membership      project_members(project_id, member_id -> workspace_members, project_role)
Authorization   project_role(p) / can_edit_project(p) / can_manage_project(p)   <- single source (SQL, SECURITY DEFINER)
                RLS (read = is_project_member) + BEFORE triggers (viewer = no write, on every path incl. definer RPCs)
Events          activity_logs = project event log, written by DATABASE TRIGGERS from the trusted operation itself
Notifications   notifications, created by the same triggers, readable only by the recipient
Realtime        Supabase postgres_changes as a SIGNAL (cards/columns/activity_logs/project_members filtered by project_id,
                notifications filtered by recipient). The database stays the source of truth; clients re-read.
Presence        Supabase Presence on the PRIVATE channel `project:<id>` (realtime.messages policies: members only). No DB writes.
Concurrency     cards.version (server-incremented) + conditional update + client three-way merge -> conflict notice
```

Nothing new runs outside Postgres + the existing Next.js client: no broker, no queue, no new dependency.

## 2. Membership and permissions

| Role (stored value) | UI label | Read | Edit board (cards, columns, checklists, comments, files, meetings) | Manage members / invite |
|---|---|---|---|---|
| owner (= `projects.user_id`) | Vlastník | yes | yes | yes, any role below owner |
| `admin` | Správce | yes | yes | yes, only Editor/Čtenář; cannot touch admins/owner |
| `member` | Editor | yes | yes | no |
| `viewer` | Čtenář | yes | **no** | no |

* `member` keeps its stored value (existing rows and the column default stay valid); it is the editor role.
* A stored `owner` on a non-owner row (legacy data) is treated as `member` -- never as owner.
* Nobody changes their own role; the owner row cannot be demoted or removed; members can only come from the
  project owner's workspace (no cross-workspace membership). RPCs: `set_project_member`, `remove_project_member`.
* The owner's existing direct-table path (`project_members` RLS, owner only) is unchanged.
* **New projects are no longer shared automatically.** Previously a new project's membership defaulted to *every*
  workspace member, which silently gave every linked collaborator access. In Supabase mode a new project now starts
  with the owner only (demo mode keeps the old behaviour: single local user).
* Removing a member revokes access immediately: RLS (reads, realtime row delivery), the client drops the board on
  the membership signal, their notifications about the project are deleted (they get one "removed" notice).

### Viewer enforcement

`b_collab_guard_write` (BEFORE INSERT/UPDATE/DELETE) on `columns, cards, task_checklists, task_comments, task_activities,
card_assignees, task_resources, meetings, meeting_transcripts, intelligence_items` refuses a viewer with SQLSTATE 42501.
Triggers also fire inside SECURITY DEFINER / INVOKER RPCs (Meeting Intelligence apply/undo, restore), which RLS alone
would not cover. Storage: restrictive policies `collab_viewer_no_upload/delete` for `task-resources` and `meeting-audio`.
The UI hides create/edit controls and disables the task drawer for viewers (`is-readonly`, `<fieldset disabled>`).

## 3. Invitations

* Existing workspace invitations (Team page) are unchanged: 256-bit token, only its SHA-256 stored, 7 days,
  single use, bound to the VERIFIED account e-mail.
* New `create_project_invitation(project, email, role)`: owner/admin; admin cannot invite an admin; per-inviter
  limit 20/hour plus the existing 50 pending per workspace; a newer invitation replaces an older pending one.
  Acceptance (the existing token flow or the in-app one) also grants the project role (trigger
  `collab_invitation_accepted`, so `accept_workspace_invitation` is not redefined).
* In-app acceptance `accept_invitation_by_id`: when the invited e-mail already has a **verified** account, the invitee
  gets an `invitation` notification with an *Accept* button. Proof of the address is the verified account e-mail instead
  of possession of the link. Expired / used / revoked / wrong-account invitations are refused.
* `revoke_invitation(id)`: workspace owner, or owner/admin of the invitation's project.
* E-mail delivery is still manual (copy link) -- unchanged scope.

## 4. Domain events (activity) -- contract

`activity_logs` is the project event log. **Only the database writes trusted events** (triggers, deferred to commit).

| Field | Meaning |
|---|---|
| `id` | `evt-<uuid>` |
| `action_type` | event type (below) |
| `workspace_id` | project owner at the time of the event (tenant) |
| `project_id` | project |
| `entity_type`, `entity_id` | `task`/`column`/`project`/`member`/`comment`/`invitation` + id |
| `card_id` | linked task while it exists (FK, `ON DELETE SET NULL`) |
| `actor_id`, `actor_name` | `auth.uid()` of the operation; display name resolved server-side (never client-supplied) |
| `created_at` | server time |
| `source` | `app` (trigger), `client` (narrow self-attested path, see below), or a value a trusted server path sets with `set_config('clearspace.event_source', '<source>', true)` (future: `gmail`, `calendar`, `meeting_intelligence`...) |
| `schema_version` | `1` |
| `correlation_id` | from `set_config('clearspace.correlation_id', ..., true)` |
| `idempotency_key` | unique per project when set (integrations: re-delivery is a no-op) |
| `details` | type-specific JSON; titles/names only, **never comment or description text** |

Types: `project_created, project_renamed, board_restored, column_created, column_renamed, column_deleted,
card_created, card_moved{from,to,from_column_id,to_column_id,completed}, card_archived, card_restored, card_deleted,
card_renamed, card_priority_changed, card_due_changed, card_tag_changed, card_details_changed (coalesced per actor/card
for 10 min), card_assigned, card_unassigned, comment_added, member_invited (masked e-mail), member_added,
member_role_changed, member_removed`. `card_moved.from/to` keep the names the dashboard burndown already reads.

Noise rules: a board created or replaced in one transaction (new-project seed, AI-history restore) produces no per-row
events (`board_restored` once for a restore); an assignee re-sync of identical rows is not a new assignment; when a
Meeting Intelligence RPC already logged `card_created`/`card_archived` with its richer `source` details in the same
transaction, the trigger does not log it again.

Client writes: free-form client logging is gone (it let any member fabricate events under any name). One narrow path
remains because the Intelligence apply/undo RPCs are SECURITY INVOKER and insert their own event: types
`card_created`/`card_archived` only, for a real task of that project, actor/name/time/workspace forced by the server,
`source = 'client'`, viewers refused. Events are immutable for clients (no UPDATE/DELETE).

## 5. Notifications

`notifications(recipient_id, project_id, type, actor_id, actor_name, entity_type, entity_id, card_id, title, event_id, read_at)`.
Types: `mention, comment (new comment on a task you are assigned to), assignment, project_added, project_role_changed,
project_removed, invitation, invitation_accepted`. Created only by the database (`collab_notify`), never for the actor,
never for someone who cannot read the project. Recipient-only RLS; clients may only set `read_at` or delete their own.
Not every change notifies (no notifications for moves, edits, columns).

**Future delivery (Slack/Telegram):** a server-side worker (service role) reads new `notifications` rows (or subscribes to
them), applies per-user channel preferences, and records delivery state in its own table (`notification_deliveries`:
notification_id, channel, status, attempts, external_id). The in-app row stays the source; external delivery is a
projection of it and never widens who is notified.

## 6. Realtime

* `useRealtimeBoard` (one channel per project + purpose, removed on unmount/project switch): `cards`, `columns`,
  `activity_logs`, `project_members`, all filtered `project_id=eq.<id>`. RLS is evaluated per subscriber, so an outsider
  or a removed member receives no row data (verified).
* Every card event is a signal: the client re-reads that card with its children (`fetchCard`) and applies it only if
  `(version, child_rev)` is newer -> echoes of own writes, duplicates and out-of-order deliveries are dropped.
  Child changes (checklist, comment, assignee, file) bump `cards.child_rev` server-side, so one subscription covers them.
* Writes in flight (`pendingWrites`) are not overwritten by an older re-read.
* Failed optimistic writes (create, move, edit, comment) are rolled back to the server's state.
* Reconnect: after `CHANNEL_ERROR/TIMED_OUT/CLOSED` the library rejoins; the next `SUBSCRIBED` (and the browser
  `online` event) triggers a silent full re-read, so changes missed while offline are reconciled. The toolbar shows
  "Spojení přerušeno, obnovuji…" while disconnected.
* `useNotifications`: `notifications` filtered `recipient_id=eq.<uid>`.

## 7. Presence

`usePresence`: private channel `project:<id>`, presence key = user id, one meta per tab
`{name, initials, color, idle}`; idle = the tab is hidden. Folded into one entry per person (tabs counted). Ephemeral:
no database writes. Join/track authorization: `realtime.messages` policies `clearspace_project_channel_read/write`
(members only; an outsider's join is refused). Stale sessions disappear when the socket heartbeat stops.

## 8. Concurrent editing

* `cards.version` is set/incremented by the server on every content change (client values ignored).
* Card field saves send `expectedVersion`; the update is conditional (`... AND version = ?`).
* On a mismatch the client re-reads the card and merges per field (base = value the editor started from, i.e. the
  field's value when it was focused): fields only the other person changed -> keep theirs, re-apply mine, retry;
  the **same** field changed differently -> conflict notice (in the task drawer if open), the field shows their value,
  the user chooses *Ponechat jejich verzi* or *Přepsat mou verzí*. Nothing is overwritten silently.
* Drag & drop moves, archive and column operations are last-writer-wins (by design, small and reversible).
* Comments: only the author edits; author, owner or admin deletes.
* No CRDT/OT, no live text co-editing (out of scope).

## 9. Security boundaries (summary)

* All authorization in Postgres (RLS + SECURITY DEFINER helpers with pinned `search_path`, minimal EXECUTE grants;
  internal helpers are not callable as RPCs).
* Comment author, comment time, event actor/name/time, card `project_id`/`version` are server-derived.
* Comment content is untrusted: 1-5000 characters, rendered as React text only (no HTML), mentions highlighted by
  splitting text; mentions are filtered server-side to project members (max 20) -- no cross-workspace identity leak,
  suggestions come only from the project roster.
* Rate limits: comments 20/min/author, invitations 20/hour/inviter (+50 pending per workspace).
* No tokens or private content in logs; invitation e-mails masked in events.

## 10. Migration and rollback

Apply after `20261118000900`, one transaction: `psql --single-transaction -f 20261124001000_collaboration.sql`.
Additive and idempotent; preflight refuses (and changes nothing) without 0900. Data impact: `cards.project_id` backfilled
from the column, `activity_logs.workspace_id` backfilled; no deletes.

Rollback: `psql --single-transaction -f supabase/rollback/20261124001000_collaboration.down.sql`. It **refuses** while
admin/viewer roles or pending project invitations exist (rolling back would silently turn viewers into editors).
Otherwise it restores the 0900 catalog exactly (verified by catalog snapshot), dropping notifications and the added
event/comment/card columns (rows are kept). Hosted application must follow `docs/MIGRATION_RUNBOOK.md` and needs the
owner's approval; the hosted project is currently paused and was not touched.

Hosted prerequisites: Realtime enabled, tables in `supabase_realtime` (the migration adds them), and for presence
privacy **disable "Allow public access" for Realtime channels** in the project settings (private channels only).

## 11. Tests

| Layer | Where | What |
|---|---|---|
| SQL, committed transactions | `supabase/tests/collab/90_collaboration.sql` via `tests/collab.sh` (scenario K of `run.sh`) | 120 assertions: roles, viewer guard (all tables + definer RPC + storage), invitations (token, in-app, expired, wrong account, reuse, revoke, rate limit), events + noise rules, comments, mentions, notifications, removal, concurrency contract, restore, cascade |
| SQL rollback | `tests/collab.sh` | refusal with a viewer present; catalog after rollback == 0900; re-apply |
| Whole DB harness | `supabase/tests/run.sh` | all earlier scenarios still pass with the new migration |
| Real stack HTTP | `supabase/tests/real_stack.sh` | real GoTrue/PostgREST incl. the new migration |
| Multi-user realtime | `supabase/tests/collab_realtime.mjs` | 45 checks, five separately signed-in clients, real Realtime |
| Browser, two users | `e2e/collaboration.spec.ts` | separate browser contexts, real login, UI invite + accept, presence, live create/move/deadline/assign/comment, mention notification, timeline, conflict notice, viewer read-only, offline reconnect, live revocation, reload |
| Unit | `src/__tests__/collab/*` | conflict rules, mentions, texts, presence folding, comment rendering (XSS) |

Run locally (isolated stack with Realtime, all ports on 127.0.0.1):

```bash
frontend/scripts/collab-stack.sh up        # needs the one-time stack project, see the script header
frontend/scripts/collab-stack.sh seed      # alice/bob/vera + "Společný projekt"
frontend/scripts/collab-stack.sh app       # http://127.0.0.1:3431
eval "$(frontend/scripts/collab-stack.sh env)"
node frontend/supabase/tests/collab_realtime.mjs                      # from frontend/
PLAYWRIGHT_TEST_BASE_URL=http://127.0.0.1:3431 npx playwright test e2e/collaboration.spec.ts --workers=1
frontend/supabase/tests/run.sh                                         # whole DB harness (throwaway container)
```

## 12. Known limitations

1. A card moved into **another project** is not removed live from the old project's boards (the realtime filter is on
   the new `project_id`); it disappears on the next re-read.
2. Checklist items, column names and drag positions are last-writer-wins.
3. The per-card history inside the task drawer (`task_activities`) is still client-written text (legacy); the project
   timeline (`activity_logs`) is the trusted one.
4. Realtime DELETE events cannot be filtered by Supabase; payloads carry only primary keys (random ids).
5. Presence revocation is enforced at join; a removed member's client leaves at once, a modified client could stay on
   the channel until it rejoins (token refresh, <= 1 h). Data access is cut immediately by RLS.
6. Collaborators can read the project owner's whole contact list (`can_view_workspace`, pre-existing): names/e-mails of
   workspace contacts beyond the project. Recommended follow-up: scope to project co-members.
7. No e-mail delivery of invitations; no Slack/Telegram delivery (contracts only).
8. Workspace-level (Team page) invitations do not carry a project/role (they still work as before).

## 13. Extension points for the next runs

* **Google Drive (RUN 02)**: attachments belong to a card/project -> reuse `collab_project_of()` and the viewer guard
  (add the attachment table to the guard list), bump `cards.child_rev` via `collab_touch_card`, emit
  `attachment_added/removed` with `source='drive'`, `entity_type='attachment'`, `idempotency_key = drive file id`.
  Use `task_resources`' storage/permission pattern for the authorization check before any Drive call.
* **Gmail**: email-derived tasks -> insert cards inside a server function that sets
  `clearspace.event_source='gmail'` and `clearspace.correlation_id=<message id>`; attribute to the connecting account
  (`actor_id`), never to the sender.
* **Calendar**: external ids + `idempotency_key` on events; conflict handling via `cards.version` (calendar sync is just
  another writer with an expected version).
* **Slack / Telegram**: consume `notifications` (section 5); never read `activity_logs` directly for delivery.
* **Meeting Intelligence**: already writes through RPCs that pass the viewer guard and dedupe with trigger events;
  move its `source` into the envelope (`set_config('clearspace.event_source', 'meeting_intelligence', true)`).
* **Integrations Hub**: connections should be per workspace (`workspace_id` = project owner), scopes checked with
  `project_role()`; health = last successful event per `source`.
