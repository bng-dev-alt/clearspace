# RUN 03 – Gmail: živá akceptace (checklist pro vlastníka)

Stav: **PROVEDENO 2026-11-25 (RUN 03B) – PASS**, výsledky v §E. Tag `run03-complete` po PASS. Mock výsledky jsou zvlášť v `GMAIL.md` §5.
Testovat jen s vlastním testovacím Gmail účtem a neškodnými e-maily (např. pošlete si 2–3 zprávy s předmětem „ClearSpace test“).

## A. Jednorázové kroky v Google Cloud – DEV projekt (z RUN 02B), dělá vlastník
1. **APIs & Services → Library → Gmail API → Enable.**
2. **OAuth consent screen → Data access → Add scopes** → `https://www.googleapis.com/auth/gmail.readonly` (zobrazí se jako restricted). Stav aplikace ponechat **Testing**; váš účet musí být mezi *Test users*.
3. **Credentials → OAuth 2.0 Client (Web, ten z RUN 02B) → Authorized redirect URIs** → přidat `http://127.0.0.1:3451/api/google/oauth/callback`
   (a `http://127.0.0.1:3451` do *Authorized JavaScript origins*, kvůli Pickeru). *Alternativa bez změny URI: spustit aplikaci na 3441 – jen když neběží RUN 02 aplikace.*
4. Nic dalšího neměňte (žádné publikování, žádné ověření).

> `gmail-live.sh verify` dnes potvrzuje, že Google **přijímá klienta + secret** (token endpoint). Neautentizovaná sonda auth endpointu
> ale může přesměrovat na přihlášení i při chybném redirect URI – registrace 3451 tím **není prokázaná**; prokáže ji až bod 2 níže.

## B. Spuštění (jeden odkaz, bez hesel)
```
frontend/scripts/gmail-stack.sh up        # jen pokud stack neběží
frontend/scripts/gmail-live.sh verify     # klient + secret přijaty Googlem (hodnoty z Keychainu, nikdy se nevypisují)
frontend/scripts/gmail-live.sh app        # http://127.0.0.1:3451/settings?login=auto  (skutečný Google; mock nesmí běžet souběžně)
```
Jedna instance = jedna DEV identita (alice, vlastník projektu `project-collab-demo`). Bod 10 (druhý uživatel) je volitelný: druhý prohlížečový
profil s ručním přihlášením jiného syntetického účtu, nebo ho zapište jako NOT VERIFIED.

## C. Checklist (zapisujte PASS / FAIL / NOT VERIFIED; nic nepočítat z mocku)
| # | Krok | Očekávání |
|---|---|---|
| 1 | Propojené účty: pokud je Drive připojený z 02B, svítí „Google Disk: Povoleno“, Gmail „Nepovoleno“ | stav služeb zvlášť |
| 2 | **Připojit Gmail** → skutečná obrazovka Google: jen Gmail (číst e-maily), účet předvybraný | návrat „Gmail je připojený (jen čtení)“; žádné `redirect_uri_mismatch` |
| 3 | Na obrazovce Google Gmail **odškrtnout** (nebo Zrušit) | „Přístup ke Gmailu nebyl povolen…“, Disk dál „Povoleno“, Drive Picker funguje |
| 4 | Znovu připojit Gmail a povolit | služby Disk + Gmail; v DB `scopes` obsahuje `drive.file` i `gmail.readonly` |
| 5 | Projekt → Soubory a e-maily → **Připojit e-mail** → hledat „ClearSpace test“ | výsledky z vaší schránky, stránkování funguje |
| 6 | Vybrat konverzaci → Připojit k projektu; vybrat zprávu → připojit k úkolu | řádky s předmětem / odesílatelem (jméno nebo doména) / datem / počtem |
| 7 | Náhled (oko) | text zprávy, HTML jako prostý text, žádné obrázky; „Otevřít v Gmailu“ otevře správné vlákno (účet 0) – zapsat výsledek |
| 8 | **Drive Picker po zapnutí Gmailu** | Picker se otevře (server log: `narrow_token … "extra":0`). Pokud 503 „Výběr z Disku se nepodařilo bezpečně připravit“ → Google nepodporuje zúžení; zapsat FAIL a Gmail vypnout |
| 9 | Duplicitní připojení | „už byl připojený“ |
| 10 | Realtime (druhý profil/uživatel) | připojení a odebrání bez reloadu; druhý uživatel **nemá** náhled |
| 11 | Aktivita | „připojil(a) … e-mailovou konverzaci z Gmailu“, bez předmětu |
| 12 | Smazat zprávu v Gmailu → Obnovit informace | stav „už ve schránce … není“ |
| 13 | Přesunout do koše → Obnovit | „v koši Gmailu“ |
| 14 | Expirace access tokenu (počkat > 1 h, nebo `UPDATE google_connections SET access_expires_at = now()`) → hledat | funguje, `token_version` +1 |
| 15 | **Vypnout Gmail v ClearSpace** (bez mazání) | Gmail volání stop, Disk funguje, Picker funguje; text upozorňuje, že grant u Googlu zůstává |
| 16 | myaccount.google.com/permissions | ClearSpace (dev) stále uvedena s Gmail – potvrzuje „grant-level“ chování |
| 17 | Znovu zapnout Gmail; pak **Odpojit Google účet** | `revokedAtGoogle: true`; Disk i Gmail pryč; odkazy zůstanou s metadaty |
| 18 | (volitelně) `google-live.sh revoke-check` analogie pro Gmail | starý refresh token → `invalid_grant` |
| 19 | Server log (`$TMPDIR/cs-gmail-app*.log` / terminál) | žádné tokeny, `code=`, těla e-mailů, adresy, Gmail id, `/api/gmail/search?` |
| 20 | Klasika + Monograph, desktop + mobil, světlý/tmavý | bez horizontálního scrollu, žádný štítek „simulace“ |
| – | NEOVĚŘITELNÉ v dev: Workspace účet s blokací správcem (očekávané 403 „…zakázal správce“), 7denní expirace Testing, druhý skutečný Google účet | zapsat NOT VERIFIED |

