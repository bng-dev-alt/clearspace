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
