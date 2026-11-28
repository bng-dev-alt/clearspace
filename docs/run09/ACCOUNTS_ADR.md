# ADR RUN 09-01 – Rozdělení účtů pro produkční demo a piloty (ZÁVAZNÉ)

Stav: **přijato vlastníkem 2026-11-27**. Platí pro všechny budoucí runy včetně RUN 10 (Meeting Intelligence) a finálního polish runu.

## Rozhodnutí
1. **Jeden prezentační účet pro funkční portfolio demo všech integrací**: ClearSpace účet prezentujícího (`luf…@gmail.com`,
   zobrazované jméno „Demo Account“), jehož přihlašovací e-mail je **zároveň demo Google identita „Alex Morgan“**. Vlastní 14 projektů
   CSD-CORVANE (`csdp-p01…p14`) se syntetickými daty a výhradně syntetický obsah Gmailu, Disku a Kalendáře.
2. **Všechny pilotní allowlisty obsahují jen prezentační účet**: `GOOGLE_PILOT_USER_IDS` (+ `GOOGLE_PILOT_ACCOUNTS` = demo Google účet),
   `HUB_PILOT_USER_IDS`, `NOTIFY_PILOT_USER_IDS`. Budoucí funkce (Meeting Intelligence, stage 2 PI) dostanou vlastní allowlist se stejnou
   hodnotou – nikdy „všichni“.
3. **Osobní účet vlastníka (`mic…@gmail.com`) není součástí dema** – žádný pilot, žádné demo připojení. Obsahuje osobní projekty a osobní Google.
4. **Chat poskytovatelé pro demo**: Slack workspace **BNG Workspace** (testovací), kanály `#clearspace_test` (+ soukromý testovací);
   Telegram skupina **„ClearSpace Test“**. Boti jsou jen v těchto místech; osobní konverzace vlastníka jsou mimo jejich dosah.
   Osobní oznámení (HQ bot) chodí do Telegramu vlastníka, protože demo nemá vlastní telefonní číslo (vědomé omezení).
5. **Veřejnost**: neexistuje veřejný demo login, auto-login ani sdílené heslo. Prezentační účet zná jen vlastník. Každý jiný účet (i nově
   registrovaný) dostane u Slack/Telegram 403 „pilotní provoz“, u Google `*_disabled`, u AI 403 `ai_owner_only` – ještě před voláním
   poskytovatele, tedy bez nákladů. AI mají jen `AI_OWNER_USER_IDS` (vlastník, beze změny od RC1–RC5) a od 2026-11-28 prezentační účet
   v demo tieru (`AI_DEMO_USER_IDS`, 40 000 tokenů/den, 2/min); nikdo jiný.
6. **Testovací obsah** vzniká jen v označených testovacích projektech prezentačního účtu („RUN09 Pilot …“, „RUN09 Izolace …“), nikdy v CSD
   projektech, kromě obnovy evidovaných demo vazeb (Gmail vlákna t01–t14).

## Důsledky pro budoucí runy
* RUN 10 Meeting Intelligence: pilot = prezentační účet, demo porady jen v CSD projektech nebo v testovacím projektu; náklady (STT/AI)
  jen přes `AI_DEMO_USER_IDS` s přísnými limity po schválení vlastníka.
* Stage 2 (Cortex + PI): od 2026-11-28 aktivní – `AI_DEMO_USER_IDS` = prezentační účet (40 000 tokenů/den, 2/min, bez přepisu řeči).
* Změna allowlistu = změna tohoto ADR (vlastník).
