# ClearSpace V1 – RUN 05 Slack & Telegram: MASTER RUN (konsolidovaný prompt)

TRUTH MODE + SCOPE MODE. Jeden dlouhý **autonomní** běh: audit → architektura → implementace → mock akceptace → živá akceptace proti skutečnému
Slacku a Telegramu → nápravy → regrese → konsolidace do `main` → řízené produkční nasazení s **vypnutými** přepínači Slack i Telegram → dokumentace a handoff.

**Autonomie.** Mezi běžnými fázemi nečekej na schválení. Běžná architektonická, implementační, databázová, testovací a UX rozhodnutí v rámci
schváleného rozsahu dělej sám: zvol nejbezpečnější rozumné řešení, zapiš ho do `docs/run05/DECISIONS.md` (rozhodnutí · varianty · důvod · dopad) a pokračuj.
Nekonči po mock akceptaci, pokud živá akceptace a produkční konsolidace mohou bezpečně pokračovat. Mezikroky ukládej jako checkpointy (tagy
`run05-mock-complete`, `run05-live-complete`, `run05-complete`) a pokračuj dál. Celý RUN 05 je **jeden běh od Phase 0 po finální handoff**.
Interakce vlastníka se Slackem/Telegramem je **jeden sloučený blok** (OWNER BLOCK, §4 Phase 0.6). Volitelný nebo vlastníkem neproveditelný živý test
**nezastavuje** běh: označ ho BLOCKED (s důvodem) a pokračuj ostatními fázemi, pokud to je bezpečné.

**Pravdivost.** Každé tvrzení = příkaz + výstup / počet; jinak **NOT VERIFIED**. Mock ≠ Slack/Telegram: nic z mocku se nepočítá jako živé ověření.
Živou akceptaci lze prohlásit jen na **finálním commitu** (po všech nápravách znovu spustit živou bránu a dotčené body). Fakta o API a limitech
poskytovatelů (scopes, rate limity, pravidla redirect URL, limity Vercel Cron, dostupnost `pg_cron`/`pg_net`) zapisuj s datem a zdrojem
(oficiální dokumentace nebo konzole); co jsi sám neověřil, je NOT VERIFIED.
Stavy výsledků (používej důsledně, nikdy je nezaměňuj): **PASS** = ověřeno důkazem v tomto běhu · **FAIL** = ověřeno, nefunguje · **BLOCKED** = nešlo provést
(chybí vstup vlastníka, přístup, prostředí) · **NOT VERIFIED** = neověřeno (např. jen mock tam, kde je potřeba živý důkaz). Mock test **není** důkazem živé integrace.
Žádná regrese se nezamlčuje; neověřená funkce se neoznačuje jako hotová.

## 0. Schválení vlastníka (platí jen toto)
| Oblast | Stav |
|---|---|
| **Dev Slack aplikace** „ClearSpace Dev“ v testovacím Slack workspace vlastníka (vytvoření, bot scopes, redirect URL pro lokální port, instalace do toho workspace) | **SCHVÁLENO** |
| **Dev Telegram bot** (vytvoří vlastník přes BotFather v OWNER SESSION; token jen do Keychainu skrytým promptem); `getUpdates`/`setWebhook` jen na **dev** botu | **SCHVÁLENO** |
| Živá akceptace proti skutečnému Slacku a Telegramu – zprávy **jen do soukromé konverzace účtu vlastníka** (Slack DM, Telegram private chat s dev botem) | **SCHVÁLENO** |
| Produkční migrace 1500, merge `--no-ff` do `main`, staged deploy + promote s `SLACK_INTEGRATION_ENABLED=0` a `TELEGRAM_INTEGRATION_ENABLED=0`, push `main` + tagy | **SCHVÁLENO**, pokud projdou všechny povinné bezpečnostní, migrační, regresní a nasazovací brány (§4 Phase 7) |
| Zapnutí Slacku/Telegramu v produkci, produkční Slack aplikace nebo produkční bot, public distribution / Slack Marketplace, `setWebhook` na produkční URL, jakákoli produkční tajemství Slack/Telegram ve Vercelu | **NESCHVÁLENO** |
| Odesílání do kanálů, skupin nebo jiným osobám než připojenému uživateli; odesílání soukromého obsahu (viz §2.4) | **NESCHVÁLENO** |
| Tunel vystavující lokální stack do internetu (ngrok, cloudflared, …), nová npm závislost (Slack/Telegram SDK aj.), placený plán nebo služba (Vercel Pro, placený Slack, externí scheduler) | **NESCHVÁLENO** |
| Změny Google Cloud (`clearspace-dev`, `clearspace-prod`), přepínačů Gmail/Kalendář, Drive chování | **NESCHVÁLENO** |

## 1. Výchozí stav (ověřeno při přípravě promptu 2026-11-26; v Phase 0 ověř znovu příkazy)
* Repo `/Volumes/WORKSPACE/Dev/Apps/ClearSpace/V1`; `main` = `6732dca` (docs) nad merge **`19a0c6b`**, tag **`run04-complete`**. Hlavní checkout má nesledované
  soubory vlastníka `DEMO/` a `frontend/test_intro.mp4` – **nikdy na ně nesahej**; staged deploy jen z dočasného čistého pracovního stromu `main`.
