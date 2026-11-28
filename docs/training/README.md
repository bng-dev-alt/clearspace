# ClearSpace V1 – závěrečné produktové školení (plán)

Školení proběhne po RUN 10 (Meeting Intelligence) a finálním UX polish runu (RUN 11 – změny UX jsou v modulech 3 §8 a 5 §10). Každý modul vychází jen z **ověřené implementace**
(živé akceptace a regresní testy jednotlivých runů), ne z plánů. Odkazy na důkazy jsou v každém modulu.

| # | Modul | Stav podkladů | Soubor |
|---|---|---|---|
| 1 | Projekty, board, kalendář, dashboard, týmová spolupráce a realtime (RUN 00–01) | k doplnění | – |
| 2 | Google Disk, Gmail, Kalendář – pilot s demo účtem (RUN 02–06) | k doplnění | – |
| 3 | **Komunikační hub: Slack aplikace, Telegram HQ, Relay a Cortex (RUN 05–09)** | **hotovo** | `COMMUNICATION_HUB.md` |
| 4 | Project Intelligence a AI (RC1–RC5, RUN 09 stage 2) | částečně (chatová část v modulu 3) | – |
| 5 | **Meeting Intelligence (RUN 10)** – plánování, Meet, živý přepis, analýza, schválení úkolů, PI | **hotovo** (živé části označeny jako čekající na akceptaci) | `MEETING_INTELLIGENCE.md` |
| 6 | Provoz, bezpečnost, náklady, vypínače | podklady v `docs/run09/OPERATIONS.md` | – |

Demo prostředí pro všechna školení: **prezentační účet** (ADR `docs/run09/ACCOUNTS_ADR.md`), projekty CSD-CORVANE, Slack BNG Workspace,
Telegram skupina „ClearSpace Test“. Nikdy osobní účet vlastníka.

## RUN 11 – změny UX pro budoucí moduly 1, 2, 4 (podklady)
* **Modul 1 (projekty, board):** hlavička projektu = název projektu + jeden řádek skutečných faktů (vaše role · členové · úkoly po termínu);
  na telefonu jsou 4 metriky v jednom řádku a „Nový úkol“ nahoře; v Classic pod 1280 px je přepínač vzhledu a motivu v menu avataru.
  Mazání úkolu, komentáře, přílohy, člena a projektu potvrzuje jednotný dialog s následky (Esc zavře, focus se vrací).
* **Modul 2 (Google):** Propojené účty → sekce Google: stav služeb v řádcích, zásady sbalené pod „Co ClearSpace vidí a ukládá“;
  vypnutí Gmailu/Kalendáře nabídne ve stejném dialogu volbu „odebrat i připojené položky“ (výchozí ponechat).
* **Modul 4 (AI):** AI Studio ukazuje **model, který server skutečně používá**, a **limity vašeho účtu** podle serverové politiky (vlastník bez
  denního limitu, prezentační účet 40 000 tokenů/den, 2/min, 30 min přepisu); co nejde zjistit, je výslovně „nelze zjistit“. Přepínač modelu v hlavičce
  byl odstraněn – nikdy nic neovlivňoval.
