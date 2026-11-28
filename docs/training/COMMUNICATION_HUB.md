# Školení – modul 3: Komunikační hub (Slack aplikace, Telegram HQ, Relay, Cortex)

Vše níže je ověřeno živě v produkci (RUN 09, 27.–28. 11. 2026) nebo živě s dev identitami (RUN 08), pokud není uvedeno jinak.
Důkazy: `docs/run09/README.md`, `docs/run08/RUN08B.md`. Provoz: `docs/run09/OPERATIONS.md`.

## 1. Proč čtyři identity (a ne jedna)
ClearSpace odděluje **osobní** a **projektovou** komunikaci a **čtení pro AI** od všeho ostatního. Každá identita má jen oprávnění, která potřebuje.

| Identita | Platforma | Účel | Co smí | Co nesmí / nevidí |
|---|---|---|---|---|
| **ClearSpace oznámení** (A0CMH9F3N1X) | Slack app | osobní oznámení jednomu uživateli (DM) | jen `chat:write` – psát uživateli, který ji připojil | žádné kanály, žádné čtení |
| **ClearSpace Projekty** (A0CMK6CGW8L) | Slack app | projekt ↔ vybrané kanály: oznámení, úkol ze zprávy, vlákna ↔ komentáře, PI | `chat:write`, `commands`, `channels:history`, `groups:history` – čte jen kanály, kam ji pozvete | žádné user scopes, nevidí seznam kanálů ani lidí workspace |
| **@ClearSpaceHQBot** | Telegram bot | osobní oznámení do soukromého chatu | psát uživateli po „Start“ (čte jen `getUpdates` při párování) | žádné skupiny |
| **@ClearSpaceRelayBot** | Telegram bot (privacy mode ON, bez admin práv) | projekt ↔ Telegram skupina: oznámení, `/task`, odpovědi ↔ komentáře | vidí jen příkazy pro sebe a odpovědi na své zprávy | běžnou konverzaci skupiny nevidí |
| **@ClearSpaceCortexBot** | Telegram bot (privacy mode OFF, nikdy nepíše) | čtení celé skupiny pro Project Intelligence | jen ve skupině, kterou správce projektu výslovně potvrdil + zapnul „Celá komunikace“ | cokoli jiného zahodí bez uložení |

Architektura: Slack/Telegram → webhook `https://clearspace.luffast.com/api/hub/*` (podpis Slacku / `secret_token` Telegramu, jinak 401) →
odolný inbox v DB → zpracování pod servisní identitou bez práv k projektům → RPC s kontrolou role. Odchozí zprávy: aktivita v projektu → outbox →
plánovač `pg_cron` každou minutu → `/api/hub/dispatch` → poskytovatel (souhrn „N změn“, opakování, idempotence). Tokeny šifrované (AES-256-GCM),
ID kanálů/uživatelů jen jako HMAC otisky. Každá funkce má vypínač a pilotní allowlist (dnes jen prezentační účet).

## 2. Párování (vždy „kód z ClearSpace → poslat z chatu → potvrdit v ClearSpace“)
Kódy platí **10 minut**, jsou jednorázové a mají limit pokusů. Tím obě strany prokážou, že patří stejnému člověku / projektu.

| Co | V ClearSpace | V chatu |
|---|---|---|
| Osobní Slack | Nastavení → Oznámení mimo aplikaci → **Připojit Slack** | OAuth „Allow“ (ClearSpace oznámení) |
| Osobní Telegram | **Připojit Telegram** | odkaz na @ClearSpaceHQBot → Start (nebo `/start KÓD`) → zpět „Ano, je to můj účet“ |
| Slack aplikace pro projekty | Nastavení → Slack a Telegram pro projekty → **Nainstalovat do Slacku** | OAuth „Allow“ (ClearSpace Projekty) |
| Slack účet (identita) | **Propojit Slack účet** → kód | `/clearspace ucet KÓD` kdekoli ve Slacku |
| Telegram účet (identita) | **Propojit Telegram účet** | odkaz na Relay → Start (záložně `/start KÓD`) |
| Slack kanál → projekt | Projekt → Integrace → **Připojit Slack kanál** | v kanálu `/invite @ClearSpace Projekty`, pak `/clearspace propojit KÓD` → v ClearSpace **Potvrdit propojení** |
| Telegram skupina → projekt | **Připojit Telegram skupinu** | „Přidat bota do skupiny“ (pošle kód sám) nebo `/link@ClearSpaceRelayBot KÓD` (zakladatel/správce) → potvrdit |