* Produkce `https://clearspace.luffast.com` = `dpl_FeGsSgZxxG2D87Tmx5bEo8b1MFMv` (z `19a0c6b`); Supabase `twjlnsxjtuntujarwner`, DB markery do **1400**;
  Drive aktivní, Gmail OFF, Kalendář OFF. Vercel auto-deploy vypnutý (`git.deploymentEnabled:false`), plán Hobby (runtime logy ~1 h). Rollback bod kódu: `dpl_FeGsSgZx…`.
  Monograph výchozí design, Classic (`clearspace-style=existing`) funkční. GitHub repo je **veřejné**.
* Baseline: Vitest **1373/1373**, DB harness **2378**, Calendar HTTP 18/18 + OFF 1/1, Gmail HTTP 23/23, Drive HTTP 28/28, prod `check-deployment.sh` **122/122**,
  `hosted-verify.sh` **18/18**, bundle guard 77/77. Známé E2E pády **TD-1, TD-2** (`docs/TECH_DEBT.md`) nejsou regrese.
* **Existující notifikační infrastruktura (RUN 01/01B) – nepřepisovat:**
  * tabulka `public.notifications` (migrace `20261124001000_collaboration.sql` §5): typy `mention, comment, assignment, project_added, project_role_changed,
    project_removed, invitation, invitation_accepted`; RLS jen příjemce; unikátní `(recipient_id, type, entity_id)` pro mention/comment/invitation;
  * `public.collab_notify(...)` (SECURITY DEFINER): neposílá sám sobě, **ověří členství příjemce v projektu**, `ON CONFLICT DO NOTHING`; volají ho triggery karet,
    členství, komentářů a pozvánek; při odebrání přístupu se notifikace projektu mažou;
  * realtime: trigger `z_collab_broadcast_notification` → `collab_send('user:<id>', 'notification', …)` (`20261125001100_collab_hardening.sql`);
  * UI/text: `src/components/collab/NotificationBell.tsx`, `src/hooks/useNotifications.ts`, `src/lib/collab/notificationText.ts`
    (`describeNotification`, `notificationHref` → `/projects/<id>?task=<cardId>`), aktivita `src/lib/collab/activityText.ts`, `activity_logs`;
  * vzor odchozího doručování: `invitation_deliveries` + `src/lib/collab/invitationServer.ts` (`deliverInvitation`, `APP_BASE_URL`), `src/lib/email/*`;
  * kryptografie tokenů: `src/lib/google/crypto.ts` (`seal`/`open` AES-GCM s AAD, `KeyRing` s rotací, `sha256hex`, `randomToken`), vzor `google_connections`,
    `google_oauth_states`, `integration_audit`;
  * `cards.due_date` je `TEXT` (datum bez času – ověř formát v datech a kódu); `vercel.json` nemá `crons`; žádná migrace nepoužívá `pg_cron`/`pg_net`.
* Čti nejdřív: `docs/run04/{HANDOFF_NEXT_RUNS,DECISIONS,PRODUCTION_ROLLOUT,PRODUCTION_ACCEPTANCE,PRIVACY_AND_SECURITY,MEETING_INTELLIGENCE_COMPAT}.md`,
  `docs/collaboration/COLLABORATION.md`, `docs/ROADMAP.md`, `docs/TECH_DEBT.md`, `docs/LOCAL_DEV.md`, `docs/MIGRATION_RUNBOOK.md`; skripty `calendar-stack.sh`,
  `calendar-live.sh`, `google-mock.mjs`, `rehearse-calendar-prod.sh`, `apply-calendar-hosted.sh`, `deploy-drive-staged.sh`, `check-deployment.sh`,
  `check-production-bundle.sh`, `hosted-verify.sh`, `redact-secrets.mjs`, `collab-stack.sh`.

## 2. Pevná pravidla
1. **Znovupoužij, nepřepisuj.** Zdroj pravdy o události je stávající `notifications` / `collab_notify`. Externí doručení je **aditivní vrstva nad ním**; in-app
   notifikace, realtime, aktivita, role, Drive/Gmail/Kalendář a jejich kód zůstávají beze změny chování. Kryptografii znovupoužij (`seal`/`open`) s **vlastním
   klíčem a AAD** pro notifikační kanály (ne Google klíč). Žádná nová npm závislost – Slack Web API i Telegram Bot API voláš přes `fetch`.
2. **Parita s aplikací.** Externí kanál nikdy nedoručí nic, co by příjemce **v okamžiku odeslání** neviděl v aplikaci. **Bezprostředně před každým odesláním**
   (ne jen při zařazení) ověř: aktuální členství a roli v projektu, existenci projektu/úkolu, stav propojení kanálu (aktivní, potvrzený, ne „znovu připojit“),
   aktuální preference (kanál, typ, projekt, „bez názvů“) a u `due_soon` i to, že úkol není hotový a termín se nezměnil. Cokoli neplatí → `cancelled`, nic neodejde.
3. **Jen osobní cíl.** Slack = DM s botem pro uživatele, který kanál připojil (`authed_user.id` z OAuth); Telegram = `private` chat s botem. Kanály, skupiny,
   jiní uživatelé = NESCHVÁLENO (LATER, vyžaduje samostatný privacy model).
