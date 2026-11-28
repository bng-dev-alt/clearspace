# RUN 11 – UX/UI audit (fáze A + B, 2026-11-28)

Worktree `V1-run11`, větev `polish/run11` z `main` `e8f0625`. Vše lokálně, **0 placených volání** (Google mock, fake Soniox, fake Gemini na 127.0.0.1).
Legenda zdroje: **[UI]** viděno v prohlížeči / na snímku · **[KÓD]** ověřeno čtením kódu · **[AXE]** axe-core WCAG 2.1 A/AA · **[DOC]** z dokumentace.

## 1. Výchozí stav (fáze A)

| Kontrola | Výsledek |
|---|---|
| Git | `main` = `origin/main` = `e8f0625`, tag `run10-closed`; worktree `V1-run11` / `polish/run11` |
| Produkce | `vercel inspect clearspace.luffast.com` → `dpl_FwWirB1MSS4hA7Mig8Rp67t92pia`, target production, Ready **[ověřeno]** |
| Unit testy | `vitest run`: **101 souborů, 1 500 / 1 500 PASS** |
| Lint | **0 chyb, 10 varování** (starší, v `supabase/tests/*.mjs`) |
| E2E (výchozí, před implementací, `scripts/run11-e2e.sh`) | **stack porad** (čistý `cs-run11-sb`): 45 PASS, 3 FAIL – všechny předem existující: TD-3 `meetings:152`, TD-2 `task-resources:140`, `r6-quality:102`; 8 nespuštěno (sériový `meetings.spec` za TD-3), 1 skip · **živý přepis** 3/3 PASS · **demo režim** 27 + 19 PASS · **hub + oznámení** 2/2 PASS |
| `V1-run10` | ověřeno: není worktree (`git worktree list`), 0 souborů (jen prázdné `.claude/.cc-writes`), žádný proces → **odstraněn** |
| Lokální prostředí | `meetings-stack.sh` (cs-run10-sb, loopback), app `http://127.0.0.1:3481/?login=auto` |
| Snímky | `docs/run11/screens/before/` – nástroj `frontend/scripts/run11-shots.mjs` (overflow, chyby konzole, axe) |

### Matice snímků (core, 20 obrazovek vč. detailu porady s analýzou)
| Průchod | Případů | Čisté | Nálezy |
|---|---|---|---|
| 1440 px × Classic light/dark × Monograph light/dark | 84 | **84/84** | žádné přetečení ani chyba konzole |
| 1024 / 768 / 375 × Classic light + Monograph dark | 126 | **91/126** | Classic: **vodorovné přetečení na všech 17 přihlášených stránkách při 1024 i 768 px** (1136 resp. 965 px, navbar); 375 px: detail porady 397 px. Monograph: 0 |

**axe-core (WCAG 2.1 A/AA), 1440 px, součet uzlů přes 21 obrazovek:**
| Pravidlo | Classic light | Classic dark | Monograph light | Monograph dark | Příčina |
|---|---|---|---|---|---|
| `select-name` | 13 | 13 | 13 | 13 | `<select>` bez přístupného názvu: řazení v toolbaru, stav/priorita/štítek v detailu úkolu |
| `color-contrast` | 35 | 22 | 6 | 7 | avatary (bílý text na světle modré), `.cs-badge` warning/accent/default, drobné popisky |
| `label` | 1 | 1 | 1 | 1 | datum v detailu úkolu (`.drawer-date-input`) |
| `button-name` | 1 | 1 | 1 | 1 | úprava rozpočtu v AI Studiu (`.ai-budget-edit-btn`) |


## 2. Nálezy

Závažnost: **S1** zavádějící / falešný stav, nedokončitelná operace, blokuje prezentaci · **S2** matoucí, nekonzistentní, a11y porušení · **S3** kosmetika.

### 2.1 Systémové příčiny (jedna oprava řeší mnoho míst)

