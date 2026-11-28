# RUN 11 – Global UX/UI Polish: discovery a inventura (read-only, 2026-11-28)

Zpracováno read-only v `V1` (`main`). Nic nebylo změněno, spuštěno ani nasazeno. Jediné nové soubory jsou tento a `RUN11_MASTER_PROMPT.md`.

Legenda: **[OVĚŘENO]** = viděno v repozitáři v této relaci · **[DOC]** = převzato z dokumentace/paměti, v této relaci znovu neověřeno · **[PŘEDPOKLAD]** = můj odhad.

## 1. Výchozí stav

| Položka | Stav |
|---|---|
| `main` | `e8f0625` = `origin/main`, 0 nepushnutých commitů **[OVĚŘENO]** |
| Pracovní strom | čistý kromě cizích `DEMO/` a `frontend/test_intro.mp4` (nesahat) **[OVĚŘENO]** |
| Tagy | `run10-closed` (poslední) **[OVĚŘENO]** |
| Produkce | `dpl_FwWirB1MSS4hA7Mig8Rp67t92pia`, kód `c468e2e`, rollback `dpl_GWQF6jGs…` **[DOC]** – proti Vercelu neověřeno |
| Unit testy | 1 500/1 500 **[DOC]** – nespuštěno |
| Worktree | 23 worktree; experimenty: archive-os, artform, atelier, editorial, editorial-japan, microcrm, mission-control, obsidian-gold, system-01, tactile – **nesloučené** **[OVĚŘENO]** |
| `V1-run10` | adresář bez `.git` (zbytek po RUN 10, obsahuje jen `frontend`) **[OVĚŘENO]** – úklid jen se souhlasem |

## 2. Inventura obrazovek a komponent [OVĚŘENO]

**Routy (14):** `/` (board/dashboard/kalendář), `/projects/[id]`, `/projects/[id]/meetings`, `/projects/[id]/meetings/[meetingId]`, `/team`,
`/settings`, `/ai-control-center`, `/ai-history`, `/about`, `/privacy`, `/login`, `/register`, `/accept-invite`, `/oauth/google`.
Většina workflow žije v modalech/drawerech (TaskDetailDrawer, ProjectTeamModal, ProjectIntegrationsModal, AddCardModal, …).

**Design system:** tokeny v `globals.css` (3 797 ř.), primitivy `.cs-*` v `design-system.css` (257 ř.), Monograph v `monograph.css` (372 ř.,
`data-style="monograph"`), React primitivy `components/ui/` = `Button`, `Badge`, `EmptyState`, `MetricCard`, `ModalShell`.
Zdroj pravidel: `ClearSpace_Design_Bible_v1.0.md`, `DESIGN_PLAN.md`, reviews `40–56`, `docs/monograph/`.

**Míra konzistence (systémové příčiny):**

| Metrika | Hodnota | Význam |
|---|---|---|
| Soubory s `<Button>` / `<ModalShell>` / `<EmptyState>` | 15 / 7 / 12 | primitivy existují, adopce je částečná |
| Holé `<button>` v TSX | 273 výskytů (`.cs-btn` 76) | hlavní zdroj nejednotných tlačítek |
| Inline `style={{…}}` | 1 324 | spacing/typo mimo tokeny |
| Hex barvy v TSX | 72 | obcházení tokenů → riziko v dark/Monograph |
| Nativní `confirm()` | 14 souborů | nekonzistentní, netestovatelné, nestylované potvrzení |
| Vlastní dialogy (`role="dialog"`/`aria-modal`) | 16 souborů vs. 7 přes `ModalShell` | rozdílné chování focusu/Esc |
| Toast / globální hlášení | žádná sdílená komponenta | zpětná vazba ukládání řešena ad hoc |
| `aria-live` | 5 výskytů | async stavy (ukládání, AI, přepis) se čtečce většinou neohlásí |
| Kopírování do schránky | 4 komponenty (PairingBox, ScheduleCard, team, ProjectTeamModal) | ne všechny příkazy/kódy |
| Breakpointy | hlavně 767 / 900 / 1023 px | okno 1024–1140 px nepokryto (viz navbar) |

