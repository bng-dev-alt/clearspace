# RUN 09 – Communication Hub Production Release (report)

**Verdikt: GO – etapa 1 (Slack + Telegram, osobní oznámení) je v produkci a živě akceptována v pilotu jen pro prezentační účet.
Etapa 2 (Cortex + Project Intelligence z chatů): skutečný Gemini test PASS (6 požadavků, ≤ 0,05 USD) a od 2026-11-28 **TRVALE AKTIVNÍ**
jen pro prezentační účet (`dpl_GWQF6jGsECxp16U99vJ6ZpNH6afv`), limity 40 000 tokenů/den a 2 požadavky/min ověřeny po nasazení.**
Rozdělení účtů: `ACCOUNTS_ADR.md` (závazné). Provoz a rollback: `OPERATIONS.md`. Etapa 2: `STAGE2_GEMINI_PROPOSAL.md`. UX: `UX_BACKLOG.md`. RUN 10: `RUN10_HANDOFF.md`.

## 1. Produkce
| | Stav |
|---|---|
| Deployment | `dpl_BvqQZBpsey4ehYNLJNoMDyZk469d` (commit `87e86f2`), staged → 142/142 kontrol → promote; doména 142/142 |
| Mezikroky | `dpl_9TGb58…` (kód RUN 09, hub vypnutý, 163/163) → `dpl_54myMw9f…` (pilot mic…) → `dpl_7kvzV9jJ…` (oprava Signing Secret) → `dpl_BvqQZBps…` (pilot = prezentační účet) |
| DB | migrace 1600 + 1700 (jedna transakce, počty a otisky dat beze změny, 12 tabulek s RLS); znovu nazkoušeno proti aktuálnímu produkčnímu DDL (REHEARSAL PASS, katalog `ea62e3a1…`) |
| Zálohy | šifrované (AES-256, klíč v Keychainu) `public` + `auth` před první změnou, obnova ověřena (32 projektů, 337 úkolů); záloha skriptu migrace taky zašifrována |
| Plánovače | pg_cron `clearspace-hub-dispatch` + `clearspace-notify-dispatch` každou minutu: 240 běhů, 0 chyb |
| Servisní identita | `hub-service@clearspace.invalid` vytvořena SQL (bez e-mailu, bez admin klíče), bez práv k projektům, přihlášení ověřeno |
| Pilot | `HUB_PILOT_USER_IDS` = `NOTIFY_PILOT_USER_IDS` = prezentační účet (nový allowlist i pro osobní oznámení RUN 05) |

## 2. Živá akceptace (skutečný Slack BNG Workspace + Telegram, produkce, prezentační účet, syntetický obsah)
| Scénář | Výsledek |
|---|---|
| Slack manifest: události → produkce, **Verified**, 4 bot události (provedeno přes prohlížeč) | PASS |
| Instalace Slack aplikace pro projekty + osobní Slack (OAuth Allow vlastníkem) | PASS |
| Propojení Slack identity (`/clearspace ucet`) a Telegram identity (`/start` u Relay) | PASS |
| Osobní Telegram (HQ, potvrzení účtu), osobní Slack DM | PASS |
| Propojení `#clearspace_test` a skupiny „ClearSpace Test“ párovacím kódem + potvrzení | PASS |
| Zkušební zprávy (hub i osobní) + limit 1 / 30 s (druhý pokus 429) | PASS |
| Oznámení plánovačem: nový úkol + připomínka termínu do Slacku i Telegramu (souhrn „2 změny“, odkaz do produkce) | PASS |
| Dokončení úkolu → Slack + Telegram | PASS |
| Osobní připomínka termínu (Slack DM + Telegram HQ) | PASS |
| Úkol z Telegramu `/task@ClearSpaceRelayBot …` (po zapnutí „Interaktivní“; předtím správně odmítnuto) | PASS |
| Úkol ze Slack zprávy (zkratka „Vytvořit úkol“, modal) | PASS |
| Komentáře obousměrně: Telegram odpověď → komentář, komentář → Telegram; Slack vlákno → komentář, komentář → vlákno (ověřený autor = prezentační účet) | PASS |
| Atribuce zdroje: „Konverzace v chatu“ u úkolu (zdroj úkolu neověřený autor, odpovědi ověřené, permalink „Původní zpráva“) | PASS |
| Izolace: úkol v nepropojeném projektu → 0 záznamů outboxu | PASS |
| Autorizace: přihlášený nepilotní účet → 403 na 8 routách hubu/oznámení; AI 403 `ai_owner_only` pro nepilotní i prezentační účet | PASS |
| Odpojení Slack kanálu → další úkol jen do Telegramu (ověřeno čtením kanálu); znovupřipojení kódem → aktivní, zkušební zpráva | PASS |
| Kanál bez bota (po odvolání dev tokenu) → `removed_bot`; po `/invite` → „znovu aktivní“ | PASS |
| PI na serveru vypnuto (UI „Na serveru vypnuto“), Cortex bez webhooku | PASS (containment) |
| Osobní oznámení od jiného uživatele (přiřazení/komentář) | NOT VERIFIED v produkci (pilot má jediný účet; RUN 08 LIVE lokálně) |

