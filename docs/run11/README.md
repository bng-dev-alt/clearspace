# RUN 11 – Global UX/UI Polish: závěrečný report (2026-11-28)

**Verdikt: GO.** Produkce běží s RUN 11 (`dpl_8Ye3m66H66vSnLPaAE6KKyMtYmWS`, kód `25225f7`, tag `run11-deployed`); všechny akceptační,
regresní a staged gate prošly; 0 placených volání. Rollback: `vercel promote dpl_FwWirB1MSS4hA7Mig8Rp67t92pia --scope bng-dev-alt-webadvisor --yes`
(RUN 10; RUN 11 nemá migrace, rollback je čistě kódový).

Dokumenty: [`RUN11_INVENTORY.md`](RUN11_INVENTORY.md) (inventura + rozhodnutí vlastníka) · [`RUN11_MASTER_PROMPT.md`](RUN11_MASTER_PROMPT.md) ·
[`AUDIT.md`](AUDIT.md) (nálezy F-/H-, systémové příčiny SC-1–7) · [`DECISIONS.md`](DECISIONS.md) (checkpoint D1–D10 + schválení) ·
[`ACCEPTANCE.md`](ACCEPTANCE.md) · [`BEFORE_AFTER.md`](BEFORE_AFTER.md).

## 1. Git a nasazení
| | |
|---|---|
| Větev | `polish/run11` (worktree `V1-run11`) → fast-forward do `main`, push `origin/main` |
| Nasazený kód | `25225f7` (tag `run11-deployed`), release worktree `V1-release-run11` / `release/run11` (čistý strom) |
| Staged | `dpl_8Ye3m66H66vSnLPaAE6KKyMtYmWS`: preflight PASS (Git, názvy proměnných, produkční DB 1200–1400, pilot), `check` **143/143** |
| Produkce | promote → `clearspace.luffast.com` = `dpl_8Ye3m66H…`; `check-deployment.sh` na doméně **142/142**, anonymní `/api/intelligence/access` 401, `lang="cs"`; Propojené účty v produkci ověřeny jen čtením stránky |
| Migrace | žádné |
| Náklady | Soniox 0 min, Gemini 0 požadavků (vše lokálně s mocky / fake Gemini) |

## 2. Co se změnilo (podle systémových příčin)
* **SC-1 Pravdivé stavy:** pryč je přepínač AI modelu (nic nedělal), rozpočet 300 CZK a natvrdo model v AI Studiu (localStorage), „Fullscreen
  (připravuje se)“ ×2, neaktivní „Nastavení (připravujeme)“, šablonové hero s nepravdivým „THIS WEEK“, „Vymazat logy“ nad serverovým záznamem,
  odznak „AI ENGINE“. AI Studio ukazuje model a limity **volajícího** podle vynucované politiky (`lib/ai/status.ts` přes `/api/intelligence/access`);
  co nejde zjistit, říká „nelze zjistit“. Ikona „smazat“ u karty archivuje – teď to tak i říká. PI při vypnutém serveru není zaškrtnutá.
* **SC-2 Hlavička:** Classic pod 1280 px přesouvá vzhled/motiv do menu avataru → 0 přetečení (dřív 1024/768 na 17 stránkách).
* **SC-3 Porady v Classic:** styl design systému, drobečková navigace s projektem, #15 skupiny (Dnes/Týden/Později/Uplynulý termín/Proběhlé + „spusťte
  přepis“), #16 funkční celá obrazovka s barevnými značkami mluvčích, #17, #19–#22, poznámka o podporovaných zařízeních.
* **SC-4/5 Sdílené primitivy:** `useConfirm` (19× `confirm` a 11× `alert` → jeden vzor, volba „smazat i záznamy“ uvnitř dialogu), `CopyButton`
  (přiznává selhání schránky), `StatusMessage`, `useDialogFocus` / `DialogFocus` v `ModalShell` a všech 15 vlastních dialozích (focus dovnitř, Tab past, návrat).
* **SC-6 Jazyk:** `lang="cs"`, česky UI kromě názvů produktu (Board, Project Intelligence, AI Studio, Cortex, Classic, Monograph), české skloňování
  a čísla, Telegram bot odkazuje na nové názvy sekcí.
* **SC-7 Přístupnost:** popsaná pole, AA kontrast (tokeny `--*-text`, `--text-on-accent`, `readableOn()` pro avatary), klávesnicí dostupné
  posuvné tabulky. Výsledek: axe 0 nálezů v 336 případech (4 vzhledy × 4 šířky × 21 obrazovek).
* **Propojené účty (D1):** přehled + Google · Osobní oznámení · Slack a Telegram pro projekty, vysvětlení režimů, stav instalace Slacku (#7),
  „Propojeno ✓“ s dalšími kroky (#2, #8, #9), `/task` s kopírováním (#5, #12), D6 jen pro nová nastavení.
* **Mobil:** metriky v jednom řádku, „Nový úkol“ nahoře (44 px), kompaktní název projektu nad boardem.

Změněné sdílené komponenty a tokeny: `components/ui/{ModalShell, useConfirm, useDialogFocus, CopyButton, StatusMessage, index}`,
`components/settings/*` (nové), `components/meetings/{LiveTranscriptView, MeetingBreadcrumb}` (nové), `HeroSection`, `BoardPanel`, `Navbar`,
`lib/{plural, color, ai/status, meetings/groups}` (nové); tokeny `--warning-text`, `--success-text`, `--accent-text` (světlý motiv),
`.cs-btn--danger-outline`, `.cs-status*`, `.settings-*`, Classic pravidla `.mi-page`.

## 3. Testy (podrobně `ACCEPTANCE.md`)
Unit **1 517 / 1 517** (výchozí 1 500) · lint 0 chyb · build PASS · bundle guard 153 OK · stack-guard 2/2 · E2E: stack porad **49 PASS** (výchozí 45;
jen 2 předem existující pády TD-2 a r6-quality:102), živý přepis 3/3, demo 27+19, hub+oznámení 2/2 · matice 336/336 bez přetečení a chyb konzole,
axe 0 · praktická kontrola klávesnicí v prohlížeči.

## 4. Backlog, odloženo, dluh
* UX backlog #1–22: stav každé položky v `docs/run09/UX_BACKLOG.md` §„Stav po RUN 11“ (19 hotovo, #8 částečně, #13 a #18 LATER).
* Tech dluh: `docs/TECH_DEBT.md` §RUN 11 – TD-3 vyřešen; zbývá TD-1, TD-2, `r6-quality:102` (předem existující), #8 serverové ověření bota,
  #13 prompt, revize rozšíření `access` v RUN 12, lokální stack a opakované `up`.
* Školení: `docs/training/COMMUNICATION_HUB.md` §8, `MEETING_INTELLIGENCE.md` §10, `README.md` (podklady pro moduly 1, 2, 4).

## 5. Úklid a otevřené položky pro vlastníka
Zastaveno vše, co RUN 11 spustil (aplikace, mocky, loopback proxy, stacky přes `sb stop` bez `--no-backup`). Data stacků zůstala.
**Ke schválení jedním seznamem (nic nesmazáno):** zastavený stack `cs-run10-sb` (data RUN 10), zastavený stack `cs-run11-sb` (testovací data RUN 11),
plné sady snímků v `_G2_BACKUP/2026-11-28-run11/screens` (65 MB, se SHA256SUMS), staré feature worktree RUN 01–07.
Mimo RUN 11 (nezahájeno): RUN 12 Final Security & Architecture Audit (model Fable, důraz RUN 08–10), RUN 13, portfolio, Product Training Hub.
