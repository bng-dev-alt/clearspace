# ClearSpace V1 – roadmapa (stav k 2026-11-25, aktualizováno po RUN 02)

| RUN | Téma | Stav | Odkaz |
|---|---|---|---|
| RC1–RC5 | Intelligence, Monograph, odolnost AI, chyby příloh | **v produkci** (dnes součást buildu RUN 01) | `docs/intelligence/RELEASE_DECISION.md` |
| 00 | Demo data (dataset CSD-CORVANE, česky) | **hotovo v produkci**; kód seederu je na větvi `seed/run00-demo-data`, zatím mimo `main` | `docs/collaboration/RUN00_SEED_INTEGRATION.md` |
| 01 | Týmová spolupráce a realtime (role, přítomnost, živé úpravy, komentáře s @zmínkami, notifikace, pozvánky) | **PASS v rozsahu ověřených funkcí**, v produkci | `docs/collaboration/COLLABORATION.md`, `PRODUCTION_ROLLOUT.md` §11 |
| 01B | Zabezpečení a spolehlivost, pozvánky e-mailem | **hotovo, v produkci** | tamtéž |
| 01C | Produkční připravenost (Resend, nodemailer, rollout, DMARC, Monograph build) | **hotovo, v produkci** | `PRODUCTION_ROLLOUT.md` |
| **02** | **Google Drive Integration** (připojení účtu Google, Picker + `drive.file`, soubory u projektů a úkolů, realtime, aktivita, šifrované tokeny) | **dokončeno lokálně, tag `run02-complete`** (nepushnuto, nenasazeno): RUN 02B živě ověřeno proti skutečnému Googlu (dev projekt, režim Testing) včetně náhledu nativního Dokumentu, obnovy po přejmenování a **prokázané revokace u Googlu**; NOT VERIFIED: druhý Google účet, 7denní expirace refresh tokenu, odmítnutý souhlas naživo | `docs/run02/GOOGLE_DRIVE.md` §13–14, `docs/run02/PRODUCTION_ROLLOUT.md` |
| **02C** | **Production Rollout** Google Drive (vlastní doména `clearspace.luffast.com`, produkční Google projekt, migrace 1200, staged build, živá akceptace) | **příprava hotová, tag `run02c-ready`** (nácvik migrace na replice produkce PASS, regresní brána PASS, zásady + homepage, skripty); **čeká na souhrnné schválení a Google Cloud kroky vlastníka**; produkce beze změny | `docs/run02/PRODUCTION_ACCEPTANCE.md` |
| 03 | Gmail & Email Intelligence | další; staví na sdíleném Google připojení (inkrementální autorizace) | `docs/run02/GOOGLE_DRIVE.md` §12, `docs/run02/HANDOFF_NEXT_RUNS.md` |
| 04 | Google Calendar | plánováno; stejný základ | tamtéž |

## Kandidáti po RUN 02 (z known limitations a provozních poznatků; bez závazku)
* Webhooky Resend (stav *Delivered/Bounced* v `invitation_deliveries`) – dnes je znám jen „server převzal“.
* E-mailové pozvánky na úrovni workspace (Tým) – dnes kopírování odkazu.
* Zpřísnění DMARC `p=none` → `quarantine` po několika týdnech provozu; přísnější CSP s noncí (dnes úzká CSP, viz `next.config.ts`).
* Automatizace nasazení: skript pro staged build, který porovná `build.env` s předchozí produkcí (příčina chybějícího Monographu 2026-11-25).
* Začlenění RUN 00 seederu do `main` (rozhodnutí o UUID účtu v manifestu, viz plán).

## Technický dluh
* Viz `docs/TECH_DEBT.md` (TD-1, TD-2: dva známé E2E testy, které padají i na `run01-complete`).

## Poznámky z RUN 02
* Před nasazením RUN 02: Google Cloud (dev + prod projekt), rozhodnutí Testing vs. ověření značky (vlastní doména), migrace 1200 (`apply-drive-hosted.sh`).
* Napojení obsahu Drive do Project Intelligence je připravené rozhraním (`getTextContent`), ale vědomě neaktivované (placené AI volání + rozhodnutí o soukromí).
* Dva E2E testy z dřívějška padají i na `run01-complete` (AI brána owner-only 403 vs. očekávaných 400; test „neuložené karty“) – kandidát na úklid testů.
