# RUN 10 – akceptační matice (živá akceptace + finální uzavření 2026-11-28)

LIVE PASS = skutečný poskytovatel / zařízení / produkce · MOCK PASS = deterministický test (fake Soniox / Google mock / falešný mikrofon
Chromia / fake Gemini) · PARTIAL · BLOCKED · NOT VERIFIED. **Žádný MOCK výsledek se nepočítá jako živá akceptace.**

Prostředí živé akceptace: produkce `clearspace.luffast.com`, výhradně prezentační účet (Alex Morgan / luffast.demo, ADR RUN 09-01),
testovací projekt „RUN10 Pilot – porady (test)“, Mac (Chrome) + iPad ve skutečném Google Meet. Pilot jen pro tento účet.

| # | Schopnost | Stav | Důkaz |
|---|---|---|---|
| 1 | Plánovaná porada (čas, délka, odkaz, pozvaní bez účtu) | LIVE PASS | porada „RUN10 Kickoff Corvane (test)“ v produkci |
| 2 | OAuth: přírůstkové povolení „Plánování porad“ (`calendar.events.owned`) | LIVE PASS | scope přidán v `clearspace-prod-515815`; Google consent ukázal jen toto oprávnění |
| 3 | Skutečná událost v Google Kalendáři se skutečným Meet odkazem (jen z odpovědi Googlu) | LIVE PASS | `meet.google.com/ary-gzpp-fcp`, událost „V Google Kalendáři“ |
| 4 | Řízené pozvánky (`sendUpdates=all`) | LIVE PASS | „Invitation: RUN10 Kickoff“ doručena na alias `sales@luffast.com` (demo Gmail) |
| 5 | Přesměrování z ClearSpace do Meet, Mac + iPad současně ve skutečném hovoru | LIVE PASS | vlastník; tlačítko „Připojit se ke schůzce“ |
| 6 | Zachycení **mikrofonu** naživo | LIVE PASS | 4 streamy, přepisy uložené v produkci |
| 7 | Zachycení **vzdáleného účastníka přes sdílenou kartu** (izolovaně od mikrofonu) | PARTIAL | anglická replika iPadu je v přepisu jako jiný mluvčí, ale aplikace neukládá, ze kterého zdroje zvuk přišel, a iPad byl ve stejné místnosti – nelze vyloučit, že ho zachytil mikrofon. Od opravy RUN 10 ukazuje panel samostatnou úroveň mikrofonu a karty (MOCK PASS); izolovaný důkaz = hovor se vzdáleným účastníkem mimo místnost |
| 8 | Skutečný český přepis (Soniox `stt-rt-v6`) | LIVE PASS | obě porady; kvalitu vlastník hodnotí jako velmi dobrou |
| 9 | Skutečný anglický a smíšený CZ/EN přepis | LIVE PASS | Kickoff: EN repliky + CZ odpověď ve stejném streamu; anglické YouTube video |
| 10 | Diarizace mluvčích | PARTIAL (LIVE funkční, přesnost omezená) | Kickoff: Mac = Mluvčí 1 (CZ), iPad = Mluvčí 2 (EN) správně; vlastník: občas nepřesné přiřazení; video rozděleno na 2 mluvčí |
| 11 | Start / pauza (konec streamu) / pokračování (nový segment) / stop + uložení | LIVE PASS | Diktát: 3 segmenty (stop, pauza, stop), každý uzavřený a vyúčtovaný |
| 12 | Obnova spojení (výpadek sítě) | MOCK PASS / NOT VERIFIED live | v živém testu se výpadek nevyvolal (Kickoff = 1 segment) |
| 13 | Rezervace před klíčem, jednorázový klíč, strop relace, ledger | LIVE PASS | 4 řádky `meeting-transcribe` (soniox, `estimated`), každý ≤ rezervace 10 min |
| 14 | Výběr mikrofonu, bezplatný lokální test, živá úroveň vstupu, detekce ticha/odpojení | MOCK PASS + LIVE PASS (bez placení: výběr, test, chybová cesta) | produkce: výběr mikrofonu a „Otestovat mikrofon“ zobrazeny, test zavolal server 0×, zablokovaný mikrofon nahlášen; ukazatele úrovně během streamu a skutečná BT/USB zařízení NOT VERIFIED live |
| 15 | Zrušit přepis (potvrzení, okamžitý konec streamu, uvolnění zdrojů, zahození částí, porada/pozvaní/událost zůstávají, vyúčtování) | MOCK PASS / NOT VERIFIED live | E2E `meeting-live.spec.ts` (3/3), unit; naživo by vyžadoval placený stream |
| 16 | Stavové indikátory (prázdný přepis, „zvuk nahrán“, termín vs. průběh, uplynulý termín neblokuje) | LIVE PASS (zobrazení) + MOCK | produkce: nová porada „Zvuk zatím nenahrán“, „Termín: nadcházející“; Kickoff „Termín uplynul“ + „Přepis uložen“ |
| 17 | Tlačítko „Připojit se ke schůzce“ – kontrast | LIVE PASS (zobrazení) + MOCK | Classic světlý 5,1:1, Classic tmavý 10,5:1, Monograph světlý 15,8:1, Monograph tmavý 7,9:1 (dříve zelená na zelené) |
| 18 | Skutečná Gemini analýza (rozhodnutí, úkoly, termíny) nad živým přepisem | LIVE PASS | Kickoff revize #2 (bez YouTube části), `gemini-3.6-flash`: shrnutí, 1 rozhodnutí („report v angličtině“), 1 úkol („každý čtvrtek“) – obojí s nalezenou citací; zmínka „Petr“ správně označena jako ne-člen, „každý čtvrtek“ jako nejasný termín |
| 19 | Lidské schválení + vytvoření úkolu, idempotence | LIVE PASS | rozhodnutí přijato; karta „Odesílat týdenní report v angličtině každý čtvrtek.“ (Naplánováno, řešitel zvolen člověkem, termín 3. 12. 2026, UI upozornilo, že řešitel není zmíněná osoba); druhé schválení (RPC v transakci s rollbackem) = `already_applied: true`, stejná karta, počet karet beze změny |
| 20 | Project Intelligence s citací skutečného přepisu porady | LIVE PASS | odpověď „angličtina, každý čtvrtek, Petr“ s citacemi: rozhodnutí z porady, karta, schválený úkol, shrnutí porady „RUN10 Kickoff Corvane (test)“ |
| 21 | Izolace projektů a účtů | LIVE PASS | DB (RLS, read-only): cizí účet 0 řádků, anon odmítnut; PI ze samostatného testovacího projektu: „Data projektu tyto informace neobsahují“, 0 citací |
| 22 | Smazání porady → přepis, segmenty, části, pozvaní, vazby pryč; ledger zůstává | LIVE PASS | „RUN10 Diktat“ smazán v UI: vše 0, smazaný text nevyhledatelný, 3 řádky ledgeru (0,0084 USD) zůstaly |
| 23 | Vyloučení smazaného zdroje z PI | LIVE PASS | po smazání porady Kickoff (přepis, návrhy, segmenty, pozvaní = 0) PI poradu necituje („informace z porady v datech není“); cituje jen kartu, která po smazání podle návrhu zůstává |
| 24 | Veřejnost / ne-pilot nemůže čerpat placené služby | LIVE PASS | anonymní live 401; AI/STT jen pro `AI_DEMO_USER_IDS` = prezentační účet, ostatní účty fail-closed; live navíc `MEETING_PILOT_USER_IDS` |
| 25 | Skutečné náklady v limitu | LIVE PASS (ledger) / Soniox Console NOT VERIFIED | Soniox 4 relace / 6,37 min / 0,0127 USD (limit 6 / 30 / 0,06); Gemini 4 dotazy, 6 441 + 987 tokenů ≈ 0,017 USD při ceníku 1,50/7,50 USD za 1M (limit 8 / 0,30 USD) |
| 26 | Hodinová porada | MOCK PASS (deterministický 60min test) / NOT VERIFIED live | rozpočet 30 min neumožňuje |
| 27 | Přímé sdílení pozvánky do Slack/Telegram hubu | LATER | vyžaduje nový typ zprávy hubu (DB CHECK + dispatcher + UI); dnes kopírování jedním klikem |
| 28 | Safari / iPad jako snímací zařízení | NOT VERIFIED (DOC) | iPad použit jen jako účastník Meet |

