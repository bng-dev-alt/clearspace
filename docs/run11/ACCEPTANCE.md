# RUN 11 – akceptace (2026-11-28)

Vše lokálně (čistý stack `cs-run11-sb`, stack hubu `cs-notify-sb`, demo režim), mocky Google / Slack / Telegram, fake Soniox, fake Gemini.
**Placená volání: 0** (Soniox 0 min, Gemini 0 požadavků). Legenda: PASS · FAIL · NOT VERIFIED (+ důvod).

## A. Akceptační kritéria z `DECISIONS.md` §C

| Dávka | Kritérium | Výsledek | Důkaz |
|---|---|---|---|
| 1 Primitivy | 0× `confirm()` / `alert()` v `src/` | **PASS** | `grep -rnE "confirm\(|alert\(" src` (mimo testy) = 0 |
| 1 | Esc / Tab / návrat focusu v dialozích | **PASS** | unit `uiPrimitives` (5); prakticky v prohlížeči: `alertdialog` s názvem, Tab zůstává v dialogu, Esc zavře jen potvrzení (detail úkolu zůstane), focus zpět na „Archivovat úkol“ |
| 1 | uložení/chyba ohlášené (`role=status/alert`) | **PASS** | `StatusMessage`, `CopyButton` (sr-only status), unit test |
| 2 Layout a jazyk | 0 přetečení ve všech šířkách a vzhledech | **PASS** | matice 336/336 čistá (dřív 35 přetečení v Classic 1024/768 + detail porady 375) |
| 2 | žádný anglický řetězec ze seznamu F-51; `lang="cs"` | **PASS** | grep + snímky (Board, Project Intelligence, AI Studio, Cortex, Classic, Monograph zůstávají jako názvy) |
| 3 Poctivé stavy | žádný prvek bez účinku | **PASS** | odstraněno: přepínač AI modelu, rozpočet 300 CZK, natvrdo model, „Fullscreen (připravuje se)“ ×2, „Nastavení (připravujeme)“, šablonové hero, „Vymazat logy“ nad serverovým záznamem, odznak „AI ENGINE“ |
| 3 | každý stav odpovídá serveru | **PASS** | AI Studio z `/api/intelligence/access` (`lib/ai/status.ts` = vynucovaná politika; unit 5 + route test); PI při vypnutém serveru (E2E hub); stav instalace Slacku ze `slackWorkspaces`; „smazat“ kartu = archiv a dialog to říká |
| 4 Porady | Classic bez nativních prvků, 375 px bez přetečení | **PASS** | snímky + matice |
| 4 | #15 skupiny + upozornění, #16 funkční celá obrazovka | **PASS** | unit `meetingGroups` (4), `liveTranscriptView` (3); E2E `meeting-live` krok celé obrazovky |
| 4 | živý přepis na nepodporovaném zařízení vysvětlen | **PASS** (kód) / NOT VERIFIED na skutečném iPadu | `live-device-note` při chybějícím `getDisplayMedia` |
| 5 Propojené účty | stav každé části čitelný bez rozbalení, všechny akce dostupné | **PASS** | E2E hub + notify 2/2; snímek na stacku hubu (jen lokálně) |
| 6 Přístupnost | axe `select-name`, `label`, `button-name` = 0; `color-contrast` = 0 ve 4 vzhledech | **PASS** | matice 336 případů: **0 nálezů axe** (dřív 1440 px: kontrast 35/22/6/7, select-name 13×4, label 4, button-name 4) |
| 7 Testy a dluh | unit ≥ 1 500 PASS | **PASS** | 105 souborů, **1 517 / 1 517** |
| 7 | E2E bez nových selhání | **PASS** | viz §B |
| 7 | TD-3 PASS | **PASS** | `meetings.spec` 8/8 |

## B. Regrese E2E (`frontend/scripts/run11-e2e.sh`)

| Sada | Výchozí (před implementací) | Po implementaci |
|---|---|---|
| Stack porad (porady, PI, zvuk, kalendář, Disk, Gmail, přílohy, spolupráce, runtime, r6) | 45 PASS · 3 FAIL (TD-3, TD-2, r6-quality:102) · 8 nespuštěno · 1 skip | **49 PASS** · 2 FAIL (TD-2, r6-quality:102 – obě předem existující) · 5 nespuštěno (sériově za TD-2) · 1 skip |
| Živý přepis (`meeting-live`) | 3 PASS | **3 PASS** (+ krok celé obrazovky) |
| Demo režim (kanban, reflow, feature-updates, ios-zoom + Monograph) | 27 + 19 PASS | **27 + 19 PASS** |
| Hub + oznámení | 2 PASS | **2 PASS** (+ nové UX asserty: Propojeno ✓, /task, PI vypnuto, zkušební zpráva) |

Změny testů (rozlišení): **legitimní změna UI** – nativní `confirm` → sdílený dialog (calendar, collaboration, gmail, google-drive, notify, hub, task-resources;
unit: calendar, drive, gmail, kanban), správná čeština (meetings, meetingsUi), H1 = název projektu (kanban), bez placeholderu (task-detail-modes),
nové názvy (monographNav, notify heading, bot texty), formát čísel (aiAnalytics), tvar `/api/intelligence/access` (ownerAccess, owner-access);
**zastaralé očekávání** – TD-3. Žádný test nebyl oslaben: nové asserty kontrolují text dialogu, roli `alertdialog`, přesnou sadu událostí TD-3.

## C. Build a pojistky
| Kontrola | Výsledek |
|---|---|
| `npm run lint` | 0 chyb, 10 starších varování (beze změny) |
| `npm run build` (Monograph flag) | PASS |
| `check-production-bundle.sh` | PASS (153 kontrol) |
| `scripts/stack-guard.test.sh` | 2/2 |
| Bezpečnost a náklady | beze změny: RLS, oprávnění, kill switche, AI 40 000 tokenů/den, Soniox 30 min/den jen prezentační účet, demo bez placených služeb. Jediná serverová změna: `access` vrací limity **volajícího** (tier/limity/model), žádné seznamy ani tajemství – k revizi v RUN 12 |

## D. NOT VERIFIED (vědomě)
* Skutečný iPad/Safari jako zařízení pro živý přepis (jen logika a texty).
* `e2e/owner-access.spec.ts` (běží jen přes `owner-e2e.sh` na samostatném s1 stacku) – kontrakt pokrývá unit `ownerAccess`.
* Čtečka obrazovky (VoiceOver/NVDA) – axe + praktická kontrola klávesnicí ano, plný průchod čtečkou ne.
* Živé poskytovatele (Slack, Telegram, Google, Soniox, Gemini) – RUN 11 neměnil integrační logiku; ověření proběhne po nasazení bezplatnými kontrolami (`check-deployment.sh`).
