# ClearSpace V1 – roadmapa (stav k 2026-11-26, aktualizováno po RUN 05)

| RUN | Téma | Stav | Odkaz |
|---|---|---|---|
| RC1–RC5 | Intelligence, Monograph, odolnost AI, chyby příloh | **v produkci** (dnes součást buildu RUN 01) | `docs/intelligence/RELEASE_DECISION.md` |
| 00 | Demo data (dataset CSD-CORVANE, česky) | **hotovo v produkci**; kód seederu je na větvi `seed/run00-demo-data`, zatím mimo `main` | `docs/collaboration/RUN00_SEED_INTEGRATION.md` |
| 01 | Týmová spolupráce a realtime (role, přítomnost, živé úpravy, komentáře s @zmínkami, notifikace, pozvánky) | **PASS v rozsahu ověřených funkcí**, v produkci | `docs/collaboration/COLLABORATION.md`, `PRODUCTION_ROLLOUT.md` §11 |
| 01B | Zabezpečení a spolehlivost, pozvánky e-mailem | **hotovo, v produkci** | tamtéž |
| 01C | Produkční připravenost (Resend, nodemailer, rollout, DMARC, Monograph build) | **hotovo, v produkci** | `PRODUCTION_ROLLOUT.md` |
| **02** | **Google Drive Integration** (připojení účtu Google, Picker + `drive.file`, soubory u projektů a úkolů, realtime, aktivita, šifrované tokeny) | **dokončeno lokálně, tag `run02-complete`** (nepushnuto, nenasazeno): RUN 02B živě ověřeno proti skutečnému Googlu (dev projekt, režim Testing) včetně náhledu nativního Dokumentu, obnovy po přejmenování a **prokázané revokace u Googlu**; NOT VERIFIED: druhý Google účet, 7denní expirace refresh tokenu, odmítnutý souhlas naživo | `docs/run02/GOOGLE_DRIVE.md` §13–14, `docs/run02/PRODUCTION_ROLLOUT.md` |
| **02C** | **Production Rollout** Google Drive | **HOTOVO 2026-11-25, tag `run02c-complete`**: produkce `https://clearspace.luffast.com` (308 ze `clearspace-ai.vercel.app`), migrace 1200, Google projekt `clearspace-prod` v režimu **Testing = omezený pilot** (jen test users), živá akceptace vlastníka PASS; Monograph výchozí vzhled. Otevřené: výměna Picker API klíče (připraveno), veřejné publikování / ověření značky (samostatné rozhodnutí); NOT VERIFIED: druhý Google účet, 7denní expirace | `docs/run02/PRODUCTION_ACCEPTANCE.md` |
| **03** | **Gmail Integration** (inkrementální `gmail.readonly` vedle Disku, vlastní výběr e-mailů/konverzací, připojení k projektům a úkolům, soukromé zdroje + sdílená metadata, náhled jen pro vlastníka, realtime, aktivita bez předmětu, přepínač funkce) | **HOTOVO, tag `run03-complete`; v `main` a v produkci s Gmailem VYPNUTÝM (RUN 03C)**: mock tag `run03-mock-complete`; RUN 03B živá akceptace proti skutečnému Googlu (dev projekt, Testing) **PASS 20/20** vč. kritické brány zúžení Picker tokenu. Produkční Gmail **vypnutý** (rozhodnutí vlastníka; restricted scope) | `docs/run03/GMAIL.md`, `ARCHITECTURE_DECISION.md`, `LIVE_ACCEPTANCE.md` §E |
| 03B | Upstream merge `run02c-complete` + Gmail live acceptance (dev projekt, Testing) | **HOTOVO 2026-11-25** (PASS 20/20; NOT VERIFIED: druhý Google účet, Workspace blokace, 7denní expirace, odškrtnutí checkboxu) | `docs/run03/LIVE_ACCEPTANCE.md` §E |
| **03C** | Konsolidace do `main` + produkční nasazení s Gmailem vypnutým (migrace 1300 před kódem) | **HOTOVO 2026-11-25, tag `run03c-complete`**: `dpl_3wGY3njT…` z `e9aefbc`, produkční brány 110/110 + hosted 17/17, Gmail containment ověřen | `docs/run03/PRODUCTION_ACCEPTANCE.md` |
| později | **Veřejná syntetická ukázka Gmailu** pro návštěvníky portfolia (bez připojení vlastní schránky; syntetická schránka na serveru, jasně označená) | návrh, neimplementováno | `docs/run03/HANDOFF_NEXT_RUNS.md` |
| **04** | **Google Calendar** (inkrementální `calendar.events.owned.readonly` – sensitive; osobní vrstva v kalendáři projektu jen pro uživatele, připojení vlastních událostí k projektům a úkolům se sdílenými metadaty a soukromým zdrojem, soukromé události nelze připojit, realtime, aktivita bez názvu, přepínač) | **HOTOVO 2026-11-26, tag `run04-complete`; v `main` a v produkci s Kalendářem VYPNUTÝM** (`dpl_FeGsSgZx…`, migrace 1400): mock + DB + E2E PASS, **živá akceptace proti skutečnému Googlu PASS** (E1–E10 kromě NOT VERIFIED v LIVE_ACCEPTANCE §D), produkční brány 122/122 + hosted 18/18 | `docs/run04/CALENDAR.md`, `LIVE_ACCEPTANCE.md`, `PRODUCTION_ACCEPTANCE.md` |
| později | Produkční Kalendář (pilot v Testing / ověření – sensitive, bez CASA); Meeting Intelligence „porada z události“; Project Intelligence nad událostmi | rozhodnutí vlastníka / návrh | `docs/run04/HANDOFF_NEXT_RUNS.md`, `MEETING_INTELLIGENCE_COMPAT.md` |
| **05** | **Slack & Telegram** (oznámení mimo aplikaci: připojení/odpojení, šifrované údaje, přiřazení, připomínka termínu 09:00 Europe/Prague den předem, zmínky/komentáře/dokončení/změna termínu/členství, odkazy do ClearSpace, předvolby typů a projektů, režim bez názvů; outbox s idempotencí, retry, rate limitem; plánovač `pg_cron` + `pg_net` v DB) | **HOTOVO lokálně + v `main` a v produkci s oběma přepínači VYPNUTÝMI** (`dpl_Gp6omv6…`, migrace 1500, tag `run05-complete`): mock + DB + E2E + regrese PASS, produkční brány 147/147 + hosted 19/19; **živá akceptace BLOCKED** (čeká na owner block – dev Slack app + bot) | `docs/run05/NOTIFICATIONS.md`, `LIVE_ACCEPTANCE.md`, `PRODUCTION_ACCEPTANCE.md` |
| později | Živá akceptace Slack/Telegram (owner block) → rozhodnutí o zapnutí (pilot / veřejně); obousměrné zprávy, digesty, kanály – LATER | vlastník | `docs/run05/HANDOFF_NEXT_RUNS.md` |

