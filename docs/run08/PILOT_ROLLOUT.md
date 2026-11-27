# RUN 08B – společný řízený produkční rollout Communication Hubu (Slack + Telegram) – PŘIPRAVENO, NEAKTIVOVÁNO

**Produkce je beze změny** (`clearspace.luffast.com`: build RUN 06, `/api/hub/*` = 404, DB markery končí 1500). Vše níže až po schválení vlastníka.

## 1. Rozsah pilotu
| | Etapa 1 | Etapa 2 (samostatné „ano“) |
|---|---|---|
| Účty | jen vlastník: `HUB_PILOT_USER_IDS=<id účtu vlastníka>`, ostatní dostanou 403 „zatím v pilotním provozu“ | totéž |
| Slack | projektová aplikace „ClearSpace Projekty“ (kanály veřejné i soukromé, úkoly z kanálu, vlákna ↔ komentáře) | totéž |
| Telegram | Relay bot (skupiny, `/task@bot Název`, odpovědi ↔ komentáře) | totéž |
| Project Intelligence z chatů | **vypnuto** (`HUB_INTELLIGENCE_ENABLED` nenastaveno, Cortex bez webhooku) | Cortex + `HUB_INTELLIGENCE_ENABLED=1` – AI použije jen kanály/skupiny s výslovným souhlasem; čerpá rozpočet Gemini |
| Osobní oznámení RUN 05 | beze změny (vypnuto) – nemají omezení na účet, zapnutí = pro všechny | mimo tento rollout |
| RUN 06 pilot (Gmail/Kalendář) | nedotčen (jiné tabulky, proměnné i plánovač) | |

## 2. Přechod z DEV do produkce bez nových aplikací a botů (doporučeno)
Telegram bot má vždy jen **jeden** webhook a Slack aplikace jen **jednu** sadu URL – současný běh dev i prod na stejné identitě je tedy
technicky vyloučen. Místo zakládání nových aplikací se stávající vývojové identity **povýší do produkce s rotací všech tajemství**:

| Identita | Povýšení | Izolace (proč dev nemůže zasáhnout produkci) |
|---|---|---|
| Slack „ClearSpace Projekty“ | manifest `docs/run08/slack-hub-manifest.prod.yaml` (URL → `clearspace.luffast.com`); **Regenerate** Client Secret i Signing Secret | staré dev hodnoty přestanou platit; dev instalaci (bot token v lokální DB) odvolám `auth.revoke` ještě před povýšením; nová instalace vznikne jen v produkční DB |
| Telegram Relay | BotFather `/revoke` → nový token; webhook na produkci s novým tajemstvím | starý token je mrtvý; lokální prostředí nemá platný token ani tajemství webhooku |
| Telegram Cortex (etapa 2) | totéž | totéž |
| Serverová tajemství hubu | **nově vygenerovaná** (`HUB_SERVER_SECRET`, `HUB_ROUTING_KEY`, `HUB_TOKEN_ENCRYPTION_KEY`, tajemství webhooků) – nikdy dev hodnoty | dev záznamy (zašifrované odkazy, otisky) jsou v produkci nečitelné a naopak |
| Keychain | nová služba „ClearSpace V1 – Hub (production)“; dev položky se po povýšení odstraní nebo označí jako neplatné (součást konsolidace Keychainu) | žádná hodnota nežije ve dvou prostředích |

Data se nepřenášejí: produkce začíná prázdná, vlastník v ní jednou propojí kanál/skupinu (2 min, párovací box).
Další živé testy na vývoji pak buď na simulaci (výchozí), nebo – jen pokud budou potřeba – s novými dev boty. Tunel `clearspace-hub-live` zůstává.
Alternativa (čistší oddělení, víc práce): nová produkční Slack aplikace + 2 noví boti; dev identity zůstanou pro testy.

