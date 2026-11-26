# Handoff RUN 05 → další běhy

Stav 2026-11-26: `main` = merge `1c83872` (+ oprava kontrolního skriptu `d3aa353` + dokumentace), tagy `run05-mock-complete`, `run05-complete`;
**`run05-live-complete` NEEXISTUJE** (živá akceptace BLOCKED). Produkce `dpl_Gp6omv6sy6jfchmC8rJGRtQ9nAST`, DB do 1500, **Gmail, Kalendář, Slack i Telegram vypnuté**,
plánovač vypnutý. Pracovní strom `V1-notify` (větev `feature/run05-slack-telegram`), stack `cs-notify-sb`.
Start: `NOTIFICATIONS.md`, `ARCHITECTURE_DECISION.md`, `PRIVACY_AND_SECURITY.md`, `LIVE_ACCEPTANCE.md`, `PRODUCTION_ACCEPTANCE.md`, `DECISIONS.md`.

## Zbývající manuální kroky vlastníka
1. **Obnovit `V1/frontend/.env.local`** (smazán při bráně 12 – incident v `PRODUCTION_ACCEPTANCE.md`).
2. **OWNER BLOCK pro živou akceptaci** (jediný blok, ~15 min; Claude pak doběhne sám): viz závěrečná zpráva RUN 05 / níže.
3. Rozhodnutí o zapnutí v produkci (A vypnuto / B pilot jen pro vlastníka / C veřejně): `PRODUCTION_ROLLOUT.md` §0–1 – až po živé akceptaci.
4. Beze změny z RUN 04: produkční Kalendář/Gmail, úklid dev OAuth klienta Google (2 client secrets).

### OWNER BLOCK (co přesně udělat)
1. Slack (testovací workspace, klidně nový zdarma): api.slack.com/apps → Create New App → From scratch → „ClearSpace Dev“ → OAuth & Permissions:
   Bot Token Scope **jen `chat:write`**, Redirect URL `https://localhost:3472/api/notify/slack/callback` → App Home: zapnout **Messages Tab**.
2. Telegram: @BotFather → `/newbot` → jméno „ClearSpace Dev“, username dle volby (končí na `bot`).
3. V terminálu: `frontend/scripts/notify-live.sh set-slack` (Client ID + Client Secret, skrytě) a `frontend/scripts/notify-live.sh set-telegram` (token skrytě + username).
4. Napsat Claudovi „hotovo“ → spustí `notify-live.sh app`; pak v prohlížeči `https://localhost:3472/settings?login=auto` (jednou přijmout lokální certifikát),
   „Připojit Slack“ → Allow; „Připojit Telegram“ → otevřít odkaz → Start → „Ano, je to můj účet“. Zbytek (brána, L1–L9, revoke-check, úklid) proběhne bez vás.

## Co je hotové a znovupoužitelné
| Potřeba | Kde |
|---|---|
| Další poskytovatel doručení (Teams, e-mail…) | `src/lib/notify/providers.ts` (fetch + klasifikace), `server.ts` `sendWith`/`sendBatch`, CHECK `provider` v 1500, UI karta |
| Nový typ události | trigger `notify_from_notification`/`notify_from_activity` + `KINDS` + `message.ts` + předvolba |
| Plánované úlohy bez placeného plánu | vzor `notify_scheduler_tick()` + `supabase/ops/notify_scheduler_enable.sql` (pg_cron + pg_net + Vault) |
| Živá brána pro poskytovatele | `notify_live_gate.mjs`, `notify-live.sh` (Keychain, HTTPS proxy pro OAuth redirect) |
| Nácvik + apply migrace | `rehearse-notify-prod.sh`, `apply-notify-hosted.sh` (vzor pro 1600) |

## LATER (beze změny ze zadání)
Produkční aktivace, obousměrné zprávy, úkoly z chatu, slash commands, interaktivní tlačítka, AI asistenti, souhrny/digesty, Slack kanály a skupinové chaty,
tiché hodiny a nastavitelná hodina připomenutí, pásmo per uživatel, e-mailové notifikace, další poskytovatelé, Slack Events API.

## Poučení z RUN 05
* Strážní test `40_definer_hardening` zakazuje anonymní RPC – plánovač bez uživatele proto běží celý v DB (interní funkce) a do aplikace jen posílá dávku.
* Vercel Hobby Cron = 1× denně ±59 min; `pg_cron` + `pg_net` jsou na Supabase dostupné bez upgradu, `pg_net` z lokálního Dockeru dosáhne `host.docker.internal`.
* Slack vyžaduje HTTPS redirect → lokálně `https-loopback-proxy.mjs` (self-signed, jen loopback), žádný tunel.
* Hostované ověření (`hosted-verify.sh`) **nikdy v hlavním checkoutu** – zapisuje a maže `.env.local` a `test-results/`; vždy z dočasného exportu.
* `monograph-prodcheck.mjs` hlásí 2 body (přepínač/rail) jako FAIL na odhlášené produkci – očekávané, NOT VERIFIED.
* Testy v lokálních stacích sdílí mock workspace: uklidit kanály jiných uživatelů před testem odvolání tokenu.

## Omezení, která platí dál
Žádný push/merge/deploy bez schválení; V2/Artform/RUN 01–04 stacky beze změny; žádná placená AI volání; tajemství jen Keychain/Vercel; DEV login jen lokálně;
zapnutí Gmailu/Kalendáře/Slacku/Telegramu v produkci = samostatné rozhodnutí vlastníka.