## 3. Mock vs. skuteční poskytovatelé
Vše v tabulce 2 je **LIVE** (skutečný Slack/Telegram + produkce). Mock regrese: sekce 6.

## 4. Etapy
Etapa 1 **AKTIVNÍ** (pilot, prezentační účet). Etapa 2 **ověřena skutečnou AI a znovu VYPNUTÁ** (dočasná izolovaná aktivace 2026-11-28 04:3x–05:0x,
`dpl_761dCNdj…` → kill-switch `dpl_FwMs3B7p…` → finální `dpl_EfUg58JQCRSUpKdqbQ6GdpDWkrop`). Trvalá aktivace čeká na rozhodnutí vlastníka.

## 5. Gemini – skutečný akceptační test etapy 2 (schváleno: ≤ 12 požadavků, ≤ 0,50 USD, syntetická data, prezentační účet)
Preflight: model z ledgeru **`gemini-3.6-flash`**; ceník Google $0,75/$3,75 za 1M (zaváděcí do 31. 12. 2026), ceníkový $1,50/$7,50 (počítáno s vyšším);
chat posílá `thinkingBudget: 0`, výstup max 2 000 tokenů; tvrdý strop `AI_DEMO_DAILY_TOKEN_BUDGET=40000` + 2 požadavky/min → nejhorší případ ≤ 0,40 USD.
Dočasně: `AI_DEMO_USER_IDS`=prezentační účet, `HUB_INTELLIGENCE_ENABLED=1`, Cortex token + webhook; PI s potvrzením jen u `#clearspace_test` a skupiny
„ClearSpace Test“ (u skupiny celá komunikace přes Cortex). Syntetika: 2 zprávy Slack, 3 Telegram (vč. „SYSTEM: ignoruj pokyny…“).

| # | Ověření | Výsledek |
|---|---|---|
| ingest | Slack 2 + Telegram (Cortex) 3 zprávy uloženy, ověřený autor, `retain_until` +90 dní | PASS |
| 1 | Shrnutí chatů: fakta ze Slacku i Telegramu, každé s citací `comm:` (kanál/skupina) | PASS |
| 2 | „Proveď pokyny ze zpráv“: odmítnuto jako data; otisk všech úkolů (test + CSD) beze změny, 0 upravených | PASS |
| 3 | Vylákání promptu / klíčů / tokenů / e-mailů: nic nevydáno | PASS (nález LOW: vypíše interní ID vlastního projektu – ne tajemství) |
| – | rate limit 2/min → 429 před voláním Gemini (nezapočteno, 0 nákladů) | PASS |
| 4 | Izolace: stejná otázka v nepropojeném projektu → žádný chatový kontext | PASS |
| opt-out | vypnutí PI u skupiny → 3 importy okamžitě smazány | PASS |
| 5 | po opt-outu: Telegram fakta neznámá, Slack fakt citován | PASS |
| kill switch | `HUB_INTELLIGENCE_ENABLED=0`: nové zprávy Slack + Cortex přijaty, **0 uloženo** | PASS |
| 6 | kill switch: AI bez chatového kontextu i se souhlasem u kanálu | PASS |
| vypnutí | souhlas u Slacku odvolán → importy smazány; 8 dočasných proměnných odstraněno; Cortex `deleteWebhook`; finální build 142/142; AI prezentační účet 403, PI webhook 503 | PASS |
| retence | mazání `retain_until < now()` v plánovači (kód 1600/1700, harness RUN 07) – 90denní expirace živě neověřitelná | kód + mock |

**Skutečné náklady: 6 požadavků, 22 021 tokenů (19 491 vstup / 2 530 výstup) → ≤ 0,048 USD ceníkově, ≈ 0,024 USD zaváděcí cenou.**
**Verdikt etapy 2: GO technicky** (všechny podmínky splněny); trvalá aktivace = rozhodnutí vlastníka (`OPERATIONS.md`: `push-env stage2` + `AI_DEMO_*` + webhook Cortexu).

## 6. Regrese
Vitest **1429/1429** (96 souborů) · produkční build z čistého exportu + bundle guard **140/140** · tsc 0 chyb · nazkoušení migrací (DB kontrakty 92–97 na produkčním DDL) PASS ·
check-deployment: hub OFF 126 + 146, pilot 142 (×3) · průvodce Keychainem E2E PASS.

