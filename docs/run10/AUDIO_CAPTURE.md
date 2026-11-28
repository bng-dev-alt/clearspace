# RUN 10 – zachycení zvuku: kompatibilita a omezení

Legenda: **MOCK** = ověřeno automatem / Chromium s falešným zařízením; **DOC** = podle dokumentace prohlížeče, neověřeno na skutečném
zařízení v tomto runu; **LIVE** = ověřeno skutečným hovorem 2026-11-28 (Mac Chrome + iPad v Google Meet, viz ACCEPTANCE.md).

## Tři různé zdroje zvuku (co se opravdu nahrává)
| Zdroj | Co to je | Jak ho ClearSpace získá | Kdo je slyšet |
|---|---|---|---|
| **Mikrofon** | vstupní zařízení počítače (interní, Bluetooth sluchátka, USB, webkamera) | `getUserMedia`, konkrétní zařízení z výběru „Mikrofon“ | vy + vše, co mikrofon slyší v místnosti (i reproduktor) |
| **Zvuk karty** | zvuk, který přehrává jedna karta prohlížeče (Meet/Zoom/Teams **ve webu**, video) | `getDisplayMedia` + „Sdílet i zvuk karty“ (jen Chrome/Edge na počítači) | ostatní účastníci hovoru, bez ozvěny místnosti |
| **Systémový zvuk** | vše, co přehrává počítač (i desktopové aplikace Zoom/Teams) | ClearSpace ho **nezachytává**; Chrome ho umí sdílet jen na Windows u celé obrazovky, na macOS vůbec | – |

Režim „Mikrofon + zvuk karty“ oba zdroje smíchá do jedné stopy pro přepis a od RUN 10 hardening ukazuje **dvě samostatné úrovně**
(Mikrofon / Zvuk karty). Ze záznamu se zpětně nedá určit, ze kterého zdroje věta přišla – proto LIVE akceptace vzdáleného účastníka
přes kartu je jen PARTIAL (iPad byl ve stejné místnosti). Se sluchátky a vzdáleným účastníkem mimo místnost je důkaz jednoznačný.

## Výběr mikrofonu a bezplatný test (RUN 10 hardening)
* Seznam = zařízení, která prohlížeč zpřístupní (`enumerateDevices`); názvy až po povolení mikrofonu. Volba se pamatuje v prohlížeči.
* „Otestovat mikrofon“: 5 s, jen v prohlížeči (getUserMedia + analyzátor), **žádné volání serveru ani Soniox**, výsledek „funguje“ / „ticho“.
* Vybrané zařízení odpojené: upozornění + použije se výchozí; odpojení během nahrávání: stream se ukončí, text lze uložit nebo spustit znovu.
* Ticho > 12 s během nahrávání: výrazné upozornění s odkazem na ukazatel úrovně.

## Diarizace (rozlišení mluvčích) – omezení
Soniox čísluje mluvčí podle hlasu v rámci **jednoho streamu**; po pauze/rollover je číslování nové (`2.1`, `2.2`). Živě: krátká výměna
Mac (CZ) / iPad (EN) rozlišena správně, ale přiřazení občas kolísá (podobné hlasy, přesahy, hlas z reproduktoru, video). Jména mluvčích
doplní člověk („Jména mluvčích“) před analýzou; AI z čísla mluvčího nikdy neodvozuje identitu.

## Podporovaná zařízení (stav RUN 10)
Doporučeno: **Chrome nebo Edge na počítači + sluchátka**. Safari / iPad / iPhone / Firefox: jen mikrofon (zvuk karty neumí). iPad byl
v živém testu jen účastníkem Meet, ne snímacím zařízením (NOT VERIFIED). Desktopové aplikace Zoom/Teams: jen přes reproduktor do
mikrofonu (horší kvalita).

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
