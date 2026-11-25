# RUN 02 – Google Drive Integration: technický handoff z RUN 01

Stav k 2026-11-25. Cíl RUN 02: propojit ClearSpace s Google Drive (odkazy na soubory u úkolů, výběr souborů, případně náhled/analýza), s ohledem na role a soukromí projektů.
Tento dokument shrnuje, **na čem RUN 02 stojí, jaké vzory použít a čeho se vyvarovat**. Žádný kód RUN 02 neexistuje.

## 1. Výchozí bod
* **Start: tag `run01-complete` (= `origin/main` po konsolidaci; přesný SHA je v reportu a v `git rev-list -n1 run01-complete`).** Nová větev `feature/run02-google-drive` z tohoto tagu, vlastní worktree (např. `V1-drive`). Ne z `V1` (lokální checkout `main` se synchronizuje podle MAIN_CONSOLIDATION_PLAN.md fáze B).
* Produkce: `clearspace-ai.vercel.app`, nasazení `dpl_6x1fgFaAeJJ2CaU8WMfJYtwJsZhW` (kód `78c2b7b`/`bc34de4`), Supabase `twjlnsxjtuntujarwner`, migrace 0100–0900 + 1000 + 1100.
* Zelená základna testů (poslední plný běh, `b27612f`): jednotkové 1205/1205, DB harness 2158, `collab_realtime` 64, `invite_email` 41, `realtime_check` 9, hosted UI 16/16, E2E spolupráce. RUN 02 nesmí tyto testy zhoršit.
* **Next.js je novější než v tréninkových datech:** `frontend/AGENTS.md` ukládá číst `node_modules/next/dist/docs/` před psaním kódu.

## 2. Existující kód, na který navázat
| Oblast | Kde | Poznámka pro RUN 02 |
|---|---|---|
| Přílohy úkolů | `src/services/resourceService.ts`, `src/components/board/TaskResourcesSection.tsx`, typ `TaskResource` v `src/types/kanban.ts`, migrace `20261117000400_task_resources_storage.sql` | Soukromý bucket `task-resources`, cesta `tasks/<card id>/<soubor>`, limit 10 MiB, MIME allow-list, signed URL, RLS přes `is_project_member`. Soubory jsou neměnné. **Drive odkazy modelovat jako samostatnou tabulku** (např. `task_drive_links`: card, fileId, název, mime, webViewLink, přidal, čas) – ne kopírovat obsah a nemíchat se `storagePath`. |
| Serverová tajemství | tabulka `server_trust` + RPC s `p_server_secret` (`email_delivery_*`, `stt_*`), `src/lib/email/config.ts` | Vzor: tajemství jen ve Vercelu (Sensitive) a v Keychainu, v DB jen SHA-256. **Ve Vercelu není service-role klíč** a RUN 02 ho nemá zavádět; serverové operace jdou jako volající uživatel (RLS) nebo přes SECURITY DEFINER RPC chráněné serverovým tajemstvím. |
| Serverové trasy | `src/app/api/collab/invitations/**`, `src/lib/collab/invitationServer.ts` (`authenticateCaller`, Bearer token, chyby DB → HTTP) | Vzor pro `/api/drive/*`. Nepoužívat `/api/ai/*` (firewall `Block legacy AI API` blokuje celý prefix). |
| Realtime | privátní téma `project:<id>:<realtime_key>`, `realtime.send` z triggerů (jen ID), `useRealtimeBoard.ts`, `usePresence.ts` | Změny Drive odkazů vysílat stejným mechanismem (trigger → signál s ID → klient dotáhne data). Veřejné kanály jsou vypnuté (`private_only`). |
| Role | `owner / admin / member / viewer („Čtenář“)`, guard triggery | Čtenář nesmí přidávat/odebírat odkazy. Oprávnění Google Drive ≠ role projektu: odkaz v ClearSpace nikomu neotevře soubor v Drive. |
| OAuth přihlášení | `AuthContext.loginWithOAuth`, `NEXT_PUBLIC_ENABLE_OAUTH` | **Google provider je v Supabase vypnutý** (`external_google_enabled=false`). Přístup k Drive navrhnout jako **samostatný OAuth tok (inkrementální autorizace)**, ne přes přihlášení do aplikace. |
| Notifikace/komentáře | `notifications`, `task_comments`, `useNotifications.ts` | Případné „soubor přidán“ jako nový typ notifikace přes existující trigger vzor. |
| UI | Monograph + Klasika, česky | Oba styly nutné; nové prvky ověřit v obou. Testy `taskResourcesSection.test.tsx`. |
| AI | `/api/intelligence/analyze-resource` (owner-only), dodržet pravidlo „žádná placená AI API volání“ | Čtení obsahu Drive pro AI je samostatné rozhodnutí; výchozí = jen metadata/odkazy. |

