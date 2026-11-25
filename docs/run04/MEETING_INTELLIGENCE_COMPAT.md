# RUN 04 – kompatibilita Google Calendar ↔ Meeting Intelligence

Read-only průzkum (2026-11-25, větev `feature/run04-google-calendar`). TRUTH MODE: každé tvrzení má `soubor:řádek`; co nebylo viděno, je **NEOVĚŘENO**.
Zkratky: `M0500` = `frontend/supabase/migrations/20261118000500_intelligence_core.sql`, obdobně `M0600`, `M0700`, `M0800`, `M0900`;
`M1200` = `…/20261126001200_google_drive.sql`; `ARCH` = `docs/intelligence/ARCHITECTURE.md`; `HARD` = `docs/intelligence/HARDENING_RELEASE_CANDIDATE.md`;
`OWNER` = `docs/intelligence/OWNER_ACTIVATION.md`; `REL` = `docs/intelligence/RELEASE_DECISION.md`.

## 1. Inventura

| Oblast | Stav (zdroj) |
|---|---|
| `meetings` sloupce | `id`, `project_id` (FK projects CASCADE), `title` 1–200, `occurred_at` (jeden okamžik, žádný konec), `created_by`, `source_kind text\|audio`, `status` (draft…failed, píše jen DB), `language_hint`, `current_revision`, `speaker_names` (jména zadává člověk, AI nikdy), `UNIQUE(id, project_id)` – M0500:139-156. Audio/STT sloupce viz níže (M0700:67-86). **Žádný sloupec s externím odkazem / event id** (M0500:139-156, M0700:67-86). |
| RLS | SELECT/UPDATE člen projektu, INSERT člen + `created_by = auth.uid()`, DELETE autor nebo vlastník projektu – M0500:182-194. |
| Granty | `authenticated`: SELECT, DELETE; INSERT jen 8 sloupců; UPDATE jen `title, occurred_at, language_hint, speaker_names` – M0500:196-201. Consent/audio/STT sloupce klient nepíše (M0700:104). |
| Guardy | `guard_meeting_identity`: `project_id` a `source_kind` neměnné, `created_by` jen → NULL po smazání profilu (M0900:31-54, převzato i v M0800:2088-2111). Kvóta 500 porad/projekt, 40/uživatel/den (M0600:95, M0800:1103-1104, trigger M0800:1163-1192). |
| Souhlas | `consent_at`, `consent_by` (M0700:67-68); `record_audio_consent` jen u `source_kind='audio'`, idempotentní, první souhlas platí (M0700:316-337). Je to **prohlášení člena**, ne právní doklad (M0700:316-317, `NewMeetingForm.tsx:16`, `AudioPanel.tsx:154`). Upload do Storage bez souhlasu RLS odmítne (M0700:215-228, 284-287); `stt_reserve` vrací `no_consent` (M0800:1701-1702). |
| Audio storage | Soukromý bucket `meeting-audio`, 50 MB, whitelist MIME (M0700:170-180), cesta `<project>/<meeting>/<uuid>.<ext>` (M0700:8). Retence: `audio_delete_after` se nastaví při **uploadu**, default 7 d, max 30 (M0700:24, 389; M0600:99; `lib/stt/pipeline.ts:38` env `STT_RETENTION_DAYS`). Žádný cron – mazání při otevření porad (sweep) nebo ručně (M0700:24-26, HARD:46, 126). Osiřelé soubory smazaných porad → `meeting_audio_orphans` (trigger BEFORE DELETE, M0700:182-212). Mazání nezávisí na STT příznacích (`lib/stt/audioCleanup.ts:3-7`). |
| `stt_jobs` | Každá úloha u poskytovatele: `state submitting\|unknown_outcome\|active\|succeeded\|failed\|cancelled`, vlastní `cleanup_state` (8 pokusů, backoff), `meeting_id` ON DELETE SET NULL → řádek přežije poradu (M0700:137-165, 760-762). Stav na poradě `stt_state none\|submitting\|unknown\|transcribing\|completed\|failed` (M0700:91-93). Placený POST se nikdy neopakuje, nejistota se dohledá přes `client_reference_id` (M0700:13-15, HARD:15, 44). |
| `server_trust` | Tabulka s SHA-256 tajemství, RLS bez politik (M0700:109-116); `require_server_secret` volají všechny zápisové `stt_*` RPC (M0700:118-132, 458, 537, 582, 606, 650, 722, 773). Staré RPC bez tajemství M0800 výslovně DROPuje (M0800:1658-1667). |
| Erasure (0900) | Oprava: smazání uživatele padalo na guardu (HTTP 500); nyní povolen jen přechod `created_by → NULL` při neexistujícím profilu, funkce SECURITY DEFINER (M0900:4-16, 41-47). |
| Revize přepisu | `meeting_transcripts` neměnné (PK `meeting_id, revision` = sha256 hex), FK `(meeting_id, project_id)` CASCADE (M0500:206-220), klient jen SELECT/INSERT (M0500:288-292); nová revize → `current_revision` + status `transcribed` (M0500:260-278). Lineage `parent_revision`, `edit_note`, zdroj `edit` (M0600:57, 71); `source='soniox'` jen přes `stt_complete` (token `machine_persist_tokens`, M0800:1120-1149); max 25 revizí (M0800:1105). |
| Citace | Projektový kontext: `meeting:<meetingId>#<segmentId>` (`lib/intelligence/context.ts:72, 78`; `citations.ts:19`; ARCH:272, 388). V DB evidenci položky je ref `segment:<id>` (M0500:356, 424-426). |
| `intelligence_items` | Evidence 1–4 odkazy na **reálné** segmenty revize běhu; `quoteFound`, časy a `support` přepočítává DB (M0500:389-462); `decision`/`action_item` musí být `linked` (M0500:453-456). Vstup jen přes SECURITY DEFINER `persist_meeting_run` (M0500:13-14, 565-573); review/apply stavový automat (M0500:474-547). |
| AI brána | Meeting routy leží v `/api/intelligence/meetings/{analyze,transcribe,sync,purge,sweep}` (soubory `frontend/src/app/api/intelligence/meetings/*/route.ts`), **ne** v `/api/ai` – ten drží produkční firewall zavřený (`…/analyze/route.ts:5-6`, OWNER:11, 18). Přístup jen `AI_OWNER_USER_IDS`, fail closed (OWNER:9-10; `lib/ai/gateway.ts:155-157`). Tiery a rozpočty: `docs/intelligence/AI_BUDGET_POLICY.md:5-14`. |
| Produkce | Produkce = RC5 `12f7738` (REL:63), owner-only Meeting + Project Intelligence (REL:8, 10). K 2026-11-19 „nothing activated“ (OWNER:3); zda je dnes v produkci `STT_ENABLED=1` – **NEOVĚŘENO** (REL:49 jen zmiňuje „owner's earlier real run“). Gemini paid tier: externí gate BLOCKED (HARD:85), stav potvrzení **NEOVĚŘENO**. |

Rozpory v dokumentaci: `docs/run04/DESIGN.md:50` uvádí `/api/ai/meetings/*` – skutečné cesty jsou `/api/intelligence/meetings/*` (OWNER:11).
ARCH:234 („audio se maže po přijetí přepisu“) je překonané – lhůta běží od uploadu (M0700:24, HARD:46).

## 2. Budoucí „Vytvořit poradu z události“ – co lze převzít / co chybí

| Převzít beze změny | Chybí / nutno rozhodnout |
|---|---|
| INSERT porady klientem s `title`, `occurred_at` (granty M0500:198-199) – prefill z `name` / `event_start` linku | Vazební tabulka porada ↔ link (neexistuje; §3) |
| RLS, kvóty, guardy, erasure (M0500:182-201, M0800:1163-1192, M0900) | `meetings` nemá konec ani délku (jen `occurred_at`, M0500:143) – konec nechat v linku, nekopírovat |
| Souhlas + audio + STT + retence + úklid (M0700) | `source_kind` je neměnný (M0900:38) a text porada vzniká jen s přepisem (`meetingService.ts:263-288`), audio jen se souborem a souhlasem (`meetingService.ts:441-459`): „prázdná plánovaná porada z události“ dnes **není podporovaný tok** |
| Evidence, citace, review/apply (M0500:389-547) | Pozn.: název porady jde do promptu Gemini (`lib/intelligence/meetingBrief.ts:71`) – prefill z události = název události u Gemini při analýze |
| Owner gate + rozpočty (`gateway.ts:155-157`) | `ResourceProvider` v `lib/resources/contract.ts:16` zatím nezná `google_calendar_event` (RUN 04 přidá jen pokud potřebuje; pro AI zůstává `not_consented`) |

## 3. Doporučená vazba (provider-neutral)

```sql
-- BUDOUCÍ aditivní migrace (≥ 1500), NE v RUN 04
CREATE TABLE public.meeting_resource_links (
  meeting_id UUID NOT NULL REFERENCES public.meetings(id) ON DELETE CASCADE,
  link_id    UUID NOT NULL REFERENCES public.external_resource_links(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL,
  PRIMARY KEY (meeting_id, link_id),
  FOREIGN KEY (meeting_id, project_id) REFERENCES public.meetings (id, project_id) ON DELETE CASCADE
  -- + kontrola link.project_id = project_id (trigger, nebo FK po přidání UNIQUE(id, project_id) na links)
);  -- RLS: SELECT is_project_member(project_id); zápis přes RPC
```

| Proč | Zdroj |
|---|---|
| Multi-provider: jeden mechanismus pro Calendar, později Drive/Gmail/jiné kalendáře; `meetings` zůstane bez Google sloupců | `contract.ts:4-6` (jeden tvar zdrojů), DESIGN.md:38-39 |
| Soukromí: sdílený řádek linku je viditelný členům (RLS `is_project_member`, M1200:396-399); event id, calendar id a Google `sub` jen v soukromé `calendar_link_sources` (DESIGN.md:105). Event id v `meetings` by je zveřejnil všem členům (M0500:184-185) | |
| Konzistence projektu: `meetings.project_id` je neměnné (M0900:38) a má `UNIQUE(id, project_id)` (M0500:155) → kompozitní FK jako u přepisů (M0500:10-11, 219) | |
| Smazání linku smaže jen vazbu, nikdy poradu (CASCADE jen na vazební řádek); smazání porady smaže jen vazbu, link zůstává | |
| Pozor: `external_resource_links` nemá `UNIQUE(id, project_id)` (M1200:369-388) a u úkolových linků trigger přepisuje `project_id` podle karty (M1200:404-419). Doporučení: vázat jen projektové linky (`card_id IS NULL`), nebo kontrolu triggerem. Chování linků při přesunu karty – **NEOVĚŘENO** | |

**RUN 04 musí zachovat:** stabilní `external_resource_links.id` (refresh = UPDATE, ne delete+insert); `event_start`/`event_end`/`event_all_day` ve **sdíleném** řádku
(DESIGN.md:101-102); žádné změny `meetings` ani Google sloupce v ní; žádný provider-specifický klíč mimo `calendar_link_sources`; `provider_state='deleted'` místo mazání řádku při zrušení události (DESIGN.md:103).

## 4. Privacy pravidla pro budoucnost

| Pravidlo | Zdroj |
|---|---|
| Jména účastníků/členů/mluvčích, název porady ani projektu se **neposílají do Soniox**; context je jen `{general:[{key:'domain',value:'Project meeting'}]}` | HARD:47 (P1-10), `lib/stt/pipeline.ts:238-242` |
| Prefill `speaker_names` z účastníků události **nedělat automaticky**: `speaker_names` jdou do Gemini (`lib/ai/meetingAnalyze.ts:50-53`) a jména zadává člověk (M0500:151) | |
| Meet URL, popis, místo, e-maily účastníků: RUN 04 neukládá; později jen po schváleném privacy modelu | DESIGN.md:40 |
| Souhlas zůstává ruční zaškrtnutí člena (událost ho nikdy nenahradí); právní základ je BLOCKED | `NewMeetingForm.tsx:16, 147`, M0700:316-317, HARD:81 |
| Obsah linků do AI jen s výslovným per-use souhlasem; dnes `aiUse: 'not_consented'` a `assertAiUseAllowed` vždy vyhodí | `contract.ts:12-14, 32, 60-63` |
| Skutečný text porad do Gemini jen s placeným tierem klíče (release gate) | ARCH:240, 670; HARD:85 |
| Soniox: region US default, DPA/subprocesoři BLOCKED, data u Soniox 30 dní | HARD:80; `docs/intelligence/SONIOX_API_VERIFICATION.md:37, 40-41` |

## 5. Mimo RUN 04

- tabulka `meeting_resource_links`, tlačítko „Vytvořit poradu z události“, jakákoli změna `meetings`/`meeting_transcripts`/`stt_jobs`;
- nahrávání, přepis (Soniox), připojování k Meet, vytváření porad/událostí v Google Kalendáři, zápis do Googlu;
- AI zpracování událostí (Gemini, Project Intelligence kontext z událostí), změna `aiUse`;
- ukládání Meet URL, popisu, místa, e-mailů účastníků; prefill `speaker_names`;
- Meet API nahrávky/přepisy; webhooky / push notifikace kalendáře;
- změna firewallu, owner allowlistu, rozpočtů nebo `server_trust`.
