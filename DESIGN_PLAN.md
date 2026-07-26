# DESIGN_PLAN — ClearSpace vizuální redesign

> Tento dokument je **analýza a návrh**, žádný kód nebyl změněn. Funkcionalita, UX, workflow, informační architektura, routování, business logika a databázová vrstva zůstávají beze změny — návrh se týká výhradně vizuální vrstvy (design tokeny, CSS, komponentní styl).
>
> Zdroje, ze kterých vycházím: `frontend/src/app/globals.css` (3472 řádků), `frontend/src/app/design-system.css` (sdílené `.cs-*` primitivy), `ClearSpace_Design_Bible_v1.0.md` (existující designová specifikace z release 24–29), a živý průchod aplikací v prohlížeči (light/dark mode, dashboard, board, task drawer, tým, AI Studio, kalendář).

---

# 1. Analýza současného UI

## Silné stránky

- **Tokenový systém už existuje a je poctivě navržený.** `globals.css` má sémantické proměnné (`--accent`, `--surface`, `--text-muted`...), `design-system.css` staví nad nimi sdílené `.cs-*` primitivy (`.cs-btn`, `.cs-card`, `.cs-input`, `.cs-metric`, `.cs-modal`...). Redesign tedy z velké části znamená **přepočítat hodnoty tokenů**, ne přepisovat komponenty od nuly.
- **Typografické párování má už teď charakter.** Fraunces (editorialní serif) pro nadpisy + Sora (humanistický sans) pro tělo — není to výchozí Inter-všude, je to uvážená volba, kterou stojí za to zachovat.
- **Dark mode je promyšlený, ne invertovaný.** „Hluboký oceán" (modro-tealová), ne černo-zelená kyberpunk paleta. Kontrasty byly cíleně doladěny na AA (viz `56_responsive_R9_open_decisions.md` — konkrétní poměry 5.14:1, 4.93:1...).
- **Sdílené komponenty reálně existují a používají se:** `MetricCard`, `Button`, `Badge`, `EmptyState`, `ModalShell` — nejde jen o CSS třídy, ale o React komponenty, které stojí za to rozšířit, ne nahradit.
- **Responsivita je centralizovaná** přes jediný token `--page-pad`, breakpointy jsou na jednom místě, motion respektuje `prefers-reduced-motion`.
- **Fotografický hero (`hero-ocean.jpg`) přes glass karty** je koncepčně blízko referenčnímu obrázku — „prémiový workspace s reálnou fotografií pod skleněnými kartami" už je tady nastavený vzorec. Nejde o cizí směr, jde o jeho dotažení.

## Slabé stránky a nekonzistence

**Rozptýlené inline styly.** `Navbar.tsx`, `ProjectDashboard.tsx` a další komponenty mají desítky řádků inline `style={{...}}` vedle existujících `.cs-*` tříd. To je největší riziko celého redesignu — token se dá přepočítat na jednom místě, ale inline barva/radius/padding musí najít a opravit ručně soubor po souboru.

**Dva paralelní systémy tlačítek a badgí.** Vedle `.cs-btn` (design-system.css) žije samostatná sada `.toolbar-btn-primary` / `.toolbar-new-task-btn` / `.toolbar-settings-btn` v `globals.css`, vizuálně skoro identická, ale nesdílená. Stejně tak `.card-tag` (badge na kartě) a `.cs-badge` dělají to samé jinou cestou. Znamená to, že úprava jednoho vizuálního pravidla dnes vyžaduje najít a opravit dvě až tři místa.

**„Glass experiment" vrstva mimo tokenový systém.** V `globals.css` (řádek ~2963) je blok explicitně okomentovaný jako *„Glass experiment... Snadno vratné: stačí smazat tento blok"*, který dodatečně překrývá `.card`, `.column`, `.stat-card`, `.members-table` druhou vrstvou průhlednosti a blur efektu — mimo `design-system.css`. Je to poctivě přiznaná rozpracovanost, ale znamená to, že se vizuální jazyk „glass" doladil živě v produkční CSS, ne v tokenech. Dobrá příležitost tohle při redesignu sjednotit natrvalo.

