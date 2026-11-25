# ClearSpace V1 – plán konsolidace větve `feature/run01-collaboration` do `main`

Stav (2026-11-25): **jen plán. Nic nebylo mergnuto ani pushnuto.** Každý příkaz níže, který mění Git na serveru nebo ve vašem checkoutu `V1`,
čeká na vaše výslovné schválení.

## 1. Zjištěný stav (jen čtení)

| Položka | Zjištění |
|---|---|
| Vzdálený repozitář | `origin` = `github.com/bng-dev-alt/clearspace`; **jediná větev na serveru je `main`** na `5c80dcf` (ověřeno `git ls-remote` 2026-11-25; beze změny od posledního fetche v červenci) |
| Lokální `main` (checkout `V1`) | `ff615c3`, **71 commitů za `origin/main`** (zastaralý) |
| Větev `feature/run01-collaboration` | `f1731b7` (+ commit s tímto plánem): **49 commitů před `origin/main`, 0 za** → publikace je čistý *fast-forward*, bez merge commitu a bez konfliktů |
| Co větev obsahuje | vše, co dnes běží v produkci: Intelligence RC1–RC5 (`12f7738`, předchozí produkce), Monograph, RUN 01/01B/01C. Starší větve (`release/rc2-monograph`, `feature/intelligence-v2`, `integration/monograph-clearspace`) jsou její předci, takže jejich historie se zachová |
| Shoda s produkcí | produkce = build `78c2b7b`; od něj se změnily jen 4 soubory v docs/e2e/scripts, **žádný zdrojový kód, balíčky ani konfigurace** |
| Ochrana proti nasazení z Gitu | `frontend/vercel.json` = `{"git":{"deploymentEnabled":false}}` je v HEAD i v dnešním `origin/main`. Push do `main` proto **nevytvoří nasazení** (ověřeno v R1, 2026-11-17); nasazuje se jen přes CLI |
| Branch protection | `main` není chráněná (GitHub API: 404 „Branch not protected“) → přímý push je technicky možný |
| Sken tajemství | přidané řádky `origin/main..HEAD` (240 souborů, +13 387/−1 083): žádný klíč Supabase/Resend/Gemini, JWT, privátní klíč ani heslo v URL; žádný sledovaný `.env*` |
| Ostatní worktrees | všechny čisté **kromě** `V1` (a `V1-editorial`: jen nesledovaná složka `Screens/`) |

### Nesouvisející neuložené změny v `V1` (12 položek) – proč se v `V1` nic nemergne

* Upraveno (sledované): `frontend/CLAUDE.md` (vaše pravidla pro rozsah kontextu), `frontend/eslint.config.mjs` (ignoruje `scripts/**`),
  `frontend/next.config.ts` (`allowedDevOrigins` pro `clearspace-origin.luffast.com`), `frontend/src/__tests__/invite-members.test.tsx`
  (stejný obsah už ve větvi je).
* Nesledované: `CLEARSPACE_E2E_VALIDATION_REVIEW.md`, `CLEARSPACE_LOCAL_LAUNCHER_REVIEW.md`, `CLEARSPACE_PROJECT_AUDIT.md`, `DEMO/` (14 MB videí),
  `Start_ClearSpace.command`, `scripts/runtime/*`, `frontend/scripts/build_presentation_video.js`, `frontend/scripts/copy_demo_videos.js`, `frontend/test_intro.mp4` (0 B).
* **Kolize:** tři upravené soubory se mění i ve větvi (`CLAUDE.md`, `eslint.config.mjs`, `next.config.ts` – jiný obsah) a dva nesledované
  (`scripts/runtime/clearspaceoriginctl`, `…plist`) by přepsal checkout. Fast-forward ve `V1` by se proto zastavil; nic by se nepřepsalo, ale
  hrozí, že si někdo pomůže `--force`/`reset --hard` a vaše práce zmizí.
* **Záchranný snímek (pořízen 2026-11-25, `V1` nezměněn):** `/Volumes/WORKSPACE/_G2_BACKUP/20261125-v1-uncommitted-main-checkout/`
  (`tracked-changes.patch`, `untracked-files.tgz` 13 MB / 37 položek, `status.txt`, `base-commit.txt`, `SHA256SUMS`).

## 2. Doporučený postup (dvě oddělené fáze)

**Zásada:** publikace na server se dělá z čistého worktree `V1-collab`, ne z `V1`. `V1` se při tom vůbec nedotkne.

### Fáze A – publikace na `origin/main` (po vašem schválení; doporučuji až po živém akceptačním testu pozvánek)

1. **Brány (vše musí platit, jinak STOP):**
   ```bash
   cd /Volumes/WORKSPACE/Dev/Apps/ClearSpace/V1-collab
   test -z "$(git status --short)" && echo "strom je čistý"
   git ls-remote --heads origin main                      # musí být 5c80dcfef0113b1988d48a8b55d6b8ecd7409530
   git fetch origin main && git merge-base --is-ancestor origin/main HEAD && echo "fast-forward je možný"
   git diff --name-only 78c2b7b HEAD -- frontend/src frontend/package.json frontend/package-lock.json frontend/next.config.ts frontend/vercel.json | wc -l   # musí být 0
   git show HEAD:frontend/vercel.json                     # musí obsahovat "deploymentEnabled": false
   ```
