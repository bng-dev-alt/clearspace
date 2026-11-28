# RUN 10 – zachycení zvuku: kompatibilita a omezení

Legenda: **MOCK** = ověřeno automatem / Chromium s falešným zařízením; **DOC** = podle dokumentace prohlížeče, neověřeno na skutečném
zařízení v tomto runu; **LIVE** = ověřeno skutečným hovorem (zatím nic – viz OWNER_BLOCK).

| Scénář | Chrome / Edge (macOS, Windows) | Firefox (desktop) | Safari (macOS) | iPad / iPhone (Safari) | Android Chrome |
|---|---|---|---|---|---|
| Místní mikrofon (osobní porada) | MOCK PASS (fake device, E2E) | DOC ano | DOC ano, pokud MediaRecorder umí WebM/Opus (novější Safari); jinak panel hlásí „neumí kódovat“ | DOC: stejně jako Safari | DOC ano |
| Zvuk jiné karty (Meet/Zoom/Teams **v prohlížeči**) | DOC ano – `getDisplayMedia` + „Sdílet i zvuk karty“; logika ověřena MOCK | DOC ne (Firefox zvuk karty nesdílí) | DOC ne | ne | ne |
| Mikrofon + zvuk karty současně (oba směry hovoru) | DOC ano (mix v AudioContext) | ne – jen mikrofon | ne – jen mikrofon | ne | ne |
| Systémový zvuk / desktopová aplikace Zoom/Teams | Windows: DOC „sdílet systémový zvuk“ u celé obrazovky; **macOS: ne** (Chrome na macOS sdílí zvuk jen karty) | ne | ne | ne | ne |
| Hovor přes reproduktor, nahrává jen mikrofon | funguje (ostatní slyší mikrofon z reproduktoru) – horší kvalita, ozvěna | stejně | stejně | stejně | stejně |
| Sluchátka + jen mikrofon | **ostatní účastníci se NENAHRAJÍ** (UI to výslovně říká) | | | | |

Zásady v UI: „jen mikrofon“ se nikdy nevydává za záznam celé porady; volba zvuku karty je dostupná jen kde ji prohlížeč umí; po skončení
sdílení karty se zobrazí varování „zachycuje se jen váš mikrofon“; doporučení sluchátek proti zdvojení (hlas ostatních z reproduktoru
do mikrofonu + z karty).

## Ošetřené chybové stavy (MOCK PASS – `src/__tests__/meetings/liveCapture.test.ts`, E2E)
Odmítnutý mikrofon · žádný mikrofon · zrušené sdílení karty · karta bez zvuku · prohlížeč bez getDisplayMedia · odpojený mikrofon
(stream se ukončí, text zůstává) · ticho > 12 s (upozornění) · konec sdílení karty (varování) · pád spojení (nový segment, max 3×) ·
odmítnutý start (rozpočet/pilot/organizátor) · dvojí start (automat + DB 409) · zavřená karta (obnova z uložených částí) ·
uvolnění mikrofonu, sdílení, AudioContext a časovačů při ukončení i opuštění stránky.

## Limity
Max. 300 minut přepisu na poradu (pevný limit streamu Soniox i `max_audio_ms`), segment = rezervace (výchozí 30 min, pak plynulé
navázání dalšího), max 40 segmentů, max 20 000 uložených částí. Paměť prohlížeče: drží se jen text (posledních 4 000 finálních tokenů
na obrazovce), zvuk se nebuferuje. Neověřeno: hodinová porada na skutečném zařízení (spotřeba paměti/CPU) – součást živé akceptace.
