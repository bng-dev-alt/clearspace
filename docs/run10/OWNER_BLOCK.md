# RUN 10 – jediný blok vlastníka (schválení + jedna akceptační relace)

Vše ostatní je hotové a v produkci vypnuté. Tento blok spojuje všechna rozhodnutí a interakce, které vyžadují vlastníka.

## A. Rozhodnutí (stačí odpovědět ano/ne u každého bodu)
1. **Placená akceptace Soniox** – model `stt-rt-v6` (real-time, 0,12 USD/h = 2 USD / 1M audio tokenů; účtuje se délka streamu),
   max **6 relací**, max **30 minut** celkem, odhad max **0,06 USD** (+ zanedbatelný kontext). Technický strop: `AI_DEMO_STT_DAILY_AUDIO_MIN_PER_USER=30`
   i `_GLOBAL=30`, `MEETING_LIVE_SEGMENT_MIN=10` (strop relace u Soniox = rezervace), pilot jen prezentační účet, doporučení: měsíční limit
   projektu v Soniox Console 5 USD. Syntetický obsah (scénář níže). Po testu limity zpět na 0, nebo trvalý pilot podle bodu 4.
2. **Placená akceptace Gemini** – max **8 požadavků**, max **0,30 USD**, v rámci existujícího demo rozpočtu (40k tokenů/den, 2/min): 2× analýza
   porady (CZ, EN/mix), 4× dotaz PI nad poradou, 1× injekční sonda, 1× rezerva. `MEETING_PI_ENABLED=1`.
3. **Rozšíření Google OAuth** – do produkčního klienta `clearspace-prod` (Testing) přidat scope `https://www.googleapis.com/auth/calendar.events.owned`
   (sensitive; v Testing bez ověření aplikace) a `CALENDAR_WRITE_ENABLED=pilot`. Prezentační účet pak v Propojených účtech klikne
   „Povolit plánování porad“. Gmail/Disk/Kalendář-čtení zůstávají beze změny.
4. **Po akceptaci**: nechat Meeting Intelligence trvale aktivní pro prezentační účet (doporučeno: 30 min přepisu/den), nebo vypnout.
5. **Řízené pozvánky**: povolit `sendUpdates=all` jen na adresy aliasů `@luffast.com`, které se doručují do demo Gmailu (žádní cizí příjemci).

## B. Co udělá vlastník (cca 5 min)
* Soniox Console: ověřit, že produkční klíč (už ve Vercelu jako `SONIOX_API_KEY`) má oprávnění **„Temporary API keys“** a STT
  (jinak vytvořit nový klíč s těmito oprávněními a vložit ho skrytě – Claude připraví příkaz se skrytým vstupem do Keychainu
  `ClearSpace V1 - Meetings (production)` a do Vercelu; hodnotu nikdy neuvidí chat).
* Google Cloud Console `clearspace-prod` → Data Access → přidat scope z bodu A3 (Claude připraví přesný odkaz a kontrolu).

## C. Jedna živá akceptační relace (cca 25 min, Mac + iPad)
1. Mac, Chrome, prezentační účet: testovací projekt „RUN10 Pilot“ → Nová porada → Naplánovat → hosté: 1 alias `@luffast.com`.
2. Vytvořit událost s Google Meet (s pozvánkou dle A5) → ověřit odkaz meet.google.com a doručení pozvánky do demo Gmailu.
3. Mac: připojit se do Meet (karta), **sluchátka**. iPad: připojit se jako host (odkaz z pozvánky).
4. ClearSpace: Mikrofon + zvuk karty → potvrdit prohlášení → Spustit. Mac čte český skript, iPad odpovídá (anglická věta + smíšená).
5. Pozastavit 30 s → Pokračovat → Ukončit a uložit. Ověřit: oba hlasy v přepisu, mluvčí, délka, ledger.
6. Analyzovat → schválit 1 úkol (řešitel, termín) → PI: „Co jsme rozhodli o termínu dodávky?“ (citace `meeting:`/`item:`).
7. Izolace (druhý projekt bez porady) + smazání porady → PI už nic necituje.
8. Kontrola nákladů: Soniox Console usage vs. ledger.

Skript (syntetický): *„Dobrý den, začínáme kickoff projektu Corvane. Rozhodli jsme, že první dodávka bude dvanáctého prosince. Jana připraví
plán testů do pátku. Riziko: dodavatel certifikátu může mít zpoždění.“* / iPad: *„Thanks, I agree with the December twelfth delivery. Can we
move the review to Monday? Ještě dodám, že klient chce report v angličtině.“*
