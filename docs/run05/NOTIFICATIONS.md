# RUN 05 – oznámení mimo aplikaci (Slack, Telegram): provoz a testy

Stav 2026-11-26: v `main` (merge `1c83872`) a v produkci `dpl_Gp6omv6sy6jfchmC8rJGRtQ9nAST` s **oběma přepínači vypnutými**. Architektura: `ARCHITECTURE_DECISION.md`,
rozhodnutí: `DECISIONS.md`, návrh: `DESIGN.md`, soukromí: `PRIVACY_AND_SECURITY.md`.

## 1. Jak to funguje (krátce)
1. In-app notifikace (`notifications`, RUN 01) a vybrané aktivity (`activity_logs`: dokončení / změna termínu mého úkolu) zařadí triggerem doručení do
   `notification_deliveries` – jen pro uživatele s aktivním kanálem a zapnutým typem/projektem; selhání triggeru nikdy neshodí zápis uživatele.
2. `pg_cron` každou minutu spustí `public.notify_scheduler_tick()`: vyzvedne odpovědi předchozích dávek, vygeneruje připomínky termínů
   (09:00 `Europe/Prague` den předem, dohánění do konce dne termínu), claimne dávku (`SKIP LOCKED`, znovu ověří přístup, stav, předvolby, termín)
   a pošle ji přes `pg_net` na `/api/notify/dispatch` (hlavička `x-notify-secret`).
3. Aplikace dešifruje údaje kanálu (AES-GCM, AAD = poskytovatel + kanál), složí český text (`src/lib/notify/message.ts`) a pošle: Slack
   `chat.postMessage` na ID uživatele (DM od aplikace, jen `chat:write`), Telegram `sendMessage` (bez náhledu odkazu, prostý text). Max ~1 zpráva/s na cíl.
4. Výsledek (`sent`/`retry`/`release`/`failed`/`cancelled`/`reconnect`/`blocked`) zapíše další tick. Retry 1/5/15/60 min (nebo `Retry-After`), max 5 pokusů;
   timeout po odeslání = `failed ambiguous` (nikdy znovu).

## 2. Proměnné prostředí (server; v produkci dnes jen oba přepínače = 0)
| Proměnná | Význam |
|---|---|
| `SLACK_INTEGRATION_ENABLED`, `TELEGRAM_INTEGRATION_ENABLED` | `1` = zapnuto; jinak všechny `/api/notify/*` 503 jako první krok |
| `NOTIFY_SERVER_SECRET` | ≥ 32 znaků; SHA-256 v `server_trust('notify')`; tatáž hodnota ve Vaultu pro plánovač |
| `NOTIFY_TOKEN_ENCRYPTION_KEY` (+ `_PREVIOUS`) | base64 32 B; oddělený od Google klíče |
| `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET` | Slack aplikace (OAuth v2, bot scope `chat:write`) |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME` | Telegram bot (BotFather) |
| `SLACK_API_MOCK_BASE`, `TELEGRAM_API_MOCK_BASE` | jen lokální testy (loopback, mimo produkci) |

## 3. Lokálně
```
frontend/scripts/notify-stack.sh up | mock | notify-mock | app | env | tick [now] | scheduler-on | scheduler-off
eval "$(frontend/scripts/notify-stack.sh env)"; node frontend/supabase/tests/notify_http.mjs        # NOTIFY_EXPECT_OFF=1 proti buildu s přepínači 0
frontend/scripts/notify-live.sh set-slack | set-telegram | status | app | gate | tick | revoke-check | forget     # skutečný Slack/Telegram (dev)
```
Stack `cs-notify-sb` (55600–55609, mail 55614/55615), Google mock 55621, Slack/Telegram mock 55622, aplikace 3471 (`http://127.0.0.1:3471/settings?login=auto`);
živě navíc `https://localhost:3472` (lokální HTTPS proxy kvůli Slack redirect URL, self-signed). Pro E2E aplikaci spouštějte s `DEV_AUTO_LOGIN=0`.

## 4. Testy (finální kód; Slack/Telegram SIMULOVANÉ – živá akceptace viz `LIVE_ACCEPTANCE.md`)
| Vrstva | Výsledek |
|---|---|
| Unit (`vitest`) | **1398/1398** (94 souborů; nové `src/__tests__/notify/notify.test.ts`: 25) |
| DB harness (`supabase/tests/run.sh`) | **2521** SQL asercí (95_notification_channels **143**), parita in-app 1400 = 1500, upgrade 1400→1500 bajtově shodný, rollback odmítnut při datech, katalog po rollbacku == 1400, re-apply |
| Notify HTTP + adversarial (`notify_http.mjs`) | **23/23** skupin; přepínače OFF na `next start`: **2/2** |
| E2E `notify.spec.ts` | **PASS Klasika i Monograph** (desktop světlý + telefon tmavý) |
| Regrese Drive / Gmail / Calendar HTTP | **28/28 / 23/23 / 18/18** |
| E2E Google (`calendar`, `gmail`, `google-drive`) | **3/3 Klasika, 3/3 Monograph** |
| RUN 01 | `collab_realtime` 64/64 · `realtime_check` PASS · `invite_email` 41/41 · E2E 10 passed + 2 failed = **TD-1, TD-2** (+1 skipped); v prvním běhu jednorázově selhal i `collaboration.spec.ts:62` (studený `next dev`), samostatně i v opakovaném běhu celé sady PASS |
| Real stack (`real_stack.sh`, čistý dočasný stack) | SQL **519**, HTTP **29/29** |
| Demo Playwright | 27 passed, 122 skipped (+2 nové podmíněné), 0 failed |
| Typecheck / lint / build / guard | 0 / 0 chyb (3 stará varování) / OK (přepínače on i off, DEV příznaky) / **103/103**; `next start`: `/api/dev/login` 404 (5 metod) |
| Plánovač `pg_cron → pg_net` na lokálním stacku | PASS: minutový tick odeslal (Slack + Telegram mock), další tick zapsal `sent` |
