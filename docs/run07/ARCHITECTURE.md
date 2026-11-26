# RUN 07 – Project Communication Hub: architektura

`Projekt ClearSpace → výslovně připojené Slack kanály / Telegram skupiny → vybraná komunikace → Project Intelligence (opt-in).`
Osobní notifikace RUN 05 zůstávají oddělené (jiná Slack aplikace, jiný Telegram bot, jiné tabulky).

## 1. Komponenty
| Vrstva | Prvek |
|---|---|
| Poskytovatelé | **Slack aplikace „ClearSpace Projekty“** (bot scopes `chat:write`, `commands`, `channels:history`, `groups:history`; slash `/clearspace`; message shortcut `create_task`; Events `message.channels`, `message.groups`, `app_uninstalled`, `tokens_revoked`) · **Telegram projektový bot** (privacy mode ON, webhook se `secret_token`) |
| Příjem | `/api/hub/slack/events`, `/api/hub/slack/interactivity`, `/api/hub/slack/commands`, `/api/hub/telegram/webhook` – ověření podpisu/tajemství → deduplikace (`hub_inbox`) → směrování přes vazbu → rychlé potvrzení, zbytek v `after()` |
| Servisní identita | dedikovaný Supabase uživatel (`hub_service_principal`), přihlášení heslem na serveru, RPC `hub_svc_*` vyžadují **tohoto uživatele + server secret `hub`** (žádný service-role klíč, žádné anonymní RPC) |
| Vazby | `hub_destinations` (projekt ↔ kanál/skupina, stav, schopnosti, typy událostí), `hub_slack_installations` (token per Slack workspace), `hub_link_codes` (jednorázové kódy), `hub_identities` (externí uživatel ↔ účet ClearSpace) |
| Konverzace | `hub_conversations` (úkol ↔ vlákno / potvrzovací zpráva bota), `hub_messages` (minimalizované záznamy komunikace, RLS pro členy), `hub_comment_links` (smyčky, duplicity) |
| Odchozí | `hub_outbox` ← triggery na `activity_logs` (vytvořen / dokončen / změna stavu), `task_comments` (sync do vlákna), plánovač (termíny) → `hub_scheduler_tick()` (`pg_cron` → `pg_net`) → `/api/hub/dispatch` → poskytovatel; výsledky dalším tickem |
| Audit | `hub_audit` (kdo, kdy, akce, kód – bez obsahu) |
| UI | Projekt → **Integrace** (správci), záložka **Komunikace** v aktivitě, sekce **Konverzace** v úkolu, `/integrations/link` (propojení identity), karta propojených identit v Nastavení |
| PI | `loadProjectData` načte `hub_intelligence_messages` (jen cíle s `intelligence=true`, aktivní, nesmazané) → položky `comm:<id>` v rámci `frameUntrusted` |

## 2. Toky
**Připojení Slack kanálu:** správce projektu → „Nainstalovat do Slacku“ (OAuth v2, jen u prvního připojení workspace) → „Připojit kanál“ = kód (10 min, jednorázový,
v DB jen SHA-256) → ve Slacku `/invite @ClearSpace` + `/clearspace link KÓD` v kanálu → server ověří podpis, workspace (= instalace), kód → vazba `pending`
s názvem kanálu → správce v ClearSpace **potvrdí** → `active`. Kanál smí být připojen jen k jednomu projektu (konzervativní unikátnost).
**Připojení Telegram skupiny:** správce → kód → přidat projektového bota do skupiny → `/link@bot KÓD` → server ověří tajemství webhooku, kód a že odesílatel je ve skupině
`creator`/`administrator` (`getChatMember`) → `pending` → potvrzení v ClearSpace. Samotné chat id nic nepřipojí.
**Identita:** Slack `/clearspace propojit` (ephemeral odpověď) / Telegram soukromě `/start` → jednorázový odkaz → přihlášený uživatel ClearSpace potvrdí
„Propojit účet X“ → `hub_identities`. Bez propojení nelze ze chatu nic zapsat.
**Úkol ze zprávy:** Slack message shortcut → modal (název + popis předvyplněné) → odeslání → RPC vytvoří kartu **jménem propojeného uživatele** (musí mít
`can_edit_project`) → odpověď do vlákna s odkazem + permalink zdroje. Telegram: odpověď na zprávu příkazem `/task@bot` → karta → potvrzovací zpráva bota s odkazem.
**Synchronizace:** odpovědi ve vlákně (Slack) / odpovědi na potvrzovací zprávu bota (Telegram) → záznam konverzace; od ověřeného autora s právem úprav i komentář
úkolu. Komentář v ClearSpace u propojeného úkolu → odpověď do vlákna. Smyčky: zprávy vlastního bota ignorovány; komentáře z chatu značeny (GUC + `hub_comment_links`).
**Oznámení:** události → `hub_outbox` → tick → jedna souhrnná zpráva na cíl a tick (max 10 řádků; proti „bouři“) → poskytovatel.
**Project Intelligence:** vypnuto; zapnout smí jen správce s výslovným potvrzením; Slack = „zprávy kanálů, kde je bot“, Telegram = „jen vybrané zprávy“
(privacy mode). Odpojení = okamžité vyřazení z PI + volitelný purge.

## 3. Přepínače (výchozí vypnuto)
`HUB_SLACK_ENABLED`, `HUB_TELEGRAM_ENABLED` (každá route nejdřív přepínač → 503), `HUB_INTELLIGENCE_ENABLED` (PI ingestion + retrieval; vypnuto = nic se
neukládá mimo propojené konverzace a PI nic nečte). Tajemství: `HUB_SERVER_SECRET`, `HUB_TOKEN_ENCRYPTION_KEY`, `HUB_SERVICE_EMAIL`, `HUB_SERVICE_PASSWORD`,
`SLACK_HUB_CLIENT_ID/SECRET/SIGNING_SECRET`, `TELEGRAM_HUB_BOT_TOKEN/USERNAME/WEBHOOK_SECRET`.
