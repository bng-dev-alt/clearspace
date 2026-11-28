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

## RUN 04 (Google Calendar) – vědomá omezení a zjištění
* TD-1 a TD-2 padají stejně (E2E RUN 01: 10 passed + 2 failed); nic nového.
* **Klasika: navbar přetéká vodorovně při šířce 1024 px** (`navbar-right` končí na ~1136 px; Monograph ne). Zjištěno při živé kontrole kalendáře,
  není z RUN 04 (týká se všech stránek s navbarem). Návrh: zúžit/zalomit `navbar-right` pod 1140 px.
* Kalendář: na plném dni „+N další“ bez rozbalení na desktopu (původní chování kalendáře úkolů); vlastní událost, která je i připojená, se zobrazí
  dvakrát (vrstva + událost projektu).
* Sdílená metadata událostí obnovuje jen vlastník odkazu (žádný sync); stejná událost od dvou lidí = dva odkazy (dedup přes iCalUID LATER).
* `/about` sekce Kalendář se renderuje při buildu (změna přepínače = redeploy).
* Živě NEOVĚŘENO: odškrtnutí Calendar na granulární obrazovce (Google ho pro jeden scope neukáže), `confidential` (UI ho nenabízí), podzimní DST,
  410 Gone, druhý Google účet, 7denní expirace, revokace z myaccount (viz `docs/run04/LIVE_ACCEPTANCE.md` §D).
* `monograph-prodcheck.mjs`: přepínač/rail v navbaru se na produkci odhlášeně neověří (beze změny z RUN 03C).

## RUN 05 (Slack & Telegram) – vědomá omezení a zjištění
* TD-1 a TD-2 padají stejně (E2E RUN 01: 10 passed + 2 failed + 1 skipped); v prvním běhu jednorázově selhal `collaboration.spec.ts:62` na studeném `next dev`
  (čekání na `accept-invite-preview`), samostatně i v opakovaném běhu celé sady PASS – kandidát na delší timeout/warm-up v testu.
* **Živá akceptace Slack/Telegram BLOCKED** (owner block) – mock není důkaz živé integrace; produkce zůstává vypnutá.
* **Incident: smazaný `V1/frontend/.env.local` vlastníka** (brána 12 RUN 05) – obnoví vlastník; hostované ověření jen z dočasného exportu.
* `next.config.ts` bezpečnostní hlavičky přepisují `Referrer-Policy: no-referrer` callbacků (Google od RUN 02, Slack RUN 05) na `strict-origin-when-cross-origin`:
  kód z OAuth neodchází mimo origin; čistší by bylo vynechat callbacky z globální hlavičky.
* Odpověď dávky se zapisuje až dalším tickem (≤ 1 min); ztracená odpověď ⇒ `ambiguous` po 5 min (at-most-once, zpráva mohla dorazit).
* Připomínka termínu: jedna pevná hodina 09:00 a jedno pásmo (Europe/Prague) pro všechny; nastavitelnost = LATER.
* Supabase Free plán (pravděpodobně – plán organizace přes API neověřen) pozastaví projekt po týdnu nečinnosti: plánovač pak neběží (po probuzení dožene dle M4).
* Produkční DB nemá marker `20261118000800_stt_stabilization_repair` (zjištěno v auditu RUN 05, mimo rozsah) – ověřit v samostatném úkolu.
* `monograph-prodcheck.mjs`: přepínač/rail v navbaru se na odhlášené produkci neověří (beze změny).