## Náklady (skutečné, z ledgeru `ai_requests`)
| Poskytovatel | Relace / dotazy | Délka | Odhad | Schválený limit |
|---|---|---|---|---|
| Soniox real-time | 4 | 382 156 ms = 6,37 min | 0,0127 USD (`billing_state=estimated`, 0,12 USD/h) | 6 relací / 30 min / 0,06 USD |
| Gemini (`gemini-3.6-flash`) | 4 (analýza + 3× PI); 2 pokusy odmítnuté limitem před voláním, bez záznamu | 6 441 vstup + 987 výstup tokenů | ≈ 0,017 USD (ceník 1,50/7,50 USD za 1M; zaváděcí ½) | 8 dotazů / 0,30 USD |

## Jednorázové navýšení limitu tokenů (schváleno vlastníkem 2026-11-28)
`AI_DEMO_DAILY_TOKEN_BUDGET` platí jen pro demo tier = `AI_DEMO_USER_IDS` = prezentační účet (ADR RUN 09-01) → izolované. 40 000 → 80 000
(`meetings-prod.sh tokens`, nasazení `dpl_2a7UnQho…`), 4 dotazy, pak **obnoveno 40 000** (`dpl_FwWirB1M…`). Vynucení ověřeno zdarma:
dotaz PI po obnově → `429 budget_exceeded` (dnešní spotřeba 56 451 > 40 000; při 80 000 by prošel), žádný řádek v ledgeru.

## Trvalý pilot živého přepisu (schváleno vlastníkem 2026-11-28)
30 minut/den výhradně pro prezentační účet (`AI_DEMO_STT_DAILY_AUDIO_MIN_PER_USER=30`, `_GLOBAL=30`, `MEETING_PILOT_USER_IDS`).
Maximum při ceníku 0,12 USD/h = **0,06 USD/den** (≈ 1,8 USD/30 dní); async přepis sdílí stejný denní rozpočet (0,10 USD/h, tedy méně).
Zachováno: rezervace v DB před dočasným klíčem, klíč jednorázový se stropem relace = rezervace (segment 10 min), ledger, kill switch
`MEETING_LIVE_ENABLED=0` / `STT_ENABLED=0` / minuty 0, ostatní účty a veřejnost bez AI i přepisu (fail-closed tier).

## Regrese (2026-11-28, finální `main`)
Unit **101 souborů / 1500 PASS** · lint čistý · `scripts/stack-guard.test.sh` 2/2 + skutečný stack (0 portů do LAN) · staged
`check-deployment.sh` PASS u všech 4 nasazení · produkce: anonymní live 401, limit tokenů 429.

### Předchozí běh (po opravách)
Unit 101 souborů / **1500 PASS** · lint čistý · E2E na stacku RUN 10: porady/audio/live/kalendář/Disk/Gmail/PI/tiery **39 PASS**
+ nový test zrušení/testu mikrofonu, 1 známé selhání TD-3, 18 skipped (jiné stacky) · staged `check-deployment.sh` PASS · produkce
anonymní live 401.