4. **Minimalizace obsahu.** Zpráva smí obsahovat jen: typ události (česky), jméno aktéra, název úkolu a projektu, termín, odkaz do ClearSpace
   (`APP_BASE_URL` + `notificationHref`). **Nikdy**: text komentářů, popisy, checklisty, přílohy, data z Drive/Gmail/Kalendáře, e-maily, AI výstupy.
   Uživatel může zvolit režim „bez názvů“ (jen typ + odkaz). Escapuj `&`, `<`, `>` (Slack mrkdwn: žádné `<!channel>`, `<@…>`, maskované odkazy z názvů);
   Telegram bez `parse_mode` nebo s escapovaným HTML; náhledy odkazů vypnuté (`unfurl_links/unfurl_media:false`, `link_preview_options.is_disabled`).
5. **Tajemství.** Bot tokeny, client secret, chat id, Slack user/team id, linkovací tokeny: šifrovaně nebo jako hash, jen server (`service_role`), žádný klientský
   SELECT. Tajemství jen Keychain (lokálně, skrytý prompt) – nikdy v chatu, souboru, logu, commitu, testu ani dokumentaci (repo je veřejné).
6. **Logování.** Request log ignoruje nové trasy; logy, audit a chyby bez tokenů, chat id, Slack id, textu zpráv a payloadů poskytovatele; rozšiř `redact-secrets.mjs`
   a bundle guard o vzory (`xoxb-`, `xoxp-`, `xapp-`, Telegram token `\d{6,12}:[A-Za-z0-9_-]{30,}`, `hooks.slack.com`).
7. **Přepínače.** `SLACK_INTEGRATION_ENABLED`, `TELEGRAM_INTEGRATION_ENABLED` (výchozí vypnuto). Každá nová trasa nejdřív přepínač (503 `slack_disabled` /
   `telegram_disabled`), pak auth, pak vlastnictví. Vypnutý přepínač = žádné odchozí volání, žádné nové řádky, UI sekce skrytá, `/privacy` „není zapnuto“.
8. **Pořadí migrace před kódem.** Migrace 1500 běží v produkci **pod starým buildem** (`run04-complete`). Proto: nesmí změnit, co stávající triggery zapisují do
   `notifications`, ani přidat typ, který by starý build zobrazil (default větev `describeNotification`); nový trigger nad `notifications` **nikdy nesmí vyhodit
   výjimku** (selhání zařazení nesmí shodit uložení karty/komentáře/členství – test). Invariant ověř testem: stejný scénář na 1400 a 1500 ⇒ shodné řádky `notifications`.
9. **Prostředí.** Mock base URL (`SLACK_API_MOCK_BASE`, `TELEGRAM_API_MOCK_BASE`) jen loopback, v `next start` produkčním režimu odmítnuta. DEV login: jediný odkaz
   `http://127.0.0.1:<port>/settings?login=auto` ze skriptu stacku; nikdy nežádej přihlašovací údaje; E2E hosta s `DEV_AUTO_LOGIN=0`.
10. **Design a UX:** současný design V1 – Monograph výchozí, Classic funkční; E2E v obou (desktop light + mobil dark). Jen tokeny, žádné nové barvy mimo systém.
    UI Slack/Telegram **konzistentní s integracemi Drive/Gmail/Kalendář** (stejné umístění v `/settings`, struktura karty připojení, stavy, tlačítka, texty chyb a potvrzení –
    vzor `GoogleConnectionCard`). Lokalizace: dodrž existující mechanismus textů aplikace (zjisti v auditu; dnes čeština) – žádný nový i18n systém. Klávesnice, aria,
    prázdné/chybové stavy.
11. **Nezávislost in-app notifikací.** Zvonek, realtime a in-app notifikace fungují stejně bez ohledu na dostupnost, výpadek, chybu nebo vypnutí Slacku/Telegramu
    a bez ohledu na stav plánovače (test s mockem v režimu výpadku).
12. **Žádné úniky.** Tokeny ani citlivá data se nesmí dostat do logů, testovacích výstupů a reportů (Playwright trace/screenshoty, JSON reporty), dokumentace ani
    do Git historie (kontrola diffu i historie větve před merge, G2).
13. **Rozsah:** jen MUST §3. LATER neimplementuj ani nescaffolduj. V2, redesign, Meeting Intelligence, Project Intelligence, Artform a ostatní worktree/stacky
    (`V1-calendar`, `V1-gmail`, `V1-drive`, …) neměň. Žádná placená AI volání.