## 3. Konsolidovaná inventura požadavků

Zdroje: `docs/run09/UX_BACKLOG.md` (#1–22, nadmnožina `docs/run08/UX_BACKLOG.md` #1–6), `docs/TECH_DEBT.md` (TD-1–3 + UX poznámky RUN 03–10),
`docs/run10/README.md` §Handoff, `docs/ROADMAP.md`, reviews `16`, `47–57`. Duplicity sloučeny (RUN 08 #1–6 = RUN 09 #1–6).

### ALREADY DONE (neimplementovat znovu, jen ověřit konzistenci)
| Položka | Kde |
|---|---|
| Kontrast AA tokenů `--accent`/`--danger`/`--text-muted` v obou motivech | review 56 |
| Hero sbalené na mobilu, iOS auto-zoom | review 56, 57 |
| Design Bible fáze 0–7, responzivita R1–R8 | reviews 40–55 |
| Gmail: vlastní chybové texty, náhled u smazaného e-mailu skryt | TECH_DEBT RUN 03C |
| Hub: „Ověřit znovu“, identita zahajovaná v ClearSpace, odolný inbox | RUN 07B |
| Porady: výběr + test mikrofonu, úrovně, zrušení, poctivé koncové stavy, plán vs. skutečnost, čitelné tlačítko Meet, kontrast | `2fd55c6` |
| Kopírování s „Zkopírováno“ v párovacím boxu a pozvánkách | PairingBox, ScheduleCard |
| #5 `/task` – funkční vada opravena v kódu (RUN 08B); **nápověda v UI neověřena** | run08 backlog |
| #17 „Analyzovat“ je bez přepisu `disabled` (ne skryté) – **částečně** | `MeetingDetail.tsx:233` |

### MUST-HAVE (porušují principy „žádné protichůdné stavy / žádný falešný úspěch / jasná zpětná vazba“ nebo jsou vidět při prezentaci)
| ID | Položka | Zdroj | Systémová příčina |
|---|---|---|---|
| M1 | Jednotné potvrzení destruktivních akcí místo `confirm()` (14 souborů) – jeden `ConfirmDialog` nad `ModalShell` | TECH_DEBT RUN 06/07 | chybí primitiv |
| M2 | Classic navbar přetéká při 1024 px (`navbar-right` ~1136 px) | TECH_DEBT RUN 04 | breakpoint 1024–1140 |
| M3 | #7 Slack po instalaci dál „Nainstalovat do Slacku“ (protichůdný stav) | UX #7 | stav integrace |
| M4 | #8 Propojení kanálu projde bez bota v kanálu (falešný úspěch) | UX #8 | stav integrace |
| M5 | #2 Výrazné potvrzení „Propojeno ✓“ po instalaci/propojení účtu/kanálu | UX #2 | stav integrace |
| M6 | #6 Zkušební zpráva ≠ doručená oznámení | UX #6 | texty stavů |
| M7 | #9 Nový cíl s vypnutým „Interaktivní“ → při potvrzení nabídnout zapnutí (fail-closed zachovat) | UX #9 | – |
| M8 | #12 One-click kopírování u všech párovacích příkazů/kódů/zpráv, jednotná komponenta | UX #12 | chybí primitiv `CopyButton` |
| M9 | #14 Před odpojením Telegram skupiny říct, že bot skupinu opustí | UX #14 | texty potvrzení (řeší M1) |
| M10 | #17 „Analyzovat“ u porady bez přepisu skrýt (ne jen disabled) | UX #17 | – |
| M11 | #22 „Proběhlé“ → podle skutečného stavu („Uplynulý termín“ vs. „Proběhlé s přepisem“) | UX #22 | stavové štítky |
| M12 | #21 Časomíra po zrušení přepisu: „z toho zrušeno“ | UX #21 | – |
| M13 | #10 Čeština „zadal v skupině“ → „ve skupině“ (`ProjectIntegrationsModal.tsx:139`) | UX #10 | – |
| M14 | Jednotná zpětná vazba ukládání/chyb (malý status/toast primitiv + `aria-live`), bez nové knihovny | audit, princip §8 | chybí primitiv |
| M15 | TD-3 `e2e/meetings.spec.ts:152` – **nejdřív ověřit**, že `card_created` + `card_assigned` jsou legitimní chování (migrace 1000, aktivita u ruční tvorby úkolu); teprve pak upravit očekávání | TECH_DEBT, vlastník | zastaralý test? |
| M16 | #1 Propojené účty – jedna stránka „co je připojené, k čemu, jak odpojit“ (Google, osobní oznámení, Slack/Telegram, identity) | UX #1, vlastník | IA – **návrh ke schválení (O1)** |

### SHOULD-HAVE
| ID | Položka | Zdroj |
|---|---|---|
| S1 | #19/#20 Radio/select/meter v poradách podle design systému (Classic) | UX #19, #20 |
| S2 | Adopce `Button`/`.cs-btn` a tokenů tam, kde je vidět nekonzistence (ne plošný refactor 273 tlačítek) | metriky §2 |
| S3 | Hex barvy v TSX → tokeny (72) – kvůli dark/Monograph | metriky §2 |
| S4 | Dialogy bez `ModalShell` (9 souborů): focus trap, Esc, návrat focusu | metriky §2 |
| S5 | #3 Telegram deep link jako hlavní cesta, příkaz záložně (viditelný) | UX #3 |
| S6 | #13 AI chat preferuje názvy místo interních ID (prompt; ověřit fake-gemini, ne placeně) | UX #13 |
| S7 | Gmail výběr: „Hledat“ vs. „Předmět“ v úzkém rozložení, pozice tlačítka | TECH_DEBT RUN 06 |
| S8 | Kalendář: vlastní připojená událost 2× (vrstva + projekt); „+N další“ bez rozbalení | TECH_DEBT RUN 04 |
| S9 | Srozumitelná hláška při vyčerpání AI/STT denního limitu (429/budget_exceeded) – bez nového měření | TECH_DEBT RUN 09/10 |
| S10 | #5 nápověda `/task` v UI (ověřit, doplnit) | UX #5 |
| S11 | TD-1, TD-2 – oprava zastaralých E2E (jen testy) + `GEMINI_MODEL=fake-gemini` do skriptu stacku | TECH_DEBT |
| S12 | Empty/loading/error stavy všech modulů podle jednoho vzoru (`EmptyState`) | audit |

### SHOULD-HAVE s podmínkou (schváleno vlastníkem 2026-11-28)
| ID | Položka | Podmínka |
|---|---|---|
| S13 | #15 přehled porad „dnes / tento týden“ | jen seskupení/filtr existujících dat; připomínka „spustit přepis“ jen jako stav v UI (žádné nové notifikace). Jinak zpět do LATER s důvodem |
| S14 | #16 režim přepisu na celou obrazovku (+ barvy mluvčích) | jen prezentační změna existující komponenty, žádná nová audio architektura. Jinak zpět do LATER s důvodem |

### LATER (nové funkce → mimo feature freeze)
#18 přímé odeslání pozvánky do Slack/Telegram (potvrzeno vlastníkem) ·
výběr minulých událostí Kalendáře · Picker v panelu < 500 px (Google) · stav `idle` po zrušení přepisu (migrace) · ukládání zdroje zvuku · Soniox reconnect ·
přehled spotřeby AI · nastavitelná hodina připomínky · dedup e-mailů/událostí.

### REQUIRES OWNER DECISION
| ID | Rozhodnutí | Doporučení |
|---|---|---|
| O1 | Rozsah redesignu Propojených účtů (M16) – mění informační architekturu Nastavení | ANO, ale v rámci `/settings` (žádná nová routa); Claude předloží wireframe/screenshot před implementací |
| O2 | #11 výchozí „Jen vybrané projekty“ u osobních oznámení | ANO pro nové nastavení, stávající volby neměnit |
| O3 | #4 Bot bez admin práv – BotFather `/setdefaultgroupadministratorrights` je akce vlastníka; kód změní jen `startgroup` odkaz | kód ANO, BotFather vlastník |
| O4 | Hloubka sjednocení primitiv (S2–S4): jen viditelné obrazovky, nebo plošně | jen obrazovky z demo scénářů + vše, co rozbíjí dark/Monograph |
| O5 | Mobilní podpora: které moduly jsou na 375 px „podporované“ (živý přepis = desktop Chrome/Edge) | board, projekt, detail úkolu, porady read-only, nastavení; živý přepis jen desktop s jasným sdělením |
| O6 | LATER položky #15/#16/#18 potvrdit jako mimo RUN 11 | potvrdit |
| O7 | Produkční nasazení RUN 11: předem schválit „deploy po zelených branách“, nebo samostatný stop | předem schválit (staged, rollback na `dpl_FwWirB1M…`) |
| O8 | Placené živé testy v RUN 11 | žádné; MOCK + fake-gemini; první živé použití při příští prezentaci |
| O9 | Úklid `V1-run10` (adresář bez .git) a starých feature worktree | jen seznam ke schválení, nic nemazat |
| O10 | Experimentální vzhledy (Obsidian Gold, System-01, Tactile, Archive OS, Artform, …) | mimo RUN 11, nesloučené |

## 4. Rozhodnutí vlastníka (2026-11-28)
| ID | Rozhodnutí |
|---|---|
| O1 | **Schváleno**: redesign Propojených účtů uvnitř `/settings`; návrh obrazovky je součástí jediného konsolidovaného checkpointu |
| O2 | předloží se v checkpointu |
| O3 | kód (`startgroup` bez admin) ano; BotFather = akce vlastníka |
| O4 | **Systémově přes existující komponenty a tokeny**: potvrzovací dialogy, kopírování, stavová hlášení, chybové stavy, loading/empty, tlačítka a varianty, a11y/focus. **Žádná mechanická náhrada** inline stylů/tlačítek kvůli statistikám; každá změna s prokazatelným přínosem. Nový design system nevytvářet |
| O5 | **Mobil musí být použitelný** pro: procházení projektů, běžnou správu úkolů, komentáře, přehled porad, dokumenty, notifikace, AI výstupy (dle dostupnosti účtu). Žádná samostatná mobilní aplikace. Živý přepis jen ověřené desktopové prohlížeče; na ostatních jasné vysvětlení omezení |
| O6 | #15, #16 → S13/S14 (podmíněně); #18 LATER |
| O7 | **Schváleno**: řízené produkční nasazení po splnění všech akceptačních kritérií, kompletní regrese a staged kontrolách – bez dalšího stopu |
| O8 | **Neschváleno**: žádné nové placené Soniox/Gemini testy |
| O9 | `V1-run10` smazat jen po ověření: není aktivní worktree, žádná unikátní nezálohovaná práce, žádné soubory vlastníka, žádné běžící procesy, výsledky zachované. `DEMO/` a `test_intro.mp4` nedotčené |
| O10 | experimentální větve nesloučit |
| – | Jediný schvalovací checkpoint pro zásadní designová/produktová rozhodnutí; rutinní rozhodnutí autonomně. RUN 12 nezahajovat (samostatný run, model Fable, důraz RUN 08–10) |

## 5. Co tato discovery NEověřila
Produkční stav proti Vercelu, běh unit/E2E testů, průchod aplikací v prohlížeči, screenshoty, kontrast reálně vykreslených stránek,
dark mode/Monograph vizuálně. Vše patří do fáze A MASTER promptu – samostatný discovery run už není potřeba.