**Stejná fotka na každé obrazovce.** Ověřil jsem to živě: Dashboard, Board i Tým používají **identickou** leteckou fotku tropické pláže jako hero pozadí. Napoprvé je to atmosféra, napotřetí je to tapeta — přestává to nést význam a začíná to působit jako neutrální stock výplň, ne jako značka.

**Radius škála se dodržuje jen v `.cs-*` primitivech.** Design Bible definuje jasnou škálu (tlačítko 14px / karta 18px / dialog 24px / hero 28px), ale mimo `.cs-*` třídy se pořád objevují ad hoc hodnoty 4px, 6px, 8px (dropdown menu, tag chips, toolbar select) — aplikace tak vizuálně kolísá mezi „ostrým admin panelem" a „prémiovým glass workspace", což je přesně to, čemu se Design Bible ve vlastním „Golden Rule" snaží vyhnout.

**Typografická škála není tokenizovaná.** Desítky doslovných `font-size: 0.6rem / 0.62rem / 0.64rem / 0.65rem / 0.68rem` na místech, která by měla sdílet jednu hodnotu (popisky, uppercase labely). Nejde o vizuální chybu — jde o to, že každá budoucí úprava typografie musí projít 15+ míst ručně.

**„Badge soup" na kartách.** Kanban karta dnes skládá do patičky a horní řady čtyři vizuálně soutěžící orámované prvky najednou: tag chip, priority chip s tečkou, datum chip, avatar skupina. Referenční obrázek dosahuje bohatosti informace typografií a rozestupy, ne skládáním ohraničených čipů.

**AI Studio graf bez návrhu prázdného stavu.** Živě jsem otevřel AI Studio — „Denní aktivita" graf je bez dat jen prázdný rámeček s textem „Žádná aktivita". Design Bible přitom sama žádá „Every empty state must be intentionally designed" — to je nesplněný vlastní cíl, ne můj vynález.

**Nekonzistentní velikosti ikon.** `lucide-react` ikony se používají s velikostmi 14/15/16/18/20/22 bez zjevného pravidla, kdy se která použije.

## UX problémy (v rozsahu, který je stále „vizuální")

Beze změny workflow, ale dvě věci stojí za pozornost jako vizuální/interakční polish:
- Popis karty (`card-details`) se zobrazí až po najetí myší (`max-height: 0` → rozbalení na hover) — na dotykových zařízeních tenhle hover efekt fakticky nikdy nenastane, takže popis tam de facto není vidět. Řeším to jen jako vizuální/interakční detail (ne změnu workflow) v sekci Cards.
- Barevné tečky u priority (4.5px) nesou význam čistě barvou bez dostatečné velikosti/kontrastu textu vedle sebe — mírné riziko čitelnosti na menších obrazovkách.

## Vizuální problémy — shrnutí priority

Nejvyšší dopad/nejnižší náklad: sjednotit duplicitní button/badge systémy, nahradit opakovanou stock fotku, tokenizovat typografickou škálu. Nejvyšší dopad/vyšší náklad: redesign karty a boardu (nejfrekventovanější plocha v aplikaci).

---

# 2. Analýza referenčního obrázku

## Designové principy

