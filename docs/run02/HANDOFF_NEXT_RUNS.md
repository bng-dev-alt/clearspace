# Handoff RUN 02 → RUN 02C (production rollout) a RUN 03 (Gmail)

Stav 2026-11-25, tag `run02-complete` (větev `feature/run02-google-drive`, nepushnuto, nenasazeno). Starší handoff RUN 01 → 02: `GOOGLE_DRIVE_HANDOFF.md`.

## Začít zde
* Architektura, bezpečnost, matice ověření (live vs. mock): `GOOGLE_DRIVE.md` (§13 matice, §14 closeout). Rollout: `PRODUCTION_ROLLOUT.md` (§9 plán RUN 02C). Dluh: `../TECH_DEBT.md`.
* Lokální start proti **skutečnému Googlu** (jeden odkaz, bez přihlašování – standard DEV login): `frontend/scripts/google-live.sh app` → `http://127.0.0.1:3441/settings?login=auto`.
  Tajemství jsou v macOS Keychainu (`google-live.sh setup|status|verify|forget`), nikdy v souboru ani v chatu. Mock režim (bez Googlu): `drive-stack.sh mock` + `app`; oba režimy nikdy zároveň.
* Užitečné kontroly: `google-live.sh verify` (Google přijímá klienta + redirect), `revoke-check` (odpojí a dokáže revokaci; pak znovu připojit), `doc-check` (read-only live kontrola náhledu/obnovy/originálu).
* Testy E2E s DEV auto-loginem: `DEV_AUTO_LOGIN=0` pro `collaboration-01b` (čistý kontext hosta).

## Znovupoužitelný základ pro RUN 03 (Gmail) / RUN 04 (Calendar)
`src/lib/google/*` (konfigurace s ochranou mock/real, `getAccessToken` se zámkem obnovy, šifrované obálky AES-GCM s rotací klíče, `oauthLog`), tabulky
`google_connections`/`google_oauth_states`/`integration_audit`, `server_trust('google')`, session-bound OAuth dokončení, Picker/Drive vrstva izolovaná v `drive.ts`.
* Další scopes **inkrementálně** (`include_granted_scopes=true`, nová sada vedle `DRIVE_SCOPES`); Gmail scopes jsou *restricted* → ověření/audit, nutné rozhodnout před návrhem.
* Poučení: tajemství ověřovat na úrovni **běžícího procesu** (RUN 02B: launcher přepsal secret mock hodnotou → `invalid_client`); `GOOGLE_*` jen na serveru; nikdy logovat URL callbacku s `code=`.

## Co zůstává NOT VERIFIED (nepočítat z mocku)
Druhý skutečný Google účet · 7denní expirace refresh tokenu (Testing) · odmítnutý souhlas / odškrtnutý Disk na skutečné Google obrazovce · Workspace účty a sdílené disky · produkční Google projekt a produkční běh.

## Omezení, která platí dál
Žádný push/merge/deploy bez výslovného schválení; V2/Artform a RUN 01 stack se nemění; žádná placená AI volání (napojení obsahu Drive na AI je záměrně neaktivní, `getTextContent`);
tajemství jen Keychain/Vercel Sensitive; DEV login jen v explicitně povoleném lokálním vývoji.

## RUN 02C → RUN 03: změny k převzetí (RUN 02C je do RUN 03 NEintegruje)
Zdroj: větev `release/run02-google-drive` (commity po `run02-complete`; po G10 i `main`). Doporučený postup v RUN 03: `git merge release/run02-google-drive`
(nebo `main` po merge) do `feature/run03-gmail`; žádný rebase sdílené historie.
| Soubor / oblast | Změna | Pravděpodobný konflikt v RUN 03 |
|---|---|---|
| `src/lib/google/config.ts` | pole `pilot` (z `GOOGLE_OAUTH_PUBLISHING`) | ano – Gmail přidá scopes/konfiguraci |
| `src/app/api/google/connection/route.ts`, `src/services/driveService.ts` (`GoogleStatus.pilot`) | stav pilotu v API | možný |
| `src/lib/google/labels.ts` (`PILOT_TEXT`), `src/components/drive/GoogleConnectionCard.tsx`, `DriveLinksPanel.tsx` | hláška pilotu, odkaz na zásady | ano, pokud RUN 03 rozšiřuje kartu Google |
| `src/app/privacy/page.tsx`, `src/app/about/page.tsx`, `src/components/legal/PublicPage.tsx`, `ProtectedRoute.tsx`, `login/page.tsx`, `globals.css` (konec souboru) | veřejné stránky | **RUN 03 musí zásady rozšířit o Gmail** (restricted scopes ⇒ Limited Use závazně, bezpečnostní posouzení CASA, ověření aplikace) |
| `src/app/api/dev/login/route.ts` | 404 pro všechny metody | ne |
| `src/lib/designStyle.ts`, `ThemeContext.tsx`, `Navbar.tsx`, `designStyle.test.tsx`, `playwright.config.ts` | **Monograph je výchozí vzhled v každém buildu** (dřív jen s `NEXT_PUBLIC_ENABLE_MONOGRAPH=1`); vypíná jen `=0`; výslovná volba Classic se dál respektuje | ne |
| `scripts/set-google-keys.sh`, `check-deployment.sh`, `domain-cutover.sh`, `deploy-drive-staged.sh`, `rehearse-drive-prod.sh` | provozní brány | rozšířit o Gmail proměnné / migraci (vzor `rehearse-drive-prod.sh`) |
| Migrace 1200 | **beze změny** (checksum `8c0b4b06…`) | ne |
Provozní fakta pro RUN 03: produkční doména `https://clearspace.luffast.com`; Google projekt `clearspace-prod` (Gmail přidá scopes do téhož projektu
a klienta – restricted scope znamená ověření + audit a změnu souhlasu); `APP_BASE_URL` = nová doména; produkční DB po G4 obsahuje 1200 (RUN 03 migrace
musí mít preflight „1200 přítomna“).