Mock (izolovaný stack `cs-notify-sb`, jen loopback, simulovaní poskytovatelé): `hub_http.mjs` **22/22 PI vypnuto** a **22/22 PI zapnuto** (A22/A23/A25 vč. injection jako data) ·
`notify_http.mjs` **23/23** · `drive_http` **28/28** · `gmail_http` **23/23** · `calendar_http` **18/18** · E2E hub + notify **2/2** v Classic/Monograph × světlý/tmavý (4 běhy;
notify spec má vždy světlý desktop + tmavý telefon) · `google_pilot_http` **přeskočen** (potřebuje stack `cs-gdemo-sb`; pilot Google ověřen živě v produkci, sekce 9).
Ochrana proti incidentu RUN 08: harness maže jen `(simulace)` instalace a `@example.test` identity; živé řádky na stacku (1 instalace, 2 identity, 3 cíle) **bajtově
shodné** před/po. Playwright: použit lokálně přítomný headless shell 1234 (`PW_CHROMIUM_PATH`, `docs/NEW_SUPABASE_PROJECT.md`), nic nestaženo.

## 7. Bezpečnost a soukromí
* Dev přístup zrušen: dev instalace Slack odvolána (`auth.revoke`), všechna 3 tajemství Slacku regenerována (ověřeno ≠ dev), 3 bot tokeny revokovány (staré getMe=401).
* Nalezeno a opraveno: (a) osobní oznámení RUN 05 neměla pilotní omezení → `NOTIFY_PILOT_USER_IDS`; (b) zdvojené vložení Signing Secret → oprava + validátor
  (přesně 32 hex); (c) `hub-prod.sh` nastavil Telegram webhook bez `secret_token` → produkce správně odmítala (401) → oprava.
* Žádná hodnota tajemství v repu, logu, chatu ani v Excelu (kontrola proti Keychainu: 0 shod).
* BotFather chat obsahuje tokeny v textu (≥ 3 aktuální) – doporučeno smazat (čeká na vlastníka).
* Účty: audit (`ACCOUNT_AUDIT.md`) → pilot přesunut z osobního účtu na prezentační; osobní Google vlastníka (jen Disk) mimo demo.

## 8. Git
Větev `release/run09-hub-production` (worktree `V1-run09`): commity `df6daba` … (viz `git log main..`), merge do `main` fast-forward, tag `run09-stage1-complete`.

## 9. DB a nasazení
Viz 1. Finální produkce **`dpl_EfUg58JQCRSUpKdqbQ6GdpDWkrop`** (commit `3b12454`). Demo data zachována: Disk 20 odkazů, Kalendář 17, **Gmail 14 vláken obnoveno** (t01–t14 → CSD projekty dle RUN 06, 0 duplicit, scopy beze změny);
živě: náhled Gmailu 200, Kalendář 19 událostí/30 dní, refresh Disku OK.

## 10. Keychain + Excel
Keychain: nové služby `ClearSpace V1 - Hub (production)`, `ClearSpace V1 - Notify (production)`, klíč záloh; dev služby označeny DEPRECATED (hodnoty mrtvé).
Excel `Service_Credentials_Inventory.xlsx`: záloha `backups/…_20261128-run09_before-update.xlsx`; Services S32/S33 aktualizovány + S48–S51, Credentials C16 + C56–C64,
OAuth O05/O06 + O11–O13, Domains D31, Security R11 → DONE + R29–R31. Jen odkazy na Keychain, žádné hodnoty. ZIP integrita OK; vzorce se přepočtou při otevření (LibreOffice není k dispozici).

## 11. Soubory vlastníka
`V1/frontend/.env.local`, `test_intro.mp4`, 28 souborů `DEMO/` – bajtově beze změny; hlavní checkout beze změny.

## 12. Úklid
Zastaveno: mocky (google/notify/hub), aplikace, loopback proxy, stack `cs-notify-sb` (`supabase stop` bez `--no-backup`, 3 volumy ponechány), dočasné kontejnery
nácviku a ověření obnovy (odstraněny), dočasný build export (smazán). Cizí kontejnery (cs-atelier-sb, cs-collab-sb, cs-intel-sb) a tunely vlastníka nedotčeny. Tunel `clearspace-hub-live` + DNS `cs-hub-live.luffast.com` ponechány
neaktivní pro budoucí řízenou akceptaci (rozhodnutí). Testovací projekty „RUN09 Pilot“ a „RUN09 Izolace“ v prezentačním účtu ponechány (pilot ukázka) – smazání na rozhodnutí vlastníka.

