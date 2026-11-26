# CS-GDEMO – demo data ve skutečném Google účtu + seeder

## Dataset (`frontend/scripts/google-demo/dataset.mjs`, CS-GDEMO 1.0.0)
Google strana fiktivního světa CSD-CORVANE (Corvane Systems, 14 projektů, tým z `demo-seed`). Persona **Alex Morgan, Account Director**.
* **Gmail:** 42 zpráv ve 14 vláknech (2–4 zprávy), přijaté (Doručená pošta, poslední 2 pracovní dny nepřečtené) i odeslané (podpis Alexe),
  2 přílohy CSV, čeština + angličtina u Tyrell / Yutani. Vlákna drží `In-Reply-To` / `References` + `threadId`.
* **Disk:** 7 složek (`Corvane Systems – projekty` / Yutani Logistics, Tyrell Systems, Hadley Park, Klienti, Corvane Flow, Interní),
  21 souborů: 13 Google Dokumentů (zadání, zápisy, nabídky, SoW, plány, release notes, briefy, šablona) a 8 Google Tabulek.
* **Kalendář:** 21 událostí: týdenní série (6×), celodenní milníky (go-live, vydání, dvoudenní audit), událost v pásmu America/Los_Angeles,
  servisní okno přes půlnoc, soukromá událost („Lékař“ – ClearSpace ji musí odmítnout), schůzky s hosty na rezervovaných doménách.
* Data jsou relativní ke kotvě (den seedování, pracovní dny) – demo vždy působí aktuálně. Diskrétní odkazy Alien / Blade Runner:
  Yutani, Tyrell, LV-426, Nostromo Park, Sevastopol Road, Gateway Yard, Tannhäuser, Nexus, zasedačky Sulaco / Narcissus / Bradbury.
* **Všechny adresy kromě demo účtu** jsou `example.com|org|net` nebo `*.example` (RFC 2606) – nic nemůže dorazit ke skutečnému člověku.
  Adresa demo účtu se doplní za běhu z **ověřeného** tokenu; v repozitáři není.

## Seeder (`frontend/scripts/google-demo/seed.mjs`, spouštěč `frontend/scripts/google-demo.sh`)
| Pravidlo | Jak |
|---|---|
| Oddělená oprávnění | vlastní **Desktop OAuth klient „ClearSpace Demo Seeder“** v `clearspace-dev`; scopy `openid email gmail.modify drive.file calendar.events.owned`. ClearSpace klient / jeho scopy se nemění; seeder odmítne běžet, má-li stejné client id jako ClearSpace |
| Jen ověřený demo účet | před **každým** zápisem: Google `tokeninfo` (audience = seeder, ověřený e-mail, scopy **přesně** sada seederu) + Gmail profil + Drive `about` == `demo_account` z Keychainu. Jinak „IDENTITY GUARD refused (nothing written)“ a při `auth` okamžitá revokace |
| Žádné e-maily ven | zprávy se **vkládají** (`messages.insert`), nic se neodesílá; události `sendUpdates=none`, hosté jen na rezervovaných doménách |
| Osobní data vlastníka | seeder nikdy nevidí jiný účet (ochrana identity); `drive.file` vidí jen soubory, které sám vytvořil |
| Idempotence | Gmail `Message-ID` `<cs-gdemo.<klíč>@corvane.example>` (hledání `rfc822msgid:`), Drive `appProperties.csdemo`, Kalendář deterministické `id` |
| Bezpečné odstranění | `cleanup --confirm CS-GDEMO`: Gmail → Koš, Disk → Koš, události smazány (vše obnovitelné ~30 dní); další `seed` obnoví z koše |
| Tajemství | client id / secret / demo účet / refresh token jen v Keychainu „ClearSpace V1 - Google demo seeder“ (skryté výzvy); nic v souborech / logu |

```bash
frontend/scripts/google-demo.sh setup             # jednou: client id, secret (skrytě), demo účet
frontend/scripts/google-demo.sh plan              # offline kontrola datasetu
frontend/scripts/google-demo.sh auth              # souhlas jako demo účet (30 min), ochrana identity, refresh token do Keychainu
frontend/scripts/google-demo.sh seed              # idempotentní; --only gmail,drive,calendar; --anchor YYYY-MM-DD
frontend/scripts/google-demo.sh status-google     # přítomno / v koši / duplicity
frontend/scripts/google-demo.sh cleanup --confirm CS-GDEMO
frontend/scripts/google-demo.sh revoke            # odvolá grant seederu u Googlu + smaže token
```

**Pořadí (povinné):** `auth` → `seed` → `status-google` → **`revoke`** → teprve pak připojovat ClearSpace. Google slučuje souhlasy po projektu;
dokud grant seederu žije, obrazovka ClearSpace hlásí „už má částečný přístup“ se zápisovými scopy seederu.

## Provedeno 2026-11-26 (skutečný demo účet)
* `auth`: identity guard PASS, scopy přesně 5. `seed`: Gmail 42 vytvořeno; Disk 27 + jedna chyba Googlu `500 Internal Error` při uploadu →
  opakovaný běh dorovnal (1 vytvořeno, 27 přítomno), **žádné duplicity**; Kalendář 21.
* 2. plný běh: 0 vytvořeno / 42 + 28 + 21 přítomno. `status-google`: `gmail 42/42 (0 v koši, 0 duplicit), drive 21/21 (0 duplicit), calendar 21/21`.
* `revoke`: Google 200, token smazán. Kontrola: další souhlasová obrazovka ClearSpace už „částečný přístup“ neukazovala.
* Gmail demo účtu (prohlížeč): vlákna se zobrazují správně („Elena, já, Rafael 3“), čeština bez chyb.

## Omezení
* `cleanup` / obnova z koše ověřeny jen proti fiktivnímu Googlu (`seed.test.mjs`) – na demo účtu jsme nic nemazali.
* Seeder neopakuje 5xx sám (`ponytail:` záměr) – idempotentní opakování celého běhu to řeší.
* Refresh token seederu v Testing režimu vyprší po 7 dnech; po `revoke` je třeba `auth` znovu.
