# RUN 10 handoff – Meeting Intelligence (poslední velká funkce před feature freeze)

**Výchozí stav po RUN 09**: produkce `dpl_EfUg58JQCRSUpKdqbQ6GdpDWkrop` (commit `3b12454` = kód RUN 09; `main` navíc jen dokumentace), tag `run09-complete`,
DB markery končí 1700, Communication Hub etapa 1 živě v pilotu (prezentační účet), Google pilot, demo data CSD-CORVANE (14 Gmail vláken obnoveno).
Etapa 2 (Cortex/PI) ověřena skutečnou AI a od 28. 11. trvale aktivní pro prezentační účet (`dpl_GWQF6jGs…`, 40k tokenů/den, 2/min).

## Závazné vstupy
* **Účty** – `docs/run09/ACCOUNTS_ADR.md`: pilot a demo jen na prezentačním účtu (= demo Google „Alex Morgan“); osobní účet vlastníka mimo demo.
* **Náklady** – STT (Soniox) + Gemini jen přes allowlist a ledger (`ai_requests`); demo tier (`AI_DEMO_USER_IDS`) s přísnými limity; placené testy
  jen se schválením vlastníka (vzor: `STAGE2_GEMINI_PROPOSAL.md`).
* **Bezpečnostní vzor** – přepínač funkce + pilotní allowlist + server secret v `server_trust` + vypínač plánovače; staged deploy s `check-deployment.sh`.
* **Existující základ** – `docs/run04/MEETING_INTELLIGENCE_COMPAT.md` („porada z události“ Kalendáře), STT pipeline (`src/lib/stt`), RC1–RC5 Intelligence.

## Doporučený rozsah RUN 10
1. Porada z události Google Kalendáře (demo účet) → nahrávka/přepis (Soniox, demo limity) → shrnutí + úkoly (Gemini) s návrhem, nikdy automatické změny.
2. Volitelně výstup do propojeného Slack kanálu / Telegram skupiny (hub etapa 1 – stejné cíle, nový typ události).
3. Izolace projektů, mazání (retention), PI zdroj `meeting:` s citací.

## Otevřené před RUN 10
* Etapa 2 aktivní: RUN 10 sdílí demo AI rozpočet (40k/den) – Meeting Intelligence potřebuje vlastní schválený rozpočet / limity.
* Školení: `docs/training/` – po RUN 10 doplnit modul 5 (Meeting Intelligence) ze skutečné implementace.
* UX backlog (`docs/run09/UX_BACKLOG.md`, 14 položek vč. one-click kopírování) až ve finálním polish runu.
* Živé multi-user ověření osobních oznámení (vyžaduje druhý pilotní účet – rozhodnutí podle ADR).
* Pro živé dev testy už nejsou dev boti/aplikace (povýšeny do produkce) – RUN 10 testuje v simulaci, nebo s novými dev identitami.