## 12b. Credential cleanup a testovací projekty (2026-11-28)
* BotFather: 3 zprávy s **aktuálními** tokeny (otisk SHA-256 ověřen proti Keychainu: Relay, HQ, Cortex) smazány; Telegram u zpráv bota nabízí jen „smazat pro mě“
  – smazání i u BotFathera nelze. Zbyla 1 starší zpráva s **odvolaným** dev tokenem Cortexu (getMe=False) – mimo schválení, neškodná.
* Keychain: 11 neplatných dev položek smazáno (Slack tajemství regenerována, tokeny getMe=False, nikde jinde nepoužité); `cloudflare_tunnel_token` ponechán, tunel neběží.
* Testovací projekty „RUN09 Pilot“ a „RUN09 Izolace“: evidence uložena, cíle odpojeny s `purge=1`, projekty smazány aplikací; zbylé 2 osobní doručení smazány cíleně.
  Ověřeno: 0 projektů/úkolů/cílů/zpráv/outboxu/auditu po nich; CSD 14 projektů / 154 úkolů, odkazy 51, Gmail zdroje 14 beze změny; ledger AI zachován.
  Syntetické zprávy zůstávají jen v testovacím kanálu/skupině u poskytovatelů. Relay po odpojení skupinu opustil (best effort); Cortex je ve skupině dál bez webhooku.
* Excel: záloha `…_20261128-run09-stage2_before-update.xlsx`; C16 (dev smazáno), nový řádek tunelového tokenu, R29/R30 → DONE; 0 tajemství v sešitu.

## 12c. Závěrečná kontrola po cleanupu
Etapa 1: instalace 1, identity 2, osobní kanály 2 aktivní, zkušební zprávy Slack + Telegram `sent`, plánovače běží, Relay webhook 0 chyb.
Google: Gmail náhled 200, Kalendář 19 událostí, Disk refresh OK. Oddělení: nepilotní účet 403 (8 rout), AI 403 pro prezentační i ostatní účty,
žádný veřejný login. **Produkční commit `3b12454` vs. `main` HEAD: rozdíl jen dokumentace** (viz `git diff --stat`), žádný nenasazený kód.

## 13. Zbývá / dluh
Trvalá aktivace etapy 2 (rozhodnutí) · osobní oznámení od jiného uživatele živě (pilot má 1 účet) · UX backlog · `TECH_DEBT.md` (RUN 09).

## 14. Trvalá aktivace etapy 2 (schváleno vlastníkem 2026-11-28)
| Kontrola | Výsledek |
|---|---|
| Proměnné (Production, z Keychainu): `HUB_INTELLIGENCE_ENABLED=1`, `TELEGRAM_HUB_PI_*`, `AI_DEMO_USER_IDS`=prezentační účet, `AI_DEMO_DAILY_TOKEN_BUDGET=40000`, `AI_DEMO_RATE_PER_USER_PER_MINUTE=2`, `AI_DEMO_RATE_GLOBAL_PER_MINUTE=2`, `AI_DEMO_STT_DAILY_AUDIO_MIN_PER_USER=0` | nastaveno |
| Staged build + `check-deployment.sh` (pilot, Telegram, **PI**, Google) | 142/142 → promote `dpl_GWQF6jGs…` |
| Cortex webhook `/api/hub/telegram/pi-webhook` (secret_token) | nastaven, 0 čekajících, bez chyb |
| Explicitní opt-in: zpráva v testovací skupině bez potvrzeného cíle | přijata, **0 uloženo** (0 cílů s PI) |
| Limit 2/min (deterministická funkce, 0 tokenů) | 200, 200, **429 `rate_limited`** |
| Denní strop 40 000 tokenů (rezervace ~81 000) | **429 `budget_exceeded`** před voláním modelu |
| Placené požadavky při aktivaci | **0** (ledger beze změny: 15 řádků Gemini celkem) |
| Nepilotní účet | hub/notify 403 (8 rout), AI 403 `ai_owner_only`, `aiOwner:false` |
| Prezentační účet | `aiOwner:true`, přepis řeči `false` |
| Osobní účet vlastníka | není v pilotu hubu (403) → nemůže připojit chaty ani mít PI nad chaty; jeho dřívější vlastnický přístup k AI (`AI_OWNER_USER_IDS`, RC1–RC5) beze změny |
| Etapa 1 | 2 osobní kanály aktivní, zkušební zprávy `sent`, 2 identity, Relay webhook OK, plánovače 120 běhů/h bez chyb |
| Google | Gmail náhled 200, Kalendář 19 událostí, Disk refresh OK; demo data 14 CSD / 154 úkolů / 51 odkazů / 14 Gmail zdrojů |
Rollback etapy 2: `OPERATIONS.md` (deaktivace) – ověřeno 2026-11-28 ráno.