14. Commity malé, popisné, s `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; žádný rebase sdílené historie, žádný force-push `main`.

## 3. Rozsah
**MUST (M1–M10)**
* **M1** Připojení a odpojení Slacku (OAuth v2, `state` vázaný na uživatele s expirací, jednorázový) a Telegramu (deep link `t.me/<bot>?start=<token>`, token
  jednorázový, krátká platnost, uložený jen jako hash, **potvrzení v ClearSpace** „Je to váš Telegram účet <jméno>?“ – do potvrzení se nic neposílá). Odpojení:
  Slack `auth.revoke` jen pokud token nesdílí další uživatel téže instalace; Telegram odlinkování + volitelná zpráva „odpojeno“. Stav „znovu připojit“ při chybě oprávnění.
* **M2** Bezpečné uložení přístupových údajů (§2.5), audit událostí `connected / disconnected / revoked / blocked / send_failed` bez citlivých dat.
* **M3** Notifikace o přiřazení úkolu (z existující `assignment`).
* **M4** Notifikace před termínem (`due_soon`) – **závazná sémantika** (žádný vlastní timezone subsystém; jen Postgres `AT TIME ZONE` / `Intl` s pevným pásmem):
  * `cards.due_date` je **datum bez času** = kalendářní den v pásmu aplikace **`Europe/Prague`** (jedno pevné pásmo; pásmo per uživatel = LATER). Úkol je „po termínu“
    až od 00:00 místního času následujícího dne.
  * Připomenutí: **den před termínem v 09:00 `Europe/Prague`**. Okamžik odeslání = `((due_date - 1) + time '09:00') AT TIME ZONE 'Europe/Prague'` – přechod CET/CEST
    tak řeší databáze (9:00 místního času zůstává 9:00 v zimě i v létě; 08:00 UTC v CET, 07:00 UTC v CEST). Dny přechodu (2027-03-28, 2027-10-31) mají test.
  * **Dohánění:** plánovač po výpadku nebo zpoždění odešle zmeškané připomenutí, jen dokud termín ještě neuplynul (do konce dne termínu); později nic (žádné staré připomínky).
    Úkol vytvořený nebo s termínem nastaveným po 09:00 předchozího dne dostane připomenutí při nejbližším běhu, termín dnes nebo v minulosti = nic.
  * Jednou pro trojici (uživatel, úkol, termín). **Změna termínu** = staré čekající připomenutí zrušit, nové dle nového data. **Dokončení** (definici „hotovo“ urči auditem),
    archivace nebo **smazání karty**, **odebrání přiřazení** nebo **ztráta přístupu k projektu** = zrušení; vše se ještě znovu kontroluje před odesláním (§2.2).
  * Hodina 09:00 je jedna konstanta v kódu; nastavitelná hodina/předstih = LATER.
* **M5** Vybrané změny: existující `mention`, `comment` (na můj úkol), `project_added`, `project_role_changed`, `project_removed` + nejvýš **2 nové** typy
  vybrané auditem `activity_logs` (kandidáti: můj úkol přesunut do hotovo; změna termínu mého úkolu). Výběr a důvod do DECISIONS.
* **M6** Odkazy přímo do ClearSpace (absolutní, `APP_BASE_URL`; nepřihlášený uživatel → přihlášení → návrat na úkol; bez přístupu → srozumitelná stránka, ne obsah).
* **M7** Nastavení v `/settings`: kanály, zapnutí/vypnutí per kanál a per typ události, výběr projektů (všechny / vybrané), režim „bez názvů“, testovací zpráva.
* **M8** Provider-neutral doručovací vrstva: outbox s idempotencí, deduplikací, retry s backoffem, respektem `Retry-After`/`retry_after`, rate limitem per cíl
  i globálně, rozlišením trvalých (blokace, `invalid_auth`, `channel_not_found`, 403 Telegram) a dočasných chyb (5xx, timeout, 429) a retencí záznamů.
* **M9** Ochrana dat: §2.2–2.6; uživatel vidí a smaže jen své kanály a preference; smazání účtu/odchod z projektu kaskáduje.
* **M10** Mock adaptéry, česká syntetická data, testy (§4 Phase 4), živá akceptace (§4 Phase 5).

**LATER (neimplementovat, neskafoldovat):** produkční aktivace poskytovatelů, skupinové chaty, Slack kanály, pokročilé automatizace, obousměrné zpracování zpráv (Telegram webhook/polling zpracuje jen `/start <token>` a `/stop`, vše ostatní ignoruje
s pevnou odpovědí), vytváření úkolů z chatu, slash commands, interaktivní tlačítka, AI asistenti, souhrny a digesty, kanály/skupiny, tiché hodiny, e-mailové
notifikace, další poskytovatelé (Teams, Discord, …), Slack Events API.

## 4. Fáze (autonomně za sebou)

### Phase 0 – příprava, audit, architektura, jedno sezení s vlastníkem
1. `git -C V1 worktree add ../V1-notify -b feature/run05-slack-telegram run04-complete`; zkopíruj tento prompt → `docs/run05/RUN_PROMPT.md`, založ `DECISIONS.md`.
   Ověř volné porty (návrh: app **3471**, Supabase 55600–55609, mail 55614/55615, mock 55622) a vytvoř `scripts/notify-stack.sh mock|app` (vzor `calendar-stack.sh`)
   a `scripts/notify-live.sh` (vzor `calendar-live.sh`; podpříkazy pro uložení tajemství skrytým promptem do Keychainu, `app`, `gate`, `accept`, `revoke-check`).
2. **Audit (jen čtení) → `docs/run05/AUDIT.md`:** notifikace (tabulka, `collab_notify`, všechny volající triggery, mazání při ztrátě přístupu, realtime, UI), aktivita,
   role a `project_role_of`, `/settings` a uložení uživatelských preferencí, `invitation_deliveries` jako vzor outboxu, kryptografie, `APP_BASE_URL`, formát
   `cards.due_date`, definice „hotovo“, existující rate limity, request log. Výstup: co znovupoužít, co chybí, rizika.
3. **Fakta poskytovatelů** (dokumentace/konzole, s datem): Slack bot scopes pro DM (např. `chat:write`, `im:write` – minimum ověř), zda Slack přijme
   `http://127.0.0.1` redirect; když ne, `https://localhost` s vlastním certifikátem (`openssl`, Next `--experimental-https-key/-cert`, žádná nová závislost);
   tunel je NESCHVÁLEN. Rate limity Slack (`chat.postMessage`) a Telegram (per chat / globálně), `Retry-After`, chybové kódy blokace/odvolání, `secret_token`
   hlavička webhooku, vzájemná výlučnost `getUpdates`/webhook. **Skutečné možnosti aktuálních plánů** ověř přímo (Vercel API/CLI/dashboard projektu `clearspace`,
   Supabase API/SQL na produkčním projektu jen čtením – `pg_available_extensions`, plán organizace): frekvence a přesnost Vercel Cron, limity funkcí (timeout),
   dostupnost `pg_cron`/`pg_net`, případná omezení. Zapiš s datem a zdrojem.
