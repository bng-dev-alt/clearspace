# ClearSpace V1 – technický dluh (známé, vědomě neřešené)

Stav k 2026-11-25. Položky níže **nevznikly v RUN 02** (ověřeno: padají beze změny i na tagu `run01-complete`); jsou jen evidované,
aby je další RUN nepovažoval za regresi a aby se nepřehlédly. Opravovat je samostatným malým úkolem (test, ne produktový kód).

| # | Test | Příznak (přesně) | Příčina | Dopad | Návrh opravy |
|---|---|---|---|---|---|
| TD-1 | `e2e/supabase-runtime.spec.ts:113` „AI gateway at runtime…“ | řádek 132: očekáváno `400`, přijato `403` (špatné tělo požadavku `{card: {}}` od přihlášeného uživatele) | AI brána je od RUN 01 **owner-only** a kontrolu vlastníka dělá **před** validací těla; běžný testovací uživatel proto dostane 403 dřív, než se tělo vůbec zkontroluje | žádný produktový; test je zastaralý vůči záměrnému pořadí kontrol | přepsat očekávání na 403 pro ne-vlastníka a validaci těla ověřit uživatelem v `AI_OWNER_USER_IDS` (nebo samostatným jednotkovým testem trasy) |
| TD-2 | `e2e/task-resources.spec.ts:140` „a card that is NOT saved on the server yet…“ | `locator.click` na „Neuložená karta“ vyprší (30 s): element se opakovaně „detached from the DOM“, text `a.pdf: Úkol ještě není uložený na serveru` se nikdy nevyhodnotí | test blokuje `POST /rest/v1/cards` (`route.abort()`); karta je jen optimistická a UI ji po selhání znovu vykreslí/odstraní dřív, než ji test stihne otevřít (závod mezi optimistickým zobrazením a rollbackem) | žádný produktový; scénář „neuložená karta + příloha“ nemá spolehlivý E2E | otevřít kartu bez čekání na stabilitu (`click({force:true})`/`dispatchEvent`) nebo test přepsat na komponentní (jednotkový) s ručně vytvořenou lokální kartou |

Ověřeno i v RUN 03 (2026-11-25, stack `cs-gmail-sb`): TD-1 a TD-2 padají stejně, ostatní E2E RUN 01 procházejí.

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
