# RUN 07B – schopnosti a oprávnění poskytovatelů

## 1. Aplikace / boti (každý zvlášť, konfigurace odmítne sdílení)
| Identita | Účel | Oprávnění / nastavení | Příjem | Odesílá |
|---|---|---|---|---|
| Slack app **osobní** (RUN 05) | oznámení jen mně (DM) | bot `chat:write` | – (OAuth) | DM uživateli |
| Slack app **ClearSpace Projekty** | hub projektu | bot `chat:write`, `commands`, `channels:history`, `groups:history`; žádné user scopes, žádné `channels:read`/`users:read` | Events API (zprávy kanálů, kde je členem), `/clearspace`, zkratka u zprávy | do propojených kanálů |
| Telegram bot **osobní** (RUN 05) | oznámení jen mně | privacy ON, `getUpdates` | soukromý chat | soukromý chat |
| Telegram bot **projektový** | hub projektu | **privacy ON** (nevypínat), webhook + tajemství | příkazy pro něj, odpovědi na jeho zprávy, servisní zprávy, `my_chat_member` | do propojených skupin |
| Telegram bot **PI** (volitelný) | jen čtení celé skupiny pro Project Intelligence | **privacy OFF** (BotFather → Group Privacy: Disable), webhook + vlastní tajemství | všechny zprávy skupin, kde je členem | **nikdy nic** |

## 2. Co Project Intelligence opravdu vidí (žádné tvrzení navíc)
| Kategorie | Slack | Telegram – projektový bot | Telegram – PI bot |
|---|---|---|---|
| **Výslovně vybrané zprávy** (zdroj úkolu) | ano – zpráva, ze které člověk vytvořil úkol | ano – zpráva, na kterou člověk odpověděl `/task` | – |
| **Odpovědi navázané na úkol** | ano – vlákno úkolu (komentáře) | ano – odpovědi na potvrzení bota | ne (patří projektovému botovi) |
| **Obecná komunikace skupiny / kanálu** | ano, jen při opt-inu PI: **nové** zprávy kanálu od zapnutí | **ne** (bot ji při privacy ON nedostává) – UI říká „jen vybrané zprávy“ | ano, jen při opt-inu PI **a** `full_ingest` (zvláštní potvrzení) |
| Historie před zapnutím | ne | ne | ne |
| Soukromé chaty / DM | ne | ne (soukromě jen propojení účtu, nic se neukládá) | ne (zahazuje) |
| Mazání ve zdroji | propisuje se (`message_deleted`) | Telegram botům mazání neoznamuje | dtto |

Výchozí stav: PI **vypnuto** na cíli i na serveru (`HUB_INTELLIGENCE_ENABLED=0`, kill switch před jakýmkoli dotazem). Retence 90 dní;
vypnutí PI nebo odpojení importy okamžitě maže. Text z chatu je v AI kontextu jen pro odpovědi a souhrny (`chat`, `brief`), rámovaný jako
nedůvěryhodný a nikdy pokyn.

**Ověření viditelnosti privacy mode živě**: `hub-live.sh gate` kontroluje `getMe.can_read_all_group_messages` (projektový bot `false`,
PI bot `true`). Živě zatím **BLOCKED** (chybí boti) – tabulka výše vychází z dokumentace Bot API, nikoli z živého testu.

## 3. Infrastruktura pro živou akceptaci – vyhodnocení
| Varianta | Pro | Proti | Verdikt |
|---|---|---|---|
| **Lokální izolovaný stack + brána jen pro webhooky + Cloudflare tunel** (`hub-live.sh app`) | nic placeného, syntetická data, ven jen 5 podepsaných POST cest (ověřeno: UI, DEV login, uživatelská API → 404), UI a OAuth redirect zůstávají na `https://localhost:3472` | quick tunel (bez účtu) je nespolehlivý – při testu 2026-11-26 Cloudflare vrátil **429** na `api.trycloudflare.com`; náhodná adresa → při každém běhu upravit manifest Slacku | **doporučeno s pojmenovaným tunelem** vlastníka (stabilní hostname, token v Keychainu `hub-live.sh set-tunnel`) |
| Samostatný Vercel projekt + Supabase projekt (staging) | stálé HTTPS, blíž produkci | nový Supabase projekt (Free limit 2 aktivní projekty), Vercel Deployment Protection by Slack/Telegram nepustil → musel by být veřejný celý staging, další tajemství a údržba | jen pokud bude potřeba dlouhodobý staging |
| Tunel na celou lokální aplikaci | jednoduché | vystavil by UI i DEV login | **zamítnuto** |