## 3. Postup (já provedu vše kromě bloku vlastníka)
1. **Kontrola produkce (read-only)**: markery končí 1500; migrace 1600/1700 bajtově shodné s nazkoušenými (SHA-256 `197b3449…`, `8d870e91…`).
2. **Kód s vypnutým hubem**: staged build z čistého `git archive main` → `EXPECT_HUB_OFF=1 check-deployment.sh <staged>` (+ dosavadní `EXPECT_DRIVE=1
   EXPECT_GMAIL_PILOT=1 EXPECT_CALENDAR_PILOT=1 EXPECT_SLACK_OFF=1 EXPECT_TELEGRAM_OFF=1`) → promote. Rollback: promote `dpl_9NkXChVh…` (RUN 06).
3. **Migrace**: `CONFIRM_HUB=twjlnsxjtuntujarwner frontend/scripts/apply-hub-hosted.sh` (záloha `public` do `/Volumes/WORKSPACE/_G2_BACKUP/<datum>-v1-pre-hub`,
   jedna transakce, kontrola počtů, otisků, RLS, grantů). Rollback: down-migrace 1700 a 1600 (odmítnou se, existují-li data hubu).
4. **Servisní identita + důvěra** (`hub_service_principal.sql`), nová serverová tajemství do Vercel (Production) přes stdin.
5. **Blok vlastníka (~5 min, jednou)**: v Slack aplikaci vložit produkční manifest a 2× Regenerate; v BotFather `/revoke` pro Relay (etapa 2 i Cortex);
   nové hodnoty vložit do průvodce Keychainem (`HUB_LIVE_KEYCHAIN_SERVICE="ClearSpace V1 - Hub (production)" hub-live.sh set-slack` / `set-telegram` – skryté vstupy, nic se nepíše do chatu; `hub-live.sh app` produkční službu odmítne).
6. **Proměnné (Vercel Production)**: `HUB_SLACK_ENABLED=1`, `HUB_TELEGRAM_ENABLED=1`, `HUB_PILOT_USER_IDS`, `APP_BASE_URL=https://clearspace.luffast.com`,
   Slack + Telegram (Relay) údaje; **nenastavovat** `HUB_INTELLIGENCE_ENABLED` ani `TELEGRAM_HUB_PI_*` (etapa 2).
7. **Redeploy** → `EXPECT_HUB_PILOT=1 EXPECT_HUB_TELEGRAM=1 check-deployment.sh <staged>` → promote.
8. **Webhook Telegramu** (Relay → `/api/hub/telegram/webhook`) a **plánovač** (`hub_scheduler_enable.sql`, `url=https://clearspace.luffast.com/api/hub/dispatch`).
9. **Akceptace vlastníka (~5 min)**: Nastavení → nainstalovat Slack aplikaci, propojit Slack a Telegram účet; v testovacím projektu propojit kanál a skupinu
   (párovací box); úkol ze Slacku a z Telegramu (`/task@ClearSpaceRelayBot Název`), odpověď ve vlákně → komentář. Zbytek ověřím sám.
10. **Etapa 2 (PI)**: Cortex token + `HUB_INTELLIGENCE_ENABLED=1` → `EXPECT_HUB_PI=1` kontrola → u skupiny zapnout PI s potvrzením.

## 4. Vypínače (okamžité, bez migrace)
* `HUB_SLACK_ENABLED=0` / `HUB_TELEGRAM_ENABLED=0` + redeploy → routy 503 ještě před podpisem a DB; plánovač dávky zruší.
* `HUB_INTELLIGENCE_ENABLED=0` → AI nic z chatů nečte (kontext je prázdný ještě před dotazem).
* `hub_scheduler_disable.sql` → nic se neodesílá; Telegram `deleteWebhook`; Slack: odinstalovat aplikaci → `tokens_revoked` odřízne instalaci (živě ověřeno RUN 08).
* Úplný návrat: promote RUN 06 deploymentu, případně down-migrace.

## 5. Známá omezení (z živých testů)
* Telegram Relay bez admin práv a s privacy mode: Telegram často **nepředá zprávu, na kterou se odpovídá** – úkol vznikne z názvu v příkazu
  (`/task@ClearSpaceRelayBot Název`); odpovědi na zprávy bota (komentáře) fungují. Plné převzetí původní zprávy jen s Cortexem (etapa 2).
* AI odpovědi nad komunikací z chatů nebyly živě ověřeny (lokálně bez klíče a rozpočtu) – etapa 2 je proto samostatná.
