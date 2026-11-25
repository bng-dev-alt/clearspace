# RUN 05 – rozhodnutí (autonomní, v rámci schváleného rozsahu)

Formát: rozhodnutí · varianty · důvod · dopad. Doplňuje se průběžně.

| # | Rozhodnutí | Varianty | Důvod | Dopad |
|---|---|---|---|---|
| D1 | Worktree `V1-notify`, větev `feature/run05-slack-telegram` z `run04-complete` (`6732dca`); stack `cs-notify-sb` (55600–55609, mail 55614/55615, Google mock 55621, Slack/Telegram mock 55622, app 3471) | jiné porty | porty ověřeny jako volné, vzor RUN 04 | žádný zásah do stacků RUN 01–04 |
| D2 | `node_modules` = APFS klon z `V1-calendar` (shodný `package-lock.json`, `cmp`) | `npm ci` | žádná síť do registru, identické závislosti | žádná nová závislost |
| D3 | Plánovač `pg_cron` (1/min) → `pg_net` → `/api/notify/dispatch`; migrace 1500 ho **neaktivuje** (ops skript) | Vercel Cron, externí plánovač | Hobby Cron 1×/den ±59 min; pg_cron/pg_net dostupné bez upgradu (ověřeno) | produkce bez plánovače, dokud vlastník nezapne |
| D4 | Dispatch RPC s `EXECUTE` pro `anon` chráněné `require_server_secret('notify')` | service-role klíč | server nemá service-role klíč; nové privilegované tajemství by bylo horší | test anon bez/s chybným tajemstvím → 42501 |
| D5 | Telegram propojení přes `getUpdates` na vyžádání + potvrzení v ClearSpace | webhook | žádný veřejný vstup, stejná cesta dev/prod | o jeden klik víc |
| D6 | Slack jen bot `chat:write`, DM na `authed_user.id` | `im:write` + `conversations.open`, Incoming Webhooks | dokumentace: `chat.postMessage` s ID uživatele otevře DM; webhooky volí kanál | nejmenší oprávnění |
| D7 | Nejednoznačné odeslání = at-most-once (`failed ambiguous`) | at-least-once | duplicita horší než chybějící zpráva (in-app existuje vždy) | zdokumentováno, test |
| D8 | Termín: 09:00 `Europe/Prague` den předem, dohánění do konce dne termínu, jedno pevné pásmo | per uživatel | zadání (žádný TZ subsystém) | konstanta v kódu |
| D9 | Nové typy jen v doručovací vrstvě (`task_completed`, `task_due_changed`, `due_soon`), **ne** v `notifications` | nové in-app typy | migrace před kódem: starý build by je zobrazil obecně | in-app beze změny |
| D10 | Obsah zprávy se skládá až při odeslání z aktuálních řádků; outbox nenese texty | snapshot při zařazení | méně dat, aktuální názvy, smazané = zrušené | — |
| D11 | Šifrovací klíč `NOTIFY_TOKEN_ENCRYPTION_KEY` oddělený od Google; AAD = poskytovatel + id kanálu | Google klíč | izolace integrací | nová proměnná jen při zapnutí |
| D12 | Odstraněná (zavřená) in-app notifikace se už externě neposílá | posílat dál | zdroj neexistuje ⇒ `cancelled source_gone` | zdokumentováno |
| D13 | Retence outboxu 30 dní (konečné stavy) | bez retence | minimalizace | `prepare` maže |