- **Fotografie jako atmosféra, ne dekorace.** Materiálová fotka (mech, kámen, kapradiny) je tematicky svázaná s obsahem (ReFi/carbon/eco produkt) — funguje jako thesis, ne jako výplň.
- **Dvouzónový rytmus.** Nahoře tmavá, náladová, glass zóna (hero + klíčové metriky); pod ní klidná plochá krémová datová zóna (seznam karet protokolů). Jasný předěl mezi „atmosférou" a „daty".
- **Kapslový (pill) tvarový jazyk pro ovládání.** Segmentované menu nahoře, filtry dole — všechno pilulky. Karty a dialogy jsou naopak jen měkce zaoblené (ne pilulky) — to je čitelné pravidlo: *pill = ovládání, soft-round = obsah*.
- **Jeden akcent, zbytek monochrom.** Teplá zemitá neutrální paleta (olivová/mechová zelená, kámen, krém) + jediná sytá barva (lesní zelená) na CTA a pozitivní trendy, červená jen na negativní deltu. Žádná duha barevných chipů.
- **Malé inline vizualizace jako podpis.** Mini sparkline v každé kartě + barevná delta pilulka („↗4.88%") místo velkého grafu — bohatost dat v malém prostoru.
- **Neobvyklý „TVL Growth" graf** — vrstvené barevné segmenty (krém/hnědá/zelená) skládané do sloupců, ne standardní bar chart. To je nejvýraznější signature prvek celého obrázku.
- **Typografie:** čistý grotesk, velký polotučný nadpis ("Welcome back, Rexona!"), drobné trackované labely ve verzálkách, tabulkové číslice u velkých metrik.
- **Spacing:** vzdušné, velkorysé; karty mají jemný stín a téměř žádné tvrdé ohraničení — hranice řeší primárně světlo/stín, ne linka.
- **Hierarchie:** velké číslo + malý label (klasický vzorec statistické dlaždice) — ale použitý s mírou, ne na každém prvku.
- **Mikrointerakce (odvozeno z UI jazyka, ne přímo vidět ve statickém obrázku):** pill aktivní/hover stavy, šipkový indikátor trendu v rohu karty, `Deposit` CTA jako plná pilulka v akcentové barvě.

## Co z toho převzít jako *jazyk*, ne kopii

Clearspace má už teď emerald akcent blízký referenční lesní zelené a teplé `--bg-page` v light módu — není potřeba měnit odstín značky, stačí ho zasadit do teplejší, méně „cool-tech" neutrální palety a dotáhnout pill jazyk mimo theme-toggle, kde dnes žije osamoceně.

---

# 3. Návrh redesignu ClearSpace

Pro každou oblast: co / proč / přínos / priorita (Vysoká — Střední — Nízká).

## Navigation

**Co:** Přepnout hlavní navigaci (`Board / Projekty / AI Studio / AI History / Tým`) z textových odkazů s podtrženým aktivním stavem na kapslový segmentovaný ovladač — glass pozadí, aktivní položka jako plná pilulka (stejný princip, jaký `ThemeToggle` už dnes používá, jen izolovaně).
**Proč:** Dnešní `.nav-link.active::after` podtržení je generický SaaS vzorec. Pill nav je nejčitelnější signature krok z referenčního obrázku a sjednotí se s theme-togglem, který je dnes jediné místo, kde pill jazyk žije.
**Přínos:** Silnější vizuální identita, jasnější aktivní stav, jeden tvarový jazyk pro *všechno ovládání* v aplikaci (nav, filtry, přepínač zobrazení Board/Kalendář).
**Priorita:** Vysoká — dotýká se každé stránky, ale je to jedna komponenta (`Navbar.tsx`).

## Dashboard

**Co:** Nahradit opakovanou leteckou fotku pláže bespoke vizuálem (teplý abstraktní gradient/mesh, jemná texturovaná fotografie papíru/plátna, nebo abstraktní organický tvarový systém) a **nepoužívat identickou fotku na 4+ obrazovkách** — hero jako plný fotografický moment vyhradit pro Dashboard/Board „příchod", interiérové stránky (Tým, AI Studio) ať mají odlehčenou variantu (jen gradient, bez fotky).
**Proč:** Identická fotka na každé stránce ruší svůj vlastní účel — z atmosféry se stává tapeta.
**Přínos:** Hero se stane rozpoznatelným podpisem místo dekorace; menší payload na interiérových stránkách.
**Priorita:** Vysoká — nejviditelnější prvek, první dojem.

Karty projektů: převzít klidnější plochý styl z referenčních „protokol" karet (krémový povrch, tenká linka, velkorysý padding) místo dnešního těžšího ohraničení sdíleného s kanban kartou.

## Kanban (Board)

**Co:** Zachovat 5 sloupců a drag&drop beze změny. Vizuálně: oteplit pozadí sloupců směrem k nové teplé neutrální paletě, nahradit tvrdou `1px border-right` mezi sloupci větším odstupem (referenční obrázek řeší oddělení světlem/mezerou, ne linkou), ponechat `column-card-count` pilulku (už dnes odpovídá referenčnímu jazyku).
**Proč:** Dnešní linkované sloupce čtou jako tabulka/spreadsheet; referenční velkorysost prostoru působí klidněji a prémiověji.
**Přínos:** Board víc odpovídá vlastní ambici Design Bible („premium creative workspace"), kterou dnešní ohraničení sloupců nesplňuje.
**Priorita:** Střední.

## Cards

**Co:** Zredukovat „badge soup" — tag a priorita jako jeden klidný metadata řádek (text/tečka, ne dva samostatné orámované čipy), datum a avatary do čistší patičky s větším prostorem. Řešit odhalení popisu karty i mimo hover (tap-friendly), protože hover na dotyku fakticky neexistuje.
**Proč:** Dnešní karta skládá 4 ohraničené prvky vedle sebe — vizuálně nejexponovanější, nejopakovanější komponenta v aplikaci si zaslouží nejvíc kázně.
**Přínos:** Klidnější, lépe skenovatelná karta; menší kognitivní zátěž při rychlém průchodu boardem.
**Priorita:** Vysoká — nejčastěji viditelná komponenta v celé aplikaci.

## Forms

**Co:** Sjednotit všechny inputy na `.cs-input` / `.cs-label` — dnes mají Login, TaskDetailDrawer a Toolbar-search each mírně jiný radius/border/velikost. Tokenizovat velikost/tracking labelů (dnes 0.6/0.62/0.65/0.68rem vedle sebe se stejným účelem).
**Proč:** Formuláře jsou místo, kde je nekonzistence nejvíc vedle sebe vidět — Login, drawer a toolbar dnes vypadají jako tři různé aplikace.
**Přínos:** Jeden formulářový jazyk zpomalí budoucí drift, ne jen dnešní stav.
**Priorita:** Střední.

## Tables

**Co:** Tabulka členů týmu je dnes už blízko referenčnímu stylu (`.cs-table` je čitelný a klidný) — hlavně oteplit token barvy ohraničení/pozadí a sjednotit trackovanou typografii záhlaví s novou škálou. Bez strukturální změny.
**Proč:** Nejmenší mezera mezi současným stavem a cílem ze všech ploch.
**Přínos:** Rychlá shoda za nízkou cenu.
**Priorita:** Nízká.

## Dialogs

**Co:** Ověřit, že všechny modaly skutečně používají `.cs-modal` (ne inline styl jako částečně `ProjectMembersModal`), sjednotit overlay scrim na teplejší tón místo `rgba(15, 23, 33, 0.30)`.
**Přínos:** Konzistentní „vstup do fokusu" napříč aplikací.
**Priorita:** Střední.

## Dropdowns

**Co:** Sjednotit `TagDropdown` (vlastní absolutně pozicované menu, 8px radius, ad hoc stín `0 10px 30px rgba(12,31,56,0.08)`) a nativní `<select>` s vlastním chevronem (toolbar-select) na jeden dropdown vzor sdílející token radius i `--shadow-lg`.
**Přínos:** Menu přestanou vypadat jako ze dvou různých knihoven.
**Priorita:** Střední/Nízká.

## Empty States

**Co:** Dotáhnout `.cs-empty` (komponenta i CSS už existují) na místa, kde se dnes používá jen holý text — konkrétně AI Studio graf „Žádná aktivita". Navrhnout „ghost" sparkline placeholder inspirovaný referenčními mini-grafy místo prázdného rámečku.
**Proč:** Design Bible tohle sama žádá už dnes a nesplňuje to — nízká implementační náročnost, vysoký vnímaný polish.
**Priorita:** Střední.

## Loading States

**Co:** V prošlém kódu jsem nenašel dedikovanou skeleton/shimmer komponentu — navrhuji lehký shimmer nad novými teplými surface tokeny jen tam, kde dnes dochází k viditelnému bílému probliknutí. **Potřebuje ověřit v první implementační etapě**, jestli a kde k tomu reálně dochází, než se cokoli navrhne do detailu.
**Priorita:** Nízká.

## Settings

**Co:** Tlačítko „Nastavení (připravujeme)" v toolbaru je dnes zakázané/needotažené — jen zajistit, že disabled stav odpovídá novému button systému. Samotné Settings nejsou postavené, není co redesignovat.
**Priorita:** Nízká.

## Authentication (Login/Register)

**Co:** Rozdělený layout (tmavý editorialní levý panel + plovoucí glass karta vpravo) už dnes odpovídá ambici Design Bible. Levý panel dnes má jen měkké rozostřené gradientové skvrny — navrhuji buď (a) přidat jemnou organickou texturu/fotografii za panel namísto ploché gradientové kompozice, nebo (b) oteplit tmavý panel z chladné modro-tealové směrem k hlubšímu organickému tónu blíž referenčnímu obrázku. **Tohle je otevřené rozhodnutí, viz sekce 4 — Barevná paleta.**
**Přínos:** Nejvyšší „first impression" plocha za nízkou cenu (2 soubory).
**Priorita:** Vysoká.

---

# 4. Design System

## Barevná paleta

Návrh je **evoluce, ne výměna** — emerald akcent je už značkově zavedený a AA-doladěný, měnit odstín by bylo vysoké riziko za nejasný přínos. Otepluje se hlavně neutrální paleta (chladné modro-šedé → teplé kamenné/krémové), akcent zůstává.

| Token | Dnes (light) | Návrh (light) | Poznámka |
|---|---|---|---|
| `--bg-page` | `#fbfaf8` | `#FBF9F4` | jemný posun směrem k teplejší krémové, sotva postřehnutelný sám o sobě |
| `--surface-2` | `#f5f4f1` | `#F2EEE6` | teplejší kámen |
| `--border` | `#e7e4df` | `#E6E0D4` | teplejší hairline |
| `--text` | `#101f33` (chladná modro-černá) | teplý blízko-černý tón (např. `#1B1B16`) | čitelnost beze změny, nálada teplejší |
| `--accent` | `#0b7d57` | **beze změny** | už AA-ověřený, značkově zavedený |
| `--danger` / `--warning` | beze změny | beze změny | už AA-ověřené |

**Otevřené rozhodnutí — dark mode:** Dnešní tmavý režim je „hluboký oceán" (modro-teal), promyšlený a AA-ověřený vlastní směr. Referenční obrázek je teplý/zemitý i ve své tmavé zóně. Existují dvě legitimní cesty a nechávám je otevřené k rozhodnutí, protože jde o větší filosofický posun:
1. **Zachovat oceánský dark mode beze změny** (je to hotová, odlišná, funkční identita) a teplou paletu aplikovat jen v light módu.
2. **Oteplit i dark mode** směrem k hlubokému lesnímu/uhlovému tónu, aby oba režimy sdílely stejnou „zemitou" náladu jako reference.

## Typografie

Fraunces (display) + Sora (body) zůstávají — už jde o uváženou, ne výchozí volbu. Návrh je **zavést dokumentovanou škálu** místo rozptýlených doslovných hodnot:

```
--text-xs:      0.68rem   (uppercase labely, meta)
--text-sm:      0.78rem   (badge, drobný popisek)
--text-base:    0.85rem   (tělo UI, card title)
--text-md:      0.95rem   (input, popis)
--text-lg:      1.2rem    (modal title)
--text-xl:      1.55rem   (metric value)
--text-2xl:     2.25rem   (hero info card)
--text-display: 3.25rem   (hero headline)
```

Tabulkové číslice (`font-variant-numeric: tabular-nums`) už se používají u `.cs-metric-value` — rozšířit důsledně na všechna velká čísla (hero metriky, AI Studio stats).

## Spacing scale

Formalizovat existující ad hoc hodnoty do pojmenované škály (`--space-1: 0.35rem` … `--space-8: 3rem`), aby nové komponenty sahaly po tokenu, ne po další doslovné hodnotě.

## Radius

Základní škála (`--radius-button: 14px`, `--radius-card: 18px`, `--radius-dialog: 24px`, `--radius-hero: 28px`) je dobře navržená a odpovídá referenčnímu měkkému velkému radiusu — **zachovat beze změny**. Doplnit `--radius-pill` (`999px`, dnes `--radius-full`) jako rovnocenného občana škály, používaného důsledně pro nav/filtry/segmentované ovladače, ne jen pro theme-toggle.

## Shadows

`--shadow-sm/md/lg` zůstávají, jen se **odstraní ad hoc box-shadow literály** mimo tokeny (`0 2px 8px rgba(0,0,0,0.015)` v toolbaru, `0 10px 30px rgba(12,31,56,0.08)` v tag dropdownu) a namapují na existující škálu.

## Border systém

Jednotná 1px hairline (`--border`), `--border-strong` vyhrazen pro interaktivní/focus stavy, ne pro dekorativní zvýraznění. Zrušit vzorec „skládání dvou ohraničených čipů vedle sebe" na kartách (viz Cards výš).

## Ikony

`lucide-react` zůstává (konzistentní sada, správná knihovna). Zavést tři pevné velikosti místo dnešních šesti náhodných: **14px** (inline/meta), **16px** (výchozí UI), **20px** (zvýraznění).

## Komponentový styl — tři tvarové jazyky

1. **Pill** (`--radius-pill`) — navigace, filtry, segmentované přepínače, CTA tlačítka.
2. **Soft-round** (`--radius-card` / `--radius-dialog`) — karty, modaly, inputy.
3. **Circle** — avatary, ikonová tlačítka bez textu.

Tohle je přesně systém, který referenční obrázek používá důsledně a clearspace dnes jen částečně (pill žije osamoceně v theme-toggle).

## Motion guidelines

Existující `--dur-fast` (150ms) / `--dur-base` (220ms) + `--ease-out` jsou dobře specifikované a `prefers-reduced-motion` se respektuje — **zachovat**. Navrhuji jeden orchestrovaný „signature moment" místo plošných hoverů navíc: buď animované načtení hero metrik (count-up), nebo animované vykreslení nového vrstveného sloupcového grafu v AI Studio (viz níže). V duchu „utrať odvahu na jednom místě" — ne na deseti mikro-hoverech.

## Signature prvek (návrh)

Vrstvený segmentovaný sloupcový graf inspirovaný „TVL Growth" z reference — přirozeně sedí na dnes nedostavěný AI Studio graf „Denní aktivita" a stává se jediným výrazným, zapamatovatelným vizuálním prvkem aplikace, kolem kterého zůstává zbytek UI klidný.

---

# 5. Implementační roadmapa

Rozdělená tak, aby šla aplikace po každé etapě reálně otestovat (light/dark, desktop/mobil).

| Etapa | Obsah | Proč v tomto pořadí |
|---|---|---|
| **0. Základ tokenů** | Přepočítat barevné/typografické/spacing tokeny v `globals.css` + `design-system.css`. Žádná změna markupu komponent. | Nejnižší riziko, aplikace zůstane funkčně identická, jen „o odstín teplejší" — dobrý první test, že nic nespadlo. |
| **1. Navigace + Auth** | Pill nav v `Navbar.tsx`, redesign Login/Register hero panelu. | Malý blast radius (2–3 soubory), vysoká viditelnost, první reálný test nového jazyka. |
| **2. Úklid sdílených primitiv** | Sloučit `.toolbar-btn-*` do `.cs-btn`, `.card-tag` do `.cs-badge`, sjednotit dropdown menu a stíny. Bez zamýšlené vizuální změny navíc — jen konsolidace. | Snižuje riziko pro všechny další etapy — po ní se opravuje na jednom místě, ne na třech. |
| **3. Dashboard** | Nová hero fotka/vizuál, redesign karet projektů. | Nejviditelnější „arrival" plocha, teď staví na hotových primitivech z etapy 2. |
| **4. Kanban (Board + Cards)** | Sloupce, karty, footer patička, tap-friendly popis karty. | Nejfrekventovanější plocha — dělá se až po ustálení primitiv. |
| **5. Dialogy a dropdowny** | `TaskDetailDrawer`, modaly, `TagDropdown`. | Staví na sjednocených primitivech z etapy 2. |
| **6. Tabulky a Tým** | `.cs-table`, `MembersTable`. | Nejmenší mezera k cíli, rychlá etapa. |
| **7. AI Studio a AI History** | Grafy, empty states, signature vrstvený sloupcový graf. | Nejnáročnější na návrh grafů — až po ustálení zbytku jazyka. |
| **8. Závěrečný sweep** | Empty states a loading states napříč celou aplikací, dohledání zbylých inline stylů. | Poslední průchod zachytí, co uniklo předchozím etapám. |

Po každé etapě: implementace → vizuální test v prohlížeči (light + dark, desktop + mobil) → tvoje schválení → další etapa.

---

# 6. Použité Skills

- **`frontend-design`** (načteno na začátku této analýzy) — ovlivnilo návrh přímo:
  - Princip „ukotvi se v předmětu" vedl k nálezu, že identická stock fotka na 4+ obrazovkách je přesně ten generický vzorec, kterému se má distinktivní design vyhnout — proto návrh hero jako signature prvku jen pro „arrival" obrazovky.
  - Princip „utrať odvahu na jednom místě" vedl k volbě **jednoho** signature prvku (vrstvený graf v AI Studio) místo návrhu efektů na deseti místech najednou.
  - Kalibrační varování před generickými AI-defaulty (teplá krémová + serif, tmavá + jeden neonový akcent, novinová bezserifová mřížka) vedlo k tomu, že návrh **nešahá po žádném z nich automaticky** — drží se referenčního obrázku a existující, už zavedené emerald identity místo nejbližšího klišé.
  - Princip zdrženlivosti („odlož jednu ozdobu, než vyjdeš ze dveří") vedl k doporučení zredukovat „badge soup" na kartách, ne přidat další dekorativní vrstvu.

- Ostatní dostupné skills (`canvas-design`, `theme-factory`, `brand-guidelines`) nebyly relevantní — jde o statické umělecké artefakty, prezentační theming a Anthropic brand guidelines, ne o redesign existující produkční aplikace, takže nebyly použity.

---

## Otevřené otázky k tvému rozhodnutí před implementací

1. **Dark mode** — zachovat dnešní „oceánský" tón, nebo ho oteplit směrem k reference (sekce 4)?
2. **Hero vizuál** — abstraktní gradient, texturovaná fotografie, nebo ilustrovaný organický tvarový systém? Mám je připravit jako 2–3 konkrétní vizuální koncepty k výběru, až dáš zelenou?
3. Souhlasíš s pořadím etap v roadmapě, nebo chceš prioritizovat jinak (např. Board před Dashboardem)?

Čekám na tvoje schválení tohoto plánu. Implementace nezačne, dokud ji explicitně nepotvrdíš — a i pak jen po jednotlivých etapách.
