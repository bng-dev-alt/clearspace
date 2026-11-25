# RUN 02C – Google Drive: produkční rollout a akceptace

Stav **2026-11-25 (večer)**: **NASAZENO A AKCEPTOVÁNO.** Google Drive běží v produkci na **https://clearspace.luffast.com** jako
**omezený pilot** (OAuth v režimu *Testing*). Výsledek rolloutu: §0. Oddíly 1–12 níže jsou záznam přípravy (stav PŘED rolloutem).
Kandidát: větev `release/run02-google-drive` (worktree `V1-drive-release`), z `run02-complete` (`ca6cd29`) + commity RUN 02C.
Mock výsledky nejsou live důkaz; každá položka je označena **LIVE** / **MOCK** / **LOCAL** / **NOT RUN**.

## 0. Výsledek rolloutu (2026-11-25)
| Gate | Co se stalo | Důkaz |
|---|---|---|
| G1 | Google projekt `clearspace-prod` (Testing, test users vlastníka), Drive API + Picker API, Web klient, Picker API key | vlastník; `/o/oauth2/v2/auth` s produkčním klientem, redirect URI a 3 scopes → 302 na přihlášení (žádný `redirect_uri_mismatch`/`invalid_client`) |
| G2 | doména připojena k projektu `clearspace`; Cloudflare `CNAME clearspace → …vercel-dns-017.com` (DNS only, jediný nový záznam) | `domain-cutover.sh verify`: HTTPS 200, platný certifikát, Vercel `misconfigured: false` |
| G3 | `set-google-keys.sh` (skryté výzvy): `GOOGLE_*` (6) + `PRIVACY_CONTROLLER`, `PRIVACY_CONTACT_EMAIL` v Production; žádné DEV/mock proměnné | `deploy-drive-staged.sh preflight` PASS (jen názvy) |
| G4 | migrace 1200 na `twjlnsxjtuntujarwner`: záloha `/Volumes/WORKSPACE/_G2_BACKUP/20261125-v1-pre-drive` (448 KB, SHA256SUMS), 1 transakce, počty řádků beze změny, `marker=1 rls=4 client_token_access=0 anon_exec=0 links=0 connections=0`, `server_trust('google')` | výstup `apply-drive-hosted.sh` |
| G5 | `APP_BASE_URL=https://clearspace.luffast.com`; Supabase Auth allow-list obou `…/accept-invite?token=*` | `domain-cutover.sh plan` |
| G6 | staged `dpl_26oNU69rEMtEazEZpMk1pgf7hV8k` z čistého `git archive` commitu `32eb451` (`--build-env NEXT_PUBLIC_ENABLE_MONOGRAPH=1`); `build.env` = předchozí produkce + jen nové `GOOGLE_*`/`PRIVACY_*` | `check-deployment.sh` (EXPECT_DRIVE=1) **100/100** (první běh skončil souhrnným FAIL bez konkrétní položky – přechodná chyba `vercel curl`; dva další běhy PASS) |
| G7 | promote → produkce = `dpl_26oNU69r…`; Supabase Site URL = nová doména; `clearspace-ai.vercel.app` a `cearspace.vercel.app` → **308** na novou doménu (cesta i dotaz zachovány) | `check-deployment.sh https://clearspace.luffast.com` **100/100**; `hosted-verify.sh` **16/16** + realtime check PASS (3 jednorázové účty smazány, 0 zbytků); firewall `/api/ai/*` 403 na obou doménách |
| G8 | živá akceptace (§12) | vlastník: všech 11 ručních testů PASS; read-only kontrola DB + logů (§12) |
| G10 | merge `release/run02-google-drive` → `main` (fast-forward), push, tag `run02c-complete` | §13 |