## D. Po PASS
`git tag -a run03-complete -m "RUN 03 live acceptance PASS"` na commitu, kde akceptace proběhla; výsledky zapsat do `GMAIL.md` §5 (sloupec LIVE).

## E. Výsledky RUN 03B (2026-11-25, skutečný Google, projekt `clearspace-dev`, Testing, test user vlastníka)
Prostředí: větev `feature/run03-gmail` po merge `run02c-complete`, aplikace `gmail-live.sh app` (3451, stack `cs-gmail-sb`, DEV identita alice).
Testovací data: 3 syntetické e-maily „ClearSpace test 1–3“ odeslané z testovacího účtu sám sobě (1: čeština + HTML, 2: vlákno 2 zpráv, 3: ke smazání).

**Kroky v Google Cloud (provedeno se souhlasem vlastníka, jen dev projekt):** Gmail API zapnuto; Data access → `gmail.readonly` (restricted);
OAuth klient „ClearSpace Dev Web“ + redirect `http://127.0.0.1:3451/api/google/oauth/callback` a origin `http://127.0.0.1:3451`; Picker API klíč
„ClearSpace Dev Picker“ + web restriction `http://127.0.0.1:3451/*`. Stav Testing ponechán, nic publikováno. Zjištění: dřívější `verify`
„redirect accepted“ nebylo důkazem – 3451 opravdu chyběla (potvrzeno v konzoli).

