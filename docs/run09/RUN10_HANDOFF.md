# RUN 10 handoff – Meeting Intelligence (poslední velká funkce před feature freeze)

**Výchozí stav po RUN 09**: produkce `dpl_BvqQZBpsey4ehYNLJNoMDyZk469d` (kód `87e86f2`, větev `release/run09-hub-production` → `main`),
DB markery končí 1700, Communication Hub etapa 1 živě v pilotu, Google pilot, demo data CSD-CORVANE. Etapa 2 (Cortex/PI) připravena, vypnutá.

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
* Rozhodnutí o stage 2 (Gemini test, ≤ 12 požadavků / ≤ 0,50 USD).
* UX backlog (`docs/run09/UX_BACKLOG.md`) až ve finálním polish runu.
* Smazání BotFather zpráv s tokeny a mrtvých dev Keychain položek (vlastník).
