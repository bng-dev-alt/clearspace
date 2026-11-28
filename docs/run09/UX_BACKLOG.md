# Communication Hub – UX backlog pro finální polish run (RUN 08 + RUN 09; neimplementovat dřív)

| # | Položka | Zdroj | Poznámka |
|---|---|---|---|
| 1 | **Kompletní redesign stránky Propojené účty** (Google, osobní oznámení, Slack/Telegram pro projekty, identity na jedné stránce) | vlastník | jeden vzor „co je připojené, k čemu, jak odpojit“ |
| 2 | **Výraznější potvrzení úspěchu** po instalaci, propojení účtu a kanálu | vlastník | velký stav „Propojeno ✓ #kanál“ |
| 3 | **Telegram deep link jako hlavní cesta, příkaz jen záložně** | vlastník | RUN 09: v existujícím chatu s botem Telegram Web deep link `?start=` znovu nepošle – záložní příkaz musí zůstat viditelný |
| 4 | **Bot bez předvolených admin práv** (`startgroup` bez `admin`, BotFather výchozí práva) | vlastník | Relay práva nepotřebuje |
| 5 | **Nápověda k `/task`** (název za příkazem) | RUN 08B | |
| 6 | **Zkušební zpráva vs. skutečná oznámení** odlišit | RUN 08B | |
| 7 | Po instalaci Slack aplikace Nastavení dál ukazuje „Nainstalovat do Slacku“ (bez stavu „nainstalováno do BNG Workspace“) | RUN 09 živě | |
| 8 | Propojení kanálu projde i když bot není v kanálu; chyba se ukáže až zkušební zprávou (`removed_bot`) | RUN 09 živě | v párovacím boxu ověřit členství hned po kódu |
| 9 | Nový cíl má „Interaktivní“ vypnuté a `/task` pak hlásí „vypnuté“ – při potvrzení nabídnout zapnutí | RUN 09 živě | výchozí fail-closed zachovat |
| 10 | Čeština: „zadal v **skupině**“ → „ve skupině“ | RUN 09 živě | |
| 11 | Osobní oznámení „Všechny moje projekty“ u účtu se 14 demo projekty – zvážit výchozí „Jen vybrané“ | RUN 09 | |
| 12 | **One-click „Kopírovat“ u všech párovacích příkazů a zpráv** (kódy `/clearspace propojit|ucet`, `/start`, `/link@bot`, `/task@bot Název`) – zachovat stávající kopírování s potvrzením „Zkopírováno“ a doplnit tam, kde chybí | vlastník (RUN 09) | |
| 13 | AI chat na žádost vypíše interní ID projektu (karty, sloupce, komentáře) – v odpovědích preferovat názvy | RUN 09 stage 2 (LOW) | ne tajemství |
| 14 | Po odpojení Telegram skupiny bot skupinu opustí – v UI to říct předem | RUN 09 | |
| 15 | Porady: přehled „dnes / tento týden“ a připomenutí „spustit přepis“ u začínající porady | RUN 10 | |
| 16 | Živý přepis: velký režim „na celou obrazovku“ pro prezentaci, odlišení mluvčích barvou | RUN 10 | |
| 17 | Detail porady: tlačítko „Analyzovat“ skrýt, dokud porada nemá přepis | RUN 10 | dnes se zobrazuje i u plánované porady |
| 18 | Přímé odeslání pozvánky do propojeného Slack kanálu / Telegram skupiny (dnes one-click kopírování) | RUN 10 | nový typ zprávy hubu |
| 19 | Classic: přepínače zdroje zvuku vypadají jako holé radio buttony – sjednotit s design systémem | RUN 10 | |
| 20 | Živý přepis: výběr mikrofonu a test – stylovat `<select>`/`<meter>` podle design systému (dnes nativní prvky) | RUN 10 hardening | funkčně hotovo |
| 21 | Po zrušení přepisu ukazuje časomíra i dříve spotřebovaný čas (vyúčtovaný) – zvážit popisek „z toho zrušeno“ | RUN 10 hardening | |
| 22 | Seznam porad: sekce „Proběhlé“ řadí i porady s uplynulým termínem bez přepisu – přejmenovat na „Uplynulý termín“ / filtrovat podle skutečného stavu | RUN 10 hardening | detail porady už termín a průběh odlišuje |

