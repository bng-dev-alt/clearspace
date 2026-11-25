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

## RUN 02C – PRODUKCE (2026-11-25): přesný handoff pro RUN 03 Gmail
**Stav produkce:** `https://clearspace.luffast.com` = deployment `dpl_26oNU69rEMtEazEZpMk1pgf7hV8k` z commitu `32eb451`; `main` = tag `run02c-complete`
(fast-forward z `release/run02-google-drive`; commity po `32eb451` mění jen skripty a dokumentaci). Produkční DB: markery do **1200**.
Google projekt **`clearspace-prod`**, OAuth v režimu **Testing** (test users vlastníka); Production env: `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`,
`GOOGLE_SERVER_SECRET`, `GOOGLE_TOKEN_ENCRYPTION_KEY`, `GOOGLE_PICKER_API_KEY`, `GOOGLE_CLOUD_PROJECT_NUMBER`, `PRIVACY_CONTROLLER`, `PRIVACY_CONTACT_EMAIL`,
`APP_BASE_URL=https://clearspace.luffast.com`. Supabase Auth Site URL = nová doména, allow-list obou `…/accept-invite?token=*`.

**Commity k převzetí do `feature/run03-gmail`** (RUN 03 větev vychází z `run02-complete` = `ca6cd29`; RUN 02C ji NEMĚNÍ):
```
git -C <V1-gmail> fetch origin && git -C <V1-gmail> merge --no-ff run02c-complete     # nebo origin/main; žádný rebase sdílené historie
```
| Commit | Obsah | Konflikt s RUN 03 (předpoklad) |
|---|---|---|
| `2d6c505` | `scripts/rehearse-drive-prod.sh` (vzor pro nácvik Gmail migrace na replice produkce) | ne |
| `657311d` | `/about`, `/privacy`, `PublicPage`, `ProtectedRoute` (statické veřejné cesty), pilot hláška (`config.pilot`, `PILOT_TEXT`, `GoogleStatus.pilot`), `/api/dev/login` 404 pro všechny metody, `domain-cutover.sh`, `set-google-keys.sh` | **ano**: `lib/google/config.ts`, `api/google/connection/route.ts`, `services/driveService.ts`, `components/drive/GoogleConnectionCard.tsx`, `lib/google/labels.ts`, `globals.css` (konec) |
| `2cb45c5` | `deploy-drive-staged.sh`, `check-deployment.sh` (`EXPECT_DRIVE=1`) | možná (Gmail kontroly přidat analogicky) |
| `f848632` | dokumentace RUN 02C, kontakt správce v `set-google-keys.sh` | docs |
| `513bb2a` | **Monograph výchozí vzhled** (`lib/designStyle.ts`, `ThemeContext.tsx`, `Navbar.tsx`, test, `playwright.config.ts`) | ne (pokud RUN 03 nemění vzhled) |
| `32eb451` | `set-google-keys.sh` – ořez mezer, bezpečná diagnostika, číslo projektu = Client ID | ne |
| `8e6e6a1` | `domain-cutover.sh` – řetězení přesměrování | ne |
| `c4cb910` | `hosted-verify.sh` – nová doména | ne |
| (poslední) | dokumentace po rolloutu, `set-google-keys.sh rotate-picker` | docs |

**Co RUN 03 musí zohlednit:**
1. **Zásady `/privacy`** (`src/app/privacy/page.tsx`) rozšířit o Gmail: jaká data, uložení, Limited Use je pro Gmail (restricted) **závazný**, AI zpracování
   e-mailů (pokud vůbec) výslovně; aktualizovat i `/about`. Bez toho nelze Gmail nasadit.
2. **Restricted scopes** (Gmail) ⇒ ověření aplikace u Google + bezpečnostní posouzení (CASA) pro produkční publikování; v režimu Testing jen test users.
   Gmail scopes se přidávají do **stejného** projektu a klienta `clearspace-prod` (inkrementální autorizace) – změna souhlasové obrazovky pro všechny.
3. **Produkční migrace Gmail** musí mít preflight „1200 přítomna“ a nácvik přes vzor `rehearse-drive-prod.sh`; aplikace přes skript ve stylu `apply-drive-hosted.sh`.
4. `APP_BASE_URL` a redirect URI jsou na `https://clearspace.luffast.com`; dev zůstává `http://127.0.0.1:<port>` v dev projektu `clearspace-dev`.
5. `GOOGLE_OAUTH_PUBLISHING` (pilot hláška) – pokud Gmail přidá vlastní UI, použít stejný příznak.
6. Monograph je výchozí: E2E bez `E2E_STYLE` teď běží v Monographu (pro Classic nastavit `clearspace-style=existing`).