| ID | Systémová příčina | Projevy (nálezy) | Závažnost | Oprava (návrh) |
|---|---|---|---|---|
| **SC-1** | **Falešné nebo zavádějící ovládací prvky a stavy** | F-01, F-02, F-03, F-04, F-05, F-06 | **S1** | odstranit / nahradit pravdivým stavem (rozhodnutí D2–D4) |
| **SC-2** | **Classic: chybí breakpoint 768–1140 px v navbaru** | F-10 (17 stránek × 2 šířky) | **S1** | jedno CSS pravidlo v `globals.css` (navbar se zalomí / sbalí do menu jako na mobilu) |
| **SC-3** | **Modul Porady stylovaný jen pro Monograph** | F-20 – F-26 | **S1** (prezentace v Classic) | Classic varianta pravidel `.mi-page` v `meetings.css` přes existující tokeny `.cs-input` / `.cs-btn` |
| **SC-4** | **Chybějící sdílené primitivy zpětné vazby** | F-30 (14× `confirm()`), F-31 (11× `alert()`), F-32 (kopírování jen lokálně v PairingBox), F-33 (žádné stavové hlášení) | S2 | `ConfirmDialog` nad `ModalShell`, `CopyButton` přesunout do `components/ui`, `StatusMessage` (role status/alert) – bez knihovny |
| **SC-5** | **Dialogy bez správy focusu** | F-40 (`ModalShell` neposune focus dovnitř, nezachytí Tab, nevrátí focus), 14 vlastních dialogů | S2 (a11y) | jeden hook `useDialogFocus` v `ModalShell` + adopce v 14 dialozích (1 řádek) |
| **SC-6** | **Jazyková nekonzistence** | F-50 (`<html lang="en">`), F-51 anglické texty UI | S2 | `lang="cs"`; přeložit viditelné řetězce (ne názvy funkcí „Board“, „Project Intelligence“) |
| **SC-7** | **Formulářové prvky bez přístupného názvu, kontrast Classic** | F-60 (`select-name` 13), F-61 (`label`), F-62 (`button-name`), F-63 (kontrast avatarů a badge) | S2 | `aria-label`/`htmlFor` u 5 komponent; tokeny barev avatarů a `.cs-badge` |

### 2.2 Nálezy