## RUN 06 (Google demo + pilot)
**OAuth**
* `clearspace-prod` je v režimu **Testing**: refresh tokeny Gmailu/Kalendáře vyprší 7 dní po souhlasu → prezentující se musí týdně znovu připojit. Publikace = varování „neověřená aplikace“ a strop 100 uživatelů; veřejné použití `gmail.readonly` (restricted) vyžaduje ověření aplikace + CASA. Rozhodnutí vlastníka.
* Pilotní seznamy (`GOOGLE_PILOT_USER_IDS`, `GOOGLE_PILOT_ACCOUNTS`) jsou proměnné prostředí → přidání / odebrání osoby vyžaduje redeploy; správa pilotu v aplikaci (admin UI / tabulka) není.
* Odebrání jedné služby (Gmail / Kalendář) v ClearSpace nezruší scope u Googlu – Google ruší jen celý grant (Odpojit účet). Beze změny od RUN 03/04.
* Seeder: `gmail.modify` / `calendar.events.owned` jen v dev projektu; filtry Gmailu nejdou nastavit bez `gmail.settings.basic` → v RUN 06 ručně ve webovém UI.
**UX**
* Výběr událostí z Kalendáře neumí období v minulosti (pole „Od“) – nedávné události nelze připojit.
* Odebrání odkazu (Disk/Gmail/Kalendář) používá nativní `confirm()`; vlastní potvrzovací dialog by byl konzistentní s UI a testovatelný.
* Google slučuje souhlasy po projektu: seeder (`clearspace-dev`) se musí odvolat dřív, než demo účet připojí ClearSpace (postup v `docs/run06/GOOGLE_DEMO_SEEDER.md`).
* Google Picker v úzkém panelu (< 500 px) se vykresluje mimo viditelnou plochu / se zpožděním; výběr spolehlivě jen dvojklikem. Ověřit na mobilních šířkách.
* Výběr e-mailů: pole „Hledat“ a „Předmět“ jsou v úzkém rozložení snadno zaměnitelná; Enter v poli spouští hledání, tlačítko je pod formulářem.
* Lokální testy na přetíženém stroji: GoTrue vrací 504/401 (`gdemo_live_accept.mjs` opakuje jen tento případ); starší HTTP sady opakování nemají.
* Seeder neopakuje odpověď 5xx Googlu sám – stačí znovu spustit (idempotentní).

## RUN 07 (Project Communication Hub) – vědomá omezení
* **Živě neověřeno** (mock ≠ poskytovatel): celé A1–A25 živě BLOCKED; zvlášť `getChatMember` pro bota bez admin práv, `views.open` v 3 s na Vercelu (cold start),
  Slack Events retry chování, Telegram `migrate_to_chat_id`.
* Příchozí události jsou **at-most-once** (D20): když zpracování po zápisu do `hub_inbox` selže, Slack/Telegram ho nezopakuje – uživatel akci zopakuje.
* Telegram: synchronizují se jen **odpovědi na potvrzovací zprávu bota**; odpověď na synchronizovaný komentář bota se do úkolu nepropíše. Telegram botům
  neoznamuje mazání zpráv (záznam zůstane do odpojení / retence). Odkaz na zprávu jen u superskupin.
* Slack: příchozí odpovědi ve vlákně se ukládají bez permalinku (jen zdrojová zpráva úkolu má permalink – šetří API volání); autor bez propojené
  identity se zobrazí jako „Člen kanálu (Slack)“ (bez `users:read`). Typ kanálu (veřejný/soukromý) se nezjišťuje.
* Kanál, ze kterého byl bot odebrán, se po znovupřidání sám neobnoví (Slack bez `channels:read` nedostane událost) – odpojit a propojit znovu.
* Checkboxy schopností v modalu jsou řízené serverem (stav se změní až po uložení, žádný optimistický update).
* `/integrations/link` odstraní kód z adresy hned po načtení: nepřihlášený uživatel si po přihlášení musí vyžádat nový odkaz.
* Odpojení používá nativní `confirm()` (dva dotazy: odpojit, smazat historii) – stejné jako RUN 06, vlastní dialog = LATER.
* Plánovač hubu = druhý cron job (D15); každý běh max 20 položek (souhrny se proto mohou rozdělit do dvou zpráv).
* `hub-stack.sh up` na běžícím stacku aplikuje jen migraci 1600 (opakované aplikování starší 1300 naráží na pozdější testovací data – `external_resource_links_provider_check`).
* Vitest v sandboxu: testy s lokálními sockety (SMTP, STT) padají na zákazu bindování portů; mimo sandbox 1423/1423.

## RUN 07B – stav omezení RUN 07 a nová
* **Vyřešeno**: at-most-once příchozí zpracování (→ odolný inbox, D23); chybějící permalinky synchronizovaných odpovědí (Slack); obnova po odebrání
  bota / reinstalaci (→ „Ověřit znovu“); `/integrations/link` + chat-iniciovaná identita (→ odstraněno, D22); 13 nálezů revize (`docs/run07b/FINDINGS.md`).
