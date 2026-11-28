# RUN 10 – matice znovupoužití (read-only audit 2026-11-28)

Zdrojové aplikace nebyly měněny. Licence: v žádné z nich není soubor LICENSE (vše vlastní kód vlastníka); převzaty jsou jen poznatky
a vzory, žádný cizí kód s licenční povinností.

| Komponenta | Zdroj | Skutečný stav | Znovupoužitelnost | Omezení platformy | Bezpečnost | Závislosti | Doporučení / rozhodnutí | Cena integrace |
|---|---|---|---|---|---|---|---|---|
| Porady, revize přepisu, souhlas, evidence, review/apply úkolů, kvóty, mazání | ClearSpace V1 (RC1–RC5, migrace 0500–0900) | v produkci, testováno | **plná** | – | RLS, server_trust, machine provenance | Supabase | **převzato beze změny** | nízká |
| Soniox async adaptér, normalizér tokenů, ledger STT | ClearSpace `src/lib/stt` | implementováno, živě ověřeno v RC5 | plná | async nepomůže živému přepisu | klíč jen server | – | převzato; normalizér použit i pro živé části; adaptér rozšířen o dočasné klíče | nízká |
| Gemini analýza porady + validátor citací + ochrana proti injekci | ClearSpace `meetingAnalyze` / `evidence` | v produkci | plná | – | přepis = nedůvěryhodná data | Gemini | převzato beze změny (žádná druhá AI platforma) | nulová |
| Calendar čtení, sdílená metadata, soukromé event id | ClearSpace RUN 04 | v produkci (pilot) | plná | consumer účet = jen vlastní kalendáře | `calendar_link_sources` bez RLS politik | Google | převzato; vytvořená událost se připojuje stejnou RPC | nízká |
| Soniox RT konfigurace (`cs`+`en`, LID, diarizace, endpointing), parser (is_final, `<end>/<fin>`, `finished`), poznatky (finalize 1 s zhoršil WER, rychlost doběhu 1,1–1,2×) | scribe_ (Swift, iOS) | v produkci (osobní release) | **jako specifikace** (port do TS) | iOS nativní audio | BYOK klíč na zařízení – pro web nepoužitelné | – | převzaty poznatky; WebSocket + dočasný klíč napsány nově | střední |
| Měřená kvalita CZ/EN (WER 12,6 % CZ, 8,9 % mix) | scribe_ `docs/S1_TRANSCRIPTION_RESULTS.md` | měřeno vlastníkem | jako důkaz | jiný model (rt-v5) | – | – | důvod volby Soniox; v RUN 10 neověřeno znovu | – |
| Rekordér v prohlížeči (getUserMedia → AudioContext → MediaRecorder, IndexedDB) | MicroCRM | implementováno, jen mikrofon | vzor | nemá zvuk karty ani mix | – | – | vzor převzat (MIME, mono, AudioContext); IndexedDB nepoužito (zvuk se neukládá) | nízká |
| Near-live Whisper (Groq) | MicroCRM | implementováno | ne | jiný poskytovatel | – | Groq | nepoužito (Soniox je závazný) | – |
| MI Standalone (Tauri) | `Apps/Meeting Intelligence` | prototyp, klíče v localStorage, falešná data | **ne** | – | nevyhovuje | – | nepoužívat | – |
| Universal Meeting Core | `Dev/Universal_Meeting_Core` | jen dokumenty (fáze 2 pozastavena) | koncepčně | – | – | – | hranice „obecné MI vs. projektová integrace“ dodržena (lib/meetings + lib/stt vs. komponenty projektu) | – |
| AudioGrab_ | Swift | stahování zvuku z YouTube | ne | – | – | yt-dlp | nerelevantní | – |
| Transcripter_ | Python | whisper.cpp offline | ne | – | – | – | nerelevantní | – |
| **Nově vytvořeno** | RUN 10 | – | – | – | – | – | zvuk karty + mix, dočasné klíče Soniox, segmenty s rezervací, zápis do Kalendáře + Meet, PI shrnutí porad | – |

Shrnutí: ~70 % schopností (porady, analýza, schválení, úkoly, PI citace, kalendářové linky) bylo už hotových v ClearSpace; RUN 10 doplnil
živou vrstvu (prohlížeč ⇄ Soniox), plánování a navázání na PI.