## 1. Skutečný produkční stav (read-only audit 2026-11-25, PŘED rolloutem)
| Oblast | Stav | Odpovídá RUN 01? |
|---|---|---|
| Git | `origin/main` = `ebeaa70` = tag `run01-complete`; `feature/run02-google-drive` je čistý fast-forward (merge-base = `ebeaa70`, 15 commitů, 1 nová migrace) | ano |
| Produkční build | `dpl_6x1fgFaAeJJ2CaU8WMfJYtwJsZhW` (CLI, target production, `READY`), zdrojový kód = `78c2b7b`; `git diff 78c2b7b ebeaa70 -- frontend/src package*.json next.config.ts vercel.json` = 0 souborů | ano, bez driftu |
| Vercel projekt | `clearspace` (tým `bng-dev-alt`), root `frontend`, Node 24.x, Git deploy vypnutý; domény `clearspace-ai.vercel.app` (+ `cearspace.vercel.app` → 308) | ano |
| Vercel env (jen názvy) | 26 proměnných RUN 01 (AI, e-mail, STT, Supabase); **žádná `GOOGLE_*`, žádná DEV/mock** proměnná; `NEXT_PUBLIC_ENABLE_MONOGRAPH` jen jako `--build-env` | ano |
| Firewall | zapnutý, pravidlo **„Block legacy AI API“** (deny `/api/ai*`) aktivní; `/api/ai/improve` → 403 | ano |
| Health | `/` 200, `/login` 200, HSTS, CSP (`frame-ancestors 'none'…`), `X-Frame-Options: DENY`, `nosniff`; `check-deployment.sh` **PASS** | ano |
| DEV login v produkci | `POST /api/dev/login` → 404; **`GET` → 405** (prozradí existenci trasy, nic neumožní) → v kandidátovi opraveno na 404 pro všechny metody | ano (+ zpevnění) |
| Supabase | `twjlnsxjtuntujarwner`, Postgres 17.12; markery 0100…0900, 1000, 1100 (**1200 chybí**); RLS 26/26 tabulek; buckety `task-resources`, `meeting-audio` (privátní); Realtime `private_only = true`; Auth: Site URL `https://clearspace-ai.vercel.app`, Redirect `…/accept-invite?token=*`, Google login vypnutý, potvrzení e-mailu zapnuté, SMTP Resend; `server_trust`: `email`, `stt` | ano |
| Katalog | `05a193892518d6818fcce2ee9a3adb4a lines=2709` = repozitářový řetězec 0100–1100 (ověřeno, §5) | ano |
| Rollback bod | build `dpl_6x1fgFaAeJJ2CaU8WMfJYtwJsZhW`, commit `ebeaa70`/`78c2b7b`, DB katalog výše | – |

## 2. Doména `clearspace.luffast.com`
* Zóna `luffast.com`: Cloudflare (Free), aktivní. Subdoména **nepoužitá** (žádný záznam, NXDOMAIN, bez wildcardu). Neplete se s tunely
  `clearspace-dev.luffast.com` a `clearspace-origin.luffast.com` (jiná jména; ty se nemění). Vzor existuje: `microcrm.luffast.com` = CNAME na Vercel, *DNS only*.
* `luffast.com` je ve Vercel účtu **ověřená** → přidání subdomény do projektu nevyžaduje TXT výzvu. Vercel hlásí `conflicts: []`.
* **Přesný DNS záznam** (Cloudflare → luffast.com → DNS → Add record): `CNAME` · název `clearspace` · cíl `55517e6e972f6ddf.vercel-dns-017.com` ·
  Proxy status **DNS only** (šedý mráček) · TTL Auto. Nic jiného se v zóně nemění (apex, ostatní záznamy, pravidla).
* Kanonická doména: po promote `clearspace-ai.vercel.app` → **308** na `clearspace.luffast.com` (cesty i dotazy zachovány, staré odkazy
  z pozvánek fungují). Důvod: OAuth cookie (nonce) je vázaná na hostitele a redirect URI je jen jeden – spojení s Googlem musí začínat na
  kanonické doméně. Supabase Auth: allow-list obě `…/accept-invite?token=*`, Site URL nová doména. `APP_BASE_URL=https://clearspace.luffast.com`.
* Skript: `frontend/scripts/domain-cutover.sh plan|add-domain|verify|switch-env|switch-canonical|rollback` (zápisy jen s `CONFIRM_CUTOVER`).

