# Pilotní režim Gmail / Google Kalendář (RUN 06)

## Konfigurace (jen server)
| Proměnná | Hodnota |
|---|---|
| `GMAIL_INTEGRATION_ENABLED`, `CALENDAR_INTEGRATION_ENABLED` | `1` = všichni (beze změny), **`pilot`** = jen pilot, cokoli jiného = vypnuto |
| `GOOGLE_PILOT_USER_IDS` | čárkami oddělená UUID uživatelů ClearSpace (nikdy sdílená identita veřejného dema) |
| `GOOGLE_PILOT_ACCOUNTS` | čárkami oddělené e-maily Google účtů, které smí udělit Gmail / Kalendář |

`pilot` s prázdným seznamem = vypnuto pro všechny (fail closed). Disk není pilotem omezen (v produkci už běží).

## Chování
| Místo | Pilot |
|---|---|
| `GET /api/google/connection` | `gmailAvailable` / `calendarAvailable` jen pro pilotního uživatele (s připojeným účtem jen pro pilotní účet) |
| `oauth/start` | mimo pilot `503 gmail_disabled` / `calendar_disabled` – stejná odpověď jako vypnuto, žádná URL Googlu; i když je připojený jiný než pilotní účet |
| `oauth/complete` | ne-pilotní Google účet → `pilot_account`, nic se neuloží, existující spojení beze změny; v pilotu se nikdy neuloží Gmail/Calendar scope účtu mimo pilot |
| `getAccessToken` (všechny Gmail / Calendar trasy) | kontrola uživatele **a** účtu při každém použití, před kontrolou grantu a i bez spojení → mimo pilot vždy `*_disabled`; vyřazení ze seznamu platí okamžitě |
| `/privacy` | sekce Gmail / Kalendář se zobrazí s poznámkou „Pilotní provoz … jen pro několik předem určených testovacích účtů“ |
| Klientský bundle | názvy proměnných hlídá `check-production-bundle.sh` |

Režimy `1` a `0` se chovají přesně jako dosud (regrese Drive 28, Gmail 22, Calendar 18 v režimu `1`).

## Testy
* `src/__tests__/gmail/googlePilot.test.ts` – režimy, seznamy (velikost písmen, mezery, prázdné), token pro pilot / cizího uživatele / cizí účet / bez spojení.
* `supabase/tests/google_pilot_http.mjs` – skutečné trasy + mock Google: dostupnost, 503 bez URL, `pilot_account`, plný průchod pro pilot, vynucení per požadavek.
* `supabase/tests/gdemo_live_accept.mjs isolation` – **živě**: bob (editor) a vera (čtenářka) ve stejném projektu jako pilotní alice a cizí uživatel →
  všude `*_disabled`, žádná URL souhlasu, žádný Picker token, žádný přístup ke Google alice; cizí uživatel nevidí odkazy projektu (RLS).

## Nález opravený během živé izolace
Uživatel mimo pilot **bez** připojeného Google účtu dostal z vyhledávání Gmailu `not_connected` (prozrazovalo, že Gmail běží). Opraveno
v `getAccessToken` (pilot bez spojení = odpověď vypnuto), přidán unit test; živá izolace pak prošla.