## Kandidáti po RUN 02 (z known limitations a provozních poznatků; bez závazku)
* Webhooky Resend (stav *Delivered/Bounced* v `invitation_deliveries`) – dnes je znám jen „server převzal“.
* E-mailové pozvánky na úrovni workspace (Tým) – dnes kopírování odkazu.
* Zpřísnění DMARC `p=none` → `quarantine` po několika týdnech provozu; přísnější CSP s noncí (dnes úzká CSP, viz `next.config.ts`).
* Automatizace nasazení: skript pro staged build, který porovná `build.env` s předchozí produkcí (příčina chybějícího Monographu 2026-11-25).
* Začlenění RUN 00 seederu do `main` (rozhodnutí o UUID účtu v manifestu, viz plán).

## Technický dluh
* Viz `docs/TECH_DEBT.md` (TD-1, TD-2: dva známé E2E testy, které padají i na `run01-complete`).

## Poznámky z RUN 04
* Kalendář produkčně jen po rozhodnutí vlastníka (`docs/run04/PRODUCTION_ROLLOUT.md` §0); scope je sensitive → pilot v Testing bez ověření, veřejně ověření bez CASA.
* Picker token zůstává zúžený na Drive i s povoleným Gmailem a Kalendářem (živě ověřeno).
* Testovací události ve skutečném kalendáři vlastníka byly po akceptaci smazány; dev grant ClearSpace Dev revokován (revoke-check).

## Poznámky z RUN 03
* Gmail produkčně jen po rozhodnutí vlastníka (A nepublikovat / B Testing / C interní Workspace / D ověření + CASA): `docs/run03/PRODUCTION_ROLLOUT.md` §0.
* Drive Picker teď vždy dostává na Drive zúžený token – **živě ověřeno v 03B** (Google tokeninfo bez Gmailu, Gmail API 403).
* Project Intelligence: kontrakt `src/lib/resources/contract.ts` připraven, AI zpracování obsahu e-mailů vědomě neaktivní (souhlas + Limited Use).

## Poznámky z RUN 02
* Před nasazením RUN 02: Google Cloud (dev + prod projekt), rozhodnutí Testing vs. ověření značky (vlastní doména), migrace 1200 (`apply-drive-hosted.sh`).
* Napojení obsahu Drive do Project Intelligence je připravené rozhraním (`getTextContent`), ale vědomě neaktivované (placené AI volání + rozhodnutí o soukromí).
* Dva E2E testy z dřívějška padají i na `run01-complete` (AI brána owner-only 403 vs. očekávaných 400; test „neuložené karty“) – kandidát na úklid testů.

## Poznámky z RUN 05
* Slack/Telegram produkčně jen po živé akceptaci a rozhodnutí vlastníka (`docs/run05/PRODUCTION_ROLLOUT.md` §0–1); plánovač se zapíná ops skriptem, ne migrací.
* In-app notifikace beze změny (parita 1400 = 1500 ověřena v harness i na replice produkčního DDL).
