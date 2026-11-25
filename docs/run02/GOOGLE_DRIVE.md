# RUN 02 – Google Drive integration (architecture, security, operations)

Status 2026-11-25 (after RUN 02B): implemented on `feature/run02-google-drive` (base `run01-complete` = `ebeaa70`). Verified locally against a
real Supabase stack and the real Next.js app with (a) a **deterministic Google mock** (RUN 02) and (b) **real Google** in a *dev* Google Cloud
project, Testing mode (RUN 02B, §13: core path LIVE-verified, gaps listed). Production Google project not created. Rollout: `docs/run02/PRODUCTION_ROLLOUT.md`.

## 1. What users get

* **Propojené účty** (`/settings`, user menu → „Propojené účty“): connect / reconnect / disconnect a Google account,
  see which account is connected, what was granted and what disconnecting means. Separate from ClearSpace login.
* **Soubory projektu** (toolbar icon on the board): project-level Drive files + an overview of task-level files.
* **Task drawer → Google Disk**: task-level Drive files, next to the unchanged Storage attachments („Resources“).
* Picking happens in **Google Picker** (Google's own UI: browse, search, recent, multi-select up to 20, folders).
* Per link: type icon + Czech type, name, last modified, who linked it, *Otevřít na Disku*, *Náhled textu*
  (Docs/Sheets/Slides/text, the viewer's own access), *Odebrat přílohu* (association only), *Obnovit informace*.
* Live for every member (realtime), recorded in the project timeline, read-only for *Čtenář*.

## 2. Scopes and why (least privilege)

| Scope | Classification | Why |
|---|---|---|
| `openid`, `email` | non-sensitive (sign-in) | show which Google account is connected; `sub` = stable account id |
| `https://www.googleapis.com/auth/drive.file` | **non-sensitive, Google-recommended** | per-file access to files the user picks in the Picker (and files the app created – none). Enough for metadata refresh and text preview of picked files |

**Not requested:** `drive`, `drive.readonly`, `drive.metadata.readonly` (restricted → security assessment), Gmail,
Calendar. Consequences of `drive.file`, stated honestly in the UI:
* ClearSpace never sees the whole Drive. Browsing and search happen inside Google Picker (Google's UI), and only the
  picked files are granted to the app.
* Access is **per Google user**: a teammate's server-side metadata refresh / text preview of a file linked by someone
  else works only after *that teammate* opens it with the app (button „Ověřit přístup na Disku“ opens the Picker on
  just that file; Google shows it only if the teammate can read it). Google answers 404 for both "deleted" and "not
  granted", so ClearSpace never stores "missing" – it shows the caller's own state („Přístup k souboru není dostupný…“).
* Thumbnails are not used (`thumbnailLink` is short-lived, needs credentials, not granted before picking) – type icons.

## 3. Architecture (reusable Google foundation)

```
browser ──Bearer──> /api/google/oauth/start ─┐  state(sha256)+cookie-nonce(sha256)+PKCE verifier(AES-GCM) -> google_oauth_states
   │                                          └─> 302 accounts.google.com (code, S256, offline, consent, include_granted_scopes)
   │<── Google ── /api/google/oauth/callback   (no session, no DB, no Google call: parks {state,code} in an HttpOnly
   │                                           path-scoped cookie, 303 -> /oauth/google; the code never enters a page URL)
   └─Bearer──> /api/google/oauth/complete     consume(state, nonce, auth.uid()) -> code exchange (PKCE + secret)
                                              -> id_token claims -> scope check -> AES-GCM seal -> google_oauth_complete
/api/google/connection (GET status / DELETE = revoke at Google + delete)      /api/google/picker-token (short-lived access token)
/api/drive/links (attach) · /api/drive/links/refresh · /api/drive/links/:id/content (text preview)
```

Files: `src/lib/google/{config,crypto,oauth,server,drive,labels,picker}.ts`, routes under `src/app/api/google/**` and
`src/app/api/drive/**`, client `src/services/driveService.ts`, UI `src/components/drive/*`, page `src/app/settings`,
`src/app/oauth/google`. Migration `supabase/migrations/20261126001200_google_drive.sql`.

* **No service-role key** (unchanged rule): server routes act as the calling user (RLS) and use SECURITY DEFINER RPCs
  guarded by `require_server_secret('google', …)` (new `server_trust` purpose; separate from the e-mail secret).
* **No anonymous RPC**: the OAuth completion runs under the user's session (the harness enforces
  "only `invitation_preview` is anonymous").
* Official endpoints only, called with `fetch` (3 OAuth endpoints + Drive v3), bounded by timeouts, response caps,
  `redirect: 'error'`. `google-auth-library` was considered: the flow uses three documented endpoints, all crypto is
  Node's built-in (`createCipheriv('aes-256-gcm')`, `randomBytes`, SHA-256), and plain `fetch` keeps the provider
  boundary testable with a local mock without monkey-patching. No new dependency.

### 3.1 Connection model (`google_connections`, one row per ClearSpace user)
`user_id` (PK, FK auth.users ON DELETE CASCADE), `google_sub` (UNIQUE – one Google account ↔ one ClearSpace account,
because a revocation at Google ends the app's whole grant for that Google account), `google_email`, `scopes[]`,
`status` (`active|revoked|error`), `refresh_token_enc`, `access_token_enc`, `access_expires_at`, `token_version`,
`refresh_lock_until`, `last_error_code`, per-user API budget window. **RLS on, no policy, no grants** to
anon/authenticated. The browser reads `google_connection_status()` (email, scopes, status, dates – never token data).

### 3.2 OAuth security
| Threat | Control |
|---|---|
| CSRF / login-CSRF / account linking | state (256-bit) stored as SHA-256, bound to the user who began it **and** to the browser (HttpOnly SameSite=Lax nonce cookie, hash stored) **and** consumed only by the same signed-in user |
| Replay | state single-use (`consumed_at`), completion once (`completed_at`), 10-minute lifetime, Google codes single-use |
| Code injection / interception | PKCE S256; verifier stored AES-GCM-sealed with the state as AAD, never leaves the server |
| Open redirect | `returnTo` validated at start (`/settings` or `/projects/<id>`), CHECK constraint in DB; all redirects built from `APP_BASE_URL` |
| Redirect URI | exactly `${APP_BASE_URL}/api/google/oauth/callback` (never from the Host header) |
| Denied / partial consent | `access_denied` → „nepovolili“; Drive unticked (granular consent) → nothing stored, grant revoked, audited |
| Code in URLs / referrers | callback stores it in a path-scoped HttpOnly cookie, `Referrer-Policy: no-referrer`, page URL carries nothing |
| id_token | received directly from Google's token endpoint over TLS (OIDC: no signature re-check needed); `iss`, `aud`, `exp`, `email_verified`, `sub` format still checked |

### 3.3 Token storage, refresh, revocation
* AES-256-GCM, random 96-bit IV, AAD = `clearspace:google:<refresh|access|pkce>:<user|state>` (a ciphertext copied to
  another row does not decrypt). Envelope `v1.<keyid>.<iv>.<ct>.<tag>`. Key `GOOGLE_TOKEN_ENCRYPTION_KEY` (32 bytes)
  lives only in the server environment; the database holds ciphertext only.
* **Rotation**: set the new key as `GOOGLE_TOKEN_ENCRYPTION_KEY`, the old one as `GOOGLE_TOKEN_ENCRYPTION_KEY_PREVIOUS`;
  values re-seal with the new key on their next write (refresh). Remove PREVIOUS when no envelope carries its key id
  (`select count(*) from google_connections where refresh_token_enc like 'v1.<oldid>.%'`). A lost key = users reconnect.
* **Refresh**: when the access token expires within 60 s. One request takes the database lease (`token_version`,
  20 s), the others wait for the stored result (verified: 5 concurrent requests → exactly 1 refresh). If Google returns
  no new refresh token, the stored one is kept. `invalid_grant` / `unauthorized_client` → `revoked` (+ audit) →
  „Znovu připojit účet“. Temporary failures → Czech „dočasně nedostupný“, connection kept, lease released.
* **Disconnect**: revoke the refresh token at Google (best effort; reported), delete the row, audit. Links stay.
* **Audit** (`integration_audit`, own rows readable): connected, reconnected, disconnected, revoked_by_provider,
  refresh_failed, scope_denied. Routine refreshes are not audited; nothing goes to the project timeline.
* Logs carry only error *codes* / error *names*; never tokens, codes, file names or content.

## 4. ClearSpace access vs Google access

| | Decided by | Enforced where |
|---|---|---|
| See a link (name, type, link, who/when) | ClearSpace membership | RLS `is_project_member` |
| Add a link | ClearSpace editor+ (owner/admin/member) | route pre-check + `drive_link_add` (`can_edit_project`) + viewer guard trigger |
| Remove a link | ClearSpace editor+ | RLS DELETE `can_edit_project` + viewer guard |
| Open the file / read its content | **Google** (the viewer's own Google account) | Google; content preview only with the caller's own token |

* ClearSpace never changes Drive sharing, never makes files public, never deletes or edits Drive files (no write call
  exists in the code). One user's token is never used to show another user anything from Google.
* What becomes visible to project members when linking: file **name, type, Google link, modified time, who linked it**.
  The UI says so next to the add button. Content is never copied or stored.
* Membership removal: the person loses the rows at once (RLS) and the realtime topic key rotates (RUN 01B). Their own
  Google connection is personal and stays.

## 5. Attachment model (`external_resource_links`)
`id`, `project_id` (FK), `card_id` (nullable FK = task link; project follows the card on cross-project moves),
`provider` (`google_drive`; Gmail/Calendar items later), `external_id` (validated), `name` (no control chars, ≤300),
`mime_type`, `web_url` (CHECK: `https://(drive|docs).google.com/…` only), `size_bytes`, `modified_at`,
`provider_state` (`ok|trashed`), `metadata_checked_at`, `linked_by`, `linked_by_name`, `created_at`.
Unique per (project, card-or-project, provider, external id): duplicates return the existing row (`duplicate: true`).
**INSERT/UPDATE only through server-secret RPCs** with metadata read from the Drive API by the server – a client can
never inject a name or a phishing link. Storage attachments (`task_resources`) are unchanged and separate.

## 6. Realtime and activity
* Signal-only broadcast on the private keyed project topic: `{ t: 'links', op, card }` (ids only, no names/links);
  task links also bump `cards.child_rev`. Clients re-read under RLS (`useKanbanBoard` → `emitLinksChanged`).
* Events from triggers on the persisted row (source `app`, verified actor, RUN 01 envelope):
  `drive_file_linked` / `drive_file_unlinked` with `{name, mime, link_id, title?}`. None for duplicates, refusals,
  metadata refreshes, token refreshes, or links removed together with their task/project. Czech texts in
  `activityText.ts`, icon „file“ in the timeline.

## 7. Metadata refresh
Manual („Obnovit informace“) and once when a view opens if any link is older than 1 h. Bounded: ≤25 links per call,
4 parallel requests, 8 s timeout, one jittered retry on 429/5xx, per-user budget 300 Google calls / 10 min in the DB.
Only an editor with access stores changes (rename, trash, modified time); everyone gets their own per-link state.
No polling, no webhooks: changes inside a Google document are **not** synchronized live into ClearSpace.

## 8. Project Intelligence readiness (resource-provider contract)
`src/lib/google/drive.ts` → `getTextContent(cfg, callerToken, fileId)` returns `ResourceContent` {provider,
externalId, name, mimeType, modifiedAt, retrievedAt, **text (untrusted)**, truncated}: explicit single link, the
caller's own token, text types only (Docs→text, Sheets→CSV, Slides→text, text/markdown/csv/json), 2 MB fetch cap,
20 000 chars returned, control chars stripped. Used today only by the text preview (not stored, not sent to AI).
**Deferred (decision):** feeding Drive text into Project Intelligence / Gemini. Precise next step: an explicit
"Analyzovat obsah" action calling `getTextContent` server-side and passing `text` into the existing
`/api/intelligence/analyze-resource` gateway (owner/AI policy, quota ledger, rate limits unchanged), wrapped as
untrusted quoted data with provenance (link id, retrievedAt). Not done here because it is a paid AI call and a privacy
decision (document text leaves Google for the AI provider) that needs the owner's explicit approval.

## 9. Configuration (server only; nothing `NEXT_PUBLIC_*`)
| Variable | Secret? | Notes |
|---|---|---|
| `GOOGLE_OAUTH_CLIENT_ID` | no | Web application client |
| `GOOGLE_OAUTH_CLIENT_SECRET` | **yes** (Sensitive) | |
| `GOOGLE_SERVER_SECRET` | **yes** (Sensitive) | ≥32 chars, ≠ `EMAIL_SERVER_SECRET`; its SHA-256 in `server_trust('google')` |
| `GOOGLE_TOKEN_ENCRYPTION_KEY` (+ `_PREVIOUS`) | **yes** (Sensitive) | base64 of 32 random bytes |
| `GOOGLE_PICKER_API_KEY` | public browser key | restrict to the Picker API and the app's origins (+ `https://docs.google.com/*` if the key is referrer-restricted per Google's docs) |
| `GOOGLE_CLOUD_PROJECT_NUMBER` | no | numeric project number (`setAppId`) |
| `APP_BASE_URL` | no | already set for e-mail; redirect URI and all redirects are built from it |
| `GOOGLE_API_MOCK_BASE` | – | **local tests only**; refused in production and for non-loopback hosts |

Unconfigured = integration off; UI says „Propojení s Google Diskem není na serveru nastavené.“ CSP unchanged (the
narrow CSP has no `script-src`/`frame-src`, so `apis.google.com` and the `docs.google.com` Picker frame work; if a
stricter CSP comes later, allow exactly those). The production bundle guard now also refuses Google secrets, token
prefixes, server RPC names and mock seams in `.next/static`.

## 10. Local development and tests
```
frontend/scripts/drive-stack.sh up && frontend/scripts/drive-stack.sh seed   # isolated stack cs-drive-sb (55540-55549)
frontend/scripts/drive-stack.sh mock                                         # Google MOCK on 127.0.0.1:55590 (SIMULACE)
frontend/scripts/drive-stack.sh app                                          # http://127.0.0.1:3441/?login=auto  (DEV login, no credentials: docs/LOCAL_DEV.md)
frontend/scripts/google-live.sh setup|verify|app                             # RUN 02B: the same app against REAL Google (Keychain credentials)
eval "$(frontend/scripts/drive-stack.sh env)"
```
| Layer | Command | Result (2026-11-25) |
|---|---|---|
| Unit (all) | `npx vitest run` | **1255/1255** (50 new in `src/__tests__/drive/`) |
| DB harness (all scenarios) | `supabase/tests/run.sh` | **2231** SQL assertions PASS (Drive suite `collab/92_google_drive.sql` 73 + 1200 rollback refusals + exact catalog restore + re-apply) |
| Drive HTTP integration + adversarial (real app + stack + mock) | `node supabase/tests/drive_http.mjs` | **28/28** groups |
| Browser E2E, 4 users (owner/editor/viewer/outsider) | `e2e/google-drive.spec.ts` | PASS (Klasika and Monograph) |
| RUN 01 regressions on the same stack | `collab_realtime.mjs` 64/64 · `realtime_check.mjs` PASS · `invite_email.mjs` 41/41 · `e2e/collaboration.spec.ts` + `collaboration-01b.spec.ts` PASS · `supabase-runtime` 4/5 · `task-resources` 6/7 | the 2 failures are pre-existing (identical on unchanged `run01-complete`), §11 |
| Real stack (pristine) | `supabase/tests/real_stack.sh` | PASS (legacy upgrade 16, SQL suites 519, HTTP 29/29) |
| Demo-mode Playwright | `npx playwright test` | 27 passed, 109 skipped (need stacks), 0 failed |
| Typecheck / lint / build / bundle guard | `tsc`, `eslint`, `next build`, `scripts/check-production-bundle.sh` | clean / 0 errors / OK / 48/48 |

**Mock ≠ Google.** `scripts/google-mock.mjs` implements the authorization-code + PKCE + refresh + revoke protocol,
granular consent, the `drive.file` model (readable only if the account can read it *and* picked it), Picker look-alike
and failure injection. It proves our flow and boundaries, not Google's behaviour. Everything mock-based is labelled
„SIMULACE“ in the UI.

## 11. Known limitations
1. Not verified against real Google yet (blocked on Google Cloud setup by the owner).
2. `drive.file`: teammates need their own pick (or the file shared to them in Drive) for preview/refresh.
3. In the task drawer a *Čtenář* sees links and can open them in Drive, but the drawer's read-only fieldset disables
   the preview/connect buttons there; the „Soubory projektu“ dialog offers them.
4. OAuth consent screen in **Testing**: max 100 test users and refresh tokens expire after 7 days (drive.file is not
   exempt) → users see „Znovu připojit účet“ weekly. Publishing the app needs brand verification (homepage, privacy
   policy on a verified domain); no security assessment for these scopes.
5. No live sync of document changes; metadata refresh is manual / on open.
6. Pre-existing, unrelated (also fail on unchanged `run01-complete`): `supabase-runtime` "AI gateway" expects 400 but the
   owner-only AI policy answers 403 first in this environment; `task-resources` "card not saved" waits for a card that
   the RUN 01B server-side card write never shows.

## 12. Gmail / Calendar extension points (RUN 03 / 04)
* Add a scope set next to `DRIVE_SCOPES` (e.g. `GMAIL_SCOPES`) and call `/api/google/oauth/start` with it when the
  user enables the service; `include_granted_scopes=true` keeps Drive; `google_connections.scopes` records the union.
  `hasDriveScope` → a generic `hasScope(service)` check per route.
* Reuse `getAccessToken` (lease, refresh, revocation), `server_trust('google')`, `integration_audit` (add events),
  the encrypted envelope, the route plumbing (`caller`, `dbError`, `readJson`, `errorResponse`), the mock (add endpoints).
* `external_resource_links.provider` is a CHECK list: add `gmail_message` / `calendar_event` with their URL rules.
* Gmail scopes are restricted/sensitive (security assessment) – a separate owner decision. Calendar `calendar.events`
  is sensitive (verification).

## 13. RUN 02B – live acceptance against real Google (dev project, OAuth *Testing*, one real account)

Environment: local app `http://127.0.0.1:3441`, isolated stack `cs-drive-sb`, credentials only in the macOS Keychain
(`scripts/google-live.sh setup|status|verify|app|forget`), real endpoints (`accounts.google.com`, `oauth2.googleapis.com`,
`www.googleapis.com/drive/v3`, `apis.google.com` Picker). Mock mode is separate (`drive-stack.sh mock|app`); the two never run together.
Test files: dedicated harmless files in the owner's own Drive (one JPEG, one Word document); no private files were read.

### 13.1 Findings and fixes
1. **Real sign-in failed with `invalid_client` at the token exchange (live FAIL, then fixed).** Root cause (evidence: server log phase
   `complete_failed`/`invalid_client`, state consumed, DB `connections=0`; reproduced by prefix check): `collab-stack.sh app` re-sourced the
   stack accounts file, which also holds the **mock** client secret, over the real `GOOGLE_OAUTH_CLIENT_SECRET` exported by `google-live.sh`.
   State, PKCE, session binding, cookies and DEV auto-login were all fine (state was consumed). Fix: launchers read only the values they need
   (never `source` the accounts file); `google-live.sh` refuses a non-`GOCSPX-` secret; `googleConfig()` disables the integration when a
   mock-format secret meets the real provider (instead of failing at the first sign-in). Regression tests in `googleLiveConfig.test.ts`.
2. **Authorization code in the dev server's request log (security finding).** `next dev` printed `/api/google/oauth/callback?state=…&code=…`.
   Fixed in `next.config.ts` (`logging.incomingRequests.ignore`, tested; verified live: a callback request is no longer logged). The old
   log was redacted. Production servers do not print request URLs this way.
3. **Secret-free structured OAuth logging** (`oauthLog`): one JSON line per phase (`config`, `state_consumed`, `exchange_ok|complete_failed`,
   `identity_ok`, `saved`, `complete_result`) with booleans, counts, OAuth/Postgres error codes and HTTP status only; fields > 80 chars are
   dropped; never tokens, codes, secrets, cookie values, e-mail addresses, file names or provider bodies.
4. **DEV auto-login vs. fresh-context E2E** (`collaboration-01b`): run E2E suites with `DEV_AUTO_LOGIN=0` (LOCAL_DEV.md).
5. A real-project number briefly appeared in a unit-test fixture of an unpushed local commit; scrubbed from the history before any push.

### 13.2 Matrix – LIVE (real Google) vs not verified
| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | Connect a real Google account | **LIVE PASS** | log `exchange_ok` (refresh token, id_token, Drive granted, 3 scopes) → `identity_ok` → `saved` → `connected`; DB: one `active` connection, scopes exactly `userinfo.email`, `openid`, `drive.file`; refresh token stored only as `v1.…` AES-GCM envelope |
| 2 | Connected account shown | **LIVE PASS** | status API + settings card (DOM test, Classic and Monograph; e-mail not recorded) |
| 3 | ClearSpace identity unchanged | **LIVE PASS** | session still the DEV owner; Google connection separate |
| 4 | Real Google Picker | **LIVE PASS** | owner opened the real Picker (picker-token 200 → attach 201 twice) |
| 5 | Select a real Drive file | **LIVE PASS** | a JPEG and a Word document picked |
| 6 | Attach to project | **LIVE PASS** | server path through the real Drive API (201) **and** (closeout) a manual project-level pick of a native Google Doc in the real Picker |
| 7 | Attach to task | **LIVE PASS** | two real task-level attaches via Picker (events `entity=task`) |
| 8 | Metadata + link | **LIVE PASS** (closeout: opening the original verified – host `docs.google.com`) | real size, modified time, MIME; link host `docs.google.com`, `rel=noopener noreferrer` |
| 9 | Text preview | **LIVE PASS** | native Google Doc: text loaded (files.export, caller's own token; 1834 characters, content never recorded); Word file → real unsupported-format answer (415, Czech) |
| 10 | Duplicate protection | **LIVE PASS** | same real file again → `duplicate: true`, still 1 row |
| 11 | Realtime between members | **LIVE PASS** | editor + viewer on the dialog, no reload: attach seen after ≈540 ms (incl. the real Drive call), removal after ≈115 ms |
| 12 | Activity events | **LIVE PASS** | `drive_file_linked/unlinked` per persisted change, actor verified, none for duplicates/refreshes; timeline shows the Czech sentence |
| 13 | Roles | **LIVE PASS** | editor without own Google connection: remove yes, add no (see §14 – a Google rule, not a ClearSpace one); viewer: neither; outsider via RLS (mock + DB suites) |
| 14 | ClearSpace vs Google permissions | **PARTIAL** | teammate without own Google connection gets „Nejprve připojte…“ and no content; **second real Google account NOT VERIFIED** |
| 15 | Persistence | **LIVE PASS** | connection `active` across app restarts / reloads |
| 16 | Access-token refresh | **LIVE PASS** | stored token expired → server refreshed with the real refresh token at Google (`token_version` 1→2, +60 min); browser got only the access token |
| 17 | Remove link, original untouched | **LIVE PASS** | association removed; the file was still reachable at Google afterwards (`files.get`) and re-attachable; the code has no Drive write call |
| 18 | Disconnect + reconnect | **LIVE PASS** | audit `connected`/`disconnected`/`connected`; links stayed; after reconnect Google still served the earlier-picked file (`refresh` → ok) |
| 19 | Errors | **PARTIAL** | real Drive 404 → „Přístup k souboru není dostupný…“ ✔; the `invalid_client` incident now logs the phase; **denied consent / Drive unticked on the real Google screen NOT VERIFIED live** (mock only) |
| 20 | Classic + Monograph | **LIVE PASS** | DOM assertions, desktop light + mobile dark, no horizontal overflow, no „simulace“ label |
| – | Rename in Drive → *Obnovit informace* | **LIVE PASS** (closeout) | renamed in Drive → stored name now differs from the name recorded in the link event; `metadata_checked_at` advanced |
| – | 7-day refresh-token expiry (Testing) | **NOT VERIFIED** | needs ≥ 7 days; documented behaviour |
| – | Revocation at Google on disconnect | **LIVE PASS** (closeout, §14) | `google-live.sh revoke-check`: old refresh token live (200) → product disconnect (`revokedAtGoogle:true`) → same token now `invalid_grant` |

**Verdict (before closeout): CONDITIONAL PASS** – the core real-Google path (OAuth, Picker, Drive API, refresh, attach, realtime, events, roles, disconnect/
reconnect, UI in both styles) is live-verified; the items marked NOT VERIFIED remain open. Mock results are never counted as live.

### 13.3 Live helper commands
```
frontend/scripts/google-live.sh setup | verify | app      # then open http://127.0.0.1:3441/settings?login=auto
E2E_LIVE_UI=1 [E2E_STYLE=monograph] PLAYWRIGHT_TEST_BASE_URL=http://127.0.0.1:3441 npx playwright test e2e/google-drive-live-ui.spec.ts
E2E_LIVE_REALTIME=1 E2E_LIVE_FILE_ID=<an already picked Drive id> E2E_PASSWORD=… … npx playwright test e2e/google-drive-live-realtime.spec.ts
```
### 13.4 Testing-mode limits (observed behaviour to plan for)
Refresh tokens of an External app in *Testing* expire after 7 days (re-consent: „Znovu připojit účet“); ≤100 test users; the consent screen
shows the unverified-app warning (Advanced → Go to ClearSpace). A public portfolio must not claim Google Drive is available to everyone.

## 14. RUN 02B closeout (2026-11-25)

### 14.1 Permission model of Drive links (audit; no inconsistency found)
Two **independent** layers (unchanged since RUN 02, now pinned by tests):

| Question | Decided by | Rule |
|---|---|---|
| May this user **add / remove** a link (the association in ClearSpace)? | **ClearSpace role** | add: `can_edit_project` (owner, admin, member) inside `drive_link_add`; remove: RLS DELETE `can_edit_project`; both also behind `collab_guard_write` (viewer = read-only). Identical to ordinary task attachments (`task_resources`: member of the project, viewer blocked by the same guard). |
| Can this user's **Picker / Drive call** see the file? | **Google**, `drive.file` is per user and per file | the caller's OWN token is used; ClearSpace never lends one user's token to another and never changes Google sharing. |

Consequence: **an editor can both add and remove**. The earlier report line "editor: remove only" described the live run in which the
tested editor had **no Google account connected** (adding needs the caller's own connection to open the Picker and read the metadata; removal needs
none). It was a test condition, not a permission difference. Evidence: DB suite `92_google_drive.sql` (editor adds/dedupes/removes, viewer refused
on add, remove and refresh), unit matrix `driveLinksPanel.test.tsx` "role matrix" (editor+Google: add+remove; editor without Google: remove only;
viewer: neither), mock browser E2E `google-drive.spec.ts` (editor/viewer/outsider), live realtime spec (editor and viewer see changes).
Still **NOT VERIFIED live: a second real Google account** (an editor who connects *their own* Google and adds a file).

### 14.2 Disconnect vs. revocation at Google (LIVE PASS)
* **Local disconnect** (`DELETE /api/google/connection`): decrypts the stored refresh token, calls `https://oauth2.googleapis.com/revoke`
  (best effort), then `google_disconnect` deletes the encrypted credentials. Links stay; Google sharing is not touched. Response carries
  `revokedAtGoogle` (UI tells the user when Google could not be reached and where to remove the grant manually: myaccount.google.com/permissions).
* **Real revocation proof** (`frontend/scripts/google-live.sh revoke-check`, in-memory token, only statuses printed): before disconnect the old
  refresh token → HTTP 200 (access token issued); after the product's own disconnect → `revokedAtGoogle: true` and the same token → HTTP 400
  `invalid_grant`. So the grant is dead at Google, not just forgotten locally. The connection row is gone (0 rows). The owner reconnects with one click.

### 14.3 Re-check of production protections
* DEV login: production build made with **all dev flags deliberately set** (`CLEARSPACE_DEV_LOGIN`, `NEXT_PUBLIC_DEV_LOGIN`, `NEXT_PUBLIC_DEV_AUTO_LOGIN`, a
  dummy `DEV_LOGIN_PASSWORD`): bundle guard 48/48 ok (no dev-login string, no dummy password anywhere in `.next`); `next start` with the same
  flags: `POST /api/dev/login` → **404**, no dev-login button on `/login`. Unit tests `devLogin`/`devAutoLogin` green.
* OAuth callback logs: dev log of the real-Google run has no `code=`, `state=`, token or secret (only the format label `GOCSPX`); old mock log contains
  mock codes only. `next.config.ts` ignores the callback path in request logging; `oauthLog` drops strings > 80 chars and never receives tokens.

### 14.4 Known baseline E2E failures
Recorded in `docs/TECH_DEBT.md` (TD-1, TD-2); both fail identically on `run01-complete`.

### 14.5 Closeout live results and final verdict
Reconnect (real consent), manual project-level Picker pick of a native Google Doc, text preview, rename in Drive + *Obnovit informace*, and
opening the original were verified by the owner manually and re-checked read-only by `google-live.sh doc-check` (spec `e2e/google-drive-live-doc.spec.ts`:
preview 1834 characters, rename picked up, original opens on `docs.google.com`). DB after reconnect: one `active` connection, scopes exactly
`userinfo.email`, `drive.file`, `openid`, refresh token only as `v1.…` envelope; audit trail contains `connected/disconnected/reconnected`.
The real-Google dev log of this run has no `code=`/`state=`/token.

**Final RUN 02B verdict: PASS for the live scope below; NOT VERIFIED items stay open (never counted from mock).**

| LIVE PASS | NOT VERIFIED |
|---|---|
| OAuth connect (PKCE/state/session binding), reconnect, disconnect **with proven revocation at Google**, Picker (task + project level), native Doc + JPEG + Word, metadata, text preview, rename + refresh, open original, duplicates, access-token refresh, realtime (editor/viewer), events, roles, errors (real 404), persistence, Classic + Monograph UI | **second real Google account** (ClearSpace vs Google permission separation with two Google identities; editor connecting their own Google) · **7-day refresh-token expiry** in Testing mode · **denied consent / Drive unticked on the real Google screen** (mock only) · behaviour for Google *Workspace* accounts / shared drives · production Google project, production run |

Regression at closeout: unit 1266/1266, `tsc` 0, lint 0 errors (3 old warnings), production build with DEV flags set → bundle guard 48/48 and `/api/dev/login` 404,
live specs (`google-drive-live-ui` Classic + Monograph 4/4, `dev-login-stack` 3/3, `google-drive-live-doc` 1/1). DB harness and mock suites were **not** re-run
(migration and server code unchanged since their last green run: DB harness 2231 assertions, `drive_http` 28/28, `collab_realtime` 64/64, `invite_email` 41/41).

## 15. RUN 02C (production rollout preparation, 2026-11-25)
* **Limited pilot flag:** `GOOGLE_OAUTH_PUBLISHING` (server env). Anything but `production` = consent screen in *Testing* → status API returns
  `pilot: true` and the settings card / files panel say that only approved Google test users can connect. Set `production` only after publishing.
* **Public pages:** `/about` (OAuth homepage) and `/privacy` (Google data disclosure, Limited Use statement; controller/contact from server env
  `PRIVACY_CONTROLLER` / `PRIVACY_CONTACT_EMAIL` only) – rendered without login and without client JS (`ProtectedRoute` static public paths).
* `/api/dev/login` returns 404 for every method (production previously answered 405 to GET).
* Production rehearsal of 1200 on a faithful replica of the production schema: PASS (`scripts/rehearse-drive-prod.sh`).
* Everything about the production rollout: `docs/run02/PRODUCTION_ACCEPTANCE.md`.
* **2026-11-25: in production** (`https://clearspace.luffast.com`, deployment `dpl_26oNU69rEMtEazEZpMk1pgf7hV8k`, commit `32eb451`) as a limited pilot
  (consent screen in Testing). Owner live acceptance PASS; details, evidence and NOT VERIFIED items: `PRODUCTION_ACCEPTANCE.md` §0, §12, §13.
