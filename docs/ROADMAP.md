# ClearSpace V1 – roadmapa (stav k 2026-11-25)

| RUN | Téma | Stav | Odkaz |
|---|---|---|---|
| RC1–RC5 | Intelligence, Monograph, odolnost AI, chyby příloh | **v produkci** (dnes součást buildu RUN 01) | `docs/intelligence/RELEASE_DECISION.md` |
| 00 | Demo data (dataset CSD-CORVANE, česky) | **hotovo v produkci**; kód seederu je na větvi `seed/run00-demo-data`, zatím mimo `main` | `docs/collaboration/RUN00_SEED_INTEGRATION.md` |
| 01 | Týmová spolupráce a realtime (role, přítomnost, živé úpravy, komentáře s @zmínkami, notifikace, pozvánky) | **PASS v rozsahu ověřených funkcí**, v produkci | `docs/collaboration/COLLABORATION.md`, `PRODUCTION_ROLLOUT.md` §11 |
| 01B | Zabezpečení a spolehlivost, pozvánky e-mailem | **hotovo, v produkci** | tamtéž |
| 01C | Produkční připravenost (Resend, nodemailer, rollout, DMARC, Monograph build) | **hotovo, v produkci** | `PRODUCTION_ROLLOUT.md` |
| **02** | **Google Drive Integration** | **další**; handoff připraven | `docs/run02/GOOGLE_DRIVE_HANDOFF.md` |

## Kandidáti po RUN 02 (z known limitations a provozních poznatků; bez závazku)
* Webhooky Resend (stav *Delivered/Bounced* v `invitation_deliveries`) – dnes je znám jen „server převzal“.
* E-mailové pozvánky na úrovni workspace (Tým) – dnes kopírování odkazu.
* Zpřísnění DMARC `p=none` → `quarantine` po několika týdnech provozu; přísnější CSP s noncí (dnes úzká CSP, viz `next.config.ts`).
* Automatizace nasazení: skript pro staged build, který porovná `build.env` s předchozí produkcí (příčina chybějícího Monographu 2026-11-25).
* Začlenění RUN 00 seederu do `main` (rozhodnutí o UUID účtu v manifestu, viz plán).
