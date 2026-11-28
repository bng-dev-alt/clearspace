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
