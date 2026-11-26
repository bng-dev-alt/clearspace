# RUN 05 – návrh: oznámení mimo aplikaci (Slack, Telegram)

Závazné principy: `RUN_PROMPT.md` §2, architektura: `ARCHITECTURE_DECISION.md`. Tento dokument = rozpracování MUST M1–M10.

## 1. Události
| Typ (doručení) | Zdroj | Kdo dostane | Obsah zprávy (česky) | Předvolba |
|---|---|---|---|---|
| `assignment` | `notifications` (trigger) | přiřazený (ne aktér) | „<aktér> vám přiřadil(a) úkol „<úkol>““ + projekt + odkaz | Přiřazení úkolu |
| `due_soon` | plánovač | přiřazení s účtem | „Zítra / Dnes (<datum>) je termín úkolu „<úkol>““ + projekt + odkaz | Blížící se termín |
| `mention` | `notifications` | zmíněný | text `describeNotification` + projekt + odkaz (bez textu komentáře) | Zmínka |
| `comment` | `notifications` | autor/přiřazený dle RUN 01 | dtto | Komentář k mému úkolu |
| `task_completed` | `activity_logs.card_moved` (`completed=true`) | přiřazení kromě aktéra | „<aktér> označil(a) váš úkol „<úkol>“ jako hotový“ | Můj úkol dokončen |
| `task_due_changed` | `activity_logs.card_due_changed` | přiřazení kromě aktéra | „<aktér> změnil(a) termín vašeho úkolu „<úkol>“ na <datum> / odebral(a) termín“ | Změna termínu mého úkolu |
| `project_added`, `project_role_changed`, `project_removed` | `notifications` | dotčený člen | text `describeNotification`; `project_removed` bez odkazu | Členství v projektech |
| `test` | ruční | jen sám sobě | „Zkušební zpráva z ClearSpace – oznámení fungují.“ | — |
Režim **„bez názvů“**: místo názvů úkolu/projektu jen typ („Máte nový přiřazený úkol v ClearSpace.“) + odkaz. Nikdy: text komentářů, popis, přílohy, Drive/Gmail/Kalendář.
Odkaz: `APP_BASE_URL` + `notificationHref` (`/projects/<id>?task=<card>`); nepřihlášený uživatel projde přihlášením stávajícím mechanismem.

## 2. Data (migrace 1500, vše bez klientského přístupu – jen server-secret RPC)
* `notification_channels` (1 na uživatele a poskytovatele): `status linking|confirm|active|reconnect|blocked`, `enabled`, `secret_enc` (AES-GCM obálka:
  Slack `{botToken, userId}`, Telegram `{chatId}`; AAD `clearspace:notify:<provider>:<channel id>`), `team_hmac` (Slack, HMAC team id), `label`
  (název workspace / jméno v Telegramu – vidí jen vlastník), `link_hash` + `link_expires_at` (jednorázový propojovací token / OAuth state, 10 min),
  `last_error_code`, `last_sent_at`, `last_test_at`.
* `notification_preferences` (1 na uživatele, chybí = výchozí): `event_types text[]` (výchozí vše), `project_ids text[]` (NULL = všechny), `hide_titles`.
* `notification_deliveries` (outbox): `channel_id`, `user_id`, `kind`, `dedupe_key` (unikátní s kanálem: `n:<notification>`, `a:<activity>`, `d:<card>:<date>`),
  odkazy na zdroj (`notification_id`, `activity_id`, `project_id`, `card_id`, `due_date`), `status pending|sending|sent|failed|cancelled`, `attempts`,
  `next_attempt_at`, `lease_until`, `last_error_code`. Žádné názvy ani texty.
* Triggery `AFTER INSERT` na `notifications` a `activity_logs` → `notify_enqueue` (výjimky pohlceny). Žádná změna existujících objektů.

