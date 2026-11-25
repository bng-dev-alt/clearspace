# RUN 03 – Gmail: příprava produkčního nasazení (NEPROVÁDĚT bez rozhodnutí vlastníka)

Tento dokument nic nepovoluje. Navazuje na `docs/run02/PRODUCTION_ROLLOUT.md` (RUN 02C, Drive), který musí proběhnout dřív nebo současně.

## Rozhodnutí vlastníka (RUN 03B, 2026-11-25)
Pro současný portfolio rozsah platí **varianta A**: skutečný Gmail jen v řízeném vývoji/testování (`clearspace-dev`, Testing); **veřejná produkce
má Gmail vypnutý** (`GMAIL_INTEGRATION_ENABLED` nenastaveno). Žádné ověření restricted scope ani CASA se nezahajuje; `clearspace-prod` se nemění,
produkční DB se nemigruje, nic se nemerguje do `main`, nepushuje ani nenasazuje. Budoucí položka: veřejná **syntetická** ukázka Gmailu (ROADMAP).

## Plán budoucího merge a rolloutu (až na výslovné schválení)
1. `feature/run03-gmail` (tag `run03-complete`) obsahuje už `run02c-complete` → merge do `main` bude bez konfliktů s RUN 02C (`--no-ff`, žádný rebase).
2. Před merge: `vitest`, `supabase/tests/run.sh`, `next build` + `check-production-bundle.sh`; E2E Drive na stacku.
3. Produkce s Gmailem vypnutým: nasadit kód bez `GMAIL_INTEGRATION_ENABLED` → `/privacy` ukáže „Gmail není zapnutý“, Gmail trasy 503, UI sekci skryje.
4. **Migrace 1300 je pro tento kód povinná i s vypnutým Gmailem**: `oauth/complete` volá `google_connection_sub` a `google_service_audit`
   (funkce z 1300) i pro Disk – bez migrace by připojení Disku selhalo bezpečně (fail closed). Pořadí: záloha → nácvik na replice
   (vzor `rehearse-drive-prod.sh`) → 1300 v jedné transakci → teprve potom kód. Rollback 1300 je bez Gmail dat čistý.
5. Zapnutí Gmailu kdekoli mimo dev = nové rozhodnutí podle §0 (B/C/D) + Privacy Policy (sekce Gmail je připravená, zobrazí se se zapnutým přepínačem).

## RUN 03C – schválené pořadí nasazení (Gmail VYPNUTÝ)
Vercel: `vercel.json` má `git.deploymentEnabled: false` a všechny produkční buildy jsou `src=cli` (push RUN 02C žádný build nevytvořil) –
push `main` tedy nic nenasazuje; nasazuje jen `deploy-drive-staged.sh` + `vercel promote`.
1. Nácvik: `scripts/rehearse-gmail-prod.sh` (produkce jen čtena; replika = produkční DDL + syntetická data vč. Drive řádků) → PASS.
2. Kompatibilita: kód RUN 02C (`run02c-complete`) proti DB s 1300 – Drive HTTP 28/28 + Drive E2E (lokálně, mock).
3. Produkční env: `GMAIL_INTEGRATION_ENABLED=0` (Production, výslovně; Preview nemá).
4. `CONFIRM_GMAIL=twjlnsxjtuntujarwner scripts/apply-gmail-hosted.sh` (záloha `pg_dump` → 1 transakce → otisk existujících Google řádků beze změny).
5. Starý build (RUN 02C) dál běží: `check-deployment.sh https://clearspace.luffast.com` (EXPECT_DRIVE=1) + `hosted-verify.sh` (jednorázové účty).
6. Merge `feature/run03-gmail` → `main` (`--no-ff`), z merge commitu `RELEASE_BRANCH=main EXPECT_GMAIL_MIGRATION=1 CONFIRM_DRIVE_DEPLOY=<sha>
   deploy-drive-staged.sh deploy` → `check <staged-url>` (vč. Gmail containment) → `vercel promote`.
7. Produkce: `check-deployment.sh` (EXPECT_DRIVE=1 EXPECT_GMAIL_OFF=1), `E2E_EXPECT_GMAIL=off hosted-verify.sh`, Monograph, runtime logy; push `main` + tagy.
**Rollback:** kód = `vercel promote` předchozího buildu (`dpl_26oNU69r…`, RUN 02C, s 1300 funguje – krok 2). DB 1300 se **nevrací**, dokud běží kód,
který ji potřebuje; i potom jen `rollback/20261127001300_gmail.down.sql` (odmítne při Gmail datech).