## 3. Konfigurace a omezení prostředí, na která RUN 02 narazí
* **Redirect URL v Supabase Auth jsou záměrně úzké:** `https://clearspace-ai.vercel.app/accept-invite?token=*`. Callback Drive OAuth, pokud půjde přes Supabase, vyžaduje přidat jedinou konkrétní cestu (ne `/**`). Pokud půjde přes vlastní trasu, Supabase se nemění; redirect URI se pak nastavuje jen v Google Cloud.
* **CSP je úzká** (`frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'`, bez `script-src`/`connect-src`), takže Google Picker/`apis.google.com` fungují; při jakémkoli zpřísnění CSP je nutné povolit Google domény.
* **`NEXT_PUBLIC_*` se zapékají při buildu.** Produkční nasazení jde **jen přes CLI**: `vercel deploy --prod --skip-domain --build-env NEXT_PUBLIC_ENABLE_MONOGRAPH=1 …` a před promote **porovnat `build.env` s předchozí produkcí** (`vercel api /v13/deployments/<id>`). Vynechání příznaku způsobilo 2026-11-25 dočasný zánik Monographu. Push do Gitu nenasazuje (`frontend/vercel.json` `deploymentEnabled:false`).
* **Google Cloud (vyžaduje uživatele):** projekt, OAuth consent screen, klient (Web), redirect URI na `clearspace-ai.vercel.app`, případně Picker API key; ověření vlastnictví domény. Rozsahy: `drive.file` (nesenzitivní, vhodné s Pickerem) vs. `drive.readonly` (restricted, ověření/audit). V režimu *Testing* refresh token vyprší za 7 dní a je limit testovacích uživatelů – nutné rozhodnout před návrhem.
* **Tajemství Googlu** (client secret, tokeny) nikdy do konverzace ani do repozitáře: použít vzor skriptu s skrytou výzvou `frontend/scripts/set-resend-keys.sh` (hodnota → Vercel Sensitive, ověření bez zápisu do logu). Tokeny uživatelů ukládat jen na serveru, šifrovaně; klient je nikdy nedostane.

## 4. Provozní postup, který se osvědčil (použít znovu)
1. Migrace psát idempotentně s preflightem a rollbackem v `frontend/supabase/rollback/`; **nacvičit na kopii produkčních dat** (lokální kontejner, role `postgres`, ne superuser) – viz `frontend/scripts/apply-collab-hosted.sh` (kontrolní součty, zámek na čistý strom, záloha `pg_dump`, jedna transakce na migraci, ověření).
2. Produkci číst jen read-only (`SET default_transaction_read_only = on`; pooler ignoruje `PGOPTIONS`). Heslo DB je v Keychainu (`ClearSpace V1 – Supabase Database`).
3. Staged build → kontroly (`check-deployment.sh`, `hosted-verify.sh` s jednorázovými účty `@example.test`) → promote → ověření → záznam v dokumentaci. Zpět: `vercel promote <předchozí>`.
4. Testovací účty zakládat přes admin API (nic se neposílá) a mazat podle ID; **skutečné e-maily jen na adresy vlastníka a jen po jeho pokynu**.
5. Preflight a report před/po živém testu: `live-acceptance-preflight.sh`, `live-acceptance-report.sh`.

## 4a. Pasti a poučení z RUN 01
* `vercel api /v9/projects/<p>`: klíče pole `protectionBypass` **jsou samy bypass secrety** – nevypisovat.
* **Repozitář `bng-dev-alt/clearspace` je veřejný.** Do commitů nepatří tajemství, osobní údaje ani UUID skutečných účtů (viz RUN00_SEED_INTEGRATION.md). Provozní identifikátory (project ref, názvy Keychain položek) už ve veřejné historii jsou.
* Auto-mode klasifikátor odmítá zásahy do produkce, DNS a cizí konfigurace bez výslovného pokynu; plánovat jedno souhrnné schválení.
* `apply-collab-hosted.sh` je vzorem, ale kontrolní součty a očekávaný katalog jsou pevně svázané s RUN 01 – pro RUN 02 vytvořit nový skript, ne upravovat tento.

## 5. Otevřená rozhodnutí pro RUN 02 (doporučení)
1. **Rozsah Googlu:** doporučuji `drive.file` + Picker (uživatel vybírá soubory; bez restricted scope).
2. **Model:** odkaz místo kopie; per-uživatel propojení (každý vidí jen to, k čemu má v Drive právo); metadata v `task_drive_links`.
3. **Role:** přidat/odebrat odkaz = člen a výš; Čtenář jen vidí. Zrušení přístupu člena projektu nesmí ponechat tokeny ani odkazy s oprávněním.
4. **Soukromí:** žádný obsah ani název souboru v logu ani v Realtime signálu (jen ID).
5. **Zpětná kompatibilita:** stávající přílohy (Storage) zůstávají beze změny.

## 6. Co potřebuje od vlastníka (nic z toho neexistuje)
Google Cloud projekt a OAuth klient (client ID veřejné, secret přes skrytou výzvu), rozhodnutí o režimu consent screen (Testing/Production), případně doména pro ověření; po implementaci staged build, jedno souhrnné schválení nasazení.