4. **`docs/run05/ARCHITECTURE_DECISION.md`** – závazné principy §2, rozhodnutí s variantami:
   * datový model (návrh: `notification_channels` server-only, `notification_preferences`, `notification_deliveries` outbox s unikátním klíčem idempotence,
     `notification_link_tokens` hash + expirace; přesná podoba je tvoje rozhodnutí);
   * zdroj událostí: jak se z `notifications` (a z `due_soon` / nových typů) zařadí doručení **bez změny in-app chování starého buildu** (§2.8);
   * **plánovač** pro `due_soon` a retry: **žádná varianta není předem určená** (Vercel Cron, `pg_cron`, `pg_net`, odeslání po zápisu přes `after()`, kombinace).
     Na základě ověřených faktů z bodu 3 zvol **nejjednodušší spolehlivou variantu bez upgradu placeného plánu** a zdůvodni ji (varianty · limity · selhání · obnova).
     Povinné vlastnosti bez ohledu na volbu: idempotentní běh (opakované spuštění nic neduplikuje), bezpečné souběžné spuštění (dva běhy současně = žádné dvojí
     odeslání), retry s backoffem, **zotavení po výpadku plánovače** (zmeškaná práce se dožene podle pravidel M4, nic se neztratí ani nezdvojí), chráněný vstup.
     S vypnutými přepínači v produkci nesmí plánovač nic odesílat ani zapisovat.
   * Telegram příjem `/start`: produkčně webhook se `secret_token` (neověřitelné bez produkčního bota → mock + HTTP testy, živě NOT VERIFIED), lokálně `getUpdates`
     na dev botu přes **stejnou** obslužnou funkci; případně on-demand polling bez webhooku – vyber a zdůvodni.
   * politika nejednoznačného odeslání (timeout po odeslání požadavku): at-least-once vs at-most-once, a co uvidí uživatel.
5. `docs/run05/DESIGN.md`: MUST M1–M10 rozpracované do tras, UI, textů (česky), dat a testů; tabulka událostí × kdo dostane × co obsahuje zpráva.
6. **OWNER BLOCK – jediný sloučený blok interakce vlastníka se Slackem/Telegramem.** Zařaď ho tam, kde je nejefektivnější (nejpozději po Phase 4, aby šly
   živé body ověřit rovnou na téměř finálním kódu); do té doby pracuj na všem, co vlastníka nepotřebuje. Připrav předem skripty, aplikaci a přesný checklist, pak požádej najednou o:
   (a) testovací Slack workspace (existující nebo nový zdarma) a vytvoření/konfiguraci dev aplikace na api.slack.com – je-li vlastník přihlášen v prohlížeči,
   proveď konfiguraci sám (vzor RUN 04 D3), jinak přesný postup; (b) client id/secret a Telegram bot token zadá vlastník do skrytého promptu `notify-live.sh` (nikdy chat);
   (c) vytvoření dev bota přes BotFather (jméno bez osobních údajů); (d) souhlas „Allow“ ve Slack OAuth a „Start“ v Telegramu dělá vlastník; (e) druhý Slack uživatel
   / druhý Telegram účet, pokud je má (jinak body s nimi = NOT VERIFIED). Během sezení rovnou proveď živou sondu (DM přes Slack, zpráva přes Telegram, ověření
   rate-limit hlaviček a chybových kódů) a co nejvíc živých bodů nezávislých na finálním kódu; zbytek živé akceptace běží bez vlastníka.

### Phase 1 – DB migrace 1500
`supabase/migrations/20261129001500_notification_channels.sql` + `supabase/rollback/…down.sql`; preflight „1400 přítomna“; vše aditivní; RLS na všech nových
tabulkách, klient nemá SELECT na tajemství, anon bez EXECUTE; CHECKy délek a výčtů; `CREATE OR REPLACE` jen tam, kde je to nutné a zpětně kompatibilní.
Test `supabase/tests/collab/95_notification_channels.sql` (vzor `94_google_calendar.sql`): RLS, role, cizí uživatel nevidí cizí kanál/preference/doručení,
nečlen nedostane doručení, odebrání člena zruší čekající doručení, idempotence (dvojí zařazení = 1 řádek), trigger nikdy nevyhodí výjimku (simulované selhání),
**parita in-app notifikací 1400 vs 1500**, kaskády při smazání účtu/projektu/úkolu, upgrade 1400→1500 (existující řádky bajtově shodné), rollback odmítnut při
datech, katalog po rollbacku == 1400, re-apply.

