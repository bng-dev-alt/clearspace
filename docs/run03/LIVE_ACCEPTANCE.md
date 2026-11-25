# RUN 03 – Gmail: živá akceptace (checklist pro vlastníka)

Stav: **NEPROVEDENO** – blokováno kroky v Google Cloud (níže). Vše v `GMAIL.md` §5 je mock. Tag `run03-complete` až po PASS tohoto checklistu.
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
