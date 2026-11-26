# RUN 05 – rozhodnutí (autonomní, v rámci schváleného rozsahu)

Formát: rozhodnutí · varianty · důvod · dopad. Doplňuje se průběžně.

| # | Rozhodnutí | Varianty | Důvod | Dopad |
|---|---|---|---|---|
| D1 | Worktree `V1-notify`, větev `feature/run05-slack-telegram` z `run04-complete` (`6732dca`); stack `cs-notify-sb` (55600–55609, mail 55614/55615, Google mock 55621, Slack/Telegram mock 55622, app 3471) | jiné porty | porty ověřeny jako volné, vzor RUN 04 | žádný zásah do stacků RUN 01–04 |
| D2 | `node_modules` = APFS klon z `V1-calendar` (shodný `package-lock.json`, `cmp`) | `npm ci` | žádná síť do registru, identické závislosti | žádná nová závislost |
| D3 | Plánovač `pg_cron` (1/min) → `notify_scheduler_tick()` → `pg_net` → `/api/notify/dispatch`; migrace 1500 ho **neaktivuje** (ops skript) | Vercel Cron, externí plánovač | Hobby Cron 1×/den ±59 min; pg_cron/pg_net dostupné bez upgradu (ověřeno) | produkce bez plánovače, dokud vlastník nezapne |
| D4 | **(revidováno v Phase 1)** Plánovač běží celý v DB: `notify_scheduler_tick()` (interní, bez EXECUTE pro `anon`/`authenticated`) sbírá odpovědi, připravuje, claimuje a dávku POSTne přes `pg_net` do `/api/notify/dispatch`; aplikace jen dešifruje, odešle a vrátí výsledky v odpovědi | (a) dispatch RPC pro `anon` + server secret (původní D4), (b) service-role klíč | (a) porušilo strážní test `40_definer_hardening` (jediné anonymní RPC je `invitation_preview`) – pravidlo se neoslabuje; (b) nový privilegovaný produkční secret | aplikace nepotřebuje k doručování žádná DB práva; výsledky se zapíší o tick později (lease 5 min) |
| D5 | Telegram propojení přes `getUpdates` na vyžádání + potvrzení v ClearSpace | webhook | žádný veřejný vstup, stejná cesta dev/prod | o jeden klik víc |
| D6 | Slack jen bot `chat:write`, DM na `authed_user.id` | `im:write` + `conversations.open`, Incoming Webhooks | dokumentace: `chat.postMessage` s ID uživatele otevře DM; webhooky volí kanál | nejmenší oprávnění |
| D7 | Nejednoznačné odeslání = at-most-once (`failed ambiguous`) | at-least-once | duplicita horší než chybějící zpráva (in-app existuje vždy) | zdokumentováno, test |
| D8 | Termín: 09:00 `Europe/Prague` den předem, dohánění do konce dne termínu, jedno pevné pásmo | per uživatel | zadání (žádný TZ subsystém) | konstanta v kódu |
| D9 | Nové typy jen v doručovací vrstvě (`task_completed`, `task_due_changed`, `due_soon`), **ne** v `notifications` | nové in-app typy | migrace před kódem: starý build by je zobrazil obecně | in-app beze změny |
| D10 | Obsah zprávy se skládá až při odeslání z aktuálních řádků; outbox nenese texty | snapshot při zařazení | méně dat, aktuální názvy, smazané = zrušené | — |
| D11 | Šifrovací klíč `NOTIFY_TOKEN_ENCRYPTION_KEY` oddělený od Google; AAD = poskytovatel + id kanálu | Google klíč | izolace integrací | nová proměnná jen při zapnutí |
| D12 | Odstraněná (zavřená) in-app notifikace se už externě neposílá | posílat dál | zdroj neexistuje ⇒ `cancelled source_gone` | zdokumentováno |
| D13 | Retence outboxu 30 dní (konečné stavy) | bez retence | minimalizace | `prepare` maže |
| D14 | Přepínače poskytovatelů žijí v aplikaci (env): DB je nezná; aplikace odpoví `cancelled provider_disabled` pro vypnutého poskytovatele a 503 pro oba vypnuté → tick dávku zruší | přepínače v DB | jediný zdroj pravdy = env jako u Google | žádné zastaralé zprávy po pozdějším zapnutí |
| D15 | Uvítací zpráva po potvrzení Telegramu nespotřebuje 30s limit zkušební zprávy | jeden limit | zjištěno E2E (uživatel hned po připojení nemohl poslat test) | `notify_test_begin(p_allow_confirm)` |
| D16 | `release`/`retry` pro kanál, který mezitím přestal být použitelný (blokace, pauza) = `cancelled channel_inactive` | vrátit do fronty | zjištěno HTTP testem (zbytek dávky by se vracel) | žádné zbytečné pokusy |
| D17 | Živá akceptace BLOCKED (vlastník musí vytvořit Slack app / Telegram bot); produkce nasazena s oběma přepínači 0 bez čekání | čekat na vlastníka | zadání: volitelný živý test nezastavuje běh; produkce OFF na živé integraci nezávisí | tag `run05-live-complete` nevznikl; zapnutí až po živé akceptaci |
| D18 | Slack lokálně přes `https://localhost:3472` (vlastní HTTPS proxy, self-signed) | tunel (NESCHVÁLEN), `next --experimental-https` | Slack vyžaduje HTTPS redirect; `pg_net` potřebuje http aplikaci → proxy jen pro prohlížeč | žádná nová závislost |
| D19 | `check-deployment.sh` po promote spuštěn z hlavního checkoutu → **incident**: smazán vlastníkův `V1/frontend/.env.local` | — | chyba postupu (RUN 04 to dělal z dočasného `V1-release`) | zapsáno v PRODUCTION_ACCEPTANCE + handoff; vlastník obnoví |
