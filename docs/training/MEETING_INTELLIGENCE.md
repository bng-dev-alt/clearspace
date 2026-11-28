# Modul 5 – Meeting Intelligence (RUN 10)

Podklad k prezentaci pro HR, vedoucí, byznys i techniky. Vychází jen z ověřené implementace (`docs/run10/ACCEPTANCE.md`). Co je zatím
ověřeno jen v simulaci, je tak výslovně označeno – **nikdy neprezentujte mock jako živý přepis.**

## 1. Proč to existuje
Porady jsou místo, kde vznikají rozhodnutí a úkoly – a kde se nejčastěji ztrácejí. Meeting Intelligence propojuje poradu s projektem:
naplánujete ji z projektu, přepíše se, AI navrhne rozhodnutí a úkoly **s citací přepisu**, člověk je schválí a z porady se stane
dohledatelný zdroj znalostí pro celý tým (Project Intelligence).

Řeší: zapomenuté úkoly z porad · „co jsme vlastně domluvili?“ · ruční zápisy · rozptýlené odkazy na hovory · nejasnou odpovědnost.

## 2. Jak to funguje (demo cesta, 7 kroků)
1. **Projekt → Porady → Nová porada → Naplánovat / živě**: název, začátek, délka, odkaz (Zoom/Teams/jiný) a pozvaní (e-maily; hosté
   nepotřebují účet v ClearSpace).
2. **Termín a připojení**: „Vytvořit událost s Google Meet“ – událost vznikne ve vašem Google Kalendáři, odkaz Meet dodá Google.
   Pozvánky e-mailem pošle Google jen když je výslovně zaškrtnete. „Kopírovat pozvánku“ = text pro Slack/Telegram/e-mail i s upozorněním
   na přepis.
3. **Živý přepis**: vyberete mikrofon (interní, Bluetooth, USB…) a ověříte ho tlačítkem **„Otestovat mikrofon“** (zdarma, nic se
   neodesílá), zvolíte zdroj zvuku, potvrdíte, že jste účastníky informovali, a kliknete „Spustit přepis“. Vidíte dva stavy –
   **nahrávání** (● Nahrává se) a **přepis** (Přepis běží), ukazatel úrovně mikrofonu (a zvlášť zvuku karty), délku a průběžný text.
4. **Pauza / pokračování / ukončit / zrušit** – pauza opravdu zastaví posílání zvuku i placení; „Ukončit a uložit“ uloží jednu verzi
   přepisu; **„Zrušit přepis“** (s potvrzením) stream hned ukončí a text zahodí – porada, pozvaní i událost zůstanou, spotřebovaný čas
   se započítá. Termín porady je jen informace: i po jeho uplynutí se lze připojit a přepis spustit.
5. **Analyzovat** – AI navrhne shrnutí, rozhodnutí, úkoly, otázky a rizika; každý návrh má citaci (klik = zvýraznění v přepisu).
6. **Schválit** – upravíte název, řešitele (jen člen projektu), termín a vytvoříte úkol. Bez schválení se v projektu nic nezmění.
7. **Project Intelligence** – „Co jsme rozhodli o termínu dodávky?“ – odpověď cituje poradu (`meeting:`) nebo schválený závěr (`item:`).

## 3. Zvuk – co prohlížeč umí (říkejte přesně)
Tři různé věci: **mikrofon** (co slyší vaše zařízení v místnosti), **zvuk karty** (hovor ve webovém Meet/Zoom/Teams v Chrome/Edge)
a **systémový zvuk** (desktopové aplikace – ClearSpace ho nezachytává). Podrobně `docs/run10/AUDIO_CAPTURE.md`.

| Situace | Doporučení |
|---|---|
| Porada v místnosti | „Jen mikrofon“ |
| Meet / Zoom / Teams **v prohlížeči** (Chrome/Edge na počítači) | „Mikrofon + zvuk karty“, vybrat kartu s hovorem, zapnout „Sdílet i zvuk karty“, **sluchátka** |
| Desktopová aplikace Zoom/Teams na Macu, Safari, iPad | zachytí se jen váš mikrofon; ostatní jen pokud je mikrofon slyší z reproduktoru |
ClearSpace se do hovoru nepřipojuje (žádný bot) a nikdy nenahrává skrytě.

## 4. Technika (pro technické publikum)
* Prohlížeč streamuje WebM/Opus **přímo do Soniox real-time** (`stt-rt-v6`, čeština + angličtina, identifikace jazyka, diarizace).
* Server nejdřív v databázi **zarezervuje rozpočet** a teprve pak vydá **jednorázový dočasný klíč** s maximální délkou relace = rezervace;
  dlouhodobý klíč nikdy neopustí server. Účtuje se jen skutečný čas (pauza ukončí stream).