## 3. Kód RUN 02C (kandidát) – jen v rozsahu RUN 02
| Změna | Proč |
|---|---|
| `/about` (domovská stránka aplikace) a `/privacy` (zásady) – veřejné, server-renderované, čitelné bez přihlášení i bez JS | Google: homepage nesmí být jen přihlašovací stránka, musí popsat aplikaci a odkazovat na zásady na stejné doméně |
| Zásady: přesně popsaná data z Google (jen vybrané soubory, ukládaná metadata, šifrované tokeny, týmový přístup ≠ přístup k obsahu, odpojení, odebrání odkazu, výmaz, žádný obsah Disku do AI, Limited Use prohlášení); správce a kontakt **jen ze serverových env** `PRIVACY_CONTROLLER`, `PRIVACY_CONTACT_EMAIL` (nic nevymyšleno, nic osobního v repozitáři); bez nich stránka uvede, že kontakt chybí, a staged brána neprojde | pravdivost, soukromí vlastníka |
| `GOOGLE_OAUTH_PUBLISHING` ≠ `production` ⇒ v Nastavení a u souborů hláška **„Omezený pilotní provoz: Google Disk zatím mohou připojit jen schválené testovací účty Google…“** | Testing režim se nevydává za veřejnou funkci |
| `/api/dev/login` → 404 i pro GET/PUT/PATCH/DELETE | produkce odpovídala 405 (existence trasy) |
| **Monograph = výchozí vzhled v každém buildu** (`NEXT_PUBLIC_ENABLE_MONOGRAPH` už není potřeba; vypíná jen `=0`; uložená volba Classic se respektuje) | požadavek vlastníka; zároveň odstraňuje riziko z 2026-11-25 (build bez `--build-env` ztratil Monograph) |
| Odkaz „O aplikaci · Ochrana osobních údajů“ na přihlašovací stránce, odkaz na zásady v kartě Google | dostupnost zásad |
| Skripty: `rehearse-drive-prod.sh`, `domain-cutover.sh`, `deploy-drive-staged.sh`; `check-deployment.sh` (`EXPECT_DRIVE=1`); `set-google-keys.sh` (tělo požadavku přes stdin – žádný dočasný soubor; odmítne DEV client ID/secret/Picker key; volitelný kontakt správce) | provozní brány, poučení z RUN 02B |
Migrace 1200 **beze změny** (checksum `8c0b4b06…` = nacvičený soubor).

## 4. Google Cloud – produkční projekt (dělá vlastník; ověřeno proti kódu a oficiální dokumentaci)
Scopes v kódu (`src/lib/google/config.ts`): `openid`, `email` (Google vrací `https://www.googleapis.com/auth/userinfo.email`),
`https://www.googleapis.com/auth/drive.file`. Redirect URI se staví **jen** z `APP_BASE_URL` + `/api/google/oauth/callback`; Picker:
`setAppId(GOOGLE_CLOUD_PROJECT_NUMBER)`, API key v prohlížeči. DEV projekt `clearspace-dev-515810` a jeho klíče se **nemění**.

1. Nový projekt **`clearspace-prod`**: https://console.cloud.google.com/projectcreate (Project ID přidělí Google; dále `<PROD_ID>`).
2. Zapnout jen **Google Drive API** a **Google Picker API**:
   https://console.cloud.google.com/apis/library/drive.googleapis.com?project=<PROD_ID> · https://console.cloud.google.com/apis/library/picker.googleapis.com?project=<PROD_ID>
