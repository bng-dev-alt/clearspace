# RUN 04 – Google Calendar: produkční nasazení (provedeno s Kalendářem VYPNUTÝM)

Schválení vlastníka (RUN_PROMPT §0): konsolidace + nasazení s `CALENDAR_INTEGRATION_ENABLED=0` po splnění bran; **produkční Kalendář
a změny `clearspace-prod` NESCHVÁLENY**. Záznam provedení: `PRODUCTION_ACCEPTANCE.md`.

## 0. Rozhodnutí vlastníka pro zapnutí Kalendáře (budoucí)
`calendar.events.owned.readonly` je **sensitive** (ne restricted):
* **A – nechat vypnuto** (současný stav).
* **B – pilot v Testing** (`clearspace-prod`, jen test users, varování „neověřená aplikace“, autorizace vyprší po 7 dnech): bez ověření Googlem.
* **C – interní aplikace** ve vlastní Workspace organizaci.
* **D – veřejně**: ověření aplikace (brand + zdůvodnění scope + demo video); **CASA není potřeba** (jen pro restricted).

## 1. Postup pilotu (B) – až po výslovném schválení
1. `clearspace-prod`: zapnout Calendar API; Data Access + `https://www.googleapis.com/auth/calendar.events.owned.readonly`; redirect/origin beze změny.
2. Vercel Production: `CALENDAR_INTEGRATION_ENABLED=1` (plain) → staged deploy téhož commitu (`deploy-drive-staged.sh`, `EXPECT_CALENDAR_MIGRATION=1`;
   `check` bez `EXPECT_CALENDAR_OFF`) → promote. `/privacy` sekci Kalendář ukáže sama; `/about` po buildu s `=1`.
3. Živá akceptace na produkci účtem vlastníka (body 2–20 z `LIVE_ACCEPTANCE.md`, `calendar_live_gate.mjs`-ekvivalent proti produkci nemáme – ručně / rozšířit).
4. Zpět: `CALENDAR_INTEGRATION_ENABLED=0` + redeploy (grant u uživatelů zůstává; uživatel ho ukončí odpojením účtu).

## 2. Provedené pořadí (RUN 04, Kalendář OFF) – vzor RUN 03C
1. G1 preflight (Git, Vercel, produkční DB jen čtení) · 2. G2 revize diffu (veřejné repo) · 3. G3 `rehearse-calendar-prod.sh` (replika s produkčním DDL)
· 4. G4 kód RUN 03C proti DB s 1400 · 5. G5 finální regrese + živá brána na finálním SHA · 6. G6 `CALENDAR_INTEGRATION_ENABLED=0` (Production)
· 7. G7 `CONFIRM_CALENDAR=twjlnsxjtuntujarwner scripts/apply-calendar-hosted.sh` (záloha, 1 transakce, otisky) · 8. G8 starý build na 1400
(`check-deployment.sh` EXPECT_DRIVE=1 EXPECT_GMAIL_OFF=1 + `hosted-verify.sh` E2E_EXPECT_GMAIL=off) · 9. merge `--no-ff` → `main`
· 10. `RELEASE_BRANCH=main EXPECT_GMAIL_MIGRATION=1 EXPECT_CALENDAR_MIGRATION=1 CONFIRM_DRIVE_DEPLOY=<sha> deploy-drive-staged.sh deploy` + `check`
· 11. `vercel promote` · 12. produkce: `check-deployment.sh` (EXPECT_DRIVE=1 EXPECT_GMAIL_OFF=1 EXPECT_CALENDAR_OFF=1), `hosted-verify.sh`
(E2E_EXPECT_GMAIL=off E2E_EXPECT_CALENDAR=off), Monograph prodcheck, runtime logy, data vlastníka.
Staged deploy běží z čistého pracovního stromu `main` (hlavní checkout má nesledované soubory vlastníka, na které se nesahá).

## 3. Rollback
* **Kód:** `vercel promote dpl_3wGY3njTQ2LWJsaxG7H6Kuitq8ur` (RUN 03C, `e9aefbc`) – na DB s 1400 prokázaně funguje (G4 + G8).
* **DB 1400 nevracet**, dokud běží kód, který ji čte; potom jen `supabase/rollback/20261128001400_google_calendar.down.sql` (odmítne při Calendar
  odkazech / auditu; jinak obnoví katalog 1300 – ověřeno harness + nácvik). Záloha: `/Volumes/WORKSPACE/_G2_BACKUP/20261125-v1-pre-calendar`.
* Granty u Googlu rollback nemění.
