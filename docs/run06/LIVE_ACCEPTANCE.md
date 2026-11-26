# RUN 06 – živá akceptace s demo účtem (skutečný Google)

2026-11-26, lokální stack `cs-gdemo-sb` (app `http://127.0.0.1:3461`, DEV login alice/bob/vera), Google `clearspace-dev` (Testing), klient
„ClearSpace Dev Web“, demo účet Alex Morgan (test user). Pilot: `GMAIL/CALENDAR_INTEGRATION_ENABLED=pilot`, pilot = jen alice + jen demo účet.
Projekty: CSD-CORVANE nasazený do lokálního stacku (`demo-seed apply --target local:…`, z kopie seederu – sledovaný manifest jiného stromu nedotčen);
bob = editor a vera = čtenářka projektu Yutani (`csd1-p01`). Nástroj: `frontend/scripts/gdemo-stack.sh live-node gdemo_live_accept.mjs link|drive|isolation`.

## Připojení (prohlížeč, souhlasy odklikané se schválením vlastníka – výhradně jako demo účet)
| Krok | Ověření před potvrzením | Výsledek |
|---|---|---|
| Disk | URL: scope `openid email drive.file`; výběr účtu = demo; obrazovka „konkrétní soubory na Disku“; políčko zaškrtnuto | `connected`, Google vrátil 3 scopy |
| Gmail | „Zobrazení e-mailových zpráv a nastavení“ (= `gmail.readonly`), stávající přístup 3 | `gmail_connected`, 4 scopy |
| Kalendář | „Čtení událostí v kalendářích Google, které vlastníte“, stávající přístup 4 | `calendar_connected`, 5 scopů |
| (první pokus o Disk) | obrazovka hlásila „už má částečný přístup (5)“ = grant seederu ve stejném projektu → **zrušeno**, seeder odvolán, pak čistý souhlas | viz README „Nález“ |

Uložené scopy ClearSpace: `openid`, `userinfo.email`, `drive.file`, `gmail.readonly`, `calendar.events.owned.readonly` – **žádný zápis**.

## Výsledky (finální kód, po obnovení spojení ze zálohy po regresi)
| # | Bod | Výsledek |
|---|---|---|
| 1 | Grant: skutečný Google, 3 služby, přesně 5 read-only scopů | PASS |
| 2 | Gmail: vyhledání 4 seedovaných vláken (Nostromo Park 4 zprávy, Tyrell 3, Hadley Park 4, Halden & Brooke 3), připojení k projektům Yutani / Tyrell / Hadley Park / Halden & Brooke, duplicita rozpoznána, náhled vlastníka ukazuje skutečný text | PASS |
| 3 | Kalendář: 26 výskytů v okně, týdenní série 6×, celodenní go-live, událost v America/Los_Angeles (16:00 Praha), servisní okno přes půlnoc; 5 událostí připojeno ke 4 projektům; soukromá „Lékař“ **odmítnuta** (`private`) | PASS |
| 4 | Disk přes **skutečný Google Picker** (UI projektu Yutani): 3 seedované soubory (zadání, zápis ŘV, tabulka výsledků pilotu); náhled obsahu vlastníka 200 | PASS |
| 5 | Týmový pohled (bob, vera): předmět, odesílatel (jméno/doména), název/čas/organizátor (doména); **žádné** id zpráv/událostí, tělo, místo, adresa demo účtu, soukromá událost | PASS |
| 6 | Náhled e-mailu / otevřít v Google jen alice; bob a vera odmítnuti | PASS |
| 7 | Izolace pilotu: bob, vera a cizí uživatel → `gmail_disabled` / `calendar_disabled` (stránka spojení, start OAuth, vyhledávání, události), žádná URL souhlasu, žádný Picker token; cizí uživatel nevidí odkazy projektu | PASS (po opravě `not_connected` → viz `PILOT_MODE.md`) |
| 8 | Log aplikace: žádná adresa demo účtu, token, secret ani předmět e-mailu | PASS |
| 9 | Seeder odvolán, ClearSpace spojení zachováno a funkční (finální živý běh volá Google se stejným grantem) | PASS |
| 10 | UI (Monograph, desktop 1280): modal „Soubory, e-maily a události projektu“ – 3 soubory, 1 vlákno, 2 události, „pořádá @gmail.com“ | PASS (vizuálně) |

Stav v lokální DB: Yutani 3 soubory + 1 vlákno + 2 události; Tyrell 1 vlákno + 1 událost; Hadley Park 1 + 1; Halden & Brooke 1 vlákno; Policy (p14) 1 událost.

## Poznámka k regresi
Pilotní HTTP sada (mock) na začátku odpojuje alici – živé spojení bylo před regresí zazálohováno (zašifrovaný řádek, tabulka uvnitř lokální DB) a
poté obnoveno. Odvolání při mockovém odpojení šlo na **lokální mock**, ne na Google – skutečný grant zůstal platný (ověřeno finálním živým během).

## NOT VERIFIED (živě)
* Úklid / obnova seederu na skutečném účtu (jen fiktivní Google).
* 7denní expirace grantu v Testing; odvolání z myaccount.google.com; odškrtnutí Gmailu/Kalendáře na granulární obrazovce (jeden nový scope = Google políčko neukazuje).
* Drive Picker pro další projekty (jen Yutani); připojení e-mailu/události k úkolu (karta) s demo daty (pokryto RUN 03/04).
* Produkce – nic nespuštěno.