* Finální text se ukládá každé ~3 s; zavřená karta nic neztratí (obnova: dokončit / pokračovat / zahodit). Výpadek sítě = nový segment.
* Analýza: existující Gemini pipeline s validací citací; přepis je **nedůvěryhodná data** (ochrana proti „prompt injection“ vyslovené v poradě).
* Kalendář: nejužší zápisový scope `calendar.events.owned`, žádaný až na pokyn; id události = id porady (žádné duplikáty).
* Bezpečnost: RLS na všech tabulkách, spuštění jen organizátor, pilotní allowlist, vypínače pro každou schopnost, ledger nákladů.

## 5. Soukromí a odpovědnost
Zvuk se v ClearSpace neukládá. Přepis a AI výstupy vidí jen členové projektu a zmizí se smazáním porady. Organizátor odpovídá za
informování účastníků a právní základ – ClearSpace **netvrdí automatický soulad s GDPR**. Podrobně `docs/run10/PRIVACY.md`.

## 6. Náklady (ceník Soniox k 28. 11. 2026)
Přepis real-time 0,12 USD/h (hodinová porada ≈ 0,12 USD); async 0,10 USD/h. Gemini analýza porady ≈ jednotky tisíc tokenů (zlomky centu).
Demo účet má denní limity (AI 40k tokenů/den, přepis dle schválení).

## 7. Skutečně funkční vs. simulace (stav po živé akceptaci 28. 11. 2026)
| Ověřeno naživo (produkce, prezentační účet) | Částečně / jen v simulaci | Neexistuje (LATER) |
|---|---|---|
| Google událost se skutečným Meet, pozvánky e-mailem, Mac + iPad v hovoru, živý přepis CZ/EN/mix (Soniox), pauza/pokračování/stop, mluvčí (funkční, ne vždy přesní), izolace dat, smazání porady, náklady v limitu | vzdálený účastník čistě ze zvuku karty (PARTIAL), Gemini analýza + schválení úkolu + PI citace nad živou poradou (čeká na denní limit AI), obnova po výpadku sítě, zrušení přepisu a test mikrofonu (MOCK) | boti v hovorech, nativní Zoom/Teams, systémový zvuk, automatické nahrávání, video, hlasová identifikace, přímé odeslání pozvánky do hubu |

Omezení, která říkat nahlas: rozlišení mluvčích občas zamění osoby (doplňte jména ručně); Safari/iPad jen mikrofon; živý přepis
v prezentačním účtu je po akceptaci vypnutý limitem minut (0), dokud vlastník neschválí trvalý rozpočet.

## 8. Demo scénáře
* **2 min (HR)**: seznam porad → hotová porada → shrnutí s citací → schválený úkol na boardu.
* **5 min (vedoucí)**: naplánovat → Meet → živý přepis 1 min → stop → analýza → schválení → PI dotaz.
* **10 min (technik)**: totéž + ukázat stavy, pauzu (konec streamu), obnovu po zavření karty, ledger, vypínače, RLS.

## 9. Časté otázky
* *Nahrává to i ostatní v hovoru?* Jen pokud zvolíte zvuk karty v Chrome/Edge (nebo vás slyší z reproduktoru). UI to vždy říká.
* *Kde je zvuk uložený?* Nikde v ClearSpace; jde rovnou k Soniox, ukládá se jen text.
* *Může AI sama vytvořit úkol?* Ne. Každý úkol potvrzuje člověk; opakované potvrzení nevytvoří duplikát.
* *Musí se hosté registrovat?* Ne. Úkol ale lze přiřadit jen členovi projektu.
* *Co když někdo nesouhlasí?* Organizátor přepis pozastaví/ukončí a nedokončené části může zahodit.
* *Proč Soniox?* Ověřená kvalita češtiny a angličtiny (měřeno v aplikaci scribe_), nízká cena, dočasné klíče pro prohlížeč.
* *Funguje to v Safari / na iPadu?* Jen mikrofon; zvuk jiné karty Safari neumí.
* *Jak poznám, že nahrávám správný mikrofon?* Před startem „Otestovat mikrofon“ (zdarma); během přepisu se hýbe ukazatel úrovně, po 12 s
  ticha se objeví upozornění.
* *Rozpozná to, kdo mluví?* Rozliší hlasy jako „Mluvčí 1, 2…“, občas je zamění; jména doplní člověk. Identitu AI nehádá.
* *Kolik to stojí?* ~0,12 USD za hodinu přepisu + zlomky centu za analýzu; limity hlídá server před voláním poskytovatele.
