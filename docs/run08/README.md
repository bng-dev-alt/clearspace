# RUN 08 – Communication Hub: živá akceptace a připravenost pilotu

**Verdikt: GO pro řízený pilot „jen Slack, jen účet vlastníka, PI vypnuto“ – po samostatném schválení vlastníka (`PILOT_ROLLOUT.md`).
NO-GO pro Telegram skupiny a Project Intelligence z chatů** (živě neověřeno, viz Blokováno). Produkce je beze změny.

Legenda: **LIVE** = skutečný poskytovatel (zpráva přečtena zpět ze Slacku / Telegram vrátil `ok`, událost přišla OD Slacku přes tunel) ·
**LIVE-DB** = skutečný plánovač (pg_cron → pg_net → aplikace → poskytovatel) a pravidla databáze · **SIMULOVÁNO** = událost podepsaná námi,
poslaná přes skutečný veřejný tunel · **MOCK** = lokální simulace poskytovatele.

## Prostředí
Izolovaný lokální stack `cs-notify-sb` (loopback), aplikace na jediné adrese `https://localhost:3472/?login=auto`, vlastní pojmenovaný tunel
`clearspace-hub-live` → `cs-hub-live.luffast.com` → webhooková brána (jen 5 POST cest, vše ostatní 404). Údaje jen v Keychainu.
Ostatní tunely vlastníka (dva procesy cloudflared) nedotčeny.

## Živé výsledky (skutečný Slack / Telegram)
| # | Scénář | Typ | Výsledek |
|---|---|---|---|
| 1a–c | Oznámení projektu „úkol vytvořen / dokončen“ plánovačem do #clearspace_test (souhrn „Společný projekt – 2 změny“) | LIVE | PASS |
| 1d–e | Připomínka termínu, právě jedna na úkol a termín | LIVE-DB | PASS |
| 2a–b | Osobní oznámení RUN 05: Slack DM + Telegram (přiřazení, termín, dokončení, změna termínu), žádné selhání | LIVE | PASS |
| 3a–e | Komentář z ClearSpace → odpověď ve Slack vlákně úkolu; `<!channel>` zneškodněn; vlastní ozvěna ignorována; události přes tunel 3:3 zpracovány | LIVE | PASS |
| – | Vlastník: úkol ze Slack zprávy (shortcut „Vytvořit úkol“), odpověď ve vlákně → ověřený komentář s odkazem | LIVE (vlastník) | PASS |
| 4 | Zpráva samotné aplikace v kanálu se neukládá (smyčky / boti) | LIVE | PASS |
| 5a–c | Duplicitní událost → jeden záznam; neověřený autor jen zaznamenán; padělaný podpis → 401 | SIMULOVÁNO | PASS |
| 6a–b | Úkol jiného projektu do kanálu nedorazí; viewer/editor nemohou spravovat (403) | LIVE / LIVE-DB | PASS |
| 7 | PI na serveru vypnuto → zapnutí u kanálu odmítnuto, nic se neuloží (oprava RUN 08) | LIVE-DB | PASS |
| 8a–b | Odpojení kanálu → vazba pryč, nový úkol nic nepošle (ověřeno čtením kanálu) | LIVE | PASS |
| 9a–f | Nový kód s přesným příkazem a platností; příkaz v kanálu (simulovaný) → čeká; potvrzení → aktivní; zkušební zpráva přečtena ze Slacku; druhý test do 30 s odmítnut (429) | LIVE / SIMULOVÁNO | PASS (9c viz níže) |
| 10a–e | **Skutečné odvolání tokenu** (`auth.revoke`) → Slack sám poslal `tokens_revoked` přes tunel → instalace i kanál odříznuty, nic se neodesílá, vlastník vidí „Nainstalujte Slack aplikaci znovu“ | LIVE | PASS (10e po opravě očekávání) |
| – | Tunel zvenku: jen webhooky, UI/API/DEV login nedostupné, nepodepsané/staré/přerostlé požadavky odmítnuty, porty jen loopback | LIVE | PASS |
| – | Identita Slack + Telegram propojená vlastníkem; kanál #clearspace_test propojen a potvrzen | LIVE (vlastník) | PASS |

Ovladače: `supabase/tests/hub_live_accept.mjs` **18/18**, `supabase/tests/hub_live_disconnect.mjs` 10 PASS + 2 opravená očekávání testu
(9c: opakování téhož kódu ze stejného kanálu je záměrně idempotentní – vazba zůstala jedna; 10e: server odmítne už v DB 400 se správnou
hláškou, ještě před voláním Slacku). Oba body ověřeny ručním dotazem, skript opraven.