## 0. Rozhodnutí, která musí udělat vlastník (před čímkoli dalším)
1. **Kdo bude Gmail používat?** `gmail.readonly` je *restricted*:
   * **A – nepublikovat Gmail veřejně** (doporučeno pro portfolio): produkce s `GMAIL_INTEGRATION_ENABLED` nenastaveným; veřejnosti jen popis a lokální/označená simulace.
   * **B – Testing režim** dev/prod projektu: ≤ 100 pozvaných testerů, varování „neověřená aplikace“, autorizace vyprší po 7 dnech.
   * **C – interní aplikace** ve vlastní Google Workspace organizaci (User type *Internal*): bez ověření a CASA, jen pro účty organizace.
   * **D – veřejné ověření**: ověření značky + restricted-scope verification (demo video, zdůvodnění scope) + **každoroční CASA (Tier 2/3, placené, týdny)**.
2. Privacy Policy na ověřené doméně, která popisuje Gmail data (co, proč, retence, mazání, „Workspace API nejsou použita k tréninku obecných AI modelů“, Limited Use).

## 1. Google Cloud (produkční projekt – oddělený od dev)
| Krok | Hodnota |
|---|---|
| API | **Gmail API** zapnout (vedle Drive API a Picker API z RUN 02C) |
| OAuth klient | ten samý Web application klient jako Drive (jeden grant, inkrementální) |
| Redirect URI | `https://<prod-doména>/api/google/oauth/callback` (beze změny) |
| Authorized JavaScript origins | `https://<prod-doména>` (Picker; beze změny) |
| Consent screen – scopes | `openid`, `.../auth/userinfo.email`, `.../auth/drive.file`, **`.../auth/gmail.readonly`** – nic dalšího |
| Klasifikace | `drive.file` non-sensitive; `gmail.readonly` **restricted** |
| Ověření | dle §0 (B/C bez ověření; D = brand + restricted verification + CASA) |

## 2. Prostředí (Vercel, Sensitive kde je to tajemství)
| Proměnná | Hodnota |
|---|---|
| `GMAIL_INTEGRATION_ENABLED` | `1` jen tam, kde je Gmail schválen (§0); jinak **nenastavovat** |
| `GOOGLE_*`, `APP_BASE_URL` | beze změny z RUN 02C (žádná nová tajemství) |
| `GOOGLE_API_MOCK_BASE` | **nikdy** (kód ho v produkci odmítne) |
Credentials zadávat jen přes Vercel UI / `vercel env add` s hidden promptem (jako RUN 02C), nikdy do chatu/souboru.

## 3. Databáze
1. Záloha (pg_dump dle `docs/MIGRATION_RUNBOOK.md`).
2. `20261126001200_google_drive.sql` (pokud ještě není) → `20261127001300_gmail.sql` v jedné transakci (`psql --single-transaction`). Aditivní, idempotentní; Drive řádky se nemění.
3. Kontrola: `select version from clearspace_migrations order by 1 desc limit 2`; `select count(*) from gmail_link_sources` = 0.
4. **Rollback**: `supabase/rollback/20261127001300_gmail.down.sql` – odmítne, pokud existují Gmail odkazy nebo per-service audit (`SET clearspace.rollback_allow_data_loss = 'on'` jen vědomě). Granty u Googlu rollback nemění: nejdřív vypnout funkci, uživatelé odpojí / vypnou Gmail.

## 4. Vypnutí funkce (bez revokace)
* `GMAIL_INTEGRATION_ENABLED` odebrat + redeploy ⇒ všechna Gmail volání 503 „není na serveru zapnuté“, UI sekci skryje (zobrazí jen existující metadata), Drive běží dál.
* Vypnutí funkce ≠ revokace grantu. Revokaci provádí uživatel („Odpojit Google účet“) nebo v myaccount.google.com/permissions. Google neumí zrušit jen Gmail scope.

## 5. Staged build a ověření
1. Build s `GMAIL_INTEGRATION_ENABLED=1` a bez DEV příznaků; `scripts/check-production-bundle.sh` (65 vzorů vč. Gmail RPC, hostu API, scope, přepínače).
2. Staged deployment (chráněný preview) → `LIVE_ACCEPTANCE.md` body 1–20 se skutečným účtem.
3. Ověřit, že Drive (RUN 02) funguje beze změny, včetně Pickeru (downscoped token, `narrow_token` v logu bez `extra`).
4. Promote až po PASS; jinak funkci nechat vypnutou.

## 6. Dopady na Drive
* Picker teď vždy dostane nově vydaný, na Drive omezený token (jeden refresh navíc na otevření Pickeru). Pokud by Google při refresh s `scope`
  vrátil širší token, Picker odmítne (503) – **živě neověřeno** (LIVE_ACCEPTANCE bod 8). Fallback: vypnout Gmail; Drive-only granty nejsou dotčené.
* „Odpojit Google účet“ teď ukončí Disk i Gmail najednou (UI to říká).

## 7. Veřejné portfolio
Bez schváleného Gmailu musí produkce působit jako „Gmail není na tomto serveru zapnutý“ – žádné tvrzení, že návštěvník může připojit skutečný Gmail.
Ukázky jen jako lokální simulace (štítek „simulace“) nebo screenshoty z mocku s popiskem.
