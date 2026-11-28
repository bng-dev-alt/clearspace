# RUN 10 – Meeting Intelligence: architektura

Stav: implementováno ve větvi `feature/run10-meeting-intelligence` (worktree `V1-run10`). Navazuje na existující jádro porad z RC1–RC5
(`docs/intelligence/ARCHITECTURE.md`) – nic z něj se nepřepisuje, jen rozšiřuje.

## 1. Celkový tok

```
Projekt ─▶ Porada (plánovaná / ad-hoc / text / nahraný záznam)          meetings (+ ends_at, conference_url, live_*)
   │            ├─ pozvaní (e-maily; hosté bez účtu)                    meeting_attendees
   │            ├─ událost Google Kalendáře + Meet (volitelně)          external_resource_links + calendar_link_sources (RUN 04)
   │            │                                                       └─ meeting_resource_links (nové, provider-neutrální)
   │            └─ živý přepis (prohlížeč ⇄ Soniox real-time)           meeting_live_segments / meeting_live_chunks
   │                         ▼  „Ukončit a uložit“
   │                  jedna revize přepisu (source 'soniox')            meeting_transcripts (beze změny)
   │                         ▼  „Analyzovat“ (Gemini, existující)
   │                  návrhy: rozhodnutí, úkoly, rizika… s citací       intelligence_runs / intelligence_items (beze změny)
   │                         ▼  člověk schválí / upraví / zamítne
   └──────────── úkol v projektu (apply_intelligence_item, idempotentní) ─▶ Project Intelligence (citace item:/meeting:)
```

## 2. Datový model (migrace 1800, aditivní)

| Objekt | Účel | Zápis | Čtení |
|---|---|---|---|
| `meetings.ends_at`, `conference_url` | plánovaný konec, odkaz pro připojení (Meet z odpovědi Googlu, nebo ručně Zoom/Teams/jiný https) | člen (sloupcový grant), CHECK https + délka | členové (RLS) |
| `meetings.live_state/live_ms/live_segments` | stav živého přepisu | jen RPC `stt_live_*` | členové |
| `meeting_resource_links` | porada ↔ `external_resource_links` (RUN 04 návrh), jen projektové linky téhož projektu (trigger) | editor projektu | členové |
| `meeting_attendees` | pozvaní (lowercase e-mail, volitelné jméno), max 50 | editor projektu | členové |
| `meeting_live_segments` | jeden stream poskytovatele = jedna rezervace v `ai_requests` | jen RPC se serverovým tajemstvím | členové (bez user_id/request_id) |
| `meeting_live_chunks` | průběžně ukládané finální tokeny (obnova po zavřené kartě) | jen RPC | členové; po dokončení se mažou |

Provider-specifické id (event id, Google `sub`) zůstávají v soukromé `calendar_link_sources`; `meetings` žádné Google sloupce nemá.
Mazání porady kaskádou odstraní přepisy, běhy, položky, pozvané, vazby, segmenty i části; **ledger `ai_requests` zůstává** (peníze se nemažou).

## 3. Živý přepis – bezpečnost nákladů a klíčů

1. Prohlížeč → `POST /api/intelligence/meetings/live {action:'start'}`.
2. Brány v tomto pořadí (vše PŘED poskytovatelem): `STT_ENABLED` + `MEETING_LIVE_ENABLED` → JWT + AI tier (`authenticate`) → pilot
   `MEETING_PILOT_USER_IDS` → STT povolené tierem (demo: `AI_DEMO_STT_DAILY_AUDIO_MIN_PER_USER` > 0) → DB `stt_live_reserve`
   (člen, **organizátor** = autor nebo vlastník projektu, prohlášení organizátora, žádný otevřený segment, limit 300 min/porada, 40 segmentů,
   denní rozpočet uživatele i globální – **společný s async přepisem**).
3. Teprve po rezervaci server vytvoří **jednorázový** dočasný klíč Soniox (`single_use`, platnost 60 s,
   `max_session_duration_seconds` = rezervace). Strop nákladů segmentu tedy vynucuje i poskytovatel. Dlouhodobý klíč nikdy neopustí server.
4. Prohlížeč otevře `wss://stt-rt.soniox.com/transcribe-websocket` s klíčem v seznamu protokolů (dokumentovaná cesta pro prohlížeče),
   první zprávou pošle konfiguraci (model `stt-rt-v6`, `audio_format:auto`, `cs`+`en`, identifikace jazyka, diarizace, endpointing,
   kontext jen `domain=Project meeting` – žádná jména ani názvy).
