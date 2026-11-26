# Návrh: bezpečný produkční pilot Gmail + Kalendář s demo účtem (K SAMOSTATNÉMU SCHVÁLENÍ – nic neprovedeno)

Cíl: na `https://clearspace.luffast.com` předvádět Gmail + Kalendář + Disk s demo účtem Alex Morgan, aniž by se integrace zapnuly komukoli jinému
a aniž by návštěvníci veřejného dema dostali přístup k Googlu.

## Princip
* `GMAIL_INTEGRATION_ENABLED=pilot`, `CALENDAR_INTEGRATION_ENABLED=pilot` (Vercel Production, plain), `GOOGLE_PILOT_USER_IDS=<UUID prezentačního účtu>`,
  `GOOGLE_PILOT_ACCOUNTS=<demo Google účet>` (obojí **Sensitive**). Všichni ostatní uživatelé dostávají přesně odpovědi „vypnuto“ (ověřeno živě v RUN 06).
* **Prezentační účet ClearSpace = samostatný pojmenovaný účet** (doporučení: `demo@luffast.com` po zřízení aliasu z `EMAIL_ROUTING.md`), vlastník
  demo projektů. **Nikdy** sdílená identita veřejného dema – návštěvníci se do něj nepřihlašují a nedostanou ani Picker token (vydává se jen
  přihlášenému vlastníkovi spojení, zúžený na `drive.file`).
* Tokeny zůstávají na serveru (AES-256-GCM v DB); do prohlížeče nejde žádný Google token kromě zúženého Picker tokenu prezentujícího.
* Demo data v Googlu už existují (CS-GDEMO) – produkce je jen čte. Seeder se do produkce nikdy nenasazuje a v `clearspace-prod` nemá klienta.

## Předpoklady
1. `clearspace-prod` (Google Cloud): zapnout Gmail API + Calendar API; Data Access + `gmail.readonly` (restricted) a
   `calendar.events.owned.readonly` (sensitive); demo účet přidat mezi **Test users** (aplikace zůstává v Testing – bez ověření / CASA).
2. Demo účet **nemá** v `clearspace-prod` jiný grant (seeder tam neexistuje → nález „souhlasy po projektu“ nehrozí).
3. Rozšířit kontrolní skripty o pilot (dnes umí jen OFF):
   * `check-deployment.sh`: `EXPECT_GMAIL_PILOT=1` / `EXPECT_CALENDAR_PILOT=1` – anonymně trasy 401 (ne 503: přepínač už není „off“), `/privacy` s `privacy-*-pilot`,
     klientský bundle beze změny.
   * `e2e/supabase-hosted.spec.ts`: jednorázový uživatel mimo pilot → `oauth/start service=gmail|calendar` 503 `*_disabled`, `gmailAvailable:false`.
4. Migrace: žádná (produkce má 1300 + 1400).

## Postup (po schválení)
1. Merge `feature/google-demo-pilot` → `main` (revize diffu – veřejné repo: žádný demo e-mail, UUID ani tajemství v kódu).
2. Vytvořit prezentační účet ClearSpace, zjistit jeho UUID; nasadit CSD-CORVANE do jeho workspace (`demo-seed apply` – samostatný krok, existující nástroj).
3. Vercel Production env (4 proměnné výše) → staged deploy (`deploy-drive-staged.sh`) → `check-deployment.sh` (pilot) + `hosted-verify.sh` → promote.
4. Prezentující se přihlásí, v Nastavení připojí Disk → Gmail → Kalendář **demo účtem**; kontrola uložených scopů (5, read-only).
5. Živá kontrola: `gdemo_live_accept.mjs`-ekvivalent proti produkci (dnes jen lokální – rozšířit o `hosted` cíl) nebo ručně body 1–8 z `LIVE_ACCEPTANCE.md`.

## Provoz a rizika
| Riziko | Opatření |
|---|---|
| Testing: grant vyprší po 7 dnech | před každou ukázkou znovu připojit (1 minuta); nebo později ověření aplikace (gmail.readonly = restricted → CASA) |
| Někdo přidá veřejnou identitu do pilotu | `GOOGLE_PILOT_USER_IDS` mění jen vlastník ve Vercelu; checklist v tomto dokumentu |
| Demo účet se přihlásí jinde | pilot vyžaduje shodu účtu (`GOOGLE_PILOT_ACCOUNTS`), jiný Google účet → `pilot_account` |
| Únik osobních dat | demo účet obsahuje jen fiktivní data na rezervovaných doménách; tým projektu vidí jen sdílená metadata |

## Rollback
`GMAIL_INTEGRATION_ENABLED=0`, `CALENDAR_INTEGRATION_ENABLED=0` + redeploy (stejný commit); prezentující „Odpojit účet Google“ (revokace celého grantu).
Kód s pilotem je zpětně kompatibilní (`0`/`1` beze změny), DB beze změny.