| ID | Obrazovka / modul | Nález | Zdroj | Záv. | Četnost |
|---|---|---|---|---|---|
| F-01 | Hlavička (všechny stránky) | Přepínač AI modelu „Auto (Chytrý výběr)“ **nic nedělá**: volba se uloží jen do `localStorage` (`selected_ai_model`), žádný kód ji nečte, server používá `GEMINI_MODEL` | [KÓD] `AiModelSelector.tsx`, grep | S1 | každá stránka |
| F-02 | AI Studio | „Měsíční limit rozpočtu 300 CZK“ je číslo v `localStorage`, server ho nevynucuje; skutečný limit je 40 000 tokenů/den na serveru | [KÓD] `aiAnalyticsService.ts:270–285` | S1 | 1 |
| F-03 | AI Studio | „Aktivní model: gemini-3.5-flash“ je natvrdo zapsaná výchozí hodnota, když chybí záznam; protiřečí hlavičce („Auto“) | [KÓD] `aiAnalyticsService.ts:216`, [UI] | S1 | 1 |
| F-04 | Projekt (board, kalendář, dashboard) | Hero je statický anglický šablonový text pro **každý** projekt („PRODUCT TEAM / Q3“, „Make meaningful progress.“, „FOCUS NOTE – Keep the work moving.“); karta „THIS WEEK 01“ ukazuje **celkový** počet úkolů, ne týdenní | [KÓD] `HeroSection.tsx`, [UI] | S1 | všechny projekty |
| F-05 | Detail úkolu, Project Intelligence | Neaktivní tlačítko „Fullscreen (připravuje se)“ = nabídka neexistující funkce | [KÓD] `TaskDetailDrawer.tsx:530`, `ProjectIntelligenceDrawer.tsx:294` | S2 | 2 |
| F-06 | Detail porady | Interní pojmy v UI: revize „· paste ·“, „Model fake-gemini“ (v produkci název modelu) | [UI] | S3 | 1 |
| F-07 | Detail porady | Gramatika: „1 návrhů, 4 položek bez důkazu“ (chybí skloňování podle počtu) | [UI] | S3 | výsledky analýzy |
| F-10 | Classic, všechny přihlášené stránky | Vodorovné přetečení při 1024 px (1136 px) a 768 px (965 px): `navbar-right` (hledání, model, styl, motiv, avatar, zvonek) se nevejde; obsah stránky je posunutý, vpravo prázdný pruh | [UI] matice, TECH_DEBT RUN 04 | S1 | 17 stránek × 2 šířky |
| F-11 | Detail porady 375 px | Přetečení 397 px (dlouhý `<select>` revize) | [UI] | S2 | 1 |
| F-12 | Projekt, mobil | Nad prvním sloupcem boardu je toolbar (4 ikonová tlačítka) + 4 metriky; „Nový úkol“ není v horní části | [UI] `monograph-dark-board-375` | S2 | board mobil |
| F-13 | Projekt, 768 px | Tlačítko „Členové projektu“ v toolbaru není dostupné (vstup do týmu projektu chybí) | [UI] `entry-point not found` | S2 | tablet |
| F-20 | Porady (Classic) | Formulář nové porady: nestylované `input`/`textarea`/`select`, prohlížečové „Choose File / No file chosen“, monospace placeholder | [UI] `existing-light-meeting-new` | S1 | 1 |
| F-21 | Porady (Classic) | „← Zpět na projekt“, „← Porady“ = výchozí modrý podtržený odkaz, v tmavém režimu **fialový navštívený** | [UI] | S2 | všechny stránky porad |
| F-22 | Porady | Hlavní navigace zvýrazňuje „Board“; chybí název projektu / drobečková navigace | [UI] | S2 | všechny stránky porad |
| F-23 | Porady | „Nová porada“ zůstává viditelná i s otevřeným formulářem (dvojí ovládání) | [UI] | S3 | 1 |
| F-24 | Porady | #17 „Analyzovat“ je bez přepisu jen `disabled`; #22 „Proběhlé“ míchá porady s přepisem a uplynulé bez přepisu; #21 „z toho zrušeno“ | [KÓD] backlog | S2 | – |
| F-25 | Porady | #19/#20 výběr zdroje zvuku = holé radio, `<select>`/`<meter>` nativní (Classic) | [KÓD] `LivePanel.tsx` | S2 | živý přepis |
| F-26 | Porady | Jazyk: volby „Čeština (výchozí)“ a „Čeština“ vedle sebe | [UI] | S3 | 1 |
| F-30 | 14 souborů | Nativní `confirm()` pro mazání/odpojení (Disk, Gmail, Kalendář, hub, tým, komentáře, porady, AI historie, karta) – nestylované, netestovatelné, text bez kontextu | [KÓD] | S2 | 14 |
| F-31 | 7 souborů | Nativní `alert()` (11×) pro chyby a výsledky (AI moduly, přílohy, tým, AI historie, dashboard) | [KÓD] | S2 | 11 |
| F-32 | Hub, tým, porady | One-click kopírování jen v `PairingBox` (lokální komponenta), `ScheduleCard`, týmu; příkaz `/task@bot Název` se v aplikaci **nikde neukazuje** (#5, #12) | [KÓD] | S2 | – |
| F-33 | celá aplikace | Žádné sdílené stavové hlášení; ukládání hlásí každý modul jinak (`drive-message`, `mi-error`, `alert()`, nic) | [KÓD] | S2 | – |
| F-40 | dialogy | `ModalShell`: Esc ano, ale focus se nepřesune do dialogu, Tab uniká na stránku, po zavření se nevrací; 14 dalších dialogů vlastní implementace | [KÓD] | S2 | 21 |
| F-50 | celá aplikace | `<html lang="en">` u české aplikace – čtečky čtou anglicky, prohlížeč nabízí překlad | [KÓD] `layout.tsx:34` | S2 | vše |
| F-51 | projekty, detail úkolu, AI Studio, board | Angličtina v UI: „New Project“, „✨ Generate Project“, „AI ENGINE“, „TASK DETAIL“, „Left / Focused / Right“, „RESOURCES“, „YOUR WORKSPACE“, „Live board“, „Request Logs“, hero | [UI] | S2 | ~15 řetězců |
| F-52 | Projekty | „+ New Project“: ikona plus + znak „+“ v textu (zdvojení), emoji ✨ | [UI] | S3 | 1 |
| F-53 | AI Studio | Desetinná tečka „0.00 CZK“, „0.00 s“ místo české čárky | [UI] | S3 | 4 |
| F-60 | toolbar, detail úkolu | 13 `<select>` bez přístupného názvu (vizuální popisek není svázaný) | [AXE] | S2 | 13 / vzhled |
| F-61 | detail úkolu | Pole termínu bez `label` | [AXE] | S2 | 1 |
| F-62 | AI Studio | Ikonové tlačítko úpravy rozpočtu bez názvu | [AXE] | S2 | 1 |
| F-63 | Classic | Kontrast: avatary členů, `.cs-badge--warning/accent`, drobné popisky (35 uzlů light / 22 dark) | [AXE] | S2 | 35 |
| F-70 | Nastavení / Propojené účty | Dlouhé odstavce, seznam zásad pod kartou, prohlížečově modrý odkaz, každá karta jiná struktura; stav připojení není vidět na první pohled | [UI] | S2 | O1 redesign |
| F-71 | Projekt | Duplicitní nadpisy: hero + „YOUR WORKSPACE / Společný projekt“ + metriky se šipkami; záložka „Porady“ stylovaná jako odkaz (podtržená) na rozdíl od ostatních | [UI] | S3 | – |
| F-72 | Karta na boardu | Prázdná karta ukazuje „…“ a „--“ zástupné znaky | [UI] | S3 | každá karta bez metadat |
| F-73 | Hlavička | 4 skupiny ovládání (hledání, model, styl, motiv) + avatar + zvonek; přepínač stylu a motivu zabírá 2 skupiny | [UI] | S3 | – |
| F-80 | TD-3 | `meetings.spec.ts:152` čeká 1 záznam aktivity; **dva záznamy jsou legitimní**: `card_created` (tvorba) + `card_assigned` z triggeru `collab_assignee_events` (migrace 1000), který zároveň posílá oznámení přiřazenému. Stejně se chová ruční vytvoření s přiřazením. → upravit test (filtr podle `action_type`), ne kód | [KÓD] `20261124001000_collaboration.sql:580–612` | – | test |

### 2.3 Hub, oznámení a Propojené účty (stack `hub-stack.sh`, mocky Slack/Telegram)
Snímky hubu **nejsou v repozitáři**: lokální stack cs-notify-sb obsahuje skutečné popisky identit vlastníka z živých testů RUN 08. Uloženy jen lokálně
(`$TMPDIR/cs-run11-hub-before/`, 12/12 bez přetečení a chyb konzole). Snímky „po“ se pořídí na anonymizovaných datech.

| ID | Nález | Zdroj | Záv. |
|---|---|---|---|
| H-01 | Integrace projektu: zaškrtnuté „Project Intelligence“ a vedle text „(Na serveru vypnuto.)“ – protichůdný stav | [UI] | S1 |
| H-02 | Nastavení míchá tři různé „Slacky“ (osobní oznámení „Nepřipojeno“, aplikace pro projekty „Nainstalovat“, identita „propojeno“) bez vysvětlení rozdílu; stav není vidět bez čtení odstavců | [UI] | S1 → O1 |
| H-03 | #7 „Nainstalovat do Slacku“ nemá stav – tlačítko je stejné před i po instalaci | [KÓD] `HubSettingsCard.tsx:80` | S1 |
| H-04 | „Odpojit“ je plné červené tlačítko vedle „Zkušební zpráva“; potvrzení přes 2× `confirm()`, bez informace, že bot skupinu opustí (#14) | [UI] [KÓD] | S2 |
| H-05 | Nápověda `/task` u Telegramu nejde zkopírovat a neříká, že se název píše za příkaz (#5, #12) | [UI] | S2 |
| H-06 | #8 propojení kanálu projde, i když bot v kanálu není (chyba až zkušební zprávou); #9 nový cíl s vypnutým „Interaktivní“ | [DOC] RUN 09 živě | S1 / S2 |
| H-07 | #2 potvrzení úspěšného propojení je jednořádková zpráva; #6 „zkušební zpráva odeslána“ ≠ oznámení doručena | [DOC] + [KÓD] | S2 |
| H-08 | Nativní zaškrtávací pole a prohlížečově modrý odkaz v modalu Integrací (Classic) | [UI] | S3 |
| H-09 | #11 výchozí „Všechny moje projekty“ u osobních oznámení | [DOC] | O2 |

### 2.4 Stav položek inventury po auditu
Všechny MUST M1–M16 z `RUN11_INVENTORY.md` se potvrdily (M2 rozšířen: přetečení i při 768 px). Nové S1 nálezy mimo backlog: F-01 – F-04, F-10 (rozsah), F-20, H-01.


