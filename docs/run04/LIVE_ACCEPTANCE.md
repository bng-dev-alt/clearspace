# RUN 04 – Google Calendar: živá akceptace (skutečný Google, dev projekt `clearspace-dev`, Testing)

Provedeno 2026-11-25 na lokálním stacku `cs-calendar-sb` (app `http://127.0.0.1:3461`, DEV login alice/bob/vera) proti skutečnému Googlu,
účtem vlastníka (test user dev projektu). Produktový kód = finální (`src/`, migrace a `next.config.ts` od commitu `77325d7` beze změny;
živá brána znovu na finálním SHA `f0c1c23` = merge `19a0c6b`). Nástroje: `calendar-live.sh gate|accept|revoke-check`, `gmail_live_gate.mjs`.

## A. Google Cloud (dev) – provedeno v rámci schválení §0
Calendar API zapnuto; Data Access + `calendar.events.owned.readonly` (konzole ho zařadila mezi **sensitive**); OAuth klient „ClearSpace Dev Web“:
JS origin `http://127.0.0.1:3461` + redirect `http://127.0.0.1:3461/api/google/oauth/callback`; Picker API klíč: referrer `http://127.0.0.1:3461/*`.
`calendar-live.sh verify`: token endpoint `invalid_grant` (klient + secret přijaty), auth endpoint 302 (redirect přijat). `clearspace-prod` beze změny.

## B. Testovací data
Ve skutečném primárním kalendáři vlastníka vytvořeny události „ClearSpace TEST – …“ **bez hostů** (žádné pozvánky): týdenní série (4×, St 9:00)
s jedním upraveným výskytem (9. 12. → 11:00) a smazaným výskytem (16. 12.), celodenní 14.–16. 12., call v pásmu America/New_York, přes půlnoc,
soukromá, DST 2027-03-28 01:30–03:30, událost k přeplánování. **Po akceptaci všechny smazány** (koš Google Kalendáře; hledání „ClearSpace TEST“ = 0).

## C. Výsledky
| # | Bod | Důkaz | Výsledek |
|---|---|---|---|
| 1 | Klient + redirect 3461 přijaty | `verify` | PASS |
| 2 | Disk: granulární obrazovka s **nezaškrtnutým** políčkem → bez zaškrtnutí `scope_denied`, nic uloženo; se zaškrtnutím připojeno | UI | PASS (dřívější NOT VERIFIED z RUN 02 „odškrtnutý Disk“) |
| 3 | Kalendář: **Zrušit** na obrazovce Googlu → „Připojení bylo zrušeno“, Disk dál Povoleno | UI | PASS (E9) |
| 4 | Kalendář povolen: obrazovka žádá jen „Čtení událostí v kalendářích Google, které vlastníte“; Gmail zůstal v ClearSpace **vypnutý**, ač ho grant u Googlu z RUN 03B drží | UI + `services` | PASS |
| 5 | Zúžený token: tokeninfo = **jen** `calendar.events.owned.readonly`; `events.list` primary (rozsah, singleEvents, orderBy, fields) 200; `q` 200; `maxResults=2` + `pageToken` 200; `events.get` výskytu 200, stejné id; id 0× mimo pravidlo; Google neposlal description/location/Meet | gate B | PASS |
| 6 | Produktová trasa vrací stejné události jako Google (nic neztraceno normalizací) | gate C | PASS |
| 7 | E1/E2: 3 výskyty série; upravený výskyt 11:00 (`modified=true`); smazaný chybí | accept link | PASS |
| 8 | E3: celodenní 14.–16. 12. (konec exkluzivní, bez posunu) | accept link | PASS |
| 9 | E4: pásmo America/New_York (16:00 Praha), přes půlnoc, **DST 2027-03-28** = 1 skutečná hodina | accept link | PASS |
| 10 | E6: soukromá událost odmítnuta (`private`), 4 jiné připojeny | accept link | PASS |
| 11 | E7: stejný výskyt znovu → stejný odkaz (`duplicate`) | accept link | PASS |
| 12 | Sdílené řádky (čtenářka vera): žádné event id, `htmlLink`, popis ani adresa; organizátor jen doména | accept link | PASS |
| 13 | Role: Otevřít (Google `htmlLink`) a Obnovit jen vlastník; editor/čtenář 403; čtenář nepřipojí; editor bez Googlu 409 | accept link | PASS |
| 14 | Odkaz k úkolu + aktivita bez názvu (čte editor) | accept link | PASS |
| 15 | E5: přeplánováno v Googlu → Obnovit → tým vidí 7. 12. 14:00 | accept after-change | PASS |
| 16 | E5: smazaný výskyt nejde připojit (`not_found`) | accept after-change | PASS |
| 17 | E5: připojená událost smazaná v Googlu → `deleted`, poslední údaje zachovány, Otevřít 404 | accept deleted-linked | PASS |
| 18 | E10: Drive + Gmail + Calendar na jednom grantu: Picker token = identita + `drive.file`; Calendar API 403, Gmail API 403, Drive 200; serverový Gmail i Kalendář fungují; RUN 03 `gmail_live_gate.mjs` PASS | gate A + Gmail gate | PASS |
| 19 | E9/E10: „Vypnout Kalendář“ → 409 `calendar_not_granted`, Disk + Gmail běží, spojení aktivní; grant u Googlu Calendar stále drží (ClearSpace ho nepoužívá); znovu zapnutí funguje | accept off + gate expect-no-calendar | PASS |
| 20 | E9: Odpojit účet → **revokace u Googlu**: starý refresh token `invalid_grant`, řádek spojení smazán | `revoke-check` | PASS |
| 21 | UI se skutečnými daty: Klasika i Monograph (připojené vs. moje, soukromá kurzívou, smazaná přeškrtnutá), Monograph bez přetečení | prohlížeč | PASS |
| 22 | Logy dev serveru: žádné názvy, tokeny, kódy, `htmlLink`, URL hledání ani adresa | accept (všechny fáze) | PASS |

## D. NOT VERIFIED (živě)
* **Odškrtnutí Calendar** na granulární obrazovce: Google pro jediný nový scope políčko nezobrazí (stejně jako Gmail v 03B); ověřeno mockem.
* **Důvěrná (`confidential`) událost**: UI Google Kalendáře ji nenabízí (jen Soukromé); ověřeno mockem a unit testy.
* **Podzimní DST 2027-10-31** živě (jarní ano); mock + unit.
* **410 Gone** a hraniční události přesně na `timeMin/timeMax` živě; mock + unit.
* **Druhý Google účet** (`account_mismatch`), **7denní expirace** v Testing, **revokace z myaccount.google.com** (cesta kódu sdílená s RUN 02/03, mock).
* Více než 250 událostí v jednom okně (ořez s hláškou) – živý kalendář tolik nemá; mock.

Po akceptaci: dev grant pro ClearSpace Dev je revokovaný (bod 20); příští živý běh začíná připojením účtu.