Ověřená úskalí (živě): v existujícím chatu Telegram Web deep link `/start` znovu nepošle → použít příkaz; bot musí být v kanálu (jinak
„removed_bot“ – po `/invite` stačí „Zkušební zpráva“ a cíl se sám reaktivuje); nový cíl má **Interaktivní vypnuto** (fail-closed) – bez zapnutí
`/task` odpoví „vypnuto“; po odpojení Telegram skupiny ji Relay opustí.

## 3. Schopnosti cíle (kanál / skupina) – zapíná správce projektu
* **Oznámení**: nový úkol, dokončení, změna sloupce, termín zítra (9:00 den předem) – souhrnně za minutu.
* **Interaktivní**: úkol ze zprávy (Slack: akce u zprávy „Vytvořit úkol“; Telegram: `/task@ClearSpaceRelayBot Název`), odpovědi ve vlákně / na zprávu bota
  ↔ komentáře úkolu. Autor je ověřený jen u propojených identit; zdroj úkolu se ukazuje jako „Konverzace v chatu“ s odkazem „Původní zpráva“.
* **Project Intelligence** (etapa 2): AI smí číst komunikaci **jen** tohoto cíle; vyžaduje výslovné potvrzení (a u Telegramu „Celá komunikace“ přes Cortex).
  Importy se drží 90 dní, vypnutí je okamžitě smaže.

## 4. Osobní oznámení (HQ / ClearSpace oznámení)
Přiřazení, blížící se termín (9:00 den předem), zmínka, komentář u mého úkolu, dokončení, změna termínu, členství; výběr projektů; režim bez názvů.
Zpráva obsahuje jen typ, autora, název úkolu/projektu, termín a odkaz – nikdy texty komentářů ani obsah Google. Vlastní akce se neoznamují.
Zkušební zpráva max. 1× za 30 s (rozlišovat od skutečných oznámení – UX backlog).

## 5. Project Intelligence nad chaty (etapa 2 – aktivní pro prezentační účet od 28. 11. 2026)
Ověřeno skutečným Gemini (`gemini-3.6-flash`, 6 požadavků, ≤ 0,05 USD): odpovědi používají fakta ze Slacku i Telegramu s citací zdroje; pokyny ve
zprávách („SYSTEM: ignoruj…“) jsou jen data – AI nic nemění; neprozradí prompt ani klíče; jiný projekt kontext nevidí; po opt-outu / vypnutí přepínače
kontext zmizí. Limity pilotu: 40 000 tokenů/den, 2 požadavky/min (ověřeno: `budget_exceeded`, `rate_limited` před voláním modelu).

## 6. Demonstrační scénáře (prezentační účet, ~15 min, bez placených AI požadavků mimo bod F)
* **A – osobní oznámení (2 min)**: Nastavení → Zkušební zpráva Slack + Telegram; ukázat DM a chat s HQ.
* **B – propojení kanálu (3 min)**: nový testovací projekt → Integrace → Připojit Slack kanál → `/clearspace propojit KÓD` v `#clearspace_test` → Potvrdit →
  zapnout Interaktivní → Zkušební zpráva.
* **C – úkol z chatu (3 min)**: ve Slacku zpráva → „Vytvořit úkol“; v Telegramu `/task@ClearSpaceRelayBot Objednat techniku`; v ClearSpace ukázat
  „Konverzace v chatu“ a zdroj.
