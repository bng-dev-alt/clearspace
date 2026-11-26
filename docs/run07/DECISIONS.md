# RUN 07 – rozhodnutí

| # | Rozhodnutí | Varianty | Důvod | Dopad |
|---|---|---|---|---|
| D1 | Běh = **RUN 07** (`docs/run07`, `run07-*`, migrace 1600), přestože zadání píše RUN 06 | `docs/run06` | RUN 06 už existuje (Google demo + pilot, nasazeno) – sloučení by zmátlo historii | názvy souborů dle zadání, jen jiná složka |
| D2 | Worktree `V1-hub`, větev `feature/run07-communication-hub` z `main` `d1236a2`; stack `cs-notify-sb` z RUN 05 (už má 1500, izolovaný, loopback); app 3471 | nový stack | méně zátěže stroje (cleanup standard), stejný stack poslouží i owner bloku RUN 05 | — |
| D3 | Správa integrací = `can_manage_project` (owner/admin); zápis z chatu = `can_edit_project` propojené identity; čtení komunikace = člen projektu | nové role | existující pravidla, žádné nové role | — |
| D4 | Příchozí webhooky volají DB přes **servisní identitu** (Supabase uživatel + server secret, RPC `hub_svc_*`) | service-role klíč; anonymní RPC | service-role = obejití RLS; anonymní RPC zakazuje strážní test `40_definer_hardening` (neoslabuje se) | nová produkční tajemství až při zapnutí |
| D5 | **Samostatný projektový Telegram bot** s webhookem; osobní bot RUN 05 zůstává `getUpdates`; konfigurace odmítne shodný token | jeden bot | getUpdates a webhook se vylučují; privacy mode je per bot | 2 boti |
| D6 | **Samostatná Slack aplikace** „ClearSpace Projekty“ | rozšířit osobní aplikaci | reinstalace by tiše rozšířila oprávnění osobních notifikací | 2 aplikace |
| D7 | Slack kanál se připojuje slash příkazem `/clearspace link KÓD` v kanálu (bot pozván) + potvrzení v ClearSpace | `incoming-webhook` výběr kanálu, `channels:read` seznam | bez `channels:read`/`groups:read`; funguje pro veřejné i soukromé kanály; nevypisuje celý workspace | typ kanálu (veřejný/soukromý) se nezjišťuje |
| D8 | Telegram skupina: `/link@bot KÓD` + odesílatel musí být `creator`/`administrator` skupiny + potvrzení v ClearSpace; bot **nesmí** potřebovat admin práva | jen kód | ověří autoritu ClearSpace i skupiny | getChatMember ověřit živě |
| D9 | Jeden kanál/skupina = nejvýš jeden projekt (globální unikátnost HMAC klíče) | více projektů | deterministické směrování, žádná nejednoznačnost | chce-li jiný projekt, nejdřív odpojit |
| D10 | Oznámení do kanálu: jen název úkolu, projekt, změna, odkaz; žádné popisy; souhrn max 10 řádků na cíl a tick | zpráva na událost | proti únikům a „bouři“ | — |
| D11 | Úkol ze Slacku přes modal (název + popis předvyplněné, upravitelné); z Telegramu `/task@bot` jako odpověď na zprávu (název = 1. řádek, popis = text) | bez náhledu | zadání „preview where appropriate“; Telegram nemá modaly | — |
| D12 | Nepropojený externí autor ve vlákně = záznam „externí autor“ v Komunikaci, **ne** komentář úkolu | komentář jako „host“ | žádný zápis bez ověřené identity | — |
| D13 | Project Intelligence: Slack „zprávy kanálů, kde je bot členem“, Telegram „jen vybrané zprávy (privacy mode)“; volitelný druhý ingest bot = LATER | druhý bot hned | privacy mode nevypínáme; poctivé označení rozsahu | — |
| D14 | Retence: zprávy z ingestu 90 dní; zprávy propojené s úkolem do odpojení/smazání úkolu; `hub_inbox` 7 dní; outbox 30 dní | bez retence | minimalizace | purge v ticku |
| D15 | Plánovač hubu = samostatná interní funkce `hub_scheduler_tick()` + endpoint `/api/hub/dispatch` (vzor RUN 05), ne rozšíření `notify_*` | rozšířit RUN 05 | izolace selhání, osobní notifikace beze změny | 2 cron joby při zapnutí |
| D16 | Demo režim (bez Supabase): statická česká simulace komunikace a integrací se štítkem „simulace“, žádné síťové volání | demo účty se skutečnými providery | izolace dema | — |
