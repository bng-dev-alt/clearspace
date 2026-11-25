# RUN 04 – rozhodnutí (autonomní, v rámci schváleného rozsahu)

Formát: rozhodnutí · varianty · důvod · dopad. Doplňuje se průběžně.

| # | Rozhodnutí | Varianty | Důvod | Dopad |
|---|---|---|---|---|
| D1 | Worktree `V1-calendar`, větev `feature/run04-google-calendar` z `run03c-complete` (`9b64ad5`); stack `cs-calendar-sb` (55570–55579, mail 55584/55585, mock 55592, app 3461) | jiné porty | porty ověřeny jako volné (`lsof`), vzor RUN 03 | žádný zásah do stacků RUN 01–03 |
| D2 | `node_modules` = APFS klon z `V1-gmail` (shodný `package-lock.json`, ověřeno `cmp`) | `npm ci` | síť do registru není potřeba, identické závislosti | žádná nová závislost |
