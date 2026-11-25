# Handoff RUN 04 → další běhy

Stav 2026-11-26: `main` = merge `19a0c6b` (+ dokumentace), tag **`run04-complete`**; produkce `dpl_FeGsSgZx…`, DB do 1400, **Gmail i Kalendář vypnuté**.
Start: `CALENDAR.md`, `ARCHITECTURE_DECISION.md`, `PRIVACY_AND_SECURITY.md`, `LIVE_ACCEPTANCE.md`, `PRODUCTION_ACCEPTANCE.md`, `DECISIONS.md`,
`MEETING_INTELLIGENCE_COMPAT.md`. Pracovní strom `V1-calendar` (větev `feature/run04-google-calendar`), stack `cs-calendar-sb`.

## Rozhoduje vlastník
1. **Produkční Kalendář** (A vypnuto / B pilot Testing / C interní / D veřejné ověření – sensitive, bez CASA): `PRODUCTION_ROLLOUT.md` §0–1.
2. Úklid dev OAuth klienta (2 client secrets z RUN 02B) – beze změny, `TECH_DEBT.md`.

## Co je hotové a znovupoužitelné
| Potřeba | Kde |
|---|---|
| Další Google služba | `config.ts` (`SERVICE_SCOPE(S)`, `GoogleService`), `server.ts` `withServiceToken` + `requireX`, `oauth/start` validace, `oauth/complete` (`service !== 'drive'` větve), `google_service_remove/_audit` whitelist v migraci |
| Soukromý zdroj + sdílená metadata | `calendar_link_sources` / `gmail_link_sources` vzor, `external_resource_links` CHECKy per provider |
| Živá brána pro nový scope | `calendar_live_gate.mjs` (zúžený token v paměti, tokeninfo, porovnání s produktovou trasou), `google-live.sh node <script>` |
| Nácvik + apply migrace | `rehearse-calendar-prod.sh`, `apply-calendar-hosted.sh` (vzor pro 1500) |

## Meeting Intelligence / Project Intelligence (LATER, neimplementováno)
* „Porada z události“: spojovací tabulka `meeting_resource_links(meeting_id, link_id → external_resource_links)`; jen projektové odkazy nebo trigger
  na shodu projektu; řešit chybějící stav „plánovaná porada“ (dnes vzniká s přepisem nebo audiem); název události se dostane do promptu analýzy
  (`meetingBrief.ts`), jména účastníků do `speaker_names` NIKDY automaticky. Detail: `MEETING_INTELLIGENCE_COMPAT.md`.
* Project Intelligence: `fromCalendarEvent()` dává jen sdílená metadata, `aiUse: 'not_consented'`; AI zpracování až po rozhodnutí o souhlasu.
* Meet URL, popis, místo – jen se schváleným privacy modelem.

## LATER (beze změny z návrhu)
Zápis do kalendáře (`calendar.app.created`), další kalendáře, free/busy, push/sync, celá série, workspace „Můj kalendář“, dedup přes iCalUID,
rozbalení „+N další“, veřejná syntetická ukázka.

## Poučení z RUN 04
* Postgres regex: opakování `{m,n}` max. 255 → délky přes `char_length`.
* Google granulární souhlas: víc scopes = políčka **nezaškrtnutá**; jeden nový scope = žádné políčko.
* Automatizace Google Kalendáře v UI: klik na ikonu koše funguje spolehlivě přes `button[aria-label="Smazat událost"]` až po otevření popupu.
* `next start` s mock Googlem v produkčním režimu odmítne mock → pro kontroly přepínače dát formátově platnou fiktivní konfiguraci.
* Dva pracovní stromy na stejné větvi nepoužívat pro commity (staged deploy z dočasného čistého stromu, pak ho odstranit).

## Omezení, která platí dál
Žádný push/merge/deploy bez schválení; V2/Artform/RUN 01–03 stacky beze změny; žádná placená AI volání; tajemství jen Keychain/Vercel;
DEV login jen lokálně; produkční zapnutí Gmailu/Kalendáře = samostatné rozhodnutí vlastníka.
