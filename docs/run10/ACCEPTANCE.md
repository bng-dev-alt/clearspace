# RUN 10 – akceptační matice

LIVE PASS = skutečný poskytovatel/zařízení · MOCK PASS = deterministický test (fake Soniox / Google mock / falešný mikrofon Chromia) ·
PARTIAL · BLOCKED (čeká na blok vlastníka) · NOT VERIFIED. **Žádný MOCK výsledek se nepočítá jako živá akceptace.**

| # | Schopnost | Stav | Důkaz |
|---|---|---|---|
| 1 | Plánovaná porada (čas, délka, odkaz, pozvaní bez účtu) | MOCK PASS | E2E `meeting-live.spec.ts`, prohlížeč (Classic světlý, Monograph tmavý) |
| 2 | Událost v Google Kalendáři s Meet, bez pozvánek (`sendUpdates=none`), idempotentní id | MOCK PASS | Google mock: 1 insert, id = id porady, hosté správně |
| 3 | Skutečný Meet odkaz na consumer demo účtu | BLOCKED | scope `calendar.events.owned` není v produkčním OAuth klientu |
| 4 | Řízené pozvánky (`sendUpdates=all`) | BLOCKED | čeká na schválení + scope |
| 5 | Připojení do skutečného hovoru, zvuk mikrofonu + vzdáleného účastníka | BLOCKED | vyžaduje druhého účastníka (blok vlastníka) |
| 6 | Start / pauza (konec streamu) / pokračování (nový segment) / stop | MOCK PASS | E2E + 12 testů řadiče |
| 7 | Rezervace před klíčem, jednorázový klíč se stropem relace, sdílený rozpočet, dvojí start 409 | MOCK PASS | DB 45 asercí, route testy, E2E |
| 8 | Skutečný český přepis (Soniox rt-v6) | BLOCKED | placený test čeká na schválení; kvalita CZ doložena dříve ve scribe_ (rt-v5, WER 12,6 %) |
| 9 | Skutečný anglický / smíšený přepis | BLOCKED | dtto |
| 10 | Mluvčí (diarizace) | MOCK PASS (tok dat) / NOT VERIFIED (kvalita naživo) | |
| 11 | Obnova po zavřené kartě, výpadek sítě (nový segment), odpojený mikrofon, karta bez zvuku, odmítnutý mikrofon | MOCK PASS | E2E obnova + unit |
| 12 | Shrnutí, rozhodnutí, úkoly, otázky, rizika s citací | MOCK PASS (fake Gemini, existující sada `meetings.spec`, `meeting-flow.spec`) / BLOCKED (nad živým přepisem s placeným Gemini) | |
| 13 | Lidské schválení + vytvoření úkolu, idempotence | MOCK PASS (existující sada) | viz TD-3 (zastaralý počet aktivit v testu) |
| 14 | Project Intelligence: atribuce `meeting:`/`item:`, izolace účelů, injekce rámovaná jako data | MOCK PASS | `meetingPiContext.test.ts` |
| 15 | PI dotaz nad poradou se skutečným Gemini | BLOCKED | placený test |
| 16 | Izolace: čtenář nesmí spravovat ani spustit, cizí nevidí, ne-pilot 403 bez nákladů | MOCK PASS | E2E, DB X1/X2, route test |
| 17 | Smazání porady → přepis, AI výstupy, pozvaní, vazby, segmenty, PI zdroj pryč; ledger zůstává | MOCK PASS | DB X3, E2E |
| 18 | Produkce: veřejnost / ne-pilot nemůže vyvolat náklady | LIVE PASS (vypnuto) | produkce: live 503, nové routy 401, bundle bez nových tajemství, 143 kontrol |
| 19 | Skutečné náklady | – | 0 USD (žádné placené volání v RUN 10) |
| 20 | Dlouhá porada (60+ min) na skutečném zařízení | NOT VERIFIED | rollover segmentů ověřen jen logikou (unit) |
| 21 | Safari / iPad | NOT VERIFIED (DOC) | viz AUDIO_CAPTURE.md |

## Regrese (2026-11-28)
Unit 101 souborů / **1485 PASS** · DB harness **2760 asercí PASS** (vč. role hostovaného non-superusera) · zkouška na produkčním DDL PASS ·
E2E na stacku RUN 10: porady/audio/kalendář/Disk/Gmail/PI/tiery 37 PASS + 2 nové RUN 10, 1 známé selhání TD-3, 18 skipped (vyžadují jiné
stacky) · produkční build + bundle guard **153/153** · staged + produkční `check-deployment.sh` **143 PASS**.
