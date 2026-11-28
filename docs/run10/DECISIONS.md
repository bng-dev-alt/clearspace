# RUN 10 – architektonická rozhodnutí

| # | Rozhodnutí | Důvod | Zamítnuté alternativy |
|---|---|---|---|
| D-01 | Rozšířit existující jádro porad (RC1–RC5), ne psát nové | ověřené RLS, souhlas, revize, evidence, review/apply, mazání; nižší riziko | samostatná MI služba (UMC) – zdvojení logiky |
| D-02 | Prohlížeč streamuje **přímo** do Soniox real-time s **jednorázovým dočasným klíčem** | dokumentovaná bezpečná cesta pro nedůvěryhodné klienty; server neproxuje zvuk (Vercel funkce nedrží WebSocket) | proxy přes server (nemožné na Vercelu); permanentní klíč v klientu (zakázáno) |
| D-03 | Rezervace rozpočtu v DB **před** vydáním klíče; `max_session_duration_seconds` = rezervace | strop nákladů vynucuje i poskytovatel; rozpočet sdílen s async přepisem | účtovat až po streamu (nekontrolovatelné) |
| D-04 | Pauza = ukončení streamu, pokračování = nový segment | Soniox účtuje délku streamu; keepalive by účtoval ticho | držet stream s keepalive |
| D-05 | Výpadek = nový segment (max 3×), ne protokol `reconnect` | jednorázový klíč + jednodušší, ověřitelné chování; mezera se poctivě vyznačí | stream reconnect s bufferem (LATER) |
| D-06 | Kodek: MediaRecorder WebM/Opus, `audio_format:auto` | jeden kodér, žádný AudioWorklet; formát podporuje RT API | PCM16 přes AudioWorklet (scribe_ vzor) – víc kódu, stejné výsledky neověřeny |
| D-07 | Zvuk se **neukládá**; ukládá se jen text (průběžně, po dokončení jedna revize) | minimalizace dat; zvuk je nejcitlivější | povinná záloha zvuku (LATER: volitelná, existující upload cesta) |
| D-08 | Zvuk karty jen přes `getDisplayMedia` s výslovnou volbou uživatele | jediná legitimní cesta k hlasu ostatních v prohlížeči; žádné skryté nahrávání | nativní companion app (zbytečná pro MUST-HAVE), boti v hovoru (LATER) |
| D-09 | Spustit / ukončit smí jen **organizátor** (autor porady nebo vlastník projektu) | odpovědnost za informování účastníků je na organizátorovi | kdokoli z členů |
| D-10 | Prohlášení organizátora (záznam `consent_at`) místo souhlasů hostů | hosté nemají účet; nevyžadujeme registraci; text netvrdí právní soulad | elektronický souhlas každého hosta |
| D-11 | Zápis do Kalendáře jako **samostatná Google služba** `calendar.events.owned`, inkrementálně | nejužší scope s vytvořením události a Meet; čtení zůstává oddělené | `calendar.events` (širší), `calendar` (mnohem širší) |
| D-12 | id události = id porady | idempotence bez další tabulky | uložit requestId zvlášť |
| D-13 | Odkaz Meet jen z odpovědi Googlu | zákaz falešné integrace | generovat odkaz |
| D-14 | `meeting_resource_links` místo Google sloupců v `meetings` | provider-neutralita (RUN 04 návrh), soukromí event id | sloupec `google_event_id` |
| D-15 | PI: shrnutí porad jen pro odpovídající účely, s příznakem AI-derived, za vypínačem | ochrana před injekcí a nechtěnými změnami; náklady | celé přepisy do PI (drahé, riziko) |
| D-16 | Vlastní pilot `MEETING_PILOT_USER_IDS` (ADR RUN 09-01) | owner tier (osobní účet) by jinak měl neomezený STT | jen AI tiery |
| D-17 | Sdílení do Slacku/Telegramu = **jednoklikové kopírování pozvánky** (s upozorněním na přepis), ne nový typ zprávy hubu | žádný nový bot, žádná změna dispatcheru; MUST „kde to dovolí existující schopnosti“ | nový `hub_outbox.kind` (LATER) |