| # | Výsledek | Důkaz |
|---|---|---|
| 1 | PASS | po připojení Disku: „Google Disk: Povoleno“, „Gmail: Nepovoleno“, bez štítku simulace |
| 2 | PASS | obrazovka Google žádala jen „Zobrazení e-mailových zpráv a nastavení“, účet předvybraný (`login_hint`), žádné `redirect_uri_mismatch`; „Gmail je připojený (jen čtení)“ |
| 3 | PASS (odmítnutí) | „Zrušit“ na obrazovce Google → „Připojení bylo zrušeno – v Google jste přístup nepovolili.“, Disk Povoleno, spojení `active`, nic nerevokováno; audit `denied`. **NOT VERIFIED:** odškrtnutí checkboxu – Google pro jediný nový scope checkbox nezobrazil |
| 4 | PASS | `scopes` = `openid`, `userinfo.email`, `drive.file`, `gmail.readonly`; audit `service_added gmail` |
| 5 | PASS | výchozí výpis 10 konverzací, Další/Předchozí stránkování; filtr Předmět „ClearSpace test“ → přesně 3 konverzace |
| 6 | PASS | 3 konverzace k projektu, zpráva „Re: ClearSpace test 2“ k úkolu; řádky: předmět, jméno odesílatele (bez adresy), datum, počet |
| 7 | PASS | náhled test 1: čeština bez poškození, použita textová část, 0 `<img>`/`<iframe>`; „Otevřít v Gmailu“ (`#all/<hex>`) otevřelo správné vlákno (Gmail přepíše na své nové id) |
| 8 | **PASS – kritická brána** | `gmail_live_gate.mjs`: Picker token podle Google tokeninfo = `openid email userinfo.email drive.file`, Gmail API s ním **403**, Drive API 200; log `narrow_token … "extra":0`; Picker se na 3451 skutečně otevřel |
| 9 | PASS | opakované připojení → „Jeden e-mail už byl připojený.“ (v DB stále 3) |
| 10 | PASS (API + realtime kanál) | bob (Editor) i vera (Čtenář): vidí 4 odkazy, žádná adresa ani Gmail id, soukromá tabulka 42501, náhled **403 `not_owner`**; Bobův odběr soukromého kanálu projektu dostal `links delete` (jen id) a aktivitu bez předmětu. Druhý *prohlížeč* nebyl použit (DEV login = 1 identita na proces); UI realtime pokrývá E2E proti mocku |
| 11 | PASS | `activity_logs`: `email_linked/unlinked` s `kind`, `link_id`, u úkolu název karty – nikdy předmět e-mailu |
| 12 | PASS | trvalé smazání test 3 v Gmailu → Obnovit → „E-mail už ve schránce … není. Zůstávají jen uložené základní údaje.“ |
| 13 | PASS | přesun test 3 do koše → Obnovit → „E-mail je v koši Gmailu toho, kdo ho připojil.“ |
| 14 | PASS | `access_expires_at` do minulosti → hledání 200, `token_version` 2 → 3 |
| 15 | PASS | Vypnout Gmail (bez mazání): Gmail 409, Disk Povoleno, Picker token stále jen Drive (tokeninfo + Gmail 403), Picker otevřen |
| 16 | PASS | myaccount.google.com: ClearSpace Dev dál uvádí „Zobrazení e-mailových zpráv a nastavení“ – grant-level chování potvrzeno |
| 17 | PASS | znovu zapnout Gmail → `gmail-live.sh revoke-check`: `revokedAtGoogle: true`, řádek spojení smazán, 4 e-mailové odkazy zůstaly s metadaty |
| 18 | PASS | starý refresh token před odpojením 200, po odpojení **400 `invalid_grant`** |
| 19 | PASS | log živé aplikace: 0× token/`code=`/adresa/tělo/Gmail id/`/api/gmail/search?`/předmět (jediný výskyt „GOCSPX“ = popisek formátu v launcheru) |
| 20 | PASS | Monograph desktop světlý, Monograph mobil tmavý, Klasika mobil světlý, Klasika desktop tmavý: bez horizontálního scrollu a přetečení, bez „simulace“ |
| – | NOT VERIFIED | druhý skutečný Google účet, Workspace účet s blokací správcem, 7denní expirace Testing, odškrtnutí checkboxu |

**Zjištění během akceptace:** 2× vypršela výměna kódu za token (10 s bez odpovědi Google, `httpStatus 0`) při souběžném klikání
v panelu; aplikace selhala bezpečně (nic neuložila ani nerevokovala), třetí pokus 337 ms. Doplněna diagnostika `reason` (jen třída síťové chyby).

## F. Neověřené živé okrajové případy (stav po RUN 03C, evidovat zvlášť; nic z toho se nepočítá z mocku)
| Případ | Proč neověřeno | Kdy ověřit |
|---|---|---|
| Odškrtnutí checkboxu Gmail na obrazovce Google (granulární souhlas) | Google pro jediný nový scope checkbox nezobrazil | až bude Gmail žádán spolu s jinou službou |
| Druhý skutečný Google účet (`account_mismatch`, izolace dvou schránek) | jeden testovací účet | před jakýmkoli zapnutím Gmailu mimo dev |
| Workspace účet s Gmailem zakázaným správcem (403) | žádný Workspace účet | varianta C (interní aplikace) |
| 7denní expirace autorizace v režimu Testing | vyžaduje čekání 7 dní | při dalším live běhu po ≥ 7 dnech |
| Realtime u druhého uživatele ve skutečném druhém prohlížeči | DEV login = 1 identita na proces (ověřeno kanálem + E2E proti mocku) | volitelně |
| Gmail v produkci | záměrně vypnutý (varianta A) | jen po novém rozhodnutí vlastníka |
