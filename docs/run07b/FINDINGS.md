# RUN 07B – nálezy a opravy

Zdroj: nezávislá adversariální revize (samostatný agent, jen čtení kódu) + vlastní hardening. Každá oprava má regresní test.
DB = `supabase/tests/collab/97_hub_hardening.sql` (a upravená 96), HTTP = `supabase/tests/hub_http.mjs`, U = `src/__tests__/hub/hub.test.ts`.

| # | Závažnost | Nález | Oprava | Test |
|---|---|---|---|---|
| R1 | **vysoká** | Phishing identity: odkaz z chatu (`/clearspace ucet`, `/start`) šlo přeposlat oběti; jedno kliknutí navázalo **útočníkův** chat účet na ClearSpace účet oběti (úkoly a komentáře jménem oběti) | Tok obrácen: kód vytvoří **přihlášený** uživatel v Nastavení a pošle ho **ze svého** chat účtu (`/clearspace ucet KÓD`, Telegram deep link `/start KÓD`). Chat sám propojení nezahájí; stránka `/integrations/link` odstraněna; potvrzení v chatu jmenuje účet ClearSpace | DB 96 (identity), HTTP „identity (RUN 07B)“, E2E krok identity |
| R2 | střední | Přesun karty do jiného projektu: odpovědi ze starého vlákna se zapisovaly jako komentáře do cizího projektu; duplicitní cesta prozradila název | Kontrola `cards.project_id = projekt cíle` v příchozích zprávách, duplicitě i synchronizaci komentářů; nová odpověď `card_moved` | DB 97 R2 |
| R3 | střední | Souběžné duplicity (`/task` dvakrát, dvojí odeslání modalu) mohly vytvořit 2 karty | `pg_advisory_xact_lock` na (projekt, zpráva) v `hub_svc_create_task` i `hub_svc_inbound_message` | DB 97, HTTP souběh `/task` |
| R4 | střední | Názvy Slack workspace všech tenantů viditelné v `hub_project_status` | Jen workspace použité tímto projektem nebo instalované volajícím | DB 97 R4 |
| R5 | střední | Vypnutí PI nechalo importované zprávy čitelné členům 90 dní; `retain_until` přežil změnu na `task_source` | Vypnutí PI importy **smaže**; `retain_until = NULL` při vzniku úkolu | DB 97, HTTP A23 / RUN 07B |
| R6 | nízká–stř. | Kód, který ve skupině zadal ne-správce, zůstal platný a šel zkopírovat do jiné skupiny; správce potvrzoval jen podle názvu | Neoprávněný pokus kód **spálí**; potvrzení ukazuje, **kdo** kód zadal (`linked_by_label`); nepotvrzené propojení vyprší po 24 h | DB 97 R6, HTTP A3 |
| R7 | nízká | Reinstalace Slacku jedním tenantem tiše reaktivovala odvolané kanály jiných projektů | Žádná automatická reaktivace; správce projektu „Ověřit znovu“ (prokázané odeslání) | DB 97 R7, HTTP A19 |
| R8 | nízká | Úkol z chatu se neoznámil v **ostatních** cílech projektu (ochrana proti smyčce byla globální) | Ochrana jen pro původní cíl (`clearspace.hub_inbound = id cíle`) | DB 97 R8 |
| R9 | nízká | Druhý úkol ze stejného Slack vlákna se připojil ke konverzaci prvního | Vlákno patří prvnímu úkolu; druhý vznikne bez vazby a potvrzení to řekne | DB 97 R9 |
| R10 | nízká | Záznam zdrojové zprávy: autor zprávy vydáván za „ověřeného“ tvůrce; Slack ukládal upravený text z náhledu | Zdroj = vlastní (neověřený) autor; tvůrce je v aktivitě úkolu; ukládá se **původní** text zprávy | DB 96, HTTP A12/A13 |
| R11 | nízká | Znovupřidání Telegram bota samo reaktivovalo cíl (skupina mohla změnit majitele) | Jen odebrání se sleduje; reaktivace = „Ověřit znovu“ správcem | HTTP A19 |
| R12 | nízká | `readRaw` bufferoval celé neautentizované tělo; jeden tajný klíč pro DB bránu, plánovač i směrovací HMAC (rotace by rozbila směrování); plánovač přijímal `http://` | Limit v bajtech + odmítnutí podle Content-Length; samostatný `HUB_ROUTING_KEY` (nikdy se nerotuje); plánovač jen `https://` (http jen k lokálnímu Dockeru) | U (config), harness |
| R13 | nízká | Text z chatu mohl ovlivnit funkce PI, které **navrhují změny** | Zdroj `comm:` jen pro `chat` a `brief`; `pm`, `improve`, `risk`, `capacity`, `daily`, `meeting` chat nevidí | U „purposes …“ |

## Hardening nad rámec revize
* **Odolné zpracování příchozích událostí** (`hub_inbox` jako fronta): stavy `received → processing → replying → completed | retry → failed`, lease + atomický claim (souběžní workeři), exponenciální backoff, po 5 pokusech terminální selhání, payload uložen jen do dokončení. Webhook jen ověří a zaznamená; zpracování běží po odpovědi; co spadlý požadavek nedokončil, dokončí dispatcher plánovače. **Odpovědi do chatu se po přechodu do `replying` nikdy neopakují** (dvojznačné odchozí doručení = at most once). Propojení kódem a identita jsou replay-safe.
* **Telegram – poctivá viditelnost**: projektový bot (privacy ON) ukládá pro PI jen „vybrané“ zprávy (odpovědi na bota); celou komunikaci skupiny smí číst jen **volitelný samostatný PI bot** (privacy OFF, nikdy nepíše, jen potvrzené cíle s výslovným opt-inem `full_ingest`, nikdy soukromé chaty, nikdy odpovědi patřící projektovému botovi).
* **Slack původ**: synchronizované odpovědi dostanou permalink původní zprávy; komentáře v úkolu ukazují „z vlákna (Slack) ↗“ / „odesláno do vlákna“; nad komentáři je upozornění, že komentáře úkolu odcházejí do propojeného vlákna.
* **Obnova**: „Ověřit znovu“ pro odebraného bota, archiv, chybu i odvolaný workspace po reinstalaci (aktivace jen po prokázaném odeslání do 2 min).

## Ověřeno jako v pořádku (revize)
Podpisy Slacku (HMAC nad surovým tělem, 5 min okno), tajemství Telegramu, `response_url` jen `hooks.slack.com`, `private_metadata` v podepsaném payloadu + znovu-resolvování kanálu, HMAC směrovací klíče, `UNIQUE(provider, klíč)`, oprávnění servisní identity a granty, `hub_act_as` transakčně lokální a vždy poslední zápis, view PI se `security_invoker`, OAuth state vázaný na uživatele i prohlížeč, escapování odchozích zpráv, závody při odpojení (FOR UPDATE + FK).