### Phase 2 – server
`src/lib/notify/` (konfigurace + přepínače, model zprávy, renderer textu, adaptéry `slack.ts` a `telegram.ts` přes `fetch`, odesílač outboxu s leasem
(`FOR UPDATE SKIP LOCKED` nebo ekvivalent), rate limiter, klasifikace chyb), trasy `/api/notify/{slack,telegram}/…` (connect, callback, confirm, disconnect,
test), `/api/notify/preferences`, chráněný endpoint plánovače (tajemství v hlavičce, porovnání v konstantním čase) a příjem Telegram aktualizací (`secret_token`).
Rate limit i na příchozí trasy (connect, test zpráva, webhook). Vlastní české texty chyb.

### Phase 3 – UI
`/settings`: sekce „Oznámení mimo aplikaci“ (Slack, Telegram: stav, připojit, potvrdit, odpojit, znovu připojit, testovací zpráva), typy událostí, projekty,
režim „bez názvů“; vysvětlení, co se posílá a kam. `/privacy` (+ `/about` jen se zapnutým přepínačem). Classic i Monograph, mobil, klávesnice, aria.
Vizuálně a strukturou stejné jako karty Google integrací (§2.10); in-app notifikace a zvonek beze změny.

### Phase 4 – mock a automatické testy → checkpoint `run05-mock-complete`
`scripts/notify-mock.mjs` (loopback; Slack `oauth.v2.access`, `auth.test`, `auth.revoke`, `conversations.open`, `chat.postMessage`; Telegram `getMe`, `sendMessage`,
`getUpdates`, `setWebhook`; řízené chyby 429 s `Retry-After`/`retry_after`, 5xx, timeout, `invalid_auth`, `token_revoked`, 403 „blocked by the user“; záznam přijatých
zpráv pro aserce). Česká syntetická data (projekty, úkoly s termíny přes DST a přes konec měsíce, názvy s `<`, `>`, `&`, `<!channel>`, emoji, 300 znaků).
Testy: Vitest (`src/__tests__/notify/*`), DB 95, `supabase/tests/notify_http.mjs` (role, cross-account, podvržené id/tokeny, přepínače OFF → 503 všude, logy bez tajemství),
`e2e/notify.spec.ts` (3 uživatelé, Classic + Monograph), regrese Drive + Gmail + Calendar (HTTP + E2E), RUN 01 sady (in-app notifikace a realtime beze změny),
`real_stack.sh`, typecheck, lint, build, `check-production-bundle.sh` (+ `slack.com/api`, `api.telegram.org`, oba přepínače, vzory tokenů), `/api/dev/login` 404 v `next start`.

### Phase 5 – živá akceptace (skutečný Slack a Telegram, dev aplikace) → checkpoint `run05-live-complete`
`notify-live.sh gate|accept|revoke-check`, `node supabase/tests/notify_live_gate.mjs` (vzor `calendar_live_gate.mjs`). Projdi každý živý řádek §5 a body níže;
záznam `docs/run05/LIVE_ACCEPTANCE.md` (bod · důkaz · PASS/FAIL/NOT VERIFIED):
připojení Slack + Telegram (vč. potvrzení) · přiřazení → zpráva s funkčním odkazem na úkol · `due_soon` (plánovač spuštěný ručně s injektovaným „teď“ na dev stacku)
· mention/comment/projektové změny · filtr projektu a vypnutý typ nic nepošlou · „bez názvů“ · název s mrkdwn/HTML se zobrazí doslova, bez náhledu odkazu
· dávka 20 událostí: vše doručeno, pořadí, žádné ztracené 429 · odebraný člen nedostane nic · odpojení (Slack token prokazatelně neplatný přes `auth.test`;
Telegram po odlinkování nic) · zablokování bota uživatelem → kanál „znovu připojit“, outbox se zastaví · přepínač OFF → 503 a nic neodchází · logy bez citlivých dat
· screenshoty Classic + Monograph (desktop + mobil).
Body, které vlastník nemůže nebo nestihne provést (nebo chybí druhý účet), označ **BLOCKED** s důvodem a pokračuj Phase 6–8 – produkční nasazení s vypnutými
přepínači na živém Slacku/Telegramu nezávisí. Tag `run05-live-complete` jen tehdy, když živá brána skutečně PASS. Úklid: odpojit kanály, dev tokeny revokovat/odlinkovat (`revoke-check`), dev bota a aplikaci ponechat (vlastník rozhodne).

### Phase 6 – nápravy a finální regrese
Každý FAIL oprav, přidej regresní test, zopakuj dotčené mock i **živé** body na finálním commitu. Celá sada z Phase 4 + živá brána znovu na finálním SHA.

