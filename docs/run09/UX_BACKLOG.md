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
