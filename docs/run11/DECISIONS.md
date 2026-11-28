# RUN 11 – jediný schvalovací checkpoint (fáze C, 2026-11-28)

Podklady: `AUDIT.md` (registr nálezů F-/H-, systémové příčiny SC-1 – SC-7), snímky `screens/before/` (210 případů, 4 vzhledy, 4 šířky).
Co už vlastník schválil (O1, O4, O5, O7, O8, O9, O10, #15/#16 podmíněně, #18 LATER) se zde znovu neptá.

## A. K rozhodnutí (každé s doporučením)

| # | Rozhodnutí | Doporučení | Alternativa |
|---|---|---|---|
| **D1** | **Propojené účty – návrh obrazovky** (sekce B) | **schválit** návrh B | ponechat strukturu, jen opravit stavy (#2, #7) |
| **D2** | Přepínač AI modelu v hlavičce **nic nedělá** (F-01) | **odstranit** z hlavičky i z mobilního menu; model zůstává serverovým nastavením | udělat funkční = nová serverová funkce + dopad na rozpočty → mimo RUN 11 |
| **D3** | AI Studio: falešný „Měsíční limit 300 CZK“ a natvrdo „Aktivní model“ (F-02, F-03) | kartu limitu nahradit **pravdivou informací bez nového API**: „Denní limit AI určuje server; při vyčerpání se akce odmítne s vysvětlením“ + dnešní spotřeba ze serverového záznamu (už se zobrazuje); model ukazovat jen ze skutečného záznamu, jinak „—“ | ponechat a přejmenovat na „orientační, jen v tomto prohlížeči“ |
| **D4** | Hero projektu = šablonový anglický text pro všechny projekty, „THIS WEEK“ = celkový počet (F-04, F-71) | nahradit **kompaktní hlavičkou projektu**: H1 = název projektu, pod ním jeden řádek skutečných údajů (počet úkolů · po termínu · členové); odstranit „Focus note“ a duplicitní „YOUR WORKSPACE“; tlačítko sbalení zachovat | jen přeložit texty a opravit popisek čísla |
| **D5** | Hlavička: přetečení Classic 768–1140 px (F-10) a přeplněnost (F-73) | Classic pod **1280 px** přesunout přepínač vzhledu a motivu do menu avataru (jako už to dělá mobil); nad 1280 px beze změny – přepínač Classic/Monograph zůstává pro prezentace viditelný | jen zúžit prvky (riziko, že se nevejdou v češtině) |
| **D6** | #11 výchozí rozsah osobních oznámení | „Jen vybrané projekty“ **jen pro nové nastavení**; uložené volby beze změny | ponechat „Všechny“ |
| **D7** | Neaktivní „Fullscreen (připravuje se)“ v detailu úkolu a PI (F-05) | **odstranit** placeholder; režimy Vlevo / Soustředěný / Vpravo zachovat (česky) | – |
| **D8** | Anglické názvy | česky vše kromě názvů produktu/funkcí: **Board, Project Intelligence, AI Studio, Cortex, Meeting Intelligence**; „AI History“ → „Historie AI“ | překládat i názvy funkcí |
| **D9** | Mobilní board (F-12) | ≤ 767 px: 4 metriky → jeden řádek souhrnu, ikonová tlačítka toolbaru do existujícího menu „…“, „Nový úkol“ jako první akce pod hlavičkou | ponechat |
| **D10** | Integrace projektu: zaškrtnuté PI při vypnutém serveru (H-01) | při vypnutém serveru volbu **zobrazit jako nedostupnou** (disabled + „Na serveru vypnuto“), uložená hodnota se nemaže | jen text |

## B. Návrh – Propojené účty (D1)

Princip: jedna stránka, nahoře **přehled stavu na první pohled**, pod ním tři sekce se **stejným vzorem řádku**. Žádná nová routa
(`/settings`, kotvy `#google`, `#oznameni`, `#projekty`), žádná nová knihovna; komponenty `GoogleConnectionCard`, `NotificationChannelsCard`,
`HubSettingsCard` zůstávají (mění se jejich vnitřní rozložení), `data-testid` zachovány.

```
NASTAVENÍ
Propojené účty
Služby, se kterými ClearSpace pracuje vaším jménem. Odpojit je můžete kdykoli.

┌ PŘEHLED ───────────────────────────────────────────────────────────────────────┐
│ Google               ● Připojeno · alex.morgan@…   Disk · Gmail · Kalendář      [Spravovat ↓] │
│ Osobní oznámení      ● Telegram aktivní   ○ Slack nepřipojen                     [Spravovat ↓] │
│ Slack a Telegram     ● Aplikace ve Slacku: nainstalováno · 2 chat účty            [Spravovat ↓] │
│ pro projekty                                                                                 │
└──────────────────────────────────────────────────────────────────────────────────────────────┘

§ Google  (#google)                                                   [SIMULACE] jen v demo režimu
  ┌───────────────────────────────────────────────────────────────────────────────────────┐
  │ [ikona] Google Disk     ● Povoleno        Jen soubory, které vyberete.       [Vypnout]    │
  │ [ikona] Gmail           ○ Nepovoleno      Jen e-maily, které připojíte.      [Povolit]    │
  │ [ikona] Kalendář        ○ Nepovoleno      Vaše události vidíte jen vy.       [Povolit]    │
  │ [ikona] Plánování porad ○ Vyžaduje Kalendář                                  [Povolit] (disabled) │
  └───────────────────────────────────────────────────────────────────────────────────────┘
  ▸ Co ClearSpace vidí a ukládá        (dnešní seznam zásad, sbalený <details>)
  Účet: alex.morgan@…                                               [Odpojit Google účet] (outline danger → ConfirmDialog)

§ Osobní oznámení – jen vám, nikdy do kanálů  (#oznameni)
  │ [Slack]    ○ Nepřipojeno                                                [Připojit]      │
  │ [Telegram] ● Aktivní · Telegram: …   [Zkušební zpráva] [Pozastavit] [Odpojit]            │
  ▸ Co posílat  (rozbalené, pokud je něco připojeno) … [Uložit] → „Uloženo ✓“ (StatusMessage)
  ▸ Co zpráva obsahuje (zásady, sbalené)

§ Slack a Telegram pro projekty  (#projekty)
  │ [Slack] Aplikace ClearSpace Projekty   ● Nainstalováno do „BNG Workspace“   [Přeinstalovat] │
  │                                         ○ Nenainstalováno                    [Nainstalovat]  │
  Moje chat účty:  ● Slack: …   ● Telegram: …   [Odpojit]       [+ Propojit Slack účet] [+ Telegram]
  Jak propojit kanál nebo skupinu: Projekt → Integrace. Příkazy:  /link@Bot KÓD [Kopírovat]  /task@Bot Název [Kopírovat]
```
Vzor řádku (všechny tři sekce): ikona · název · **stavový štítek** (Připojeno / Aktivní / Pozastaveno / Nepřipojeno / Vyžaduje akci) ·
jedna věta „k čemu“ · akce vpravo (primární jen jedna, odpojení vždy jako obrysové „danger“ s `ConfirmDialog`). Úspěch po návratu z OAuth/párování
(#2): výrazný stav „Propojeno ✓ …“ v řádku + `StatusMessage`. Mobil: řádky pod sebe, akce na celou šířku.
Stav instalace Slacku (#7): z existujících dat `slackWorkspaces` (bez migrace); pokud je server nevrátí mimo projekt, ukáže se poslední výsledek
instalace a odkaz „Stav ověříte v projektu → Integrace“ (rutinní rozhodnutí při implementaci, zdokumentuje se).

## C. Plán implementace (po schválení autonomně)

| Dávka | Obsah | Nálezy / backlog | Akceptační kritérium |
|---|---|---|---|
| 1 Primitivy | `ConfirmDialog` (nad `ModalShell`), `CopyButton` → `components/ui`, `StatusMessage`; `ModalShell` + hook `useDialogFocus` (focus dovnitř, Tab past, návrat, `aria-labelledby`) | SC-4, SC-5, F-30–F-33, F-40, M1, M8, M14 | 0× `confirm()`/`alert()` v `src/` (grep); Esc/Tab/návrat focusu ověřen testem; čtečka ohlásí uložení (`role=status`) |
| 2 Layout a jazyk | `lang="cs"`, Classic navbar < 1280 px (D5), mobilní board (D9), překlady (D8), hero → hlavička projektu (D4) | SC-2, SC-6, F-10–F-13, F-50–F-52, F-71, F-72 | matice snímků: **0 přetečení** ve všech šířkách a vzhledech; žádný anglický řetězec ze seznamu F-51 |
| 3 Poctivé stavy | odstranit přepínač modelu (D2), AI Studio (D3), placeholder Fullscreen (D7), PI při vypnutém serveru (D10), hub #2 #6 #7 #8 #9 #14, porady #17 #21 #22, F-06, F-07 | SC-1, M3–M7, M9–M12, H-01–H-07 | žádný prvek, který nemá účinek; každý stav odpovídá serveru (testy stavů) |
| 4 Porady | Classic styl `.mi-page` (tokeny), odkazy, kontext projektu a aktivní navigace, #19 #20, #15 (dnes / tento týden + „spustit přepis“), #16 (celá obrazovka + barvy mluvčích) | SC-3, F-20–F-26, S13, S14 | porady v Classic bez nativních prvků; 375 px bez přetečení; živý přepis na nepodporovaném zařízení jasně vysvětlen |
| 5 Propojené účty | návrh B | M16, H-02, H-03, H-08, D1, D6 | stav každé služby čitelný bez rozbalení; všechny dnešní akce dostupné; testy hub/notify/google zelené |
| 6 Přístupnost | názvy `<select>`, label termínu, název ikonového tlačítka, kontrast avatarů a `.cs-badge` | SC-7, F-60–F-63 | axe: **0** `select-name`, `label`, `button-name`; `color-contrast` 0 ve všech 4 vzhledech |
| 7 Testy a dluh | TD-3 (filtr `action_type`, ověřeno legitimní), `GEMINI_MODEL=fake-gemini` do skriptu stacku, nové UX regresní testy, TD-1/TD-2 jen pokud zůstane čas | M15, S11 | unit ≥ 1 500 PASS, E2E bez nových selhání, TD-3 PASS |

Nepřidávám: nové tooltipy, badge, animace, knihovny; nemění se oprávnění, RLS, API kontrakty, migrace, limity AI/STT.
Odloženo (LATER): #18; F-73 nad rámec D5; H-08 nativní checkboxy mimo Classic modal; TD-1/TD-2, pokud nezbude čas.

## D. Co potřebuji
Odpověď na **D1–D10** (stačí „schvaluji doporučení“, případně výjimky). Pak pokračuji autonomně až po nasazení (O7) a závěrečný report.

## E. Rozhodnutí vlastníka (2026-11-28) – SCHVÁLENO
D1–D10 schváleny včetně #15, #16, #7 a TD-3, s upřesněním (závazné pro implementaci):
1. **Propojené účty** v existujícím Nastavení; jasně rozlišit osobní vs. projektová propojení, stav autorizace, účel a dostupné akce; u Slacku a
   Telegramu vysvětlit rozdíl mezi kanály, boty a režimy komunikace. Schválen princip uspořádání, ne globální redesign; design system beze změny.
2. **AI Studio a stavy**: zobrazovat skutečné serverové hodnoty (limity, aktivní model, dostupnost funkcí podle prostředí a typu účtu);
   nenahrazovat hardcoded hodnoty jinými hardcoded hodnotami; co nelze spolehlivě získat, přiznat jako nedostupné; pojistky beze změny.
3. **Oznámení**: nové výchozí nastavení nesmí přepsat preference existujících uživatelů; vysvětlit rozdíl mezi režimy.
4. **#15, #16**: výjimky z feature freeze jen v prezentační vrstvě nad existujícími daty; bez placených služeb, migrací a zbytečné složitosti;
   #16 musí být skutečně funkční celoobrazovkový režim.
5. **TD-3**: opravit test, ne chování; ověřit události podle typu, správné přiřazení a zachování související notifikace; neoslabovat test.
6. **Testy**: výchozí E2E před implementací, kompletní regrese po ní; finální automatická kontrola **4 kombinace vzhled × motiv × 1440/1024/768/375**;
   deterministické indikátory připravenosti místo networkidle; praktická kontrola v reálném prohlížeči; axe není náhrada praktického testu
   přístupnosti; snímky se skutečnými identitami nikdy necommitovat.
7. **Rozsah**: systémové opravy sdílených komponent a tokenů; žádný mechanický plošný refactoring; Classic, Monograph, light/dark a lokalizace
   zachovány; žádné zásahy do experimentálních větví ani V2.
8. **Dokončení**: aktualizovat UX backlog, tech dluh, dokumentaci a školicí materiály; nezahajovat Product Training Hub ani RUN 12; žádné
   placené testy; nasazení jen při splnění všech akceptačních, bezpečnostních a regresních gate, jinak NO-GO s dokumentací.
