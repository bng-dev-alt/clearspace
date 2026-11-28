# RUN 10 – akceptační matice (živá akceptace 2026-11-28)

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
| 14 | Výběr mikrofonu, bezplatný lokální test, živá úroveň vstupu, detekce ticha/odpojení | MOCK PASS + nasazeno | unit + E2E (test mikrofonu nevolá server ani Soniox); produkce `dpl_9xskrK75…`; skutečné BT/USB zařízení NOT VERIFIED |
| 15 | Zrušit přepis (potvrzení, okamžitý konec streamu, uvolnění zdrojů, zahození částí, porada/pozvaní/událost zůstávají, vyúčtování) | MOCK PASS + nasazeno | E2E `meeting-live.spec.ts` (3/3), unit; naživo NOT VERIFIED (nespotřebovávat Soniox) |
| 16 | Stavové indikátory (prázdný přepis, „zvuk nahrán“, termín vs. průběh, uplynulý termín neblokuje) | MOCK PASS + LIVE (zobrazení) | produkce: „Termín uplynul“ + „Přepis uložen“ u Kickoff |
| 17 | Tlačítko „Připojit se ke schůzce“ – kontrast | LIVE PASS (zobrazení) + MOCK | Classic světlý 5,1:1, Classic tmavý 10,5:1, Monograph světlý 15,8:1, Monograph tmavý 7,9:1 (dříve zelená na zelené) |
| 18 | Skutečná Gemini analýza (rozhodnutí, úkoly, termíny) nad živým přepisem | BLOCKED | denní limit tokenů prezentačního účtu (40 000, ADR RUN 09) byl ráno vyčerpán na 31 994; analýza potřebuje > 8 192 → odmítnuto PŘED voláním, 0 USD. Placená část zastavena (viz návrh níže). MOCK PASS (fake Gemini) |
| 19 | Lidské schválení + vytvoření úkolu, idempotence | BLOCKED (navazuje na 18) / MOCK PASS | TD-3 (zastaralý počet aktivit v testu) |
| 20 | Project Intelligence s citací skutečného přepisu porady | BLOCKED (navazuje na 18) / MOCK PASS | `meetingPiContext.test.ts` |
| 21 | Izolace projektů a účtů | LIVE PASS (DB) | produkce, read-only transakce s RLS: cizí účet 0 porad/přepisů/segmentů/pozvaných/vazeb, prezentační účet vidí svá data, anon odmítnut; PI izolace dotazem NOT VERIFIED (18) |
| 22 | Smazání porady → přepis, segmenty, části, pozvaní, vazby pryč; ledger zůstává | LIVE PASS | „RUN10 Diktat“ smazán v UI: vše 0, smazaný text nevyhledatelný, 3 řádky ledgeru (0,0084 USD) zůstaly |
| 23 | Vyloučení smazaného zdroje z PI | MOCK PASS / LIVE NOT VERIFIED | zdroj = existující porada s analýzou; po smazání řádek neexistuje (LIVE), PI dotaz nad tím čeká na 18 |
| 24 | Veřejnost / ne-pilot nemůže čerpat placené služby | LIVE PASS | anonymní live 401; AI/STT jen pro `AI_DEMO_USER_IDS` = prezentační účet, ostatní účty fail-closed; live navíc `MEETING_PILOT_USER_IDS` |
| 25 | Skutečné náklady v limitu | LIVE PASS (ledger) / Soniox Console NOT VERIFIED | Soniox 4 relace / 6,37 min / 0,0127 USD (limit 6 / 30 min / 0,06 USD); Gemini 0 dotazů / 0 USD (limit 8 / 0,30 USD) |
| 26 | Hodinová porada | MOCK PASS (deterministický 60min test) / NOT VERIFIED live | rozpočet 30 min neumožňuje |
| 27 | Přímé sdílení pozvánky do Slack/Telegram hubu | LATER | vyžaduje nový typ zprávy hubu (DB CHECK + dispatcher + UI); dnes kopírování jedním klikem |
| 28 | Safari / iPad jako snímací zařízení | NOT VERIFIED (DOC) | iPad použit jen jako účastník Meet |

## Náklady (skutečné, z ledgeru `ai_requests`)
| Poskytovatel | Relace / dotazy | Délka | Odhad | Schválený limit |
|---|---|---|---|---|
| Soniox real-time | 4 | 382 156 ms = 6,37 min | 0,0127 USD (`billing_state=estimated`, 0,12 USD/h) | 6 relací / 30 min / 0,06 USD |
| Gemini | 0 (1 pokus odmítnut limitem tokenů před voláním, bez záznamu) | – | 0 USD | 8 dotazů / 0,30 USD |

## Návrh na dokončení placené části (bez změny limitů)
Denní limit prezentačního účtu se obnoví o půlnoci UTC. Potom ≤ 5 dotazů Gemini (analýza Kickoff revize #2, PI dotaz s citací,
PI dotaz z jiného projektu = izolace, PI dotaz po smazání porady = vyloučení, rezerva 1), odhad ≤ 0,05 USD – v rámci schválených
8 dotazů / 0,30 USD. Alternativa (nedoporučeno): zvýšit `AI_DEMO_DAILY_TOKEN_BUDGET` – mění závazný limit ADR RUN 09.

## Regrese (2026-11-28, po opravách)
Unit 101 souborů / **1500 PASS** · lint čistý · E2E na stacku RUN 10: porady/audio/live/kalendář/Disk/Gmail/PI/tiery **39 PASS**
+ nový test zrušení/testu mikrofonu, 1 známé selhání TD-3, 18 skipped (jiné stacky) · staged `check-deployment.sh` PASS · produkce
anonymní live 401.