### Phase 7 – konsolidace a produkce (sekvence RUN 04, Slack i Telegram VYPNUTÉ)
Nejdřív na feature větvi: `deploy-drive-staged.sh` (`EXPECT_NOTIFY_MIGRATION`), `check-deployment.sh` (`EXPECT_SLACK_OFF`, `EXPECT_TELEGRAM_OFF`),
`hosted-verify.sh`/`supabase-hosted.spec.ts` (`E2E_EXPECT_SLACK`, `E2E_EXPECT_TELEGRAM`), nové `rehearse-notify-prod.sh` + `apply-notify-hosted.sh` – analogicky
Calendar; chování Drive/Gmail/Calendar kontrol beze změny. Pak brány v pořadí:
* **G1** preflight: Git, Vercel, DB markery do 1400, produkce = `dpl_FeGsSgZx…`, `deploymentEnabled:false`, žádné notifikační objekty v DB.
* **G2** revize diffu `run04-complete..HEAD` (veřejné repo): žádná tajemství, tokeny, chat/user/team id, e-maily, jména workspace.
* **G3** `rehearse-notify-prod.sh`: replika = produkční DDL + syntetická data (Drive, Gmail, Calendar, kolaborace s notifikacemi); testy 92/93/94/95 na produkčním DDL
  + 1500; parita in-app notifikací; rollback a re-apply.
* **G4** kompatibilita starého buildu: `git archive run04-complete` proti DB s 1500 – Drive HTTP 28/28, Gmail HTTP 23/23, Calendar HTTP 18/18, Drive E2E,
  RUN 01 kolaborace (in-app notifikace + realtime).
* **G5** finální regrese z Phase 6 PASS + živá brána na finálním SHA PASS; pokud byla živá akceptace BLOCKED, brána G5 = jen regrese a v záznamu i handoffu je
  výslovně „živá integrace NEOVĚŘENA – produkce zůstává vypnutá, zapnutí vyžaduje nejdřív živou akceptaci“.
* **G6** Production env výslovně `SLACK_INTEGRATION_ENABLED=0`, `TELEGRAM_INTEGRATION_ENABLED=0` (plain, jen Production). Žádná jiná nová produkční proměnná
  (pokud ji kód s vypnutými přepínači vyžaduje, je to chyba – oprav kód).
* **G7** `CONFIRM_NOTIFY=twjlnsxjtuntujarwner scripts/apply-notify-hosted.sh`: záloha `pg_dump` → `/Volumes/WORKSPACE/_G2_BACKUP/<datum>-v1-pre-notify` + SHA256SUMS,
  1 transakce, otisk `notifications`/`external_resource_links`/`google_connections`/`integration_audit`/`server_trust` beze změny.
* **G8** starý build na 1500: `check-deployment.sh` (EXPECT_DRIVE=1 EXPECT_GMAIL_OFF=1 EXPECT_CALENDAR_OFF=1) + `hosted-verify.sh` (E2E_EXPECT_GMAIL=off
  E2E_EXPECT_CALENDAR=off) + scénář přiřazení → in-app notifikace a realtime fungují.
* Merge `--no-ff` → `main` (z dočasného čistého stromu); `RELEASE_BRANCH=main EXPECT_GMAIL_MIGRATION=1 EXPECT_CALENDAR_MIGRATION=1 EXPECT_NOTIFY_MIGRATION=1
  CONFIRM_DRIVE_DEPLOY=<sha> deploy-drive-staged.sh deploy` → `check <staged>` (containment: všechny nové trasy 503, webhook nic nezpracuje, plánovač nic neodešle,
  `/settings` bez sekce, `/privacy` „není zapnuto“, bundle bez Slack/Telegram řetězců; `build.env` vs. produkce: jediné nové rozdíly = dva přepínače).
* `vercel promote` → `check-deployment.sh` (EXPECT_DRIVE=1 EXPECT_GMAIL_OFF=1 EXPECT_CALENDAR_OFF=1 **EXPECT_SLACK_OFF=1 EXPECT_TELEGRAM_OFF=1**) + `hosted-verify.sh`
  + `monograph-prodcheck.mjs` + runtime logy hned (Hobby ~1 h) + DB: 0 kanálů, 0 doručení, data vlastníka beze změny → push `main` + tagy (`run05-complete`).
* Selže-li brána: oprav příčinu a opakuj; nelze-li bezpečně, **před** produkční změnou zastav, **po** ní rollback dle runbooku (kód: `vercel promote dpl_FeGsSgZx…`;
  DB 1500 nevracet, dokud ji používá běžící kód) a zapiš.

### Phase 8 – dokumentace a handoff
`docs/run05/{RUN_PROMPT,AUDIT,DESIGN,DECISIONS,ARCHITECTURE_DECISION,NOTIFICATIONS,PRIVACY_AND_SECURITY,LIVE_ACCEPTANCE,PRODUCTION_ROLLOUT,PRODUCTION_ACCEPTANCE,HANDOFF_NEXT_RUNS}.md`,
aktualizace `docs/ROADMAP.md`, `docs/TECH_DEBT.md`. `PRODUCTION_ROLLOUT.md` §0: varianty zapnutí (A vypnuto / B pilot jen pro vlastníka / C veřejně) s přesnými
kroky (produkční Slack aplikace a distribuce, produkční bot + `setWebhook`, Vercel Sensitive proměnné, plánovač, privacy text) – vše jako budoucí rozhodnutí vlastníka.
Handoff: LATER seznam, vstupní body pro budoucí obousměrné zprávy a další poskytovatele (bez implementace).

