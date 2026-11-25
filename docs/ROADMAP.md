# ClearSpace V1 – roadmapa (stav k 2026-11-25, aktualizováno po RUN 02C a RUN 03)

| RUN | Téma | Stav | Odkaz |
|---|---|---|---|
| RC1–RC5 | Intelligence, Monograph, odolnost AI, chyby příloh | **v produkci** (dnes součást buildu RUN 01) | `docs/intelligence/RELEASE_DECISION.md` |
| 00 | Demo data (dataset CSD-CORVANE, česky) | **hotovo v produkci**; kód seederu je na větvi `seed/run00-demo-data`, zatím mimo `main` | `docs/collaboration/RUN00_SEED_INTEGRATION.md` |
| 01 | Týmová spolupráce a realtime (role, přítomnost, živé úpravy, komentáře s @zmínkami, notifikace, pozvánky) | **PASS v rozsahu ověřených funkcí**, v produkci | `docs/collaboration/COLLABORATION.md`, `PRODUCTION_ROLLOUT.md` §11 |
| 01B | Zabezpečení a spolehlivost, pozvánky e-mailem | **hotovo, v produkci** | tamtéž |
| 01C | Produkční připravenost (Resend, nodemailer, rollout, DMARC, Monograph build) | **hotovo, v produkci** | `PRODUCTION_ROLLOUT.md` |
| **02** | **Google Drive Integration** (připojení účtu Google, Picker + `drive.file`, soubory u projektů a úkolů, realtime, aktivita, šifrované tokeny) | **dokončeno lokálně, tag `run02-complete`** (nepushnuto, nenasazeno): RUN 02B živě ověřeno proti skutečnému Googlu (dev projekt, režim Testing) včetně náhledu nativního Dokumentu, obnovy po přejmenování a **prokázané revokace u Googlu**; NOT VERIFIED: druhý Google účet, 7denní expirace refresh tokenu, odmítnutý souhlas naživo | `docs/run02/GOOGLE_DRIVE.md` §13–14, `docs/run02/PRODUCTION_ROLLOUT.md` |
| **02C** | **Production Rollout** Google Drive | **HOTOVO 2026-11-25, tag `run02c-complete`**: produkce `https://clearspace.luffast.com` (308 ze `clearspace-ai.vercel.app`), migrace 1200, Google projekt `clearspace-prod` v režimu **Testing = omezený pilot** (jen test users), živá akceptace vlastníka PASS; Monograph výchozí vzhled. Otevřené: výměna Picker API klíče (připraveno), veřejné publikování / ověření značky (samostatné rozhodnutí); NOT VERIFIED: druhý Google účet, 7denní expirace | `docs/run02/PRODUCTION_ACCEPTANCE.md` |
| **03** | **Gmail Integration** (inkrementální `gmail.readonly` vedle Disku, vlastní výběr e-mailů/konverzací, připojení k projektům a úkolům, soukromé zdroje + sdílená metadata, náhled jen pro vlastníka, realtime, aktivita bez předmětu, přepínač funkce) | **HOTOVO lokálně, tag `run03-complete`** (nepushnuto, nenasazeno): mock tag `run03-mock-complete`; RUN 03B živá akceptace proti skutečnému Googlu (dev projekt, Testing) **PASS 20/20** vč. kritické brány zúžení Picker tokenu. Produkční Gmail **vypnutý** (rozhodnutí vlastníka; restricted scope) | `docs/run03/GMAIL.md`, `ARCHITECTURE_DECISION.md`, `LIVE_ACCEPTANCE.md` §E |
| 03B | Upstream merge `run02c-complete` + Gmail live acceptance (dev projekt, Testing) | **HOTOVO 2026-11-25** (PASS 20/20; NOT VERIFIED: druhý Google účet, Workspace blokace, 7denní expirace, odškrtnutí checkboxu) | `docs/run03/LIVE_ACCEPTANCE.md` §E |
| později | **Veřejná syntetická ukázka Gmailu** pro návštěvníky portfolia (bez připojení vlastní schránky; syntetická schránka na serveru, jasně označená) | návrh, neimplementováno | `docs/run03/HANDOFF_NEXT_RUNS.md` |
| 04 | Google Calendar | **další**; základ z RUN 02/03 ověřen živě | `docs/run03/HANDOFF_NEXT_RUNS.md` |

## Kandidáti po RUN 02 (z known limitations a provozních poznatků; bez závazku)
* Webhooky Resend (stav *Delivered/Bounced* v `invitation_deliveries`) – dnes je znám jen „server převzal“.
* E-mailové pozvánky na úrovni workspace (Tým) – dnes kopírování odkazu.
* Zpřísnění DMARC `p=none` → `quarantine` po několika týdnech provozu; přísnější CSP s noncí (dnes úzká CSP, viz `next.config.ts`).
* Automatizace nasazení: skript pro staged build, který porovná `build.env` s předchozí produkcí (příčina chybějícího Monographu 2026-11-25).
* Začlenění RUN 00 seederu do `main` (rozhodnutí o UUID účtu v manifestu, viz plán).

## Technický dluh
* Viz `docs/TECH_DEBT.md` (TD-1, TD-2: dva známé E2E testy, které padají i na `run01-complete`).

## Poznámky z RUN 03
* Gmail produkčně jen po rozhodnutí vlastníka (A nepublikovat / B Testing / C interní Workspace / D ověření + CASA): `docs/run03/PRODUCTION_ROLLOUT.md` §0.
* Drive Picker teď vždy dostává na Drive zúžený token – **živě ověřeno v 03B** (Google tokeninfo bez Gmailu, Gmail API 403).
* Project Intelligence: kontrakt `src/lib/resources/contract.ts` připraven, AI zpracování obsahu e-mailů vědomě neaktivní (souhlas + Limited Use).

## Poznámky z RUN 02
* Před nasazením RUN 02: Google Cloud (dev + prod projekt), rozhodnutí Testing vs. ověření značky (vlastní doména), migrace 1200 (`apply-drive-hosted.sh`).
* Napojení obsahu Drive do Project Intelligence je připravené rozhraním (`getTextContent`), ale vědomě neaktivované (placené AI volání + rozhodnutí o soukromí).
* Dva E2E testy z dřívějška padají i na `run01-complete` (AI brána owner-only 403 vs. očekávaných 400; test „neuložené karty“) – kandidát na úklid testů.
