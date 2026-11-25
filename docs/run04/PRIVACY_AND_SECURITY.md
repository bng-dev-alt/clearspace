# RUN 04 – Google Calendar: privacy model a bezpečnostní hranice

## 1. Privacy model
| Vrstva | Obsah | Kdo vidí | Vynuceno |
|---|---|---|---|
| Google kalendář uživatele | vše | jen vlastník (Google) | Google; ClearSpace čte jen tokenem vlastníka, jen na jeho žádost |
| **Osobní vrstva** | název, začátek/konec, celodenní, pásmo, opakovaná/upravená, počet účastníků, organizátor (jméno/doména), soukromá ano/ne, `htmlLink` | **jen přihlášený uživatel** | trasa `/api/calendar/events` jen s tokenem volajícího; `no-store`; nic se neukládá |
| **Sdílená metadata odkazu** | název, začátek, konec, celodenní, pásmo, opakovaná, počet účastníků, organizátor (jméno, jinak jen doména), stav, kdo/kdy připojil | členové projektu | RLS `is_project_member`, zápis jen RPC se server secret, CHECKy |
| **Soukromý zdroj** | event id, id série, Google `sub`, `calendar_id='primary'` | nikdo z klientů; server jen pro vlastníka odkazu, který je stále členem | RLS bez politik, žádné granty; RPC `calendar_link_source` |
| Aktivita / realtime | `event_linked/unlinked` (id odkazu, název úkolu) / `{t:'links'}` | členové | **bez názvu události** |

**Nikdy se nepožaduje ani neukládá**: popis, místo, adresy a jména účastníků, Meet/konferenční data, přílohy (ořez `fields` – Google je vůbec nepošle);
`htmlLink` jen vlastníkovi na vyžádání. **Soukromé a důvěrné události nelze připojit** (server je odmítne dřív, než cokoli uloží); událost, která se
stala soukromou až po připojení, se při obnovení už nesdílí (zůstanou poslední známé údaje).

Text před připojením: „Členové projektu uvidí jen název události, čas, zda jde o opakovanou událost, počet účastníků, organizátora (jméno, případně
jen doménu) a kdo událost připojil. Popis, místo, adresy účastníků a odkazy na schůzky zůstávají jen ve vašem kalendáři. Soukromé a důvěrné
události připojit nelze.“

## 2. Role (DB + trasy, testováno)
| Akce | Vlastník projektu | Admin / editor | Čtenář | Odebraný člen | Cizí |
|---|---|---|---|---|---|
| Vlastní vrstva (svůj kalendář) | ano | ano | ano | – | – |
| Vidět připojené události | ano | ano | ano | ne | ne |
| Připojit (z vlastního kalendáře, Kalendář povolen) | ano | ano | ne | ne | ne |
| Odebrat odkaz | ano | ano | ne | ne | ne |
| Obnovit / Otevřít v Google Kalendáři | **jen vlastní odkazy** | **jen vlastní** | jen vlastní | ne | ne |
| Purge vlastních odkazů | ano | ano | přeskočeno (viewer guard) | **ano** | – |
Ani vlastník projektu neotevře událost editora (403 `not_owner`).

## 3. Tokeny a izolace služeb (E10)
* Jedna Google autorizace, služby zvlášť (`google_connections.scopes` = co ClearSpace používá). Calendar trasy berou token jen `service:'calendar'`;
  bez scope → 409 `calendar_not_granted`, i když jsou Drive/Gmail povolené.
* **Token pro prohlížeč (Picker) je dál zúžený na Drive** – živě ověřeno s povoleným Drive + Gmail + Calendar: tokeninfo = identita + `drive.file`,
  Calendar API 403, Gmail API 403.
* `account_mismatch` nyní i pro Kalendář; odmítnutí/odškrtnutí nic neruší (revokace by ukončila Disk a Gmail); fail-closed beze změny z RUN 03.
* Šifrování AES-256-GCM, refresh lease, revokace – beze změny.

## 4. Vypnutí, odpojení, mazání
| Akce | Výsledek | U Googlu |
|---|---|---|
| Vypnout Kalendář v ClearSpace | Calendar volání končí (409); Disk a Gmail běží | grant zůstává (uživatel informován) |
| … s `purge=1` | smažou se všechny moje Calendar odkazy (i z projektů, kde už nejsem) | – |
| Odpojit Google účet | revokace celého grantu (živě: `invalid_grant`) + smazání tokenů | grant ukončen |
| Přepínač OFF na serveru | všechny Calendar trasy 503 `calendar_disabled` (před autentizací); existující metadata čitelná; `/privacy` „není zapnutý“ | beze změny |
| Smazání uživatele | soukromé zdroje kaskádou; sdílená metadata zůstanou s `linked_by = NULL` | – |

## 5. Logování
Request log dev serveru ignoruje `/api/calendar/*` (query nese hledání a období). Chyby jen jménem/kódem. HTTP sada i živá akceptace kontrolují
log: žádné tokeny, kódy, event id, názvy, `htmlLink`, adresy ani URL hledání.

## 6. Hrozby → kontroly
| Hrozba | Kontrola | Test |
|---|---|---|
| Čtení cizího kalendáře / id | token volajícího, `calendar_link_source` jen vlastníkovi, vazba na `sub` | DB 94, HTTP (cross-account → not_found; open 403) |
| Podvržené metadata | zápis jen RPC + server znovu načte z Googlu; CHECKy | DB 94, HTTP |
| Únik soukromého obsahu | `fields` ořez, sdílí se jen vybrané sloupce, soukromé odmítnuty | unit, HTTP, live (response keys) |
| XSS / prompt injection v názvu | jen React text, řídicí/bidi znaky odstraněny, 300 znaků | unit, E2E (žádný `img`) |
| Únik tokenu do prohlížeče | Picker token zúžený na Drive | live gate A |
| DoS | ≤ 42 dní, ≤ 250/stránka, ≤ 10 k připojení, body ≤ 16 kB, rate limit 60 odkazů/10 min, timeouty | HTTP bounds |
| Zápis do kalendáře | jen read-only scope; žádné zápisové volání v kódu | unit (grep) |
