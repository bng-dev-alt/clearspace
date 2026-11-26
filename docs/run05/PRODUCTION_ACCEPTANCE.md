# RUN 05 – produkční nasazení (Slack i Telegram VYPNUTÉ) – záznam

Datum: 2026-11-26. Schválení: `RUN_PROMPT.md` §0 (konsolidace + nasazení s vypnutými přepínači po splnění bran). Produkce `https://clearspace.luffast.com`,
Supabase `twjlnsxjtuntujarwner`, Vercel `clearspace` (plán Hobby). Žádná produkční Slack aplikace ani bot, žádné tajemství notifikací ve Vercelu, plánovač vypnutý.

## Výsledek
| | |
|---|---|
| Produkční deployment | **`dpl_Gp6omv6sy6jfchmC8rJGRtQ9nAST`** (READY, promote 2026-11-26), zdroj = čistý `git archive` merge commitu **`1c83872`** |
| Předchozí (rollback bod) | `dpl_FeGsSgZxxG2D87Tmx5bEo8b1MFMv` (RUN 04, `19a0c6b`) – s migrací 1500 prokazatelně funguje (G4, G8) |
| Produkční DB | markery do **`20261129001500_notification_channels`**; záloha `public` před migrací: `/Volumes/WORKSPACE/_G2_BACKUP/20261126-v1-pre-notify` (576 KB, SHA256SUMS OK) |
| Přepínače | `SLACK_INTEGRATION_ENABLED=0`, `TELEGRAM_INTEGRATION_ENABLED=0` (Production, plain; Preview nemá); Gmail i Kalendář dál `0` |

## Brány (v pořadí)
| # | Krok | Důkaz | Výsledek |
|---|---|---|---|
| G1 | Preflight | `main` = `origin/main` = `6732dca`; produkce `dpl_FeGsSgZx…` z `19a0c6b` READY; `git.deploymentEnabled=false`; DB do 1400, žádné notify objekty, žádné `pg_cron`/`pg_net` | PASS |
| G2 | Revize diffu `run04-complete..HEAD` (50 souborů) | žádná tajemství, e-maily mimo testovací domény, identifikátory; tokenové řetězce jen syntetické mock hodnoty | PASS |
| G3 | `rehearse-notify-prod.sh` | replika A (řetězec do 1400) == produkce; replika B (produkční DDL + syntetická data) → `apply-notify-hosted.sh` v 1 transakci, počty + otisky beze změny, žádná extenze; 92 (73) + 93 (70) + 94 (77) + 95 (143) asercí na produkčním DDL + 1500; **parita in-app 1400 = 1500**; rollback odmítnut s kanálem; čistý rollback = katalog 1400; re-apply | PASS |
| G4 | Kód RUN 04 proti DB s 1500 | `git archive run04-complete`: Drive HTTP **28/28**, Gmail **23/23**, Calendar **18/18**, collab realtime PASS, E2E Drive + kolaborace PASS | PASS |
| G5 | Finální regrese (`NOTIFICATIONS.md` §4) | vše PASS; **živá brána BLOCKED** (owner block) → G5 = jen regrese, produkce zůstává vypnutá | PASS (regrese) |
| G6 | Přepínače v Production | Vercel API: oba `plain '0'`, jen production | PASS |
| G7 | **Migrace 1500 na produkci** (`apply-notify-hosted.sh`) | 1 transakce; počty i otisky (notifications, activity, assignees, links, Google, trust) beze změny; žádná extenze; `marker=1 rls=4 client_grants=0 anon_exec=0 dispatch_exec=0 triggers=2 channels=0 deliveries=0` | PASS |
| G8 | Starý build na 1500 | `check-deployment.sh` (DRIVE, GMAIL_OFF, CALENDAR_OFF) **134/134**; `hosted-verify.sh` **18/18** (+1 přeskočen = notify test) + realtime, 0 zbytků | PASS |
| 9 | Merge → `main` | `--no-ff` **`1c83872`** (strom == ověřená větev) | PASS |
| 10 | Staged build + brány | `dpl_Gp6omv6…`; preflight PASS (1200–1500, 4 přepínače explicitně jen Production, žádné notify tajemství); `check` **148 ok / 0 FAIL** (po opravě zastaralé kontroly skriptu, `d3aa353`); build.env proti produkci: jediné rozdíly = 2 nové přepínače | PASS |
| 11 | Promote | `vercel promote` → produkce = `dpl_Gp6omv6…`, `releaseCommit=1c83872` | PASS |
| 12 | Produkce po promote | `check-deployment.sh` (+ `EXPECT_SLACK_OFF=1 EXPECT_TELEGRAM_OFF=1`) **147/147**; `hosted-verify.sh` (`E2E_EXPECT_NOTIFY=off`) **19/19** vč. notify containment + realtime, 0 zbytků | PASS |
| 13 | Monograph | `monograph-prodcheck.mjs` (odhlášeně): Monograph výchozí před `<body>`, Klasika respektována (`data-style`), fonty, motiv nezávislý = OK; přepínač/rail v navbaru **NOT VERIFIED** (vyžaduje přihlášenou stránku – jako RUN 03C/04; skript tyto 2 body hlásí jako FAIL) | PASS / NOT VERIFIED |
| 14 | Runtime logy hned po promote | 3 záznamy, 0 chyb, 0 tokenů/kódů/JWT | PASS |
| 15 | Data vlastníka | otisk Google/notifikačních/aktivitních řádků po nasazení == před migrací; 0 kanálů, 0 doručení, žádný `cron` | PASS |

## Notify containment (nezávislé na UI)
Všechny `/api/notify/*` (status, preferences, channel, test, slack start/complete, telegram link/check/confirm, dispatch i s hlavičkou) → **503 `*_disabled`**
anonymně i přihlášeně; Slack callback → `/settings?notify=disabled` bez cookie; `/privacy` „není zapnuto“; `/about` bez sekce; karta v Nastavení se nezobrazí;
bundle bez Slack/Telegram hostů, tokenů, přepínačů a notify RPC.

## Incident při bráně 12 (zapsáno pravdivě)
Spuštění `hosted-verify.sh` po promote proběhlo v hlavním checkoutu `V1/frontend`, kde **už existoval vlastníkův gitignorovaný soubor `.env.local`**. Dočasný
zápis skriptu ho **přepsal a následný úklid smazal**; původní obsah neznám a nelze ho obnovit (žádný lokální snapshot, Time Machine nedostupný). Do repa ani
produkce nic neuniklo (soubor byl dočasně jen s veřejnou URL a anon klíčem). Omylem vytvořený symlink `node_modules/node_modules` a artefakty běhu
(`test-results/`) jsem odstranil. **Vlastník: obnovte prosím `V1/frontend/.env.local` ze svých záznamů** (vzor obsahu: `V1-consolidation/frontend/.env.local`).
Poučení (handoff): hostované ověření vždy z dočasného exportu (jako RUN 04 `V1-release`), nikdy v hlavním checkoutu.
