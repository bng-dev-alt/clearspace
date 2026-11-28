# RUN 10 – rozsah (SCOPE MODE)

## MUST-HAVE – stav implementace

| Schopnost | Stav | Kde |
|---|---|---|
| Porady navázané na projekt; plánované i ad-hoc | hotovo | `NewMeetingForm` (Naplánovat / živě), migrace 1800 |
| Google Calendar: vytvoření události z projektu, název, čas, pásmo, hosté, Meet, pozvánky, úprava, zrušení | hotovo (mock); živě BLOCKED (scope) | `/api/meetings/calendar`, `calendarWrite.ts` |
| Výběr existující události | hotovo už v RUN 04 (připojení k projektu) – porada z ní se vytváří ručně | RUN 04 |
| Pozvaní interní i externí (bez účtu) | hotovo | `meeting_attendees`, `ScheduleCard` |
| Otevření odkazu z ClearSpace, one-click kopie odkazu a pozvánky | hotovo | `ScheduleCard` |
| Provider-neutrální architektura (Meet/Zoom/Teams/osobní) | hotovo | obecný odkaz + zvuk karty/mikrofon |
| Transparentní ovládání start / pauza / pokračovat / stop, stavové indikátory (nahrávání ≠ přepis) | hotovo | `LivePanel`, `liveCapture.ts` |
| Zachycení v prohlížeči (mikrofon, zvuk karty) | hotovo (mock + automat); živě viz AUDIO_CAPTURE | |
| Soniox, čeština/angličtina, průběžný přepis, mluvčí | hotovo (fake); živě BLOCKED (placený test) | `live.ts` |
| Shrnutí, rozhodnutí, úkoly, otázky, rizika (s citací) | existující (RC5) – funguje i nad živým přepisem | `meetingAnalyze` |
| Lidské schválení před vytvořením úkolu, editace, řešitel, termín, idempotence | existující (RC5) | `ItemCard`, `apply_intelligence_item` |
| Project Intelligence se zdrojem porad a atribucí | hotovo | `context.ts` |
| Historie porad (nadcházející / proběhlé) | hotovo | `MeetingList` |
| Přístupy, mazání, retence | hotovo | migrace 1800, DB testy |
| Náklady: rezervace, strop u poskytovatele, ledger | hotovo | `stt_live_reserve`, dočasný klíč |
| Pilot v produkci | připraveno; aktivace = owner block | OPERATIONS.md |
| Testy a dokumentace | hotovo | viz ACCEPTANCE.md |

## LATER (vědomě neimplementováno)
Boti, kteří se sami připojují do hovorů; nativní Zoom/Teams; automatické nahrávání všech událostí; organizační politiky nahrávání;
hlasová identifikace mluvčích; video; automatické follow-up e-maily; nativní aplikace; koučink/sentiment; multimediální archiv;
analytika napříč organizací; protokol Soniox `reconnect` s bufferem; volitelné uložení zvuku k async přepřepisu; přímé odeslání pozvánky
do Slack/Telegram cíle hubu (dnes kopírování); vlastní model pro mluvčí napříč segmenty; výběr jiného než hlavního kalendáře.
