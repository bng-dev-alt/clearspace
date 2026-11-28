# RUN 10 – provoz, nastavení poskytovatelů, rollback

Produkce: `https://clearspace.luffast.com`, Supabase `twjlnsxjtuntujarwner`, Vercel `clearspace` (jen staged build + promote).

## Stav k 2026-11-28 (po RUN 10)
* DB: migrace **1800** aplikována (`scripts/apply-meetings-hosted.sh`, rehearsal `scripts/rehearse-meetings-prod.sh` PASS). Šifrovaná záloha
  `/Volumes/WORKSPACE/_G2_BACKUP/20261128-v1-run10-pre-meetings-encrypted` (AES-256, klíč Keychain `g2-backup-20261128-v1-run10-pre-meetings`,
  SHA256SUMS, obnova ověřena počty řádků).
* Kód: `dpl_FZMYZjkvXQJJ1bgk7m8Qn3ipSnLs` (commit `c66b23e`), **všechny nové schopnosti vypnuté** (proměnné níže nejsou nastavené).
* Rollback kódu: `vercel promote dpl_GWQF6jGsECxp16U99vJ6ZpNH6afv --scope bng-dev-alt-webadvisor --yes` (RUN 09; s 1800 ověřen 143/143).

## Proměnné (Vercel, Production; hodnoty jen ve Vercelu / Keychainu)
| Proměnná | Význam | Pilot (po schválení) |
|---|---|---|
| `NEXT_PUBLIC_ENABLE_MEETING_LIVE` | UI plánovaných / živých porad (build-time) | `1` |
| `MEETING_LIVE_ENABLED` | server: živý přepis (kill switch) | `1` |
| `MEETING_PILOT_USER_IDS` | kdo smí živý přepis (prázdné = nikdo) | id prezentačního účtu (ADR RUN 09-01) |
| `MEETING_LIVE_SEGMENT_MIN` | délka rezervace segmentu | `10` pro akceptaci, pak `30` |
| `AI_DEMO_STT_DAILY_AUDIO_MIN_PER_USER` / `_GLOBAL` | denní minuty přepisu demo tieru (dnes 0) | `30` / `30` pro akceptaci |
| `SONIOX_RT_MODEL` | volitelně, výchozí `stt-rt-v6` | – |
| `CALENDAR_WRITE_ENABLED` | zápis do Kalendáře (1/pilot/off) | `pilot` (používá `GOOGLE_PILOT_*`) |
| `MEETING_PI_ENABLED` | shrnutí porad v Project Intelligence | `1` |
| existující `STT_ENABLED`, `STT_SERVER_SECRET`, `SONIOX_API_KEY`, `SONIOX_REGION` | už v produkci (RC5) | beze změny; klíč musí mít oprávnění „Temporary API keys“ |

## Vypínače (okamžité, nezávislé)
| Co | Jak |
|---|---|
| Živý přepis | `MEETING_LIVE_ENABLED=0` + redeploy (start/append 503; close/complete/discard dál fungují) |
| Veškerý přepis | `STT_ENABLED=0` |
| Minuty | `AI_DEMO_STT_DAILY_AUDIO_MIN_PER_USER=0` (demo tier) |
| Zápis do Kalendáře | `CALENDAR_WRITE_ENABLED=0`; uživatel sám: „Vypnout plánování porad“ |
| PI ingest porad | `MEETING_PI_ENABLED=0` (okamžitě prázdný zdroj) |
| UI | `NEXT_PUBLIC_ENABLE_MEETING_LIVE` odebrat + redeploy |
| Poskytovatel | Soniox Console: měsíční limit projektu / zneplatnit klíč |

## Zdraví
`select live_state, count(*) from meetings group by 1` · otevřené segmenty `select * from meeting_live_segments where state='open'` (po
rezervaci + 2 min se samy uzavřou při dalším volání) · ledger `select billing_state, sum(audio_ms)/60000.0 min, sum(cost_usd) from ai_requests
where feature='meeting-transcribe' and created_at > now()-interval '24 hours' group by 1` · Vercel logy: `[stt-live]` jen kód chyby, nikdy text.

## Rollback DB (jen pokud nutné)
`frontend/supabase/rollback/20261202001800_meeting_intelligence_live.down.sql` (jedna transakce) – odmítne se, existuje-li nedokončený živý
přepis (nejdřív dokončit/zahodit). Hotové přepisy zůstávají (běžná revize `soniox`). Ledger se nemění.

## Lokální vývoj / mock
`frontend/scripts/meetings-stack.sh up|mock|soniox|app|env|down` – izolovaný stack `cs-run10-sb` (porty 55620–55629, app 3481), Google mock
55642 (vč. zápisu do Kalendáře, nikdy neposílá e-maily), falešný Soniox 55643 (async + real-time WebSocket). Mock E2E:
`E2E_MEETINGS_STACK=1 … npx playwright test e2e/meeting-live.spec.ts`.