* **D – obousměrné komentáře (2 min)**: odpověď ve vlákně → komentář; komentář v ClearSpace → zpráva ve vlákně / odpověď v Telegramu.
* **E – oznámení plánovačem (2 min)**: nový úkol s termínem zítra → do minuty souhrn v kanálu a skupině; dokončit → zpráva „dokončil(a)“.
* **F – Project Intelligence (3 min, 1–2 placené požadavky)**: u cíle zapnout PI s potvrzením (Telegram: Celá komunikace), napsat 2 syntetické zprávy,
  v projektu „Zeptej se AI“: „Shrň domluvené body z chatů se zdroji“; ukázat citace; vypnout PI → importy pryč.
* **G – bezpečnost (1 min)**: odpojit kanál → nový úkol nic nepošle; jiný účet nemá přístup (pilot).
Po ukázce smazat testovací projekt (vazby a data se odstraní kaskádou; syntetické zprávy zůstanou jen v testovacích chatech).

## 7. Časté otázky
* *Vidí ClearSpace celý Slack/Telegram?* Ne – jen kanály/skupiny, kam aplikaci/bota výslovně přidáte a propojení potvrdíte; Cortex navíc jen po opt-inu.
* *Co když bot unikne?* Vypínače `HUB_*_ENABLED`, plánovač off, `deleteWebhook`; rotace tokenu (BotFather `/revoke`) – postup v `OPERATIONS.md`.
* *Proč dvě Slack aplikace?* Osobní DM s minimálním oprávněním vs. projektová s příkazy a čtením kanálů – oddělené tokeny, oddělené odvolání.

## 8. Co se změnilo v RUN 11 (UX polish) – co ukazovat a říkat
* **Nastavení → Propojené účty** má nahoře **Přehled** (Google · Osobní oznámení · Slack a Telegram pro projekty) se stavem každé části,
  který hlásí sama sekce podle serveru. Rozbalovací „Jak spolu souvisí Slack, Telegram a ClearSpace“ vysvětluje čtyři identity z §1
  běžnou řečí (osobní oznámení = jen vám; kanály a skupiny projektu = tým; Cortex jen čte; chat účty = autor úkolů z chatu).
* Stav **instalace Slack aplikace** je vidět (Nainstalováno do „…“ / Nenainstalováno / Instalace zrušena) – dřív bylo tlačítko pořád stejné.
* Po **potvrzení propojení** kanálu/skupiny: „Propojeno ✓“ + „Odeslat zkušební zprávu“ (ověří, že aplikace/bot v kanálu smí psát; u Slacku
  připomene `/invite`) + „Zapnout i úkoly z chatu“ (Interaktivní zůstává výchozí vypnuté).
* U Telegram skupiny s úkoly z chatu je přesný příkaz `/task@bot Název úkolu` s tlačítkem Kopírovat.
* Zkušební zpráva výslovně říká, že **není** oznámením (skutečná oznámení chodí souhrnně nejvýš jednou za minutu).
* Project Intelligence při vypnutém serveru **není zaškrtnutá** – stojí tam „na tomto serveru vypnuto“ a případně „uložená volba se použije po zapnutí“.
* Odpojení (kanál, skupina, Slack, Telegram, Google) má jednotný potvrzovací dialog s následky; u Telegram skupiny řekne, že ji bot opustí;
  volba „smazat i záznamy zpráv“ je zaškrtávací pole ve stejném dialogu (výchozí = ponechat).
* Osobní oznámení – **nové** nastavení začíná „Jen vybrané projekty“ (neuloženo, dokud neuložíte nebo nepřipojíte kanál); stávající nastavení beze změny.
  Rozdíl režimů: „Všechny moje projekty“ zahrnuje i projekty, do kterých vás přidají později; „Jen vybrané“ ne.

**Cvičení (bez placených volání):** projděte Přehled → najděte, proč je část „Vyžaduje akci“ → spravte ji; vysvětlete kolegovi rozdíl mezi
osobním Telegramem (HQ) a Telegram skupinou projektu (Relay) jen podle obrazovky Nastavení.
