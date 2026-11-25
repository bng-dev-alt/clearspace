# ClearSpace V1 – technický dluh (známé, vědomě neřešené)

Stav k 2026-11-25 (ověřeno znovu v RUN 02C na kandidátovi `release/run02-google-drive`: TD-1 a TD-2 padají stejně, žádné nové selhání). Položky níže **nevznikly v RUN 02** (ověřeno: padají beze změny i na tagu `run01-complete`); jsou jen evidované,
aby je další RUN nepovažoval za regresi a aby se nepřehlédly. Opravovat je samostatným malým úkolem (test, ne produktový kód).

| # | Test | Příznak (přesně) | Příčina | Dopad | Návrh opravy |
|---|---|---|---|---|---|
| TD-1 | `e2e/supabase-runtime.spec.ts:113` „AI gateway at runtime…“ | řádek 132: očekáváno `400`, přijato `403` (špatné tělo požadavku `{card: {}}` od přihlášeného uživatele) | AI brána je od RUN 01 **owner-only** a kontrolu vlastníka dělá **před** validací těla; běžný testovací uživatel proto dostane 403 dřív, než se tělo vůbec zkontroluje | žádný produktový; test je zastaralý vůči záměrnému pořadí kontrol | přepsat očekávání na 403 pro ne-vlastníka a validaci těla ověřit uživatelem v `AI_OWNER_USER_IDS` (nebo samostatným jednotkovým testem trasy) |
| TD-2 | `e2e/task-resources.spec.ts:140` „a card that is NOT saved on the server yet…“ | `locator.click` na „Neuložená karta“ vyprší (30 s): element se opakovaně „detached from the DOM“, text `a.pdf: Úkol ještě není uložený na serveru` se nikdy nevyhodnotí | test blokuje `POST /rest/v1/cards` (`route.abort()`); karta je jen optimistická a UI ji po selhání znovu vykreslí/odstraní dřív, než ji test stihne otevřít (závod mezi optimistickým zobrazením a rollbackem) | žádný produktový; scénář „neuložená karta + příloha“ nemá spolehlivý E2E | otevřít kartu bez čekání na stabilitu (`click({force:true})`/`dispatchEvent`) nebo test přepsat na komponentní (jednotkový) s ručně vytvořenou lokální kartou |

Ověřeno i v RUN 03 a RUN 03B (2026-11-25, stack `cs-gmail-sb`, po merge `run02c-complete`): TD-1 a TD-2 padají stejně, ostatní E2E RUN 01 procházejí.

## Další známá omezení (z RUN 02/02B; ne chyby)
* Skript E2E s **DEV auto-loginem**: `collaboration-01b` (čistý kontext hosta) musí běžet s `DEV_AUTO_LOGIN=0` (zdokumentováno v `docs/LOCAL_DEV.md`).
* `npm run lint`: 3 starší varování (beze změny proti RUN 01).

## RUN 03 (Gmail) – vědomá omezení (ne chyby; detail `docs/run03/GMAIL.md` §6)
* Počet příloh e-mailu se doplní až prvním náhledem vlastníka (vyhledávání/připojení čte jen `format=metadata`).
* Stejný e-mail připojený dvěma lidmi = dva odkazy (deduplikace přes Message-ID: LATER).
* „Otevřít v Gmailu“ používá nedokumentovanou URL `/mail/u/0/#all/<threadId>` (účet 0 prohlížeče).
* Bývalý Čtenář nemůže své e-mailové odkazy v daném projektu smazat sám (viewer guard); purge je nahlásí jako přeskočené.
* Rotace `GOOGLE_SERVER_SECRET` mění HMAC klíč odkazů (nové připojení téhož e-mailu se nepozná jako duplicita).
* Mock `__control/fail` s `count: 0` nastaví 1 (testy používají přesné počty).

## RUN 03C (produkce s Gmailem vypnutým) – stav
* Produkce běží kód RUN 03 + migraci 1300; **Gmail vypnutý** (`GMAIL_INTEGRATION_ENABLED=0`). Rollback kódu = promote `dpl_26oNU69r…` (funguje s 1300).
* `monograph-prodcheck.mjs` předpokládá přihlášenou stránku (demo auth): na produkci odhlášeně kontroluje jen `data-style`/fonty/motiv; přepínač stylu a rail
  v navbaru se na produkci tímto skriptem neověří (doplnit variantu s jednorázovým účtem, až to bude potřeba).