3. **Branding** (https://console.cloud.google.com/auth/branding?project=<PROD_ID>): App name `ClearSpace`; User support email = sledovaná adresa vlastníka;
   App home page `https://clearspace.luffast.com/about`; Privacy policy `https://clearspace.luffast.com/privacy`; Authorized domain `luffast.com`;
   Developer contact = adresa vlastníka. Logo jen při ověření značky (čtverec 120×120 px, ≤ 1 MB).
4. **Audience** (…/auth/audience): User type **External**; pilot = *Testing* + Test users (vlastníkovy účty Google).
5. **Data access** (…/auth/scopes): přesně `openid`, `…/auth/userinfo.email`, `…/auth/drive.file`. Nic jiného (žádný Gmail, Calendar, `drive`, `drive.readonly`).
6. **Client** (…/auth/clients → Create client → *Web application*, název `ClearSpace production`):
   Authorized JavaScript origins `https://clearspace.luffast.com` · Authorized redirect URIs **`https://clearspace.luffast.com/api/google/oauth/callback`**
   (přesná shoda, bez lomítka na konci; **ne** `clearspace-ai.vercel.app`, ne localhost).
7. **API key** (https://console.cloud.google.com/apis/credentials?project=<PROD_ID> → Create credentials → API key): Application restrictions *Websites*:
   `https://clearspace.luffast.com/*` a `https://docs.google.com/*` (Picker běží v iframu z docs.google.com); API restrictions: **jen Google Picker API**.
8. **Project number** (Project settings): zadá se do `set-google-keys.sh` (skript ho ověří jako číslo).
9. **Search Console** – ověření vlastnictví `luffast.com` (Domain property, TXT záznam v Cloudflare): https://search.google.com/search-console – nutné jen pro
   **ověření značky** (zobrazení názvu/loga); v zóně dnes žádný `google-site-verification` záznam není.
Tajemství se zadávají jen do skrytých výzev `frontend/scripts/set-google-keys.sh` (nikdy do chatu, souboru ani repozitáře).

## 5. Google pravidla (oficiální dokumentace, ověřeno 2026-11-25)
* `drive.file`, `openid`, `email` jsou **nesenzitivní** scopes; ověření aplikace (sensitive/restricted) ani bezpečnostní audit CASA **nejsou potřeba**
  (developers.google.com/workspace/drive/api/guides/api-specific-auth; support.google.com/cloud/answer/13463073; developers.google.com/terms/api-services-user-data-policy).
* **Testing:** max. 100 testovacích uživatelů; autorizace **vyprší za 7 dní** (platí i pro tuto aplikaci, protože žádá `drive.file`)
  (support.google.com/cloud/answer/15549945; developers.google.com/identity/protocols/oauth2).
* **In production** bez ověření: pro čistě nesenzitivní scopes Google neuvádí varování „neověřená aplikace“ ani limit uživatelů; souhlas ukáže
  **doménu místo názvu aplikace**. **Ověření značky** (název + logo): homepage na ověřené doméně, ne jen login, popis aplikace + odkaz na zásady;
  zásady na stejné doméně; authorized domain ověřená v Search Console; ruční kontrola obvykle 2–3 pracovní dny (bez záruky)
  (developers.google.com/identity/protocols/oauth2/production-readiness/brand-verification; support.google.com/cloud/answer/15549049).
* **User Data Policy:** platí pro všechny aplikace (zásady, přesné zveřejnění, bezpečné uložení, nový souhlas pro nové použití). **Limited Use**
  je formálně pro sensitive/restricted scopes; prohlášení přesto uvádíme (budoucí Gmail). Odvolání: `POST https://oauth2.googleapis.com/revoke`
  (implementováno, RUN 02B live), uživatel: myaccount.google.com/permissions; po odvolání tokeny trvale smazat (děláme).
* Redirect URI/origins: https, bez zástupných znaků, přesná shoda; změny v konzoli se projeví za 5 min až několik hodin (support.google.com/cloud/answer/15549257).
* Další limit: 100 refresh tokenů na účet Google a klienta (nejstarší se zneplatní) – pro ClearSpace (1 připojení na uživatele) nepodstatné.

**Doporučení:** (A) pilot v *Testing* jen s účty vlastníka pro živou akceptaci → (B) po akceptaci **publikovat „In production“** (bez ověření;
odpadne 7denní expirace a limit 100) a nastavit `GOOGLE_OAUTH_PUBLISHING=production` + redeploy → (C) volitelně ověření značky (název/logo na
souhlasu) – vyžaduje Search Console. (B) a (C) jsou samostatné body schválení; bez (B) aplikace pravdivě ukazuje „omezený pilot“.

## 6. Nácvik migrace 1200 (bez zápisu do produkce) – **LOCAL na replice produkčního schématu: PASS**
`frontend/scripts/rehearse-drive-prod.sh` (produkce jen čtena: katalog, markery, `pg_dump --schema-only` schématu `public`; žádná data neopustila produkci):
1. Produkce: markery končí 1100, žádné Drive objekty, katalog `05a19389… lines=2709`.
2. Replika A (baseline + 0100–1100 z repozitáře) **== produkční katalog** (11 interních triggerů hostované služby Storage vyloučeno – nejsou z ClearSpace).
3. Replika B (produkční DDL obnovené ze schema-only dumpu + syntetická data, role `postgres` bez superuser) **== produkční katalog**; skutečný
   `apply-drive-hosted.sh` v režimu nácviku: zálohy, 1 transakce, počty řádků beze změny, `marker=1 rls=4 client_token_access=0 anon_exec=0`.
4. Drive DB suite (73 asercí: RLS, role, server trust, izolace účtů, události, realtime signály, kaskády) na produkčním DDL: PASS.
5. Rollback **odmítnut**, dokud existuje odkaz (nic se nezměnilo); na čistém stavu vrátí katalog **přesně** na produkční 1100; 1200 jde znovu aplikovat; data beze změny.
Pozorování: běh testů v JEDNÉ transakci hlásil falešné FK chyby při kaskádovém mazání účtu (Postgres znovu kontroluje řádky vložené ve stejné
transakci). Ve skutečném režimu (oddělené požadavky) smazání účtu i projektu s Drive odkazy na obou replikách prochází – nejde o chybu produktu.

## 7. Bezpečnostní a regresní brána (kandidát `release/run02-google-drive`)
| Brána | Výsledek | Typ |
|---|---|---|
| Unit | **1278/1278** | LOCAL |
| Typecheck / lint | 0 chyb / 0 chyb (3 starší varování) | LOCAL |
| Produkční build s **nastraženými DEV příznaky** (`CLEARSPACE_DEV_LOGIN`, `NEXT_PUBLIC_DEV_LOGIN`, `…AUTO_LOGIN`, falešné heslo) | build OK; bundle guard **48/48**; falešné heslo nikde v `.next`; `next start`: `/api/dev/login` **404 pro GET/POST/PUT/PATCH/DELETE**, žádné DEV tlačítko; `/privacy` + `/about` server-renderované; bezpečnostní hlavičky | LOCAL |
| DB harness | **2231 asercí PASS** (vč. Drive, rollback 1200, hosted role, drift, souběh) | LOCAL |
| Drive HTTP suite | **28/28** (state, PKCE, session binding, CSRF, izolace, šifrování, zámek obnovy, revokace, logy) | MOCK |
| Realtime / spolupráce / pozvánky | `collab_realtime` **64/64**, `realtime_check` PASS, `invite_email` **41/41** | LOCAL stack |
| Browser E2E (stack) | `google-drive` Classic + Monograph PASS, `collaboration` PASS, `collaboration-01b` PASS, `task-resources` 5/6, `supabase-runtime` 3/4, `dev-login-stack` 3/3 | MOCK + LOCAL |
| Browser E2E (demo režim) | **27 passed / 0 failed** (117 skipped = potřebují stack) | LOCAL |
| Live specy proti **skutečnému Googlu** (dev projekt) na kandidátovi | `google-drive-live-ui` Classic 2/2 + Monograph 2/2, `google-drive-live-doc` 1/1 (náhled nativního Dokumentu, obnova po přejmenování, otevření originálu) | **LIVE (dev)** |
| Logy | real-Google dev log: 0× `code=`; OAuth fáze bez tokenů/kódů/cookies | LIVE (dev) |
| Známý dluh | **TD-1** (`supabase-runtime` 400 vs 403) a **TD-2** (`task-resources` optimistická karta) – **stále baseline**, nic nového | – |
Kontrolní body bezpečnosti (state, PKCE, session binding, CSRF, RLS, role, server trust, izolace účtů, šifrování, zámek obnovy, revokace, bezpečné
logování, výstup, CSP, origin, URL) – beze změny proti RUN 02/02B; kandidát přidal jen statické stránky, hlášku a 404 trasy.

## 8. Staged deployment (provedeno, viz §0 G6)
`frontend/scripts/deploy-drive-staged.sh preflight` (dnes správně FAIL: chybí `GOOGLE_*`, `PRIVACY_*`, migrace 1200) → `deploy` (čistý `git archive`,
`vercel deploy --prod --skip-domain --build-env NEXT_PUBLIC_ENABLE_MONOGRAPH=1 --meta releaseCommit=<sha>`) → `check <staged-url>` (porovnání `build.env`
s produkcí, `check-deployment.sh` s `EXPECT_DRIVE=1`: firewall, hlavičky, DEV login 404, `/privacy` s kontaktem, `/about`, Google trasy 401/405, žádný mock, bundle).
**OAuth na staged URL neověřitelný** (není v redirect URI a `APP_BASE_URL` míří na kanonickou doménu) → OAuth akceptace až po promote; nerozšiřujeme kvůli tomu trust boundary.

## 9. Pořadí rolloutu (brány; selhání = stop, diagnostika, případně rollback §11)
| # | Krok | Kdo | Brána |
|---|---|---|---|
| G1 | Google Cloud §4 (projekt, API, branding, audience Testing + test users, scopes, klient, API key) | vlastník | hodnoty dle §4 |
| G2 | `domain-cutover.sh add-domain` + DNS CNAME (§2) → `verify` | agent po schválení (DNS přes Cloudflare API) | HTTPS 200, platný certifikát; stávající build na nové doméně |
| G3 | `set-google-keys.sh` (skryté výzvy; vytiskne jen SHA-256 serverového tajemství) | vlastník | `deploy-drive-staged.sh preflight`: všechny názvy, žádné DEV/mock |
| G4 | Migrace: `CONFIRM_DRIVE=twjlnsxjtuntujarwner GOOGLE_SERVER_SECRET_SHA256=<z G3> frontend/scripts/apply-drive-hosted.sh` (záloha `pg_dump`, 1 transakce, ověření) | agent po schválení | `marker=1 rls=4 client_token_access=0 anon_exec=0 links=0 connections=0`; RUN 01 build ji ignoruje |
| G5 | `domain-cutover.sh switch-env` (APP_BASE_URL + allow-list obou domén) | agent po schválení | `plan` ukazuje nové hodnoty |
| G6 | `deploy-drive-staged.sh deploy` + `check <url>` | agent po schválení | PASS |
| G7 | `vercel promote <staged-url>` → `domain-cutover.sh switch-canonical` (Site URL, 308 z vercel.app) | agent po schválení | `check-deployment.sh https://clearspace.luffast.com` (EXPECT_DRIVE=1) PASS |
| G8 | Živá akceptace §12 (pilot, účty vlastníka) | vlastník + agent | matice §12 |
| G9 | (volitelně) publikovat OAuth „In production“ + `GOOGLE_OAUTH_PUBLISHING=production` + redeploy; ověření značky | vlastník + agent po schválení | souhlas bez „Testing“; hláška pilotu zmizí |
| G10 | Merge `release/run02-google-drive` → `main`, push, tag `run02c-complete` | agent po schválení | jen po G8 PASS |

## 10. Souhrnná žádost o schválení
> „Schvaluji RUN 02C pro `release/run02-google-drive` (HEAD větve = tag `run02c-ready` + commit „Monograph výchozí“): (1) přidání `clearspace.luffast.com` do Vercel projektu
> `clearspace` a CNAME `clearspace` → `55517e6e972f6ddf.vercel-dns-017.com` (DNS only) v zóně luffast.com; (2) změnu Production env `APP_BASE_URL` na
> `https://clearspace.luffast.com` a doplnění `GOOGLE_*`/`PRIVACY_*` přes `set-google-keys.sh`; (3) Supabase Auth: allow-list obou
> `…/accept-invite?token=*`, po promote Site URL na novou doménu; (4) migraci 1200 na `twjlnsxjtuntujarwner` skriptem `apply-drive-hosted.sh`;
> (5) staged build, kontroly a promote; (6) po promote 308 z `clearspace-ai.vercel.app` na novou doménu; (7) živou akceptaci s mými účty Google
> v režimu Testing; (8) po úspěšné akceptaci merge do `main` a push do GitHubu. Publikování OAuth aplikace „In production“ / ověření značky
> schvaluji zvlášť.“

## 11. Rollback
* **Kód (první volba, sekundy):** `vercel promote https://clearspace-9nczah0zw-bng-dev-alt-webadvisor.vercel.app --scope bng-dev-alt-webadvisor --yes`
  (`dpl_6x1fgFaAeJJ2CaU8WMfJYtwJsZhW`, RUN 01). RUN 01 build tabulky 1200 ignoruje; Google funkce zmizí, ostatní funguje.
* **Doména:** `domain-cutover.sh rollback` (bez 308, Site URL a allow-list zpět, `APP_BASE_URL` zpět – platí po dalším deployi); doména může zůstat připojená.
* **Vypnutí jen Google Disku:** smazat `GOOGLE_OAUTH_CLIENT_ID` (Production) + redeploy → integrace „není nastavená“ (fail closed), odkazy zůstanou čitelné.
* **Existující připojení:** dokud běží Drive build, uživatelé je odpojí (revokace u Google). Hromadné ukončení: v Google Cloud **smazat/vypnout OAuth
  klienta** `clearspace-prod` (všechny jeho tokeny přestanou platit) a/nebo odstranit `GOOGLE_TOKEN_ENCRYPTION_KEY` (uložené tokeny nelze dešifrovat).
* **Připojené soubory:** jsou to jen odkazy + metadata; v Google Disku se nic nemění. Ponechat (aditivní tabulka) je bezpečné.
* **DB rollback 1200 – jen když neexistují připojení ani odkazy** (skript to sám vynutí; jinak jen vědomě s `clearspace.rollback_allow_data_loss`).
  Pokud už existují skutečná data: **migraci ponechat, funkci vypnout, aplikaci vrátit** – destruktivní rollback není první volba. Záloha z G4
  v `/Volumes/WORKSPACE/_G2_BACKUP/<datum>-v1-pre-drive`.

## 12. Produkční živá akceptace (G8) – **PASS (pilot, Testing)**
| # | Test | Výsledek | Důkaz |
|---|---|---|---|
| 1–6 | stránka, přihlášení, projekty/úkoly, spolupráce, realtime, Google nakonfigurovaný | **LIVE PASS** | `check-deployment.sh` 100/100, `hosted-verify.sh` 16/16, realtime check |
| 7–8 | připojení Google na skutečné obrazovce, identita ClearSpace beze změny | **LIVE PASS** | vlastník; logy: `state_consumed → exchange_ok (refresh, id_token, driveGranted, 3 scopes) → identity_ok → saved → connected` |
| 9–13 | Picker, výběr, připojení k projektu i úkolu, duplicita | **LIVE PASS** (vlastník) | DB po testech: 1 odkaz (úkol, nativní Dokument, `docs.google.com`), 1 událost `drive_file_linked`. Projektové odkazy a duplicitní pokus v DB **nezůstaly** (žádná `drive_file_unlinked` událost → s největší pravděpodobností testovací projekt smazán kaskádou; z DB nelze nezávisle potvrdit) |
| 14–16 | náhled nativního Dokumentu, obnova metadat po přejmenování, otevření originálu | **LIVE PASS** (vlastník) | runtime logy z doby testu již nejsou k dispozici (Hobby plán drží ~1 h) |
| 17 | role (editor/čtenář) | **LIVE PASS** v RUN 02B (dev Google) + DB suite na produkčním DDL; v produkci samostatně **NOT VERIFIED** | – |
| 18 | izolace účtů s **druhým skutečným Google účtem** | **NOT VERIFIED** | druhý účet nebyl k dispozici |
| 19–21 | odpojení, revokace, znovupřipojení | **LIVE PASS** (vlastník) | audit: `connected=2, disconnected=1`; jedno aktivní připojení; vlastník ověřil zmizení z myaccount.google.com/permissions |
| 22 | zamítnutý souhlas („Zrušit“) | **LIVE PASS** (vlastník) | aplikace zamítnutí neaudituje (jen `scope_denied`); hláška ověřena vlastníkem |
| 23–24 | mobil + desktop, Classic + Monograph | **LIVE PASS** (vlastník) | – |
| 25 | žádný DEV login | **LIVE PASS** | `/api/dev/login` 404 pro GET/POST/PUT/PATCH/DELETE |
| 26 | žádná citlivá data v logách | **PASS (částečně)** | dostupné runtime logy (posledních ~60 min, 12 záznamů): 0× `code=`, `state=`, `GOCSPX`, `AIza`, `ya29.`, `1//`, JWT, e-mail, cookie; jen fázové řádky `{"evt":"google",…}`. Starší logy Vercel (Hobby) neuchovává – **nelze ověřit zpětně** |
DB po akceptaci (read-only): 1 připojení `active`, scopes přesně `drive.file`, `openid`, `userinfo.email`; refresh i access token jen jako `v1.…`
obálky (0 hodnot vypadajících jako token v čitelné podobě); 2 OAuth stavy (0 neprošlých neplatných); `server_trust`: email, google, stt;
markery končí 1200; projekty 18, karty 183, uživatelé 3 (beze změny proti stavu před rolloutem).

## 13. Známé problémy, omezení, otevřené body
* TD-1, TD-2 (baseline, `docs/TECH_DEBT.md`).
* **Pilot (Testing):** připojit se mohou jen test users v `clearspace-prod`; autorizace vyprší po 7 dnech (pak „Znovu připojit účet“); max. 100 test users;
  souhlas ukazuje doménu místo názvu. Veřejné publikování / ověření značky = samostatné rozhodnutí (G9, neschváleno).
* **NOT VERIFIED:** druhý skutečný Google účet (izolace účtů naživo), 7denní expirace refresh tokenu, Workspace účty a sdílené disky, role editor/čtenář
  v produkci, zpětná kontrola logů starších ~1 h (retence Vercel Hobby).
* **Picker API key** produkce se dostal do lokální historie shellu (řádek už odstraněn; klíč je omezený na Picker API + domény a je z principu
  doručován prohlížeči). Výměna připravena (`set-google-keys.sh rotate-picker`), **čeká na vlastníka** – postup ve finálním reportu RUN 02C / §11a.
* Rollback stále připraven (§11): předchozí build `dpl_6x1fgFaAeJJ2CaU8WMfJYtwJsZhW`, `domain-cutover.sh rollback`, záloha DB z G4.

## 11a. Výměna Picker API klíče (vlastník + agent)
1. Google Cloud → `clearspace-prod` → APIs & Services → Credentials → **Create credentials → API key**; stejná omezení jako původní
   (Websites: `https://clearspace.luffast.com/*`, `https://docs.google.com/*`; API: jen Google Picker API).
2. `frontend/scripts/set-google-keys.sh rotate-picker` → vložit NOVÝ klíč do skryté výzvy (skript odmítne DEV i současný klíč).
3. Agent: `deploy-drive-staged.sh deploy` z aktuálního `main` + `check` + promote (env se projeví až novým buildem).
4. Ověřit Picker na produkci; teprve pak v Google Cloud **smazat starý klíč**.

## 14. Handoff pro RUN 03 (Gmail)
Viz `docs/run02/HANDOFF_NEXT_RUNS.md` §RUN 02C – seznam změn, které RUN 03 musí převzít (RUN 02C je **neintegruje** do RUN 03 sám).
