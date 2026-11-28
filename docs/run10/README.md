# RUN 10 – Meeting Intelligence: závěrečná zpráva (2026-11-28)

## Aktualizace po živé akceptaci a hardeningu (2026-11-28)
**Verdikt: GO pro feature freeze. Uzavření RUN 10: podmíněné – chybí jen živá Gemini část (analýza → schválení úkolu → PI citace),
zablokovaná denním limitem tokenů prezentačního účtu, ne kódem; dokončit po obnově limitu (≤ 5 dotazů, ≤ 0,05 USD, bez změny limitů).**

* Živě ověřeno (LIVE PASS): OAuth „Plánování porad“, skutečná událost + Meet, pozvánky e-mailem, Mac + iPad v hovoru, Soniox CZ / EN /
  mix, pauza / pokračování / stop, ledger a náklady v limitu, izolace dat (RLS v produkci), smazání porady. Diarizace a vzdálený
  účastník přes kartu: PARTIAL. Matice: `ACCEPTANCE.md` (28 bodů).
* Opraveno a nasazeno (`dpl_9xskrK75…`, commit `2fd55c6`): výběr mikrofonu, bezplatný lokální test, živé úrovně mikrofonu / karty,
  ticho / odpojení, „Zrušit přepis“ s potvrzením, poctivé koncové stavy, termín vs. skutečný průběh, čitelné „Připojit se ke schůzce“.
* Náklady: Soniox 4 relace / 6,37 min / 0,0127 USD (limit 6 / 30 / 0,06) · Gemini 0 / 0 USD (limit 8 / 0,30).
* Po akceptaci: minuty přepisu prezentačního účtu = 0 (schválen byl test, ne trvalá spotřeba); ostatní pilotní přepínače zůstávají.
* Úklid: lokální stack `cs-run10-sb` smazán (jen syntetická data, schváleno), porada „RUN10 Diktat“ smazána (mikrofon zachytil i
  nesouvisející hovor z místnosti), worktree `V1-run10-release` sloučen a odstraněn.

---

## Původní zpráva (před živou akceptací)

**Verdikt: GO pro produkci s vypnutými přepínači (hotovo) · NO-GO pro „hotovou“ Meeting Intelligence, dokud neproběhne jediný blok
vlastníka (`OWNER_BLOCK.md`) – živý přepis, Meet z Google API a placená AI jsou ověřené jen v simulaci.**

| Oblast | Výsledek |
|---|---|
| Architektura | `ARCHITECTURE.md`; ~70 % schopností už existovalo (RC1–RC5, RUN 04); RUN 10 doplnil živou vrstvu, plánování a PI zdroj |
| Znovupoužití | `REUSE_MATRIX.md` – jádro porad, Soniox adaptér + normalizér, Gemini analýza s citacemi, review/apply, Calendar linky; poznatky ze scribe_ (protokol, kvalita CZ), vzor rekordéru z MicroCRM; MI Standalone vyřazen |
| Rozhodnutí | `DECISIONS.md` (D-01…D-17): přímý stream s jednorázovým dočasným klíčem, rezervace před klíčem, pauza = konec streamu, zvuk se neukládá, `calendar.events.owned` jako samostatná služba, Meet jen z odpovědi Googlu |
| MUST-HAVE | `SCOPE.md` – vše implementováno; živé části BLOCKED na vlastníka |
| LATER | boti, nativní Zoom/Teams, auto-nahrávání, video, hlasová identifikace, follow-up e-maily, reconnect s bufferem, přímé odeslání do hubu |
| Prohlížeče / zvuk | `AUDIO_CAPTURE.md` – Chrome/Edge desktop: mikrofon + zvuk karty; Safari/iPad/Firefox: jen mikrofon; desktop Zoom/Teams na macOS nezachytí |
| Kalendář / konference | událost + Meet + volitelné pozvánky, úprava, zrušení; MOCK PASS; skutečný Google BLOCKED (scope) |
| Soniox | `stt-rt-v6`, cs+en, LID, diarizace; MOCK PASS; skutečný přepis BLOCKED (placený test – návrh ≤ 0,06 USD) |
| AI analýza | existující pipeline (citace, validace, injekce); nad živým přepisem MOCK PASS |
| Úkoly + PI | schválení/úprava/idempotence (RC5) + nový zdroj `meeting:<id>#summary`, item s názvem/datem porady; MOCK PASS |
| Bezpečnost / soukromí | `PRIVACY.md`; RLS na 4 nových tabulkách, organizátor, pilot, vypínače, žádný klíč v klientu, bundle guard rozšířen |
| Mock vs. živě | `ACCEPTANCE.md` (21 bodů) – žádný mock se nepočítá jako živá akceptace |
| Náklady | 0 USD (žádné placené volání) |
| Regrese | unit 1485/1485 · DB 2760 asercí · E2E 37 + 2 nové PASS, TD-3 známé · build + bundle guard 153/153 · produkce 143 PASS |
| Produkce | migrace 1800 (šifrovaná záloha + ověřená obnova), kód `dpl_FZMYZjkvXQJJ1bgk7m8Qn3ipSnLs` (commit `c66b23e`), nové schopnosti OFF; rollback `dpl_GWQF6jGs…` |
| Pilot / limity | po schválení: `MEETING_PILOT_USER_IDS` = prezentační účet, 30 min/den, segment 10 min (`OPERATIONS.md`) |
| DB / storage | +4 tabulky, +5 sloupců `meetings`, 7 RPC `stt_live_*`; žádný nový bucket; zvuk se neukládá |
| Inventář | Excel aktualizován (C10, S27, O02, nové C66, C67, R32, R33), záloha `backups/…pre-run10.xlsx` |
| Školení | `docs/training/MEETING_INTELLIGENCE.md` (modul 5) |
| Dluh | `docs/TECH_DEBT.md` §RUN 10 (TD-3 aj.), UX backlog #15–19 |

## Handoff: feature freeze a finální polish (nezačínat v RUN 10)
1. **Owner block RUN 10** (živá akceptace, ~30 min) → rozhodnutí o trvalém pilotu.
2. **Feature freeze V1** – žádné nové velké funkce; jen opravy, polish, dokumentace.
3. **UX/UI polish** – `docs/run09/UX_BACKLOG.md` (19 položek, vč. Propojených účtů a porad).
4. **Finální bezpečnostní a spolehlivostní audit** – rozdíl katalogu repo vs. produkce (TECH_DEBT), retence, vypínače, logy, firewall.
5. **Vícečlenná akceptace** – druhý pilotní účet (ADR), oznámení od jiného člověka, porada se dvěma členy.
6. **Portfolio prezentace** – demo scénáře v modulech 3 a 5.
7. **Školení a cvičení** – moduly 1, 2, 4, 6 doplnit ze skutečné implementace.
8. **Simulované HR a technické pohovory** – FAQ v modulech.
9. **Finální portfolio release** (tag, release notes).
10. **Archivace ClearSpace V2** – až po validaci a samostatném schválení.