5. Zvuk: `getUserMedia` (mikrofon) + volitelně `getDisplayMedia` (zvuk karty) → `AudioContext` mix → mono → `MediaRecorder`
   WebM/Opus 32 kbps, 250 ms → binární rámce. Video sdílené karty se okamžitě zastaví.
6. Finální tokeny → každé ~3 s `append` (idempotentní `seq`) → `meeting_live_chunks`. Průběžné (non-final) jen na obrazovce.
7. Pauza = prázdný rámec (konec zvuku), čekání na `finished`, `close` (vyúčtování min(rezervace, hlášená doba, čas na serveru + 15 s)).
   Pokračování = nový segment s posunem času. Neplatí se za čas pauzy.
8. Výpadek spojení = segment se uzavře (`error`), max. 3 nové segmenty s backoffem 1/2/4 s; mezera se v přepisu projeví (mluvčí z dalšího
   segmentu se neslučují – čísla mluvčích Soniox platí jen v rámci streamu).
9. Rezervace s koncem dřív, než stream začne (poskytovatel klíč odmítne) → `stt_live_release` (nic se neúčtuje).
10. Zavřená karta: otevřený segment se po uplynutí rezervace + 2 min „sklidí“ s plnou rezervací (fail-safe); uložené části zůstávají a
    organizátor je může dokončit, pokračovat, nebo zahodit.
11. `complete`: server spojí části všech segmentů, normalizuje (stejný normalizér jako async), uloží **jednu** revizi s machine provenance,
    části smaže. Další stream po dokončení DB odmítne (`finalized`).

## 4. Kalendář a konference

* Nová Google služba `meetings` = scope `calendar.events.owned` (sensitive), žádá se **inkrementálně** až po zapnutí „Plánování porad“
  v Propojených účtech; čtecí `calendar.events.owned.readonly` zůstává beze změny. Vlastní přepínač `CALENDAR_WRITE_ENABLED` (1|pilot|off).
* `POST /api/meetings/calendar`: jen organizátor; událost v hlavním kalendáři s **id = id porady** (opakování po výpadku → 409 → dočtení,
  nikdy druhá událost/pozvánky); `conferenceDataVersion=1` + `hangoutsMeet`; odkaz Meet se bere **jen z odpovědi Googlu** (regex
  meet.google.com), jinak stav pending/failure; `sendUpdates=all` jen při výslovném zaškrtnutí, jinak `none`. Událost se připojí k projektu
  stejnou cestou jako RUN 04 a naváže `meeting_resource_links`. `PATCH` synchronizuje čas/název/hosty, `DELETE` ruší (link `deleted`).
* Zoom / Teams / jiné: jen obecný https odkaz + zachycení zvuku karty; **žádná nativní integrace**.

## 5. Project Intelligence

* Schválené závěry porad (existující `item:`) nesou název a datum porady; aplikované úkoly odkaz `card:`.
* Nově (`MEETING_PI_ENABLED=1`): AI shrnutí 8 posledních analyzovaných porad jako zdroj `meeting:<id>#summary`, jen pro účely
  odpovídání (`chat`, `brief`), označené „neověřené člověkem“ a rámované jako data (nikdy pokyny). Účely, které navrhují změny
  (pm, risk, meeting, improve, daily, capacity), shrnutí nevidí. Smazaná porada zmizí kaskádou.

## 6. Vypínače (nezávislé)

| Schopnost | Vypínač | Výchozí |
|---|---|---|
| Plánované porady v UI | `NEXT_PUBLIC_ENABLE_MEETING_LIVE` (build) | off |
| Zápis do Kalendáře / Meet | `CALENDAR_WRITE_ENABLED` (+ `GOOGLE_PILOT_*` při `pilot`) | off |
| Živé snímání + přepis | `MEETING_LIVE_ENABLED` + `STT_ENABLED` + `MEETING_PILOT_USER_IDS` + STT minuty tieru | off |
| Analýza porady | existující AI tier + `ai_reserve` (demo 40k tokenů/den, 2/min) | jak RUN 09 |
| PI ingest porad | `MEETING_PI_ENABLED` | off |

Ukončit a uložit (`close`/`complete`/`discard`) funguje i s vypnutým přepínačem – vypínač nikdy nebrání zastavení.