## Blokováno / neověřeno (vyžaduje člověka nebo rozpočet)
| Scénář | Stav | Proč |
|---|---|---|
| Soukromý Slack kanál | BLOCKED | vytvoření kanálu a pozvání aplikace dělá člověk ve Slacku (MOCK: PASS) |
| Telegram skupina: propojení, úkol z Telegramu, obousměrné komentáře | BLOCKED | vyžaduje přidání bota do skupiny a zprávy lidí (MOCK: PASS; `startgroup` odkaz živě neověřen) |
| Cortex (PI bot) – příjem skutečných zpráv skupiny | BLOCKED | vyžaduje skupinu a lidské zprávy; privacy OFF a webhook ověřeny |
| PI opt-in/out se skutečnými zprávami | BLOCKED | dtto; serverový vypínač ověřen živě (7) |
| Druhý reálný účet (izolace mezi lidmi) | BLOCKED | druhý Slack/Telegram účet; izolace ověřena se syntetickými účty |
| AI prompt injection živě | NOT VERIFIED | bez klíče a rozpočtu Gemini; MOCK A25: PASS |

## Vady nalezené a opravené v RUN 08
1. **Duplicitní text zkušebních zpráv** – příčina: dvě samostatná odeslání (žádná zpětná vazba ani prodleva) + hlavička „ClearSpace“ navíc k jménu
   odesílatele. Oprava: zpráva začíná názvem projektu, bez hlavičky (hub i osobní oznámení), tlačítko testu s 30 s prodlevou a časem odeslání.
2. **„2 změn“** – česká plurálová forma (změna / změny / změn).
3. **PI šlo zapnout přes API i se serverovým vypínačem vypnutým** (uložený souhlas by se projevil po pozdějším zapnutí serveru) → odmítnuto 400.
4. **Pilot neměl omezení na účet** – nové `HUB_PILOT_USER_IDS`: ostatní účty dostanou 403 „zatím v pilotním provozu“ (ověřeno lokálně).
5. Dříve v RUN 08: průvodce Keychainem (bash 3.2, base64 tokeny, vložené znaky), HTTPS proxy bez WebSocketů, přihlašování přes jednu adresu.

## UX blok (hotovo)
Jeden párovací box pro projekty, identity i osobní Telegram: číslované kroky, **přesný příkaz s kopírováním jedním klikem a potvrzením
„Zkopírováno“**, tlačítko pro otevření Slacku / Telegramu (Telegram skupina: „Přidat bota do skupiny“ – bot se přidá a kód pošle sám),
**odpočet platnosti kódu**, stav „vypršel“ s novým kódem, **automatické obnovení** po propojení (bez tlačítka „Obnovit“).

## Regrese
Vitest 96 souborů / 1427 testů · `hub_http.mjs` 22/22 (PI vypnuto) a 22/22 (PI zapnuto) · `notify_http.mjs` 22/22 ·
E2E hub + notify 2/2 v Classic/Monograph × světlý/tmavý · produkční build z čistého exportu + bundle guard 139/139 ·
`check-deployment.sh EXPECT_HUB_SLACK_PILOT=1` 9/9 proti lokálnímu buildu · vše MOCK, kromě živých ovladačů výše.

## Bezpečnost a soukromí
* Secret-scanning alert #1 (`notify.test.ts`, „Telegram Bot Token“): **syntetická fixture** – id bota `123456789`, tajná část je abecední
  řada (31 z 34 sousedních znaků po sobě jdoucích), neshoduje se s žádným tokenem v Keychainu. Doporučení: zavřít jako „used in tests“.
* Žádný token ani hodnota z Keychainu v commitech RUN 08 (kontrola všech 9 uložených hodnot + vzory tokenů).
* Soubory vlastníka (`.env.local` ×3, `DEMO/`, `test_intro.mp4`) bajtově shodné s inventářem před během; hlavní checkout bez změn.

## Stav Git a produkce
* `main` = fast-forward na větev `feature/run07-communication-hub` (commity RUN 08), push bez force. Vercel nenasazuje z Gitu.
* Produkce: deployment RUN 06 beze změny, DB markery končí 1500; migrace 1600/1700 bajtově shodné s nazkoušenými → nová zkouška není nutná.
* Tag `live-complete` **nevytvořen** (Telegram/PI živě blokováno).
