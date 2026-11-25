# RUN 03 – Gmail: privacy model a bezpečnostní hranice

Rozhodnutí a zdroje: `ARCHITECTURE_DECISION.md`. Implementace: migrace `20261127001300_gmail.sql`, `src/lib/google/{gmail,mime,gmailLinks}.ts`,
routes `src/app/api/gmail/**`, UI `src/components/gmail/*`.

## 1. Privacy model (výchozí, konzervativní)

| Vrstva | Co obsahuje | Kdo to vidí | Kde je to vynucené |
|---|---|---|---|
| **Soukromá Gmail schránka** vlastníka připojení | vše | jen vlastník (Google) | Google; ClearSpace používá jen token vlastníka a jen na jeho žádost |
| **Sdílená metadata odkazu** (`external_resource_links`, provider `gmail_message` / `gmail_thread`) | předmět, odesílatel = **zobrazované jméno, jinak jen doména** (`@firma.cz`), datum (poslední zprávy), počet zpráv, počet příloh, stav (`ok` / `trashed` / `deleted`), kdo a kdy připojil | členové projektu (RLS `is_project_member`) | RLS, server-only zápis (RPC se server secret) |
| **Soukromý zdroj odkazu** (`gmail_link_sources`) | Gmail message/thread id, Google účet (`sub`) | **nikdo z klientů**; server jen pro vlastníka odkazu | RLS bez politik, žádné granty; RPC `gmail_link_source` vrací řádek jen vlastníkovi, který je stále členem projektu |
| **Obsah e-mailu** (text, odesílatel s adresou, přílohy – jen názvy) | náhled | **jen ten, kdo e-mail připojil, z vlastní schránky** | route `/api/gmail/links/:id/preview` → `ownSource` (vlastník + člen + stejný Google účet s Gmail oprávněním) → token vlastníka |
| **Aktivita projektu** | `email_linked` / `email_unlinked`: druh (zpráva/konverzace), id odkazu, název úkolu | členové | trigger z perzistovaného řádku; **bez předmětu** (odebráním odkazu nezůstane v historii nic) |
| **Realtime** | `{ t: 'links', op, card }` | členové (privátní klíčovaný topic z RUN 01B) | žádné názvy, předměty ani id Gmailu |

**Nikdy se neukládá**: tělo zprávy, snippet, adresy (From/To/Cc), názvy a obsah příloh, štítky, žádné Gmail id ve sdílené tabulce
(`external_id` = neprůhledný HMAC `gmail:<kind>:<sub>:<id>` klíčem `GOOGLE_SERVER_SECRET`, slouží jen k deduplikaci).

**Co uživatel vidí před připojením** (dialog i panel): „Členové projektu uvidí jen předmět, odesílatele (jméno, případně jen doménu),
datum, počet zpráv a příloh a kdo e-mail připojil. Obsah zpráv, adresy, přílohy a ostatní e-maily zůstávají jen ve vaší schránce –
náhled obsahu vidíte jen vy. ClearSpace v Gmailu nic nemění a neposílá.“

## 2. Role (vynucené v DB i v route; testováno)

| Akce | Vlastník projektu | Admin / editor | Čtenář | Odebraný člen | Cizí |
|---|---|---|---|---|---|
| Vidět sdílená metadata | ano | ano | ano | ne (RLS) | ne |
| Připojit e-mail (vlastní schránka, Gmail povolen) | ano | ano | ne | ne | ne |
| Odebrat odkaz (asociaci) | ano | ano | ne (RLS 0 řádků) | ne | ne |
| Náhled / obnovení / Otevřít v Gmailu | **jen vlastní odkazy** | **jen vlastní** | jen vlastní (nemůže žádné vytvořit) | ne | ne |
| Smazat **všechny své** e-mailové odkazy (purge) | ano | ano | odkazy v projektech, kde je čtenář, se přeskočí (viewer guard) a nahlásí | **ano** (i po odebrání) | — |

I **vlastník projektu nečte e-mail editora** – členství v ClearSpace nikdy nedává přístup ke schránce jiného uživatele.

## 3. Účty a identifikátory
* Token jednoho uživatele se nikdy nepoužije pro jiného: všechny Gmail routes berou `getAccessToken(…, { service: 'gmail' })` volajícího.
* Gmail id nejsou globální: odkaz je vázaný na Google účet (`sub`). Po přepnutí účtu server uložené id **nepoužije** (`same_account=false` → 409).
* Podvržené / cizí id: server je čte tokenem volajícího ⇒ v jeho schránce neexistuje ⇒ „not found“, nic se nepřipojí.
* Přidání Gmailu z jiného Google účtu, než je připojený → `account_mismatch`, nic se neuloží (zbytečný grant se zruší, pokud ho nic nepoužívá).

