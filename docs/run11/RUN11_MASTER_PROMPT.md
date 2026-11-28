# MASTER PROMPT – ClearSpace V1 RUN 11: Global UX/UI Polish

**Doporučený model: Claude Opus 5.5** (audit celé aplikace, průřezové změny UI, produkční nasazení). Sonnet jen pokud se fáze D dělí na dávky.
Komunikuj česky. TRUTH MODE (odlišuj OVĚŘENO / PŘEDPOKLAD / DOPORUČENÍ) a SCOPE MODE (žádné nové funkce).

---

## 0. Kontext a vstupy (přečti nejdřív)
Repo `/Volumes/WORKSPACE/Dev/Apps/ClearSpace/V1`, `main` = `e8f0625` (tag `run10-closed`), produkce `dpl_FwWirB1MSS4hA7Mig8Rp67t92pia` (kód `c468e2e`).
V1 je ve feature freeze. Povinné vstupy:
- `docs/run11/RUN11_INVENTORY.md` – výchozí inventura, kategorie M/S/LATER/DONE/O a metriky konzistence (výchozí bod, ne dogma – ověř).
- `docs/run09/UX_BACKLOG.md` (#1–22), `docs/TECH_DEBT.md` (TD-1–3 + UX poznámky RUN 03–10), `docs/run10/README.md` §Handoff.
- `ClearSpace_Design_Bible_v1.0.md`, `DESIGN_PLAN.md`, `docs/monograph/MONOGRAPH_INTEGRATION.md`, reviews `40–57`.
- `frontend/AGENTS.md`, `docs/LOCAL_DEV.md` (DEV LOGIN STANDARD, stack pravidla), `docs/run09/ACCOUNTS_ADR.md`, `docs/run10/OPERATIONS.md`.

## 1. Cíl
Z funkčně rozsáhlé aplikace udělat konzistentní, srozumitelný a prezentovatelný produkt (HR, hiring manager, technik, klient).
Polish, ne redesign: zachovej architekturu, design system, Classic + Monograph, light + dark, lokalizaci, oprávnění, integrace, AI rozpočty, demo data.
Preferuj **systémové opravy** (jeden primitiv/token opraví desítky míst) před izolovanými záplatami. Každá změna má jasný uživatelský přínos.

## 2. Tvrdé hranice
- Žádné nové funkce kromě podmíněných S13 (#15) a S14 (#16); #18 a ostatní LATER zůstávají LATER. Žádná nová UI/design knihovna ani nový design system;
  existující primitivy `components/ui/` a `.cs-*` rozšiř minimálně. **Žádná mechanická náhrada** inline stylů/holých tlačítek kvůli statistikám –
  každá změna musí mít prokazatelný přínos a nesmí přinést zbytečnou regresi.
- Nesluč experimentální větve (artform, obsidian-gold, system-01, tactile, archive-os, …). Nesahej na ClearSpace V2.
- Bezpečnost beze změny: RLS, projektová oprávnění, serverová autorizace, OAuth scope, izolace účtů (ADR RUN 09-01), kill switche, Vercel firewall,
  Soniox 30 min/den jen prezentační účet, Gemini 40 000 tokenů/den, veřejné demo bez placených služeb, Docker loopback ochrana.
- **Žádná placená volání** Soniox/Gemini – vlastník nové placené testy **neschválil**. Testy jen MOCK + `GEMINI_MODEL=fake-gemini`; co tím ověřit nejde,
  označ NOT VERIFIED.
- Nemaž cizí soubory (`DEMO/`, `frontend/test_intro.mp4`), žádný `docker system prune`, nezastavuj cizí služby. Supabase CLI jen přes `<stack>.sh sb|reset`.
- Testy neupravuj jen proto, aby prošly. Každou změnu testu označ: (a) legitimní změna UI, (b) zastaralé očekávání (TD), (c) oprava chyby.
- Lokální aplikace vždy s jedním odkazem `?login=auto` (nikdy po vlastníkovi nechtěj přihlášení).

## 3. Postup

### Fáze A – Baseline (read-only)
1. Ověř Git (`main`, tagy, worktree) a produkci (Vercel: aktuální deployment = `dpl_FwWirB1M…`, `check-deployment.sh` bez placených volání).
2. Vytvoř worktree `V1-run11` (APFS klon `node_modules` přes `cp -cR`, ne symlink; doplň `nodemailer`, pokud chybí) na větvi `polish/run11` z `main`.
3. Spusť baseline: `npm run lint`, `npx vitest run`, Playwright (stack režim + demo režim, viz TECH_DEBT), `npm run build`, `check-production-bundle.sh`.
   Zaznamenej přesné výsledky (očekávané známé pády: TD-1, TD-2, TD-3).
4. Spusť lokální stack s demo daty (`meetings-stack.sh` / `collab-stack.sh app`) a projdi v prohlížeči hlavní workflow:
   board → detail úkolu (checklist, komentář, příloha, termín, priorita, přiřazení, drag & drop, filtry) → projekt/dashboard → kalendář → tým/pozvánky/role →
   nastavení/Propojené účty → Drive/Gmail/Kalendář (mock) → Komunikace/hub (párování, kopírování) → Cortex/PI chat (fake-gemini, citace, limit, chyba) →
   porady (plán, Meet, mikrofon test, živý přepis MOCK, pauza/konec/zrušení, revize, analýza, schválení úkolu, smazání) → AI Control Center/historie → login/registrace/pozvánka.
5. Screenshoty výchozího stavu do `docs/run11/screens/before/` (existující `monograph-shots.mjs` rozšiř, nepiš nový nástroj):
   ~12 klíčových obrazovek × Classic/Monograph × light/dark při 1440; navíc 1024, 768, 375 pro board, detail úkolu, nastavení, porady.
6. A11y baseline: `monograph-contrast.mjs`, `monograph-keyboard.mjs`, ruční kontrola focusu, Esc/návrat focusu v dialozích, přístupné názvy,
   `prefers-reduced-motion`, zoom 200 %, horizontální overflow, dlouhé názvy (projekt/úkol/kanál 80+ znaků).
7. Výkon/UX dluh: vizuální skoky (CLS), blikání při realtime, duplicitní požadavky (network log), zastaralé stavy po síťovém výpadku (offline v DevTools).

### Fáze B – Registr nálezů
`docs/run11/AUDIT.md`: tabulka `ID | obrazovka/modul | popis | závažnost | četnost | systémová příčina | návrh | odkaz na screenshot | zdroj (backlog/nový)`.
Závažnost: **S1** zavádějící/falešný stav, ztráta dat, nedokončitelná operace, blokuje prezentaci · **S2** matoucí, nekonzistentní napříč moduly, a11y porušení ·
**S3** kosmetika. Seskup do **systémových příčin** (chybějící primitiv, token, breakpoint, stavová logika, texty). Ověř každou položku z inventury:
platí / už hotovo / neplatí. Nic nevymýšlej bez důkazu (screenshot, řádek kódu, krok reprodukce).

### Rozhodnutí vlastníka platná od začátku (2026-11-28)
- O1 schváleno: redesign Propojených účtů **uvnitř `/settings`**, návrh obrazovky jde do checkpointu (fáze C).
- Sjednotit systémově: potvrzovací dialogy, kopírování, stavová hlášení, chybové stavy, loading/empty, tlačítka a varianty, a11y a focus management.
- Mobil (bez samostatné aplikace) musí být použitelný pro: procházení projektů, běžnou správu úkolů, komentáře, přehled porad, dokumenty,
  notifikace, AI výstupy (dle dostupnosti účtu). Živý přepis jen ověřené desktopové prohlížeče; jinde jasné vysvětlení omezení.
- #15 → S13 jen jako seskupení/filtr existujících dat; #16 → S14 jen jako prezentační režim existující komponenty bez nové audio architektury.
  Pokud vyžadují nečekaně rozsáhlé změny, zdokumentuj důvod a ponech v backlogu. #18 LATER.
- TD-3: nejdřív ověř, že dva záznamy aktivity jsou legitimní chování; teprve pak uprav test.
- O7 schváleno: produkční nasazení po splnění všech akceptačních kritérií, kompletní regresi a staged kontrolách – bez dalšího stopu.
- `V1-run10` smazat jen po ověření (ne aktivní worktree, žádná unikátní nezálohovaná práce, žádné soubory vlastníka, žádné běžící procesy,
  výsledky zachované). `DEMO/` a `test_intro.mp4` nedotčené.

### Fáze C – Jediný schvalovací bod (STOP)
Předlož vlastníkovi **jeden** balík `docs/run11/DECISIONS.md` a v chatu krátké shrnutí:
- prioritizovaný seznam k implementaci (MUST + vybrané SHOULD) s akceptačními kritérii a odhadem rozsahu,
- návrh obrazovky Propojených účtů (O1: wireframe/screenshot) a další zásadní UX rozhodnutí z auditu, každé s doporučením,
- otevřená rozhodnutí (O2 a nové), rozsah S13/S14,
- co navrhuješ odložit a proč.
(O7 – nasazení – je už schváleno.)
Po schválení pracuj autonomně; běžná rozhodnutí jen dokumentuj v `DECISIONS.md`. Znovu se zastav jen u změny navigační architektury nebo
chování klíčového workflow, které schválení nepokrylo.

### Fáze D – Implementace (worktree `V1-run11`, větev `polish/run11`)
Pořadí podle systémových příčin, každá dávka = samostatný commit s testy:
1. Primitivy: `ConfirmDialog` (nad `ModalShell`, nahradí 14× `confirm()`), `CopyButton` (jednotné „Zkopírováno“ + `aria-live`), status/toast pro ukládání a chyby
   (bez knihovny), sjednocení dialogů mimo `ModalShell` (focus trap, Esc, návrat focusu).
2. Tokeny a layout: hex → tokeny, navbar 1024–1140 px (Classic), formulářové prvky porad (radio/select/meter), viditelné nejednotnosti tlačítek.
3. Stavová poctivost: Slack „nainstalováno“, ověření bota při propojení kanálu, výrazné „Propojeno ✓“, zkušební zpráva vs. oznámení, nabídka „Interaktivní“,
   porady (Analyzovat jen s přepisem, „Uplynulý termín“, „z toho zrušeno“), hlášky limitů AI/STT.
4. Propojené účty (dle O1).
5. Texty a mikrocopy (čeština, prázdné stavy s dalším krokem, chyby srozumitelné běžnému uživateli).
6. Testový dluh: TD-3 (+ TD-1/TD-2 dle schválení), `GEMINI_MODEL=fake-gemini` ve skriptu stacku.
Nepřidávej tooltipy, badge, gradienty, dekorativní karty ani animace bez funkce. Respektuj `prefers-reduced-motion`.

### Fáze E – Regrese a akceptace
- `lint`, `vitest` (počet ≥ baseline), Playwright oba režimy, nové UX regresní testy pro každou M-položku (stav, ne pixel),
  `monograph-regression.mjs`, `monograph-contrast.mjs`, `monograph-keyboard.mjs`, `build`, `check-production-bundle.sh`.
- Screenshoty po změně do `docs/run11/screens/after/` ve stejné matici; `docs/run11/BEFORE_AFTER.md` s párovým porovnáním.
- Ověření, že bezpečnostní a nákladové pojistky beze změny (bezplatné sondy jako v RUN 09/10: 429 na limit, kill switche, pilotní allowlisty).
- `docs/run11/ACCEPTANCE.md`: každé akceptační kritérium → PASS / FAIL / NOT VERIFIED s důkazem.

### Fáze F – Řízené nasazení (O7 schváleno; jen pokud je E celé zelené)
Merge `polish/run11` → `main` (fast-forward nebo merge commit), push, tag `run11-complete`. Staged deploy přes `deploy-drive-staged.sh` z **čistého** worktree,
`check-deployment.sh`, `monograph-prodcheck.mjs`, ruční kontrola produkce prezentačním účtem bez placených volání. Rollback = promote `dpl_FwWirB1M…`
(žádné migrace DB v RUN 11 → rollback je čistě kódový; pokud by migrace byla nutná, je to STOP). Zapiš nový deployment id.

### Fáze G – Dokumentace, úklid, report
- Aktualizuj `docs/TECH_DEBT.md`, `docs/ROADMAP.md`, `docs/run09/UX_BACKLOG.md` (stav každé položky), `docs/training/` (moduly 1–5: nové UX
  v praktických scénářích; školicí aplikaci nevytvářej), `docs/run11/README.md`.
- Úklid dle globálního pravidla: zastav všechny své servery, mocky, stacky (`supabase stop` bez `--no-backup`), odstraň worktree `V1-run11` po merge.
  Mazání datových zdrojů a starých worktree jen jako **jeden** konsolidovaný seznam ke schválení.

## 4. Výstup (závěrečný report v chatu + `docs/run11/README.md`)
Git stav (commity, tagy), produkční deployment id + rollback, kompletní audit a prioritizovaný backlog, provedené opravy (ID → commit),
odložené položky s důvodem, změněné komponenty a tokeny, before/after, výsledky všech testů s přesnými čísly (baseline vs. po),
a11y výsledky, zbývající technický dluh, NOT VERIFIED položky, reálné náklady (očekáváno 0 USD) a **jednoznačný GO / NO-GO**.

## 5. Mimo scope
RUN 12 Security & Architecture Audit (samostatný run, model Fable, důraz RUN 08–10), RUN 13 Multi-user & Product Acceptance, portfolio, Product Training Hub, simulované pohovory,
finální release, archivace V2. Nezahajuj.
