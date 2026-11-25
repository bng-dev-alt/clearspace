# RUN 04 – rozhodnutí (autonomní, v rámci schváleného rozsahu)

Formát: rozhodnutí · varianty · důvod · dopad. Doplňuje se průběžně.

| # | Rozhodnutí | Varianty | Důvod | Dopad |
|---|---|---|---|---|
| D1 | Worktree `V1-calendar`, větev `feature/run04-google-calendar` z `run03c-complete` (`9b64ad5`); stack `cs-calendar-sb` (55570–55579, mail 55584/55585, mock 55592, app 3461) | jiné porty | porty ověřeny jako volné (`lsof`), vzor RUN 03 | žádný zásah do stacků RUN 01–03 |
| D2 | `node_modules` = APFS klon z `V1-gmail` (shodný `package-lock.json`, ověřeno `cmp`) | `npm ci` | síť do registru není potřeba, identické závislosti | žádná nová závislost |
| D3 | Google Cloud kroky v `clearspace-dev` provedl Claude sám v prohlížeči (vlastník přihlášen), v rámci schválení §0 | OWNER SESSION | žádná interakce vlastníka nebyla potřeba | Calendar API, scope, origin/redirect/referrer 3461; `clearspace-prod` beze změny |
| D4 | Scope `calendar.events.owned.readonly` (sensitive dle konzole) | `calendar.events.readonly` (fallback) | nejužší scope, živě projde list/get/q/pageToken na primárním kalendáři | fallback nepotřeba |
| D5 | Jen primární kalendář; `calendar_id` CHECK = 'primary' | výběr kalendářů | méně dat, žádný další scope | další kalendáře = LATER |
| D6 | Ořez odpovědi Googlu přes `fields` | stahovat vše a zahazovat | soukromá pole (popis, místo, adresy, Meet) se k serveru vůbec nedostanou | živě ověřeno (response keys) |
| D7 | Soukromé/důvěrné události nelze připojit; ve vlastní vrstvě vidět ano | připojit bez názvu | jednodušší a bezpečnější | srozumitelná hláška |
| D8 | Událost, která se stala soukromou po připojení: obnovení drží jen stav, nová metadata nesdílí | přepsat | žádné nové soukromé údaje do sdíleného řádku | test v HTTP sadě |
| D9 | Zrušená/smazaná/410 = `deleted`, poslední údaje zachovány; obnovení stavem nepřepisuje časy | — | žádná data 1970 z prázdných polí | test v HTTP sadě |
| D10 | `withServiceToken` zobecňuje `withGmailToken` (alias zachován) | kopie | jedna logika refresh/401; Gmail HTTP 23/23 beze změny | — |
| D11 | Gmail HTTP sada porovnává jen dvojici `{drive, gmail}` služeb | ponechat `deepEqual` | `services` dostal aditivní klíč `calendar`; chování Gmailu beze změny | jediná úprava testu RUN 03 |
| D12 | Vrstva „Můj Google kalendář“ vypnutá ve výchozím stavu (localStorage per prohlížeč) | zapnutá | žádné volání Googlu bez vědomé akce | — |
| D13 | Grid kalendáře `minmax(0, 1fr)` i v Klasice | ponechat `1fr` | dlouhé názvy událostí rozšiřovaly sloupce (zjištěno E2E screenshotem) | drobná změna CSS existující komponenty |
| D14 | `/about` sekce Kalendář při buildu, `/privacy` dynamicky | obojí dynamicky | vzor RUN 03; env změna = redeploy | v PRODUCTION_ROLLOUT |
| D15 | Testovací události ve skutečném kalendáři vytvořil a po akceptaci smazal Claude (bez hostů, předpona „ClearSpace TEST“) | vlastník ručně | autonomní běh, žádné pozvánky třetím osobám | hledání po úklidu = 0 |
| D16 | Část e-mailu vlastníka v živém testu nahrazena hodnotou za běhu; nepushnuté commity větve přepsány | ponechat v historii | veřejné repo | jen git autor zůstává (jako dosud) |
| D17 | Staged deploy z dočasného čistého pracovního stromu `main` | smazat nesledované soubory vlastníka | soubory vlastníka (`DEMO/`, `test_intro.mp4`) se nemění | strom odstraněn |
| D18 | Klasika: přetečení navbaru při 1024 px zapsáno jako technický dluh | opravit | není z RUN 04 (mimo rozsah) | TECH_DEBT |