## 4. Obsah a náhled
* Preferován `text/plain`; HTML se **nikdy nevykresluje** – na serveru se jedním lineárním průchodem převede na text (zahodí `script/style/head/iframe/svg/object/template`, komentáře, všechny atributy včetně `src`/`href`) → vzdálené obrázky / tracking pixely se nikdy nenačtou, odkazy nejsou klikatelné.
* Znaková sada podle `Content-Type` části (windows-1250, ISO-8859-2, …), neznámá/vadná → UTF-8 s náhradními znaky; řídicí a bidi znaky odstraněny.
* Meze: hloubka MIME 12, 200 částí, HTML vstup 512 kB, text 20 000 znaků/zprávu, vlákno posledních 20 zpráv, odpověď Gmail ≤ 5 MB (jinak „příliš velký“).
* Přílohy: jen název, typ a velikost; `attachmentId` server nevrací; nic se nestahuje ani neotevírá.
* Obsah je **nedůvěryhodná data** (testováno s prompt-injection textem); v UI jen jako text v `<pre>`.

## 5. OAuth a tokeny (rozšíření RUN 02, beze změny kryptografie)
* PKCE S256, `state` vázaný na uživatele + prohlížeč (HttpOnly nonce) + jednorázový 10 min, kód nikdy v URL stránky, redirect URI jen z `APP_BASE_URL`.
* Služba se určuje ze **scopes uložených se state** (ne z klienta). `include_granted_scopes=true`, `login_hint` = připojený účet.
* Ukládá se jen to, co ClearSpace používá: identita + služby povolené zde (union od Googlu může obsahovat službu vypnutou v ClearSpace – ta zůstane vypnutá).
* Odmítnutý Gmail na granulární obrazovce: existující připojení **beze změny, nic se neruší** (revokace by ukončila i Disk). Revokace jen tehdy, když grant nic nepoužívá.
* Selže-li zjištění účtu (`google_connection_sub`), postup končí **bez uložení i bez revokace** (fail closed).
* **Token pro prohlížeč (Google Picker) je vždy zvlášť vydaný a omezený na Drive scopes** (refresh s `scope`), i když grant u Googlu obsahuje Gmail; když by Google vrátil víc, server odmítne (503). Uložený serverový token nikdy neopouští server.
* Šifrování AES-256-GCM, refresh lease, revokace – beze změny z RUN 02 (`docs/run02/GOOGLE_DRIVE.md` §3).

## 6. Vypnutí, odpojení, mazání (retention)
| Akce | Co se stane | U Googlu |
|---|---|---|
| **Vypnout Gmail v ClearSpace** (`DELETE /api/gmail/connection`) | ClearSpace přestane Gmail volat (scope odebrán z používaných); Disk funguje; náhledy nejdou | **grant zůstává** – Google neumí zrušit jeden scope; uživatel je o tom informován |
| … s volbou „odebrat i připojené e-maily“ (`?purge=1`) | smažou se **všechny** e-mailové odkazy tohoto uživatele (i v projektech, odkud byl odebrán) + soukromé zdroje | — |
| **Odpojit účet Google** | revokace celého grantu (Disk + Gmail), smazání tokenů | grant ukončen |
| Odebrání odkazu editorem | asociace a soukromý zdroj smazány; e-mail v Gmailu beze změny | — |
| Smazání uživatele | soukromé zdroje kaskádou; sdílená metadata zůstanou s `linked_by = NULL` | — |
| Vypnutí funkce na serveru (`GMAIL_INTEGRATION_ENABLED` ≠ 1) | žádné Gmail volání; existující metadata zůstávají čitelná; purge funguje dál | grant beze změny |

Retention: ClearSpace drží jen sdílená metadata a soukromé id, dokud odkaz existuje. Obsah se neukládá vůbec (náhled je `no-store`).

## 7. Logování
Request log dev serveru ignoruje `/api/gmail/*` (URL vyhledávání nese hledané výrazy) i OAuth callback. Strukturovaný `oauthLog` jen fáze/kódy/počty
(stringy > 80 znaků zahozeny). Chyby jen jménem/kódem. HTTP sada kontroluje log: žádné tokeny, kódy, těla, adresy, Gmail id ani search URL.

## 8. Hrozby → kontroly (výběr)
| Hrozba | Kontrola | Test |
|---|---|---|
| Čtení cizí schránky / cizího id | token volajícího, `ownSource`, vazba na `sub` | DB 93 (source refusals), HTTP (cross-account → not_found, 403 pro editora/čtenáře/cizího/vlastníka projektu) |
| Podvržená metadata / odkaz | zápis jen RPC se server secret, metadata čte server z Gmailu, `web_url` u Gmailu NULL (CHECK) | DB 93 schema rules |
| XSS / tracking přes HTML | HTML→text na serveru, React text, žádné `img/iframe/script` | unit, HTTP, E2E (síťové požadavky na tracker = 0) |
| Únik tokenu do prohlížeče | Picker token vždy downscoped | unit + HTTP (Gmail 403 s Picker tokenem) |
| Zahlcení / DoS | ≤ 10 položek na připojení, ≤ 20 výsledků, body ≤ 16 kB, rozpočet 300 volání / 10 min, limit 60 odkazů / 10 min, timeouty 8 s, 1 retry | HTTP bounds |
| Revokace kvůli Gmailu zničí Drive | žádná revokace při odmítnutí, fail closed | HTTP (revocations unchanged) |
| Únik soukromých dat v událostech | události bez předmětu | DB 93, E2E timeline |
