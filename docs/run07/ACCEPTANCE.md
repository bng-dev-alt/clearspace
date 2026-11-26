# RUN 07 – akceptační matice (vyplňuje se během běhu)

Stavy: PASS (důkaz v tomto běhu) · FAIL · BLOCKED · NOT VERIFIED. Mock ≠ živý poskytovatel.

| # | Scénář | Mock / DB / HTTP | Živě |
|---|---|---|---|
| A1 | Připojení veřejného Slack kanálu | – | – |
| A2 | Připojení soukromého Slack kanálu | – | – |
| A3 | Připojení Telegram skupiny | – | – |
| A4 | Více cílů v jednom projektu | – | – |
| A5 | Odmítnutí neoprávněné správy integrací | – | – |
| A6 | Odmítnutí prošlého / znovu použitého Telegram kódu | – | – |
| A7 | Odmítnutí podvrženého Slack podpisu / Telegram tajemství | – | – |
| A8 | Odmítnutí událostí z nepropojených kanálů/skupin | – | – |
| A9 | Cross-project / cross-tenant izolace | – | – |
| A10 | Oznámení jen do nakonfigurovaných cílů | – | – |
| A11 | Osobní notifikace RUN 05 zachovány | – | – |
| A12 | Úkol ze Slack zprávy | – | – |
| A13 | Úkol z Telegram zprávy | – | – |
| A14 | Odmítnutí neoprávněného externího vytvoření úkolu | – | – |
| A15 | Synchronizace komentářů propojeného úkolu | – | – |
| A16 | Prevence smyček | – | – |
| A17 | Deduplikace opakovaných událostí | – | – |
| A18 | Výpadky a rate limit poskytovatele | – | – |
| A19 | Odvolaný token / odebraný bot | – | – |
| A20 | AI ingestion vypnutá ve výchozím stavu | – | – |
| A21 | Žádné sbírání v režimu jen oznámení | – | – |
| A22 | Výslovně povolené PI čtení | – | – |
| A23 | Odvolaný zdroj už není čitelný | – | – |
| A24 | Retence a purge | – | – |
| A25 | Prompt-injection containment | – | – |
| A26 | Izolace dema, 0 provozu k poskytovatelům | – | – |
| A27 | Containment vypnutých funkcí | – | – |
| A28 | Soubory vlastníka beze změny | – | – |