* `hosted-verify.sh` vyžaduje `frontend/.env.local` s hostovanou URL a veřejným anon klíčem (v RUN 03C vytvořen dočasně jen s těmito 2 hodnotami a smazán).
* Vercel Hobby: runtime logy jen ~1 h (`--since 1h` už mimo retenci) – kontrola logů je možná jen hned po nasazení.

## RUN 03B (živá akceptace Gmailu) – zjištění
* Výměna kódu za token nemá automatické opakování (záměrně: kód je jednorázový a mohl být u Google už uplatněn). RUN 03C: timeout má vlastní výsledek `unavailable` a srozumitelnou hlášku „Google neodpověděl včas … Nic se neuložilo … zkuste to znovu“; diagnostika `complete_failed.reason`.
* ~~Gmail trasy bez Google konfigurace vrací 503 s textem o „Google Disku“~~ – opraveno v RUN 03C (Gmail trasy: vlastní texty, přepínač se kontroluje první; výpadek token endpointu je hlášen jako „Google“, ne „Google Disk“).
* ~~U e-mailu ve stavu „smazáno“ zůstává tlačítko náhledu~~ – opraveno v RUN 03C (náhled se nenabízí, obnovení zůstává).
* **Dev OAuth klient „ClearSpace Dev Web“ (projekt `clearspace-dev`) má 2 aktivní client secrets**, oba vytvořené 25. 11. 2026 (RUN 02B).
  Lokální Keychain (`ClearSpace V1 - Google dev (live)`) používá jeden z nich; druhý je pravděpodobně pozůstatek rotace. **Nic se nerevokuje bez
  výslovného souhlasu vlastníka.** Postup úklidu: v konzoli porovnat poslední 4 znaky secretu s Keychainem (`security find-generic-password … -w | tail -c 5`
  v terminálu vlastníka), nepoužívaný secret „Disable“, ověřit `gmail-live.sh verify`, teprve potom „Delete“. Produkční klient (`clearspace-prod`) se netýká.
* Živě NEOVĚŘENO: odškrtnutí checkboxu Gmailu (Google pro jediný scope checkbox neukázal), druhý Google účet, Workspace blokace, 7denní expirace Testing.
* E2E se samotnou `DEV_AUTO_LOGIN=1` aplikací: `supabase-runtime:49` a `collaboration-01b` padají (host je automaticky přihlášen) – spouštět s `DEV_AUTO_LOGIN=0` (zdokumentováno od RUN 02).

## Známá omezení z RUN 02C (vědomě, bez akce)
* `integration_audit` nemá retenci (záznamy jen událost + čas, mažou se s účtem); zásady to tak uvádějí.
* Hromadné odvolání všech Google grantů neexistuje jako skript (tokeny jsou šifrované klíčem, který je jen ve Vercelu): postup = smazat/vypnout OAuth
  klienta v Google Cloud (PRODUCTION_ACCEPTANCE.md §11).
* Úplná sada Playwright testů potřebuje dva běhy: stack režim (`drive-stack.sh app`) a demo režim (build bez Supabase env); jeden běh proti stacku
  hlásí falešná selhání demo testů (`kanban`, `reflow`, `feature-updates`, `ios-zoom`).
* **Vercel Hobby plán drží runtime logy jen ~1 hodinu** (`vercel logs --since 12h` → „does not retain runtime logs for the requested time range“):
  kontrola citlivých dat v produkčních logách je možná jen krátce po akci. Pro audit delší historie by byl potřeba Log Drain nebo vyšší plán.
* Zamítnutý souhlas (`access_denied`) se neaudituje do `integration_audit` (jen `scope_denied`); stačí pro pilot, případně doplnit událost `denied`.
* Výměna produkčního Picker API klíče čeká na vlastníka (`set-google-keys.sh rotate-picker`, PRODUCTION_ACCEPTANCE.md §11a).