## 3. Trasy (`/api/notify/*`, přepínač → auth → vlastnictví; `NO_STORE`; české chyby)
| Trasa | Účel |
|---|---|
| `GET status` | stav kanálů + předvolby (503 `notify_disabled`, když jsou oba přepínače vypnuté) |
| `PUT preferences` | uloží typy, projekty, „bez názvů“ (validace) |
| `POST slack/start` → `GET slack/callback` → `POST slack/complete` | OAuth v2 (`chat:write`), state vázaný na uživatele + HttpOnly cookie prohlížeče |
| `POST telegram/link` → `POST telegram/check` → `POST telegram/confirm` | deep link → `getUpdates` → potvrzení v ClearSpace |
| `POST channel` `{provider, enabled}` | pozastavit / obnovit kanál |
| `DELETE channel?provider=` | odpojit (Slack `auth.revoke` jen bez dalších uživatelů téhož workspace; Telegram zpráva „odpojeno“) |
| `POST test` `{provider}` | zkušební zpráva (max 1 / 30 s) |
| `POST dispatch` | tick plánovače: hlavička `x-notify-secret`; `prepare` → `claim` → odeslání → `result` |

## 4. Doručování
`prepare`: zruší čekající doručení vypnutých poskytovatelů; vygeneruje `due_soon` (§5); vypršelé leasy `sending` → `failed ambiguous`; smaže konečné záznamy > 30 dní.
`claim(limit 40, lease 120 s)`: `FOR UPDATE SKIP LOCKED`, **autoritativní kontrola každého řádku** (kanál aktivní + zapnutý, poskytovatel zapnutý, předvolby,
zdroj existuje, člen projektu, úkol existuje a není archivovaný, u `assignment`/`due_soon`/`task_*` stále přiřazený, u `due_soon` termín beze změny, úkol
není hotový a termín neuplynul) → neplatné `cancelled` s důvodem, platné vrací se jmény pro vykreslení.
Odeslání: sekvenčně, ≥ 1,1 s mezi zprávami do stejného cíle, max ~50 s na tick; timeout požadavku 10 s.
Výsledky: `sent` · `retry` (5xx, síť před odpovědí, 429 s `Retry-After`/`retry_after`, Telegram 401 = konfigurace serveru) s backoffem 1/5/15/60 min, max 5 pokusů →
`failed` · `failed` (chyba zprávy, timeout po odeslání = `ambiguous`) · kanál `reconnect` (Slack `invalid_auth`, `account_inactive`, `token_revoked`, `token_expired`,
`not_authed`, `channel_not_found`, `user_not_found`, `missing_scope`, `team_access_not_granted`; Telegram 400 `chat not found`) nebo `blocked` (Telegram 403) – ostatní
čekající doručení kanálu se zruší.

## 5. Termíny
`due_date` (`YYYY-MM-DD`) = den v `Europe/Prague`. Odeslat od `((due - 1) + 09:00) AT TIME ZONE 'Europe/Prague'` do `(due + 1 den) 00:00` místního času.
Generuje `prepare` pro karty s termínem v okně `[dnes, zítra]` (místně), nearchivované, mimo sloupec hotovo, pro přiřazené s aktivním kanálem a předvolbou.
Klíč `d:<card>:<date>` ⇒ jednou; změna termínu ⇒ nový klíč, starý se při `claim` zruší (termín nesouhlasí).

## 6. UI (`/settings`, vzor `GoogleConnectionCard`)
Karta **„Oznámení mimo aplikaci“** pod kartou Google: řádky Slack a Telegram (`settings-service`: stav, Připojit / Potvrdit / Zkontrolovat / Pozastavit /
Odpojit / Znovu připojit / Zkušební zpráva), předvolby (zaškrtávací typy, Všechny projekty / Jen vybrané, „Neposílat názvy“), seznam „co se posílá a kam“,
odkaz na `/privacy#notifikace`. Návrat ze Slacku `?notify=slack`. Karta se nezobrazí, když jsou oba přepínače vypnuté. In-app zvonek beze změny.

## 7. Testy
Vitest `src/__tests__/notify/*` (renderer, escapování, klasifikace chyb, termíny/DST, konfigurace + mock jen loopback), DB `95_notification_channels.sql`,
HTTP `supabase/tests/notify_http.mjs` (mock), E2E `e2e/notify.spec.ts`, živě `supabase/tests/notify_live_gate.mjs` + `scripts/notify-live.sh`.