## 5. Povinné edge cases (každý řádek = automatický test proti mocku **a** živý bod, kde to jde; jinak NOT VERIFIED s důvodem)
| # | Případ | Očekávané chování |
|---|---|---|
| N1 | Idempotence a dvojí zpracování | stejná událost × kanál = jedno doručení (unikátní klíč); dva souběžné odesílače nepošlou dvakrát (lease); opakované spuštění plánovače nic neduplikuje |
| N2 | Deduplikace `due_soon` | jednou na (uživatel, úkol, termín); změna termínu = nové; termín v minulosti / bez termínu = nic; přes DST (2027-03-28, 2027-10-31) a konec měsíce správný den |
| N3 | Ztráta přístupu mezi zařazením a odesláním | odebraný člen, smazaný projekt/úkol, změna na roli bez přístupu → `cancelled`, nic neodejde |
| N4 | Retry a rate limit | 429 respektuje `Retry-After`/`retry_after`; 5xx/timeout → backoff do max. pokusů, pak `failed` (viditelné v nastavení); dávka 20 bez ztrát; per-cíl a globální limit |
| N5 | Trvalé chyby | Slack `invalid_auth`/`token_revoked`/`account_inactive`, Telegram 403 blokace → kanál „znovu připojit“, čekající doručení zastavena, žádné další pokusy |
| N6 | Nejednoznačné odeslání | timeout po odeslání požadavku → chování dle ADR, zdokumentováno a testováno |
| N7 | Injekce do textu | `<!channel>`, `<@U…>`, `<https://x|y>`, HTML, Markdown, nulové a řídicí znaky, 300+ znaků → doslovný bezpečný text, oříznutí, žádné zmínky/náhledy |
| N8 | Únos Telegram propojení | token jednorázový, krátká platnost, uložen jako hash; replay odmítnut; jen `private` chat; do potvrzení v ClearSpace se nic neposílá; cizí `/start` bez tokenu ignorován |
| N9 | Slack OAuth | podvržený/expirovaný/cizí `state` odmítnut; odmítnutý souhlas = beze změny; dva uživatelé téhož workspace: odpojení jednoho nezruší druhého |
| N10 | Preference | vypnutý typ, vyloučený projekt, vypnutý kanál, „bez názvů“ – vše platí i pro už zařazená doručení (kontrola před odesláním) |
| N11 | Přepínače OFF | všechny trasy 503 jako první krok; webhook nic nezpracuje; plánovač nic neodešle; UI sekce skrytá; žádné odchozí síťové volání (test s mockem počítá požadavky = 0) |
| N12 | Parita in-app | migrace 1500 i nový kód nemění řádky `notifications` z akcí uživatelů; selhání zařazení nikdy neshodí původní transakci |
| N13 | Tajemství a logy | grep logů, auditu, chybových odpovědí, bundle a gitu: 0 tokenů, chat/user/team id, textů zpráv |
| N15 | Plánovač: souběh a výpadek | dva běhy současně = jedno odeslání; běh přerušený uprostřed (kill) → další běh dokončí bez duplicit; výpadek X hodin → dohánění dle M4, staré připomínky po termínu se neposílají |
| N16 | Výpadek poskytovatele vs. in-app | Slack/Telegram 5xx/timeout/nedostupný → in-app notifikace, zvonek a realtime beze změny; outbox čeká a po obnovení doručí |
| N17 | Due date: CET/CEST a změny | připomenutí v 09:00 místního času v den před termínem i v týdnech přechodu; změna termínu, dokončení, smazání karty, odebrání přiřazení i přístupu → zrušení |
| N14 | Životní cyklus účtu | smazání účtu, odchod z projektu, smazání projektu → kaskáda kanálů/preferencí/doručení; odpojení revokuje (Slack) / odlinkuje (Telegram) |

## 6. Kdy se zastavit (jediné případy)
(a) OWNER SESSION v Phase 0 (jednou, sloučeně) · (b) krok vyžaduje něco mimo schválení §0 (produkční Slack/bot, zapnutí v produkci, tunel, nová závislost,
placená služba, odesílání do kanálů nebo soukromého obsahu) · (c) kritický bezpečnostní nález, který nelze v rozsahu bezpečně opravit · (d) produkční brána selže
a oprava není bezpečně možná · (e) oprava by vyžadovala změnit chování in-app notifikací, rolí, Drive, Gmailu nebo Kalendáře. Ve všech ostatních případech rozhodni,
zapiš a pokračuj.

## 7. Závěrečná zpráva (česky, stručně)
Tabulka fází: výsledek (PASS/FAIL/BLOCKED/NOT VERIFIED) · důkaz (příkaz, počty). Rozhodnutí (odkaz na `DECISIONS.md`). Tabulka N1–N17: mock / živě.
**Přesný stav:** `main` (SHA), commity běhu, tagy, migrace (lokálně i produkční DB marker), produkční deployment (id, commit, rollback bod), přepínače
Gmail/Kalendář/Slack/Telegram, výsledky testů s počty (Vitest, DB, HTTP sady, E2E, produkční kontroly, hosted). Omezení, regrese (žádná se nezamlčuje), zbývající
technický dluh, skutečně neověřené případy, **všechny zbývající manuální kroky vlastníka**. Aktualizuj `docs/ROADMAP.md`, `docs/TECH_DEBT.md` a `docs/run05/HANDOFF_NEXT_RUNS.md`.
