# ClearSpace V1 – roadmapa (stav k 2026-11-28, aktualizováno po RUN 10)

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
| 06 | Google demo + pilot (Gmail/Kalendář pro prezentujícího + demo účet) | **v produkci** (pilot) | `docs/run06/` |
| **07** | **Project Communication Hub** (projekt ↔ vybrané Slack kanály a Telegram skupiny: propojení kódem + potvrzení, oznámení se souhrny, úkol ze zprávy, synchronizace vlákna ↔ komentáře, identita, záložka Komunikace, PI opt-in se zdrojem `comm:`, demo simulace) | **merge-ready lokálně, tag `run07-mock-complete`** (nepushnuto, nenasazeno, produkce beze změny); mock/DB/HTTP/E2E + zkouška na replice produkce PASS; **živá akceptace BLOCKED** (owner block: staging s veřejným HTTPS, Slack app, bot) | `docs/run07/HANDOFF.md`, `ACCEPTANCE.md`, `PRODUCTION_ROLLOUT.md` |
| **07B** | Hardening hubu (odolný inbox, souběh, identita zahajovaná v ClearSpace, volitelný PI bot pro Telegram, permalinky, „Ověřit znovu“, 13 nálezů bezpečnostní revize) + konsolidace | **v `main`** (tag `run07b-hardening-complete`), **produkce beze změny** (migrace 1600 + 1700 nacvičené na produkčním DDL); kompletní regrese PASS; **živá akceptace BLOCKED** (owner block: boti, Slack app, pojmenovaný tunel) | `docs/run07b/README.md`, `OWNER_BLOCK.md` |
| 08 / 08B | Živá akceptace hubu (dev, tunel) + plán pilotu | **hotovo** (lokálně, skuteční poskytovatelé) | `docs/run08/RUN08B.md` |
| **09** | **Communication Hub – produkční release, etapa 1** (Slack + Telegram, osobní oznámení, pilot jen prezentační účet) | **HOTOVO 2026-11-28, tag `run09-complete`**: etapa 1 v produkci (`dpl_EfUg58JQ…`, pilot = prezentační účet), živá akceptace PASS; etapa 2 Gemini test PASS (6 req, ≤ 0,05 USD) a od 28. 11. **trvale aktivní** pro prezentační účet (40k tokenů/den, 2/min); 14 Gmail vláken obnoveno; credential cleanup; ADR rozdělení účtů | `docs/run09/README.md`, `ACCOUNTS_ADR.md` |
| **10** | **Meeting Intelligence** (plánované/ad-hoc porady, pozvaní, Google Kalendář + Meet, živý přepis prohlížeč ⇄ Soniox s rezervací a dočasným klíčem, PI zdroj porad) | **v produkci s vypnutými přepínači** (`dpl_FZMYZjkv…`, migrace 1800); mock + DB + E2E + regrese PASS; **živá akceptace BLOCKED** (jediný owner block: Soniox/Gemini placený test, OAuth scope, relace s druhým účastníkem) | `docs/run10/README.md`, `OWNER_BLOCK.md` |
| run10-live | RUN 10 živá akceptace + hardening (mikrofon, zrušení, stavy, kontrast) | hotovo 2026-11-28, zbývá Gemini část po obnově denního limitu | `docs/run10/ACCEPTANCE.md` |
| freeze | **Feature freeze V1** | platí od RUN 10 (výjimky vlastníka: #15, #16 v RUN 11) | `docs/run10/README.md` §Handoff |
| **11** | **Global UX/UI polish** – sdílené primitivy (potvrzení, kopírování, stavová hlášení, focus dialogů), pravdivé stavy (bez falešných přepínačů a hodnot), Propojené účty, porady v Classic, #15/#16, přístupnost, responzivita | viz `docs/run11/README.md` (stav nasazení a verdikt) | `docs/run11/` |
| 12 | Final Security & Architecture Audit (model Fable, důraz RUN 08–10) | další | – |
| později (LATER z RUN 07) | Plnohodnotní klienti chatu, kontakty, soukromé konverzace, celoworkspace indexace, historický import, hovory, zrcadlení souborů, autonomní AI odpovědi, další poskytovatelé (Teams, Discord, e-mail), volitelný ingest bot pro Telegram, přehled kanálů pro výběr (`channels:read`) | návrh | `docs/run07/DECISIONS.md` |

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

## RUN 06 (2026-11-26, větev `feature/google-demo-pilot`, nenasazeno)
* Google demo účet naplněn datasetem CS-GDEMO (Gmail / Disk / Kalendář), seeder s vlastním OAuth klientem a ochranou identity.
* Pilotní režim `=pilot` pro Gmail a Kalendář; živá akceptace s demo účtem PASS; produkční pilot = návrh k rozhodnutí (`docs/run06/`).

## Poznámky z RUN 05
* Slack/Telegram produkčně jen po živé akceptaci a rozhodnutí vlastníka (`docs/run05/PRODUCTION_ROLLOUT.md` §0–1); plánovač se zapíná ops skriptem, ne migrací.
* In-app notifikace beze změny (parita 1400 = 1500 ověřena v harness i na replice produkčního DDL).

## Školení
* Závěrečné produktové školení: `docs/training/` (modul 3 Komunikační hub hotový – Slack aplikace, HQ, Relay, Cortex, párování, demo scénáře).