* **Trvá**: Telegram neoznamuje botům mazání zpráv; Slack zpráva v soukromém kanálu bez `groups:read` nezjistí typ kanálu; checkboxy modalu bez
  optimistického update; odpojení přes nativní `confirm()`; souhrny po max. 20 položkách na běh.
* **Nové**: odpověď do chatu přerušená pádem se neopakuje (`reply_ambiguous`, záměrně); Telegram `/task` – pokud proces spadne mezi odesláním
  potvrzení a připojením vlákna, úkol vznikne bez propojeného vlákna (odpovědi se nepropíší; další `/task` řekne „Úkol už existuje“).
* **Prostředí**: spouštěcí smyčka `collab-stack.sh up` znovu aplikuje všechny migrace; na stacku s pozdějšími testovacími daty se zastaví na 1300
  a starší definice funkcí (1200) přepíšou novější → Gmail/Kalendář aktivita jako „Disk“. Náprava: znovu aplikovat 1400+; trvalé řešení =
  přeskakovat migrace se zapsaným markerem (rozhodnutí pro všechny RUN skripty).
* **Cloudflare quick tunel** může vrátit 429 (bez účtu) → pro živé testy pojmenovaný tunel vlastníka.
* TD-2 (`task-resources.spec.ts:140`) padá dál beze změny (i na `origin/main`).

## RUN 09 (produkční rollout hubu, etapa 1) – omezení a zjištění
* **Hosted Slack app settings UI** (nová `app.slack.com/app-settings`) ve vestavěném prohlížeči neukazuje tajemství („none“) – ověření tajemství
  jen nepřímo (podpis, getMe). Validátor teď odmítne zdvojené vložení (Slack secret = přesně 32 hex).
* **Osobní oznámení z vlastních akcí** se neposílají (záměr); živě ověřena jen připomínka termínu + zkušební zprávy. Přiřazení/komentář od
  jiného člověka v produkci neověřeno (pilot má jediný účet) – RUN 08 ověřil lokálně se skutečnými poskytovateli.
* **Odvolání tokenu Slacku** odebere bota z kanálů; po nové instalaci je nutný `/invite` (UX backlog #8).
* **Turbopack odmítá symlinkované `node_modules`** (build i dev) – worktree potřebuje APFS klon (`cp -cR`).
* **Hosted logy Vercelu**: `vercel logs` CLI 66.x v tomto prostředí nevrátil řádky; zdraví se ověřuje přes `cron.job_run_details` a `net._http_response`.
* **Etapa 2** neověřena živě s AI (čeká na schválení placeného testu, `docs/run09/STAGE2_GEMINI_PROPOSAL.md`).
* **Stage 2 (2026-11-28)**: Gemini test PASS (6 požadavků, ≤ 0,048 USD). Mezistav „PI bot nakonfigurován, `HUB_INTELLIGENCE_ENABLED=0`“: `check-deployment.sh`
  čeká u `/api/hub/telegram/pi-webhook` 503, route vrací 401 (podpis se ověřuje dřív než přepínač; handler pak nic neuloží) – rozšířit kontrolu o tento stav.
* **Vercel CLI 66** v neinteraktivním režimu odmítá `env rm` bez potvrzení – `hub-prod.sh` potřebuje příkaz `pull-env stage2` (mazání přes REST API dle id).
* **Neověřeno živě**: osobní oznámení od jiného člověka (přiřazení, komentář, zmínka, změna termínu, dokončení cizího úkolu) – pilot má 1 účet; živě jen
  připomínka termínu + zkušební zprávy (RUN 08 ověřil vše lokálně se skutečnými poskytovateli). Další mezery: 90denní retence (jen kód + harness),
  `google_pilot_http` lokálně (Google pilot ověřen živě), druhý reálný Slack/Telegram účet, odvolání produkčního tokenu (vědomě nedestruktivně).
* Cortex zůstal členem testovací skupiny bez webhooku → Telegram drží jeho updaty až 24 h (ClearSpace je nečte); před trvalou aktivací etapy 2 jen `setWebhook`.
* **Etapa 2 trvale aktivní (2026-11-28)**: limity jsou per-UTC-den v `ai_reserve`; žádný alert na blížící se strop (jen 429 uživateli) – zvážit
  přehled spotřeby. `check-deployment.sh` neověřuje hodnoty `AI_DEMO_*` (jen chování) – ověřováno ručně bezplatnými sondami (deterministická funkce, předimenzovaná rezervace).
