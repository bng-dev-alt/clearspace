import { Card, Column, TeamMember } from '../../types/kanban';
import { UNTRUSTED_DATA_RULES } from '../../lib/intelligence/frame';
import { AiMessage, AiContext } from './types';

// Helper pro formátování kontextu jednotlivé karty
export function formatCardContext(card?: Card): string {
  if (!card) return 'Žádný vybraný úkol.';

  let result = `ÚKOL DETAIL:\n`;
  result += `ID: ${card.id}\n`;
  result += `Název: ${card.title}\n`;
  result += `Popis: ${card.details || 'Bez popisu.'}\n`;
  result += `Priorita: ${card.priority || 'Žádná'}\n`;
  result += `Řešitel: ${card.assignee?.name || 'Nepřiřazeno'}\n`;
  result += `Termín splnění: ${card.dueDate || 'Bez termínu'}\n`;
  result += `Archivován: ${card.archived ? 'Ano' : 'Ne'}\n`;

  if (card.tag) {
    result += `Štítek: ${card.tag}\n`;
  }

  if (card.checklist && card.checklist.length > 0) {
    result += `Položky checklistu:\n`;
    card.checklist.forEach((item) => {
      result += `  - [${item.completed ? 'x' : ' '}] ${item.text}\n`;
    });
  }

  if (card.comments && card.comments.length > 0) {
    result += `Komentáře:\n`;
    card.comments.forEach((c) => {
      result += `  - Autor: ${c.authorName} (${c.createdAt}): ${c.content}\n`;
    });
  }

  if (card.activities && card.activities.length > 0) {
    result += `Historie aktivity úkolu:\n`;
    card.activities.forEach((a) => {
      result += `  - [${a.createdAt}] ${a.text}\n`;
    });
  }

  return result;
}

// Helper pro formátování kontextu projektu a celého boardu
export function formatProjectContext(context?: AiContext): string {
  if (!context) return '';
  let result = `KONTEXT PROJEKTU:\n`;
  if (context.project) {
    result += `Název projektu: ${context.project.name}\n`;
  }

  if (context.columns && context.columns.length > 0) {
    result += `Rozložení sloupců a karet na boardu:\n`;
    context.columns.forEach((col) => {
      result += `Sloupec "${col.name}":\n`;
      if (col.cards && col.cards.length > 0) {
        col.cards.forEach((c) => {
          if (!c.archived) {
            result += `  - Úkol: "${c.title}" [Priorita: ${c.priority || 'Žádná'}, Řešitel: ${c.assignee?.name || 'Nepřiřazeno'}]\n`;
          }
        });
      }
    });
  }

  if (context.metadata) {
    result += `Doplňující metadata:\n`;
    Object.entries(context.metadata).forEach(([k, v]) => {
      result += `  - ${k}: ${JSON.stringify(v)}\n`;
    });
  }

  return result;
}