## Stav po RUN 11 (2026-11-28, větev `polish/run11`)
| # | Stav | Jak / kde |
|---|---|---|
| 1 | **HOTOVO** | Nastavení → Propojené účty: přehled stavu nahoře + sekce Google · Osobní oznámení · Slack a Telegram pro projekty se stejným vzorem řádku; vysvětlení režimů (`ChatModesExplainer`) |
| 2 | **HOTOVO** | Integrace projektu: po potvrzení „Propojeno ✓ #kanál“ s dalšími kroky; identita: zpráva „Propojeno: …“ (beze změny, už existovala) |
| 3 | **HOTOVO (ověřeno)** | Párovací box: hlavní tlačítko otevře Telegram, příkaz zůstává viditelný se zkopírováním (stav z RUN 09 ponechán) |
| 4 | **HOTOVO v kódu / vlastník** | odkaz `startgroup` nežádá admin práva (ověřeno v kódu); výchozí práva bota v BotFather = akce vlastníka |
| 5 | **HOTOVO** | u Telegram cíle s Interaktivní: příkaz `/task@bot Název úkolu` s kopírováním; popisek říká, že název se píše za příkaz |
| 6 | **HOTOVO** | výsledek zkušební zprávy výslovně odlišuje zkušební zprávu od skutečných (souhrnných) oznámení |
| 7 | **HOTOVO** | Nastavení ukazuje skutečný stav instalace Slack aplikace (z dat serveru `slackWorkspaces`), tlačítko „Nainstalovat“ / „Přeinstalovat“ |
| 8 | **ČÁSTEČNĚ** | po potvrzení výzva „ověřte zkušební zprávou“ s pokynem `/invite`; ověření členství bota přímo při potvrzení = serverová změna → LATER (TECH_DEBT RUN 11) |
| 9 | **HOTOVO** | po potvrzení tlačítko „Zapnout i úkoly z chatu“; výchozí stav dál vypnutý (fail-closed) |
| 10 | **HOTOVO** | „zadal ve skupině“ / „v kanálu“ (`ProjectIntegrationsModal`) |
| 11 | **HOTOVO (D6)** | nové nastavení (nic uloženo, žádný kanál) předvybere „Jen vybrané projekty“ jako neuloženou volbu; stávající uživatelé beze změny; vysvětlení režimů |
| 12 | **HOTOVO** | sdílený `CopyButton` (přiznává i selhání schránky) v párování, poradách a u příkazu `/task` |
| 13 | **OTEVŘENO → RUN 12/LATER** | prompt AI: preferovat názvy místo interních ID; ověření by vyžadovalo placené volání (zakázáno) |
| 14 | **HOTOVO** | potvrzení odpojení Telegram skupiny říká, že bot skupinu opustí |
| 15 | **HOTOVO (výjimka z freeze)** | seznam porad: Dnes / Tento týden / Později / Uplynulý termín bez přepisu / Proběhlé + upozornění „spusťte přepis“ |
| 16 | **HOTOVO (výjimka z freeze)** | živý přepis: „Celá obrazovka“ (Fullscreen API, záložní vrstva pro iPad/Safari), velké písmo, barevné značky mluvčích |
| 17 | **HOTOVO** | bez přepisu se „Analyzovat“ nenabízí; místo toho věta, kdy bude analýza dostupná |
| 18 | **LATER** | přímé odeslání pozvánky do Slacku/Telegramu (rozhodnutí vlastníka) |
| 19 | **HOTOVO** | Classic: radio/checkbox/select v poradách podle design systému |
| 20 | **HOTOVO** | Classic: select a meter v živém přepisu stylované tokeny |
| 21 | **HOTOVO** | mimo nahrávání časomíra říká „účtováno celkem“ (včetně zrušených přepisů) |
| 22 | **HOTOVO** | „Uplynulý termín bez přepisu“ odděleno od „Proběhlé“ |