2. **Pojistka zpět:** `git tag pre-collab-main 5c80dcf` (lokální značka na dnešní vzdálený `main`).
3. **Publikace (fast-forward, bez `--force`; selže, pokud se vzdálený `main` mezitím pohnul):**
   ```bash
   git push origin feature/run01-collaboration:main
   git push origin collab-prod-2026-11-25                 # volitelně: značka produkčního nasazení
   ```
   Pozor: větev `feature/run01-collaboration` se tím **nepublikuje** jako samostatná větev; na serveru zůstane jen `main`.
4. **Ověření po pushi:**
   * `git ls-remote --heads origin main` = SHA pushnutého commitu;
   * Vercel: **žádné nové nasazení** (poslední produkční zůstává `dpl_7RtvpN81…`, `vercel ls clearspace` / API `/v6/deployments`);
   * `curl -s -o /dev/null -w '%{http_code}' https://clearspace-ai.vercel.app/login` = 200, `check-deployment.sh` PASS.
5. **Návrat (jen kdyby se Git stav na serveru pokazil; produkce tím není dotčena):**
   `git push origin pre-collab-main:main --force-with-lease=main:<nový SHA>` – potřebuje zvláštní schválení.

### Fáze B – synchronizace vašeho checkoutu `V1` (až budete chtít; provádíte vy nebo já po vašem pokynu)

Cíl: lokální `main` ve `V1` posunout na `origin/main`, **aniž se ztratí vaše neuložené změny**.

1. Snímek už existuje (viz výše). Ověřte `shasum -a 256 -c SHA256SUMS` v jeho složce.
2. Vaše práci uložte na vlastní větev (nic se neztratí, nic nejde na server):
   ```bash
   cd /Volumes/WORKSPACE/Dev/Apps/ClearSpace/V1
   git switch -c wip/v1-local-20261125
   git add frontend/CLAUDE.md frontend/eslint.config.mjs frontend/next.config.ts frontend/src/__tests__/invite-members.test.tsx \
           CLEARSPACE_*.md Start_ClearSpace.command scripts/runtime frontend/scripts/build_presentation_video.js frontend/scripts/copy_demo_videos.js
   git commit -m "wip: lokální změny z checkoutu V1 (launcher, tunel, review)"
   ```
   `DEMO/` (14 MB videí) a prázdný `frontend/test_intro.mp4` nedávejte do Gitu; nechte je ležet, nebo je přesuňte mimo repozitář / přidejte do `.git/info/exclude`.
3. Posun `main`:
   ```bash
   git switch main && git fetch origin && git merge --ff-only origin/main
   ```
   (Po kroku 2 už nic nekoliduje: upravené soubory jsou v commitu na `wip/…` a nesledované kopie zmizí z pracovního stromu spolu s přepnutím.)
4. Vaše změny na novém `main` (volitelně, později): `git switch wip/v1-local-20261125 && git rebase main`. Očekávejte ruční řešení tří souborů
   (`CLAUDE.md`, `eslint.config.mjs`, `next.config.ts`) a rozhodnutí u `scripts/runtime/*`, kde větev nese vlastní, odlišnou verzi.
   Zdroj pravdy pro vaše původní verze je záchranný snímek.
5. **Nikdy** nepoužívejte `git checkout .`, `git reset --hard`, `git clean -fd` ani `git stash` ve `V1`, dokud snímek není ověřen (stash je navíc sdílený mezi worktrees).

## 3. Ostatní větve

* `seed/run00-demo-data` (`892c6ad`, RUN 00): obsahuje `12f7738`, ale ne commity spolupráce; rozchází se s naší větví. Po Fázi A se do `main` přidá
  zvlášť (`git merge seed/run00-demo-data` z čistého worktree, očekávaný dosah: `frontend/scripts/demo-seed/**`, dokumentace). **Nezasahuje se do ní.**
* `consolidation/security-foundation`, `experiment/*`, `integration/monograph-clearspace`, `release/rc2-monograph`, `feature/intelligence-v2`:
  nedotčeny. Redesignové experimenty (`artform`, `editorial*`, `microcrm`, `mission-control`) zůstávají odděleně a mimo `main`.
* V2 (`clearspace-v2`) je jiný repozitář a tento plán se ho netýká.

## 4. Rizika a jak jsou ošetřena

| Riziko | Ošetření |
|---|---|
| Push do `main` spustí nasazení | guard `deploymentEnabled:false` je v pushnutém stromu; po pushi se ověří, že nevzniklo žádné nasazení |
| Vzdálený `main` se mezitím změnil | `push` bez `--force` selže; brána 1 to zachytí dřív |
| Ztráta neuložených změn ve `V1` | publikace běží mimo `V1`; záchranný snímek; Fáze B ukládá změny do commitu na vlastní větev |
| `main` neodpovídá produkci | kód od `78c2b7b` je beze změny (jen docs/e2e/skripty); značka `collab-prod-2026-11-25` ukazuje na commit s rolloutem |
| Tajemství v historii | sken přidaných řádků čistý; v repozitáři nejsou `.env*`; tajemství jsou jen ve Vercelu, Supabase a Keychainu |

## 5. Co potřebuji od vás

Jedno schválení pro **Fázi A** (kroky 1–4), nejlépe po úspěšném živém testu pozvánek. Fázi B stačí potvrdit, až se vám hodí
(je bez rizika pro produkci i server). Bez vašeho pokynu nic nespouštím.