export const promptBuilder = {
  buildChatPrompt(messages: AiMessage[], context?: AiContext): AiMessage[] {
    // Nová cesta (Project Context Engine): systémová zpráva obsahuje JEN instrukce a bezpečnostní pravidla.
    // Data projektu (nedůvěryhodný obsah) jdou rámovaná do poslední uživatelské zprávy.
    if (context?.renderedContext) {
      const system = `Jste inteligentní AI Asistent pro projektový Kanban board aplikace clearspace.
Vaším úkolem je pomáhat uživateli s řízením úkolů, plánováním a odpovídáním na dotazy o projektu.
Komunikujte věcně, profesionálně a česky. Nepoužívejte emoji.
Při odpovědi vycházejte z dat projektu v poslední zprávě uživatele. Tvrzení o konkrétních úkolech, komentářích, aktivitě nebo závěrech z porad podepřete odkazem přesně ve tvaru [ref] převzatým z dat (např. [card:ID], [item:ID]). Odkazujte jen na ref, který v datech opravdu je; nic si nevymýšlejte. Pokud data odpověď neobsahují, řekněte to.

${UNTRUSTED_DATA_RULES}`;
      const rest = [...messages];
      const last = rest.length - 1;
      if (last >= 0 && rest[last].role === 'user') {
        rest[last] = {
          ...rest[last],
          content: `Data projektu:\n${context.renderedContext}\n\nDotaz uživatele:\n${rest[last].content}`,
        };
      }
      return [{ role: 'system', content: system }, ...rest];
    }

    const systemContent = `Jste inteligentní AI Asistent pro projektový Kanban board aplikace clearspace.
Vaším úkolem je pomáhat uživateli s řízením úkolů, plánováním a odpovídáním na dotazy.
Komunikujte věcně, profesionálně a česky. Nepoužívejte emoji.

${formatProjectContext(context)}
${context?.card ? formatCardContext(context.card) : ''}`;

    return [
      { role: 'system', content: systemContent },
      ...messages,
    ];
  },

  buildTaskGeneratePrompt(topic: string, context?: AiContext): AiMessage[] {
    const systemContent = `Jste AI expert na tvorbu úkolů. Vygenerujte nový úkol ve formátu JSON na zadané téma.
Odpověď musí být validní JSON s klíči: "title" (krátký název), "details" (detailní popis) a "checklist" (pole doporučených položek checklistu typu string[]).
Nepište žádný doprovodný text, pouze čistý JSON.
${formatProjectContext(context)}`;

    return [
      { role: 'system', content: systemContent },
      { role: 'user', content: `Vytvoř úkol na téma: ${topic}` },
    ];
  },

  buildTaskImprovePrompt(card: Card, context?: AiContext): AiMessage[] {
    const systemContent = `Jste AI asistent specializovaný na optimalizaci a vylepšování zadání úkolů.
Vaším úkolem je navrhnout zlepšení pro zadaný úkol na základě celkového kontextu projektu.
Dodržujte následující pravidla:
- Pište výhradně česky.
- Buďte struční a věcní.
- Nevymýšlejte si nová fakta, která nesouvisí se zadáním.
- Zachovejte původní význam a záměr úkolu.
- Navrhněte pouze zlepšení stávajícího úkolu.

Odpověď musíte vrátit jako validní JSON s následující strukturou:
{
  "details": "Vylepšený, srozumitelnější popis úkolu v češtině.",
  "acceptanceCriteria": "Stručná akceptační kritéria úkolu (bodově, např. 1. ... 2. ...)",
  "risks": "Možná rizika nebo technické překážky.",
  "missingInfo": "Chybějící nebo nejasné informace, které je vhodné ujasnit.",
  "checklist": ["položka checklistu 1", "položka checklistu 2"]
}

Neuvádějte žádný doprovodný text, pouze čistý validní JSON objekt.`;

    return [
      { role: 'system', content: systemContent },
      { role: 'user', content: `${formatProjectContext(context)}\n${formatCardContext(card)}\nNavrhni vylepšení tohoto úkolu.` },
    ];
  },

  buildTaskSplitPrompt(card: Card, context?: AiContext): AiMessage[] {
    const systemContent = `Analyzujte zadaný velký úkol a rozdělte jej na menší, samostatně realizovatelné podúkoly (subtasky).
Odpovězte ve formátu JSON jako pole objektů. Každý objekt v poli musí obsahovat: "title" a "details".
Odpovězte pouze čistým JSON polem bez jakéhokoliv dalšího textu.`;

    return [
      { role: 'system', content: systemContent },
      { role: 'user', content: `${formatProjectContext(context)}\n${formatCardContext(card)}\nRozděl tento úkol na subtasky.` },
    ];
  },

  buildSprintPlanningPrompt(cards: Card[], context?: AiContext): AiMessage[] {
    const systemContent = `Jsi zkušený Scrum Master a Product Owner.
Tvým úkolem je analyzovat backlog úkolů a navrhnout optimální plán sprintu. Musíš komunikovat výhradně ČESKY.

Pravidla pro výběr úkolů:
1. Vyber logickou skupinu úkolů, které společně tvoří ucelený a smysluplný cíl sprintu (sprintGoal, max 2 věty).
2. Respektuj priority (vysoká priorita má přednost před nízkou).
3. Odhadni Story Points (storyPoints) pro každý vybraný úkol podle Fibonacciho posloupnosti (1, 2, 3, 5, 8, 13) na základě popisu a složitosti.
4. Odhadni čas (estimatedTime) pro každý vybraný úkol (např. 4h, 1d, 3d).
5. Celkový součet Story Points by měl odpovídat doporučené kapacitě týmu (sprintCapacity, např. cca 20-30 Story Points pro standardní dvoutýdenní sprint).
6. Uveď konkrétní závislosti (dependencies) mezi vybranými úkoly a identifikuj hlavní technická či procesní rizika (risks).
7. Úkoly z backlogu, které se do tohoto sprintu nevešly nebo se nehodí k cíli sprintu, uveď v poli outOfScope se stručným a jasným zdůvodněním proč (reason).

DŮLEŽITÉ: Piš stručné, věcné a profesionální popisy. Udržuj velikost odpovědi kompaktní. Odpověz výhradně ve validním formátu JSON podle poskytnutého schématu.`;

    const cardsText = cards
      .filter(c => !c.archived)
      .map(c => `ID: ${c.id}\nNázev: ${c.title}\nPopis: ${c.details || ''}\nPriorita: ${c.priority || 'Medium'}`)
      .join('\n---\n');

    return [
      { role: 'system', content: systemContent },
      { role: 'user', content: `${formatProjectContext(context)}\nSeznam úkolů v backlogu k analýze:\n${cardsText}\nNavrhni příští sprint.` },
    ];
  },

  buildSearchPrompt(query: string, cards: Card[]): AiMessage[] {
    const systemContent = `Jste sémantický vyhledávací engine.
Porovnejte vyhledávací dotaz se seznamem úkolů a vraťte JSON pole obsahující seřazená ID úkolů podle relevance k dotazu, doprovázené stručným odůvodněním ("reason").
Formát: JSON pole objektů s klíči "id" a "reason". Neodpovídejte ničím jiným než JSON.`;

    const cardsText = cards.map(c => `ID: ${c.id}, Název: ${c.title}, Popis: ${c.details || ''}`).join('\n');

    return [
      { role: 'system', content: systemContent },
      { role: 'user', content: `Dotaz: "${query}"\nSeznam úkolů k vyhledání:\n${cardsText}` },
    ];
  },

  buildSummaryPrompt(card: Card): AiMessage[] {
    const systemContent = `Vytvořte stručné a přehledné shrnutí (summary) úkolu, jeho historie aktivity a komentářů.
Shrnutí napište česky, stručně v bodech a zaměřte se na aktuální stav, vyřešené věci a zbývající blokátory.`;

    return [
      { role: 'system', content: systemContent },
      { role: 'user', content: formatCardContext(card) },
    ];
  },

  buildBacklogGeneratePrompt(
    projectName: string,
    projectDescription: string,
    columns: Column[],
    existingTasks: Card[],
    options?: { taskCount?: number; detailLevel?: string; technologies?: string }
  ): AiMessage[] {
    const systemContent = `Jste zkušený Product Manager a agilní kouč.
Vaším úkolem je vytvořit logicky uspořádaný backlog projektu na základě názvu projektu, jeho popisu a stávajícího stavu boardu.
Pravidla pro výstup:
- Komunikujte výhradně česky.
- Buďte realistický a praktický.
- Nevymýšlejte si nepodložená fakta, držte se záměru popsaného uživatelem.
- Navrhněte logické pořadí implementace (první úkoly by měly mít vyšší prioritu a patřit do úvodních fází).

Odpověď musíte vrátit jako validní JSON s následující strukturou:
{
  "projectSummary": "Stručný souhrn projektu a doporučený postup implementace (česky, max 3 věty).",
  "tasks": [
    {
      "title": "Stručný a jasný název úkolu (např. Vytvoření databázového schématu)",
      "description": "Podrobný popis úkolu včetně cílů.",
      "priority": "High" | "Medium" | "Low",
      "estimate": "Předpokládaná pracnost (např. 2h, 4h, 8h, 1d, 3d)",
      "acceptanceCriteria": [
        "Akceptační kritérium 1",
        "Akceptační kritérium 2"
      ],
      "checklist": [
        "Doporučená položka checklistu 1",
        "Doporučená položka checklistu 2"
      ],
      "recommendedColumn": "Doporučený cílový sloupec (např. Todo nebo Nápady)"
    }
  ]
}

Neuvádějte žádný doprovodný text, pouze čistý validní JSON objekt.`;

    let userContent = `Název projektu: ${projectName}
Popis projektu: ${projectDescription}

STÁVAJÍCÍ STAV BOARDU:
Rozložení sloupců a úkolů na boardu:
`;

    columns.forEach((col) => {
      userContent += `Sloupec "${col.name}":\n`;
      if (col.cards && col.cards.length > 0) {
        col.cards.forEach((t) => {
          if (!t.archived) {
            userContent += `  - Úkol: "${t.title}" [Priorita: ${t.priority || 'Žádná'}]\n`;
          }
        });
      } else {
        userContent += `  - (Žádné úkoly)\n`;
      }
    });

    userContent += `\nPOŽADAVKY NA GENEROVÁNÍ:\n`;

    if (options?.taskCount) {
      userContent += `- Počet úkolů k vygenerování: ${options.taskCount}\n`;
    }
    if (options?.detailLevel) {
      userContent += `- Úroveň detailu: ${options.detailLevel}\n`;
    }
    if (options?.technologies) {
      userContent += `- Použité technologie: ${options.technologies}\n`;
    }

    userContent += `\nVygeneruj logický backlog projektu ve formátu JSON.`;

    return [
      { role: 'system', content: systemContent },
      { role: 'user', content: userContent },
    ];
  },

  buildProjectGeneratePrompt(
    projectName?: string,
    projectDescription?: string,
    projectType?: string,
    technologies?: string,
    detailLevel?: string,
    taskCount?: number
  ): AiMessage[] {
    const systemContent = `Jsi zkušený Senior Product Manager, Senior Software Architect a AI Product Engineer.
Tvým úkolem je navrhnout kompletní strukturu projektu, jeho sloupců a backlogu úkolů na základě zadané myšlenky projektu. Musíš komunikovat výhradně ČESKY.
Tvoje návrhy musí být realistické, profesionální, srozumitelné a nesmíš si vymýšlet neexistující informace. Navrhuj produkční řešení.

DŮLEŽITÉ: Popisy úkolů (description), akceptační kritéria (acceptanceCriteria) a checklisty (checklist) piš extrémně stručně (max. 1-2 krátké věty na úkol). U checklistu a akceptačních kritérií generuj maximálně 2-3 položky. Tím se udrží délka JSON odpovědi v mezích limitu tokenů a zabrání se jejímu uříznutí.

Musíš vrátit POUZE validní JSON objekt odpovídající této TypeScript struktuře:
{
  "name": "Upravený/Vylepšený název projektu (pokud uživatel nezadal nebo zadal stručně)",
  "description": "Stručný a jasný popis cíle projektu (1-2 věty)",
  "summary": "Strukturovaný souhrn projektu a architektonických rozhodnutí (v češtině, může obsahovat odstavce, max 300 slov)",
  "icon": "Jedno emoji reprezentující projekt (např. 🚀, 💻, 🧠, 🔐)",
  "accentColor": "HEX kód barvy odpovídající projektu (např. #209dd7, #753991, #ecad0a)",
  "recommendedColumns": ["Seznam 3 až 5 doporučených sloupců pro board projektu"],
  "recommendedStack": ["Seznam doporučených technologií a knihoven"],
  "complexity": "Low" | "Medium" | "High",
  "estimatedDuration": "Odhadovaná doba realizace (např. 4 týdny)",
  "recommendedTeamSize": "Doporučený počet lidí (např. 3)",
  "tags": ["Seznam štítků, např. SaaS, React, AI, Auth, atd."],
  "aiRecommendation": {
    "recommendation": "Hlavní doporučení od AI pro tento projekt",
    "biggestRisk": "Největší technické nebo procesní riziko",
    "focusArea": "Na co se při vývoji nejvíce zaměřit",
    "mvpScope": "Co konkrétně tvoří rozsah MVP"
  },
  "tasks": [
    {
      "title": "Název úkolu",
      "description": "Podrobný a jasný popis úkolu v češtině, včetně odhadovaného času a kritérií akceptace v textu (formát Markdown)",
      "priority": "High" | "Medium" | "Low" | "",
      "estimate": "Odhadovaný čas (např. 4h, 8h, 2d)",
      "acceptanceCriteria": ["Seznam akceptačních kritérií"],
      "checklist": ["Seznam úkolů/checklist položek"],
      "recommendedColumn": "Doporučený cílový sloupec z pole recommendedColumns (přesná shoda)"
    }
  ]
}

Neuvádějte žádný doprovodný text, pouze čistý validní JSON objekt.`;

    let userContent = `MYŠLENKA PROJEKTU:
`;
    if (projectName) {
      userContent += `Název projektu (pokud existuje): ${projectName}\n`;
    }
    if (projectDescription) {
      userContent += `Popis nápadu: ${projectDescription}\n`;
    }
    if (projectType) {
      userContent += `Typ projektu: ${projectType}\n`;
    }
    if (technologies) {
      userContent += `Preferovaný stack: ${technologies}\n`;
    }
    if (detailLevel) {
      userContent += `Úroveň detailu úkolů: ${detailLevel}\n`;
    }
    if (taskCount) {
      userContent += `Počet úkolů k vygenerování: ${taskCount}\n`;
    }

    userContent += `\nNavrhni kompletní projekt, jeho sloupce a backlog ve formátu JSON podle specifikace.`;

    return [
      { role: 'system', content: systemContent },
      { role: 'user', content: userContent },
    ];
  },

  buildRiskAnalysisPrompt(projectName: string, columns: Column[], context?: AiContext): AiMessage[] {
    const systemContent = `Jsi zkušený Tech Lead, Software Architect a Product Manager s dlouholetou praxí v řízení rizik u softwarových projektů.
Tvým úkolem je kriticky zanalyzovat celý projekt (jeho workflow, backlog úkolů, priority, popisy, řešitele a termíny) a upozornit uživatele na slabá místa, chybějící části, bottlenecks, technický dluh, bezpečnostní a výkonnostní rizika a doporučení pro MVP.

Při analýze se zaměř na:
1. Zda jsou správně nastavené priority a termíny (např. zda úkoly s vysokou prioritou nemají termín až po těch s nízkou prioritou).
2. Zda v backlogu nechybí klíčové části (např. chybějící autentizace u SaaS, chybějící CI/CD, chybějící testy, chybějící databázová migrace atd.).
3. Úzká hrdla (bottlenecks) - zda není příliš mnoho úkolů v jednom sloupci, zda jeden vývojář není přetížen, nebo zda úkoly příliš dlouho nečekají.
4. Technický dluh - zda projekt nepoužívá zastaralé přístupy, zda se nepomíjí refaktoring či dokumentace.
5. Bezpečnost a výkon - chybějící HTTPS, špatné ukládání hesel, chybějící indexy v databázi, špatná optimalizace dotazů atd.
6. Doporučení pro MVP - co je nezbytné pro start a co je naopak možné odložit do dalších fází.

Komunikuj výhradně ČESKY, věcně, kriticky, konstruktivně a profesionálně. Nepoužívej emoji.

Odpověď musíš vrátit jako validní JSON objekt podle zadaného schématu. Neuváděj žádný doprovodný text okolo JSONu.`;

    let userContent = `NÁZEV PROJEKTU: ${projectName}

ROZLOŽENÍ SLOUPCŮ A KARET NA BOARDU:
`;

    columns.forEach((col) => {
      userContent += `Sloupec "${col.name}":\n`;
      if (col.cards && col.cards.length > 0) {
        col.cards.forEach((c) => {
          if (!c.archived) {
            userContent += `  - Úkol ID: ${c.id}\n`;
            userContent += `    Název: "${c.title}"\n`;
            userContent += `    Popis: "${c.details || 'Bez popisu.'}"\n`;
            userContent += `    Priorita: ${c.priority || 'Žádná'}\n`;
            userContent += `    Řešitel: ${c.assignee?.name || 'Nepřiřazeno'}\n`;
            userContent += `    Termín splnění: ${c.dueDate || 'Bez termínu'}\n`;
            if (c.checklist && c.checklist.length > 0) {
              userContent += `    Checklist: ${c.checklist.map(item => `[${item.completed ? 'x' : ' '}] ${item.text}`).join(', ')}\n`;
            }
            if (c.comments && c.comments.length > 0) {
              userContent += `    Komentáře: ${c.comments.map(comm => `[${comm.authorName}]: ${comm.content}`).join(' | ')}\n`;
            }
          }
        });
      } else {
        userContent += `  - (Žádné aktivní úkoly)\n`;
      }
    });

    if (context?.metadata) {
      userContent += `\nDoplňující metadata projektu:\n`;
      Object.entries(context.metadata).forEach(([k, v]) => {
        userContent += `  - ${k}: ${JSON.stringify(v)}\n`;
      });
    }

    userContent += `\nProveď kritickou analýzu rizik projektu a vrať strukturovaný JSON.`;

    return [
      { role: 'system', content: systemContent },
      { role: 'user', content: userContent }
    ];
  },

  buildProjectManagerPrompt(columns: Column[], context?: AiContext): AiMessage[] {
    const systemContent = `Jste zkušený AI Project Manager pro aplikaci ClearSpace Kanban.
Vaším úkolem je analyzovat stav celého projektu (sloupce, úkoly, prioritizace, blokátory, rozpracovanost WIP) a navrhnout konkrétní, bezpečná doporučení na úpravu nástěnky (Suggested Board Changes).

PRAVIDLA PRO NÁVRHY ZMĚN (Suggested Changes):
1. Nikdy automaticky neměňte projekt, pouze vytvářejte návrhy (MOVE_TASK, CHANGE_PRIORITY, SPLIT_TASK, MERGE_TASKS, ARCHIVE_TASK).
2. Pro každý návrh specifikujte jasné zdůvodnění (reason).
3. Pokud navrhujete MOVE_TASK, uveďte přesně targetColumnId a targetColumnName.
4. Pokud navrhujete SPLIT_TASK, uveďte konkrétní subtasksToCreate (seznam nových podúkolů).
5. Vypočítejte celkové skóre zdraví projektu (healthScore: 0-100) a míru jistoty (confidenceScore: 0-100).
6. Odpovězte výhradně ve validním formátu JSON podle poskytnutého schématu.`;

    let userContent = formatProjectContext(context) + '\n\nAktuální stav nástěnky:\n';
    columns.forEach(col => {
      userContent += `Sloupec "${col.name}" (ID: ${col.id}, Počet karet: ${col.cards.length}):\n`;
      col.cards.forEach(c => {
        userContent += `  - Card ID: ${c.id} | Název: "${c.title}" | Priorita: ${c.priority || 'Medium'} | Termín: ${c.dueDate || 'Není'} | Archivováno: ${c.archived ? 'Ano' : 'Ne'}\n`;
      });
    });

    userContent += '\nAnalyzujte projekt a navrhněte úpravy v JSON formátu.';

    return [
      { role: 'system', content: systemContent },
      { role: 'user', content: userContent }
    ];
  },

  buildResourceAnalysisPrompt(filename: string, fileContentText: string, context?: AiContext): AiMessage[] {
    const systemContent = `Jste AI specialista na analýzu produktových a technických podkladů (PRD, specifikace, poznámky, tabulky) pro aplikaci ClearSpace Kanban.
Vaším úkolem je pečlivě přečíst nahraný dokument, vytvořit výstižné shrnutí, extrahovat klíčová akceptační kritéria/požadavky, navrhnout rozpad na konkrétní podúkoly (subtasks) a identifikovat možná rizika.

Odpovězte výhradně ve validním formátu JSON podle poskytnutého schématu.`;

    const userContent = formatProjectContext(context) + `\n\nSoubor: "${filename}"\nObsah dokumentu:\n${fileContentText}\n\nProveďte hloubkovou analýzu dokumentu a vraťte JSON.`;

    return [
      { role: 'system', content: systemContent },
      { role: 'user', content: userContent }
    ];
  },

  buildDailyBriefPrompt(columns: Column[], activityLogsText: string, context?: AiContext): AiMessage[] {
    const systemContent = `Jste AI Project Manager pro ClearSpace Kanban. Generujete denní přehled (Daily Executive Briefing) pro projektový tým.
Analyzujte dokončené položky, rozpracované úkoly (WIP), blokátory a vytvořte motivující, věcné a přehledné ranní shrnutí v češtině.

Odpovězte výhradně ve validním formátu JSON podle poskytnutého schématu.`;

    let userContent = formatProjectContext(context) + '\n\nNedávná historie aktivit v projektu:\n' + activityLogsText + '\n\nStav nástěnky:\n';
    columns.forEach(col => {
      userContent += `Sloupec "${col.name}" (${col.cards.length} karet):\n`;
      col.cards.forEach(c => {
        userContent += `  - ${c.title} (Priorita: ${c.priority || 'Medium'}, Termín: ${c.dueDate || 'Není'})\n`;
      });
    });

    userContent += '\nVytvořte denní přehled (Daily Brief) v JSON formátu.';

    return [
      { role: 'system', content: systemContent },
      { role: 'user', content: userContent }
    ];
  },

  buildCapacityPlanningPrompt(columns: Column[], members: TeamMember[], context?: AiContext): AiMessage[] {
    const systemContent = `Jste AI specialista na plánování kapacit a vyvažování vytížení týmu (Capacity & Workload Balancing) pro ClearSpace Kanban.
Spočítejte přiřazené úkoly a odhadované hodiny pro každého člena týmu, vyhodnoťte přetížení či volné kapacity a navrhněte konkrétní přerozdělení karet mezi členy.

Odpovězte výhradně ve validním formátu JSON podle poskytnutého schématu.`;

    let userContent = formatProjectContext(context) + '\n\nSeznam členů týmu:\n';
    members.forEach(m => {
      userContent += `  - Member ID: ${m.id} | Jméno: ${m.fullName} | Pozice: ${m.role || 'Člen'}\n`;
    });

    userContent += '\nRozložení úkolů ve sloupcích:\n';
    columns.forEach(col => {
      col.cards.forEach(c => {
        const assignedNames = c.assignees ? c.assignees.map(m => m.fullName).join(', ') : c.assignee?.name || 'Nepřiřazeno';
        userContent += `  - Card ID: ${c.id} | Název: "${c.title}" | Přiřazeno: ${assignedNames}\n`;
      });
    });

    userContent += '\nProveďte kapacitní analýzu a navrhněte přerozdělení v JSON formátu.';

    return [
      { role: 'system', content: systemContent },
      { role: 'user', content: userContent }
    ];
  },

  buildVoiceActionPrompt(
    userTranscript: string,
    columns: Column[],
    context?: AiContext,
    audioBase64?: string,
    mimeType?: string
  ): AiMessage[] {
    const systemContent = `Jste AI Voice Action Copilot pro ClearSpace Kanban.
Posloucháte české nahrávky/příkazy a přetváříte je do přímých akcí na nástěnce.
Podporované akce (intentType):
- CREATE_CARD (vytvoření nové karty s názvem, sloupcem, prioritou, řešitelem)
- MOVE_CARD (přesun existující karty do jiného sloupce)
- CHANGE_PRIORITY (změna priority karty)
- RENAME_COLUMN (přejmenování sloupce)
- ADD_CHECKLIST (přidání položek do checklistu)
- GENERAL_RESPONSE (vše ostatní)

Vraťte výhradně JSON podle schématu aiVoiceActionSchema.`;

    let userContent = formatProjectContext(context) + (userTranscript ? `\n\nTextový příkaz: "${userTranscript}"\n` : '\n\nV přiloženém audio souboru je česká hlasová nahrávka příkazu.\n');
    userContent += '\nStav nástěnky:\n';
    columns.forEach(col => {
      userContent += `Sloupec "${col.name}":\n`;
      col.cards.forEach(c => {
        userContent += `  - Card: "${c.title}" (Priority: ${c.priority || 'Medium'})\n`;
      });
    });

    userContent += '\nPřeložte hlasový příkaz z audia do strukturované akce v JSON.';

    const userMessage: AiMessage = {
      role: 'user',
      content: userContent,
    };

    if (audioBase64 && mimeType) {
      userMessage.inlineData = {
        mimeType,
        data: audioBase64,
      };
    }

    return [
      { role: 'system', content: systemContent },
      userMessage,
    ];
  },
};




