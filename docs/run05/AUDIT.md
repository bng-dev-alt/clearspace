# RUN 05 – audit stávající infrastruktury (Phase 0, jen čtení)

Datum 2026-11-26. Větev `feature/run05-slack-telegram` z `run04-complete` (`6732dca`). Zdroj: kód a migrace v tomto stromu + čtení produkční DB (jen `READ ONLY` transakce).

## 1. Notifikace (RUN 01/01B) – znovupoužít beze změny
| Část | Kde | Zjištění |
|---|---|---|
| Tabulka | `20261124001000_collaboration.sql` §5 | `notifications(recipient_id, project_id, type, actor_id, actor_name, entity_type, entity_id, card_id, title, event_id, read_at)`; typy `mention, comment, assignment, project_added, project_role_changed, project_removed, invitation, invitation_accepted`; RLS jen příjemce; klient smí `SELECT`, `DELETE`, `UPDATE(read_at)`. |
| Zápis | `collab_notify()` SECURITY DEFINER | jen z triggerů: neposílá aktérovi, **ověří členství** (`project_role_of`), `ON CONFLICT DO NOTHING` (unikátní mention/comment/invitation). |
| Volající | triggery | `collab_assignee_events` (assignment, odložený constraint trigger), členství (`project_added/_role_changed/_removed` + při ztrátě přístupu **smaže** notifikace projektu), komentáře (`mention`, `comment`), pozvánky. |
| Realtime | `20261125001100_collab_hardening.sql` | `z_collab_broadcast_notification` → `collab_send('user:<id>', 'notification')`. |
| UI | `NotificationBell.tsx`, `useNotifications.ts`, `notificationText.ts` | text `describeNotification` (default větev `${actorName}: ${title}` pro neznámý typ), odkaz `notificationHref` → `/projects/<id>?task=<card>`; `project_removed` a `invitation` bez odkazu. |

## 2. Aktivita
`activity_logs` (`collab_emit`): `card_moved` nese `details.completed = collab_is_done_column(to)`, `card_due_changed` (`from`, `to`), `card_archived`, `card_deleted`, `card_assigned/unassigned` aj. **„Hotovo“** = `collab_is_done_column(column_id)`: `columns.role = 'done'` nebo název `hotovo/done/dokončeno`.

## 3. Role a přístup
`project_role_of(project, uid)` (owner/admin/member/viewer/NULL) – jen `service_role`; `is_project_member`, `can_edit_project`. Přiřazení: `card_assignees(card_id, member_id)` → `workspace_members.profile_id` (NULL = kontakt bez účtu).

## 4. Termín
`cards.due_date TEXT`; formát `YYYY-MM-DD` (helper `iso_date_or_null()` vrací NULL pro cokoli jiného). Bez času a pásma.

## 5. Serverová autorizace (důležité pro návrh)
Server **nemá service-role klíč** (`grep SERVICE_ROLE src` = 0). Vzor: klient s Bearer tokenem uživatele (`authenticateCaller`) + SECURITY DEFINER RPC s `p_server_secret`, ověřené `require_server_secret(purpose, secret)` proti SHA-256 v `server_trust` (účely `email`, `google`, …). Tajemství serveru je env proměnná, v DB jen jeho hash.

## 6. Kryptografie a OAuth vzor
`src/lib/google/crypto.ts`: `seal/open` (AES-256-GCM, obálka `v1.<keyid>.<iv>.<ct>.<tag>`, AAD), `KeyRing` s předchozím klíčem, `randomToken`, `sha256hex`. OAuth: `start` (state + HttpOnly nonce cookie), `callback` (bez relace: výsledek do HttpOnly cookie, redirect), `complete` (pod relací uživatele). Logování: `oauthLog` (whitelist, dlouhé řetězce zahodí), `errorResponse` (nikdy objekt chyby).

## 7. Nastavení a UI
`/settings` = jediná karta `GoogleConnectionCard` (`settings-card`, `settings-services`, `settings-service`, `cs-btn` varianty, `drive-message`, `cs-badge`), texty česky přímo v komponentách (žádný i18n systém – **lokalizace = čeština v kódu**), návratové stavy přes `?google=` + `RETURN_TEXT`. `/privacy` + `/about` sekce podle přepínačů.

## 8. Odchozí doručování (vzor)
`invitation_deliveries` + `deliverInvitation()`: záznam pokusu (server-secret RPC) → odeslání → výsledek; stav `sending/accepted/failed/suppressed`, chybový kód bez detailu. Žádný outbox s retry.

## 9. Plánování a infrastruktura (ověřeno 2026-11-26)
| Fakt | Důkaz |
|---|---|
| Vercel tým `bng-dev-alt-webadvisor` = plán **hobby** | Vercel API `/v2/teams` (token CLI) |
| Vercel Cron na Hobby: **1× denně, přesnost ±59 min**; funkce max 300 s | vercel.com/docs/cron-jobs/usage-and-pricing, /docs/functions/limitations |
| `vercel.json` bez `crons` | soubor |
| Produkční Supabase: `pg_cron 1.6.4`, `pg_net 0.20.4` **dostupné, nenainstalované**; `supabase_vault 0.3.2` nainstalovaný; `shared_preload_libraries` obsahuje `pg_cron, pg_net` | `pg_available_extensions`, `pg_settings` (READ ONLY) |
| Supabase Cron: až po minutě, ≤ 8 souběžných jobů, job ≤ 10 min; `pg_net` asynchronní, odchází až po COMMIT, odpovědi 6 h | supabase.com/docs/guides/cron, …/extensions/pg_net |
| Free plán Supabase: projekt se po 1 týdnu nečinnosti pozastaví | supabase.com/pricing. Plán organizace přes API **NOT VERIFIED** (CLI ho neukazuje; organizace má pozastavené projekty → pravděpodobně Free) |
| Lokální stack: `pg_net` z kontejneru dosáhne na `http://host.docker.internal:<port>` služby vázané na 127.0.0.1 (200) | ruční test na `cs-notify-sb` |

## 10. Další zjištění
* Produkční DB nemá marker `20261118000800_stt_stabilization_repair` (markery: 0100–0700, 0900, 1000–1400). Mimo rozsah RUN 05, jen evidováno (nové `TECH_DEBT` položka k ověření).
* Request log (`next dev`): `next.config.ts` `noRequestLogPaths` (OAuth callback, `/api/gmail/`, `/api/calendar/`) – doplnit `/api/notify/` (Slack callback nese kód).

## 11. Rizika pro RUN 05
1. Migrace před kódem: nový trigger nad `notifications`/`activity_logs` běží i pod starým buildem → musí být no-op bez kanálů a nikdy nesmí vyhodit výjimku.
2. Bez service-role klíče potřebuje plánovač (bez uživatele) RPC volatelné rolí `anon` chráněné jen server secretem – odchylka od vzoru, musí být úzká a testovaná.
3. Vercel Hobby neumí plánovat častěji než 1× denně → plánovač musí být v DB (pg_cron) nebo jinde bez placení.
