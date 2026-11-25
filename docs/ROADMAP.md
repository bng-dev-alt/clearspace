# ClearSpace V1 – roadmapa (stav k 2026-11-25, aktualizováno po RUN 02)

| RUN | Téma | Stav | Odkaz |
|---|---|---|---|
| RC1–RC5 | Intelligence, Monograph, odolnost AI, chyby příloh | **v produkci** (dnes součást buildu RUN 01) | `docs/intelligence/RELEASE_DECISION.md` |
| 00 | Demo data (dataset CSD-CORVANE, česky) | **hotovo v produkci**; kód seederu je na větvi `seed/run00-demo-data`, zatím mimo `main` | `docs/collaboration/RUN00_SEED_INTEGRATION.md` |
| 01 | Týmová spolupráce a realtime (role, přítomnost, živé úpravy, komentáře s @zmínkami, notifikace, pozvánky) | **PASS v rozsahu ověřených funkcí**, v produkci | `docs/collaboration/COLLABORATION.md`, `PRODUCTION_ROLLOUT.md` §11 |
| 01B | Zabezpečení a spolehlivost, pozvánky e-mailem | **hotovo, v produkci** | tamtéž |
| 01C | Produkční připravenost (Resend, nodemailer, rollout, DMARC, Monograph build) | **hotovo, v produkci** | `PRODUCTION_ROLLOUT.md` |
| **02** | **Google Drive Integration** (připojení účtu Google, Picker + `drive.file`, soubory u projektů a úkolů, realtime, aktivita, šifrované tokeny) | **implementováno lokálně, CONDITIONAL PASS po RUN 02B**: hlavní cesta ověřena proti **skutečnému Googlu** (dev projekt, režim Testing): OAuth, Picker, Drive API, obnova tokenu, připojení souborů, realtime, události, role; otevřené: náhled nativního Google Dokumentu, přejmenování+obnova, odmítnutý souhlas naživo, druhý Google účet; nenasazeno, nepushnuto | `docs/run02/GOOGLE_DRIVE.md`, `docs/run02/PRODUCTION_ROLLOUT.md` |
| 03 | Gmail & Email Intelligence | další; staví na sdíleném Google připojení (inkrementální autorizace) | `docs/run02/GOOGLE_DRIVE.md` §12 |
| 04 | Google Calendar | plánováno; stejný základ | tamtéž |

## Kandidáti po RUN 02 (z known limitations a provozních poznatků; bez závazku)
* Webhooky Resend (stav *Delivered/Bounced* v `invitation_deliveries`) – dnes je znám jen „server převzal“.
* E-mailové pozvánky na úrovni workspace (Tým) – dnes kopírování odkazu.
* Zpřísnění DMARC `p=none` → `quarantine` po několika týdnech provozu; přísnější CSP s noncí (dnes úzká CSP, viz `next.config.ts`).
* Automatizace nasazení: skript pro staged build, který porovná `build.env` s předchozí produkcí (příčina chybějícího Monographu 2026-11-25).
* Začlenění RUN 00 seederu do `main` (rozhodnutí o UUID účtu v manifestu, viz plán).

## Poznámky z RUN 02
* Před nasazením RUN 02: Google Cloud (dev + prod projekt), rozhodnutí Testing vs. ověření značky (vlastní doména), migrace 1200 (`apply-drive-hosted.sh`).
* Napojení obsahu Drive do Project Intelligence je připravené rozhraním (`getTextContent`), ale vědomě neaktivované (placené AI volání + rozhodnutí o soukromí).
* Dva E2E testy z dřívějška padají i na `run01-complete` (AI brána owner-only 403 vs. očekávaných 400; test „neuložené karty“) – kandidát na úklid testů.
