/**
 * JSON Schemas for Gemini Structured Output (responseSchema).
 * Ensures native validation and correct output formats.
 */

export const improveTaskSchema = {
  type: 'OBJECT',
  properties: {
    details: { type: 'STRING', description: 'Vylepšený podrobný popis úkolu' },
    acceptanceCriteria: { type: 'STRING', description: 'Akceptační kritéria úkolu' },
    risks: { type: 'STRING', description: 'Možná rizika úkolu' },
    missingInfo: { type: 'STRING', description: 'Chybějící informace, které by bylo dobré doplnit' },
    checklist: {
      type: 'ARRAY',
      items: { type: 'STRING' },
      description: 'Checklist podúkolů'
    }
  },
  required: ['details', 'acceptanceCriteria', 'risks', 'missingInfo', 'checklist']
};

export const backlogGenerateSchema = {
  type: 'OBJECT',
  properties: {
    tasks: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          title: { type: 'STRING', description: 'Název úkolu' },
          description: { type: 'STRING', description: 'Stručný popis úkolu' },
          priority: { type: 'STRING', enum: ['High', 'Medium', 'Low'], description: 'Priorita úkolu' },
          estimate: { type: 'STRING', description: 'Odhad času (např. 2h, 1d)' },
          acceptanceCriteria: {
            type: 'ARRAY',
            items: { type: 'STRING' },
            description: 'Akceptační kritéria'
          },
          checklist: {
            type: 'ARRAY',
            items: { type: 'STRING' },
            description: 'Položky checklistu'
          },
          recommendedColumn: { type: 'STRING', description: 'Cílový sloupec z povolených sloupců' }
        },
        required: ['title', 'description', 'priority', 'estimate', 'acceptanceCriteria', 'checklist', 'recommendedColumn']
      }
    }
  },
  required: ['tasks']
};

export const projectGenerateSchema = {
  type: 'OBJECT',
  properties: {
    name: { type: 'STRING', description: 'Vylepšený název projektu' },
    description: { type: 'STRING', description: 'Popis projektu' },
    summary: { type: 'STRING', description: 'Architektonický souhrn projektu' },
    icon: { type: 'STRING', description: 'Jedno emoji reprezentující projekt' },
    accentColor: { type: 'STRING', description: 'HEX kód barvy projektu' },
    recommendedColumns: {
      type: 'ARRAY',
      items: { type: 'STRING' },
      description: 'Seznam 3 až 5 sloupců pro board'
    },
    recommendedStack: {
      type: 'ARRAY',
      items: { type: 'STRING' },
      description: 'Doporučené technologie'
    },
    complexity: { type: 'STRING', enum: ['Low', 'Medium', 'High'], description: 'Složitost projektu' },
    estimatedDuration: { type: 'STRING', description: 'Odhadovaná doba realizace' },
    recommendedTeamSize: { type: 'STRING', description: 'Doporučený počet lidí v týmu' },
    tags: {
      type: 'ARRAY',
      items: { type: 'STRING' },
      description: 'Štítky projektu'
    },
    aiRecommendation: {
      type: 'OBJECT',
      properties: {
        recommendation: { type: 'STRING', description: 'Hlavní doporučení' },
        biggestRisk: { type: 'STRING', description: 'Největší technické riziko' },
        focusArea: { type: 'STRING', description: 'Na co se zaměřit' },
        mvpScope: { type: 'STRING', description: 'Rozsah MVP' }
      },
      required: ['recommendation', 'biggestRisk', 'focusArea', 'mvpScope']
    },
    tasks: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          title: { type: 'STRING', description: 'Název úkolu' },
          description: { type: 'STRING', description: 'Stručný popis úkolu' },
          priority: { type: 'STRING', enum: ['High', 'Medium', 'Low'], description: 'Priorita úkolu' },
          estimate: { type: 'STRING', description: 'Odhad času' },
          acceptanceCriteria: {
            type: 'ARRAY',
            items: { type: 'STRING' },
            description: 'Akceptační kritéria'
          },
          checklist: {
            type: 'ARRAY',
            items: { type: 'STRING' },
            description: 'Položky checklistu'
          },
          recommendedColumn: { type: 'STRING', description: 'Doporučený sloupec' }
        },
        required: ['title', 'description', 'priority', 'estimate', 'acceptanceCriteria', 'checklist', 'recommendedColumn']
      }
    }
  },
  required: [
    'name',
    'description',
    'summary',
    'icon',
    'accentColor',
    'recommendedColumns',
    'recommendedStack',
    'complexity',
    'estimatedDuration',
    'recommendedTeamSize',
    'tags',
    'aiRecommendation',
    'tasks'
  ]
};

export const sprintPlanningSchema = {
  type: 'OBJECT',
  properties: {
    sprintGoal: { type: 'STRING', description: 'Hlavní cíl sprintu (1-2 věty)' },
    sprintSummary: { type: 'STRING', description: 'Stručné zdůvodnění a shrnutí sprintu (max 3 věty)' },
    recommendedSprintLength: { type: 'STRING', description: 'Doporučená délka sprintu (např. 2 týdny)' },
    sprintCapacity: { type: 'STRING', description: 'Doporučená kapacita sprintu (např. 40 SP nebo 80 hodin)' },
    selectedTasks: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          id: { type: 'STRING', description: 'Originální ID úkolu z backlogu' },
          title: { type: 'STRING', description: 'Název úkolu' },
          priority: { type: 'STRING', enum: ['High', 'Medium', 'Low'], description: 'Priorita úkolu' },
          storyPoints: { type: 'INTEGER', description: 'Odhadované Story Points pro úkol (Fibonacci: 1, 2, 3, 5, 8, 13)' },
          estimatedTime: { type: 'STRING', description: 'Odhadovaný čas realizace (např. 4h, 1d)' },
          reason: { type: 'STRING', description: 'Zdůvodnění, proč byl úkol zařazen do tohoto sprintu' }
        },
        required: ['id', 'title', 'priority', 'storyPoints', 'estimatedTime', 'reason']
      },
      description: 'Seznam vybraných úkolů zařazených do sprintu v doporučeném pořadí realizace'
    },
    dependencies: {
      type: 'ARRAY',
      items: { type: 'STRING' },
      description: 'Závislosti mezi úkoly v rámci sprintu'
    },
    risks: {
      type: 'ARRAY',
      items: { type: 'STRING' },
      description: 'Možná technická nebo procesní rizika'
    },
    outOfScope: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          id: { type: 'STRING', description: 'Originální ID úkolu' },
          title: { type: 'STRING', description: 'Název úkolu' },
          reason: { type: 'STRING', description: 'Proč byl úkol ponechán mimo sprint' }
        },
        required: ['id', 'title', 'reason']
      },
      description: 'Důležité úkoly, které byly ponechány mimo sprint (a proč)'
    }
  },
  required: [
    'sprintGoal',
    'sprintSummary',
    'recommendedSprintLength',
    'sprintCapacity',
    'selectedTasks',
    'dependencies',
    'risks',
    'outOfScope'
  ]
};

export const projectRiskAnalysisSchema = {
  type: 'OBJECT',
  properties: {
    executiveSummary: { type: 'STRING', description: 'Manažerské shrnutí rizik celého projektu (2-3 odstavce)' },
    overallRiskScore: { type: 'INTEGER', description: 'Celkové skóre rizika od 0 (bez rizika) do 100 (kritické riziko)' },
    biggestRisks: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          name: { type: 'STRING', description: 'Název rizika' },
          severity: { type: 'STRING', enum: ['Low', 'Medium', 'High'], description: 'Závažnost rizika' },
          explanation: { type: 'STRING', description: 'Podrobné vysvětlení rizika a jeho dopadů v češtině' },
          recommendation: { type: 'STRING', description: 'Doporučené řešení a mitigace rizika v češtině' }
        },
        required: ['name', 'severity', 'explanation', 'recommendation']
      },
      description: 'Seznam největších rizik identifikovaných v projektu'
    },
    bottlenecks: {
      type: 'ARRAY',
      items: { type: 'STRING' },
      description: 'Identifikovaná úzká hrdla (bottlenecks) v projektu, workflow nebo prioritách'
    },
    missingFeatures: {
      type: 'ARRAY',
      items: { type: 'STRING' },
      description: 'Chybějící funkce nebo klíčové prvky, které by v projektu měly být'
    },
    technicalDebt: {
      type: 'ARRAY',
      items: { type: 'STRING' },
      description: 'Potenciální technický dluh a architektonická rizika'
    },
    securityRisks: {
      type: 'ARRAY',
      items: { type: 'STRING' },
      description: 'Bezpečnostní rizika a doporučení'
    },
    performanceRisks: {
      type: 'ARRAY',
      items: { type: 'STRING' },
      description: 'Výkonnostní rizika a škálovatelnost'
    },
    mvpRecommendations: {
      type: 'ARRAY',
      items: { type: 'STRING' },
      description: 'Doporučení pro rozsah MVP'
    },
    topAiRecommendations: {
      type: 'ARRAY',
      items: { type: 'STRING' },
      description: 'Top 5 konkrétních a akčních doporučení pro úspěch projektu (přesně 5 položek)'
    }
  },
  required: [
    'executiveSummary',
    'overallRiskScore',
    'biggestRisks',
    'bottlenecks',
    'missingFeatures',
    'technicalDebt',
    'securityRisks',
    'performanceRisks',
    'mvpRecommendations',
    'topAiRecommendations'
  ]
};

export const aiProjectManagerSchema = {
  type: 'OBJECT',
  properties: {
    summary: { type: 'STRING', description: 'Stručné shrnutí stavu projektu a doporučení' },
    confidenceScore: { type: 'NUMBER', description: 'Míra jistoty AI analýzy v procentech (0-100)' },
    risks: {
      type: 'ARRAY',
      items: { type: 'STRING' },
      description: 'Seznam zjištěných rizik'
    },
    blockers: {
      type: 'ARRAY',
      items: { type: 'STRING' },
      description: 'Seznam blokujících faktů'
    },
    suggestedChanges: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          id: { type: 'STRING', description: 'Unikátní ID návrhu' },
          actionType: {
            type: 'STRING',
            enum: ['MOVE_TASK', 'CHANGE_PRIORITY', 'SPLIT_TASK', 'MERGE_TASKS', 'ARCHIVE_TASK'],
            description: 'Typ akce'
          },
          targetCardId: { type: 'STRING', description: 'ID hlavní karty' },
          targetCardTitle: { type: 'STRING', description: 'Název hlavní karty' },
          targetColumnId: { type: 'STRING', description: 'ID cílového sloupce' },
          targetColumnName: { type: 'STRING', description: 'Název cílového sloupce' },
          newPriority: { type: 'STRING', enum: ['Low', 'Medium', 'High'], description: 'Nová priorita' },
          reason: { type: 'STRING', description: 'Zdůvodnění návrhu' },
          subtasksToCreate: {
            type: 'ARRAY',
            items: { type: 'STRING' },
            description: 'Seznam podúkolů při rozdělení karty'
          }
        },
        required: ['id', 'actionType', 'targetCardId', 'targetCardTitle', 'reason']
      }
    }
  },
  required: ['summary', 'confidenceScore', 'risks', 'blockers', 'suggestedChanges']
};

export const aiResourceAnalysisSchema = {
  type: 'OBJECT',
  properties: {
    summary: { type: 'STRING', description: 'Stručné shrnutí obsahu dokumentu v češtině' },
    extractedRequirements: {
      type: 'ARRAY',
      items: { type: 'STRING' },
      description: 'Extrahovaná akceptační kritéria a požadavky z dokumentu'
    },
    generatedSubtasks: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          title: { type: 'STRING', description: 'Název podúkolu' },
          description: { type: 'STRING', description: 'Stručný popis podúkolu' },
          priority: { type: 'STRING', enum: ['Low', 'Medium', 'High'], description: 'Priorita' }
        },
        required: ['title', 'description', 'priority']
      },
      description: 'Navržené podúkoly vzniklé rozpadem dokumentu'
    },
    detectedRisks: {
      type: 'ARRAY',
      items: { type: 'STRING' },
      description: 'Identifikovaná technická či procesní rizika zmíněná v dokumentu'
    }
  },
  required: ['summary', 'extractedRequirements', 'generatedSubtasks', 'detectedRisks']
};

export const aiDailyBriefSchema = {
  type: 'OBJECT',
  properties: {
    greeting: { type: 'STRING', description: 'Krátký ranní pozdrav a povzbuzení' },
    executiveSummary: { type: 'STRING', description: 'Stručné manažerské shrnutí stavu projektu pro dnešní den' },
    completedYesterday: {
      type: 'ARRAY',
      items: { type: 'STRING' },
      description: 'Seznam úkolů a milníků dokončených za nedávnou dobu'
    },
    topPrioritiesToday: {
      type: 'ARRAY',
      items: { type: 'STRING' },
      description: 'Top 3 klíčové priority, na které se má tým dnes zaměřit'
    },
    capacityAlerts: {
      type: 'ARRAY',
      items: { type: 'STRING' },
      description: 'Upozornění na hrozící přetížení kapacit nebo vypršení termínů'
    },
    recommendedActions: {
      type: 'ARRAY',
      items: { type: 'STRING' },
      description: 'Doporučené konkrétní kroky pro dnešní den'
    }
  },
  required: ['greeting', 'executiveSummary', 'completedYesterday', 'topPrioritiesToday', 'capacityAlerts', 'recommendedActions']
};

export const aiCapacityPlanningSchema = {
  type: 'OBJECT',
  properties: {
    totalCapacityHours: { type: 'NUMBER', description: 'Celková dostupná kapacita týmu v hodinách' },
    allocatedHours: { type: 'NUMBER', description: 'Celkově alokované hodiny v úkolech' },
    workloadByMember: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          memberId: { type: 'STRING', description: 'ID člena' },
          memberName: { type: 'STRING', description: 'Jméno člena' },
          assignedCardsCount: { type: 'NUMBER', description: 'Počet přiřazených karet' },
          estimatedHours: { type: 'NUMBER', description: 'Odhad hodin práce' },
          status: { type: 'STRING', enum: ['OVERLOADED', 'BALANCED', 'AVAILABLE'], description: 'Stav vytížení' }
        },
        required: ['memberId', 'memberName', 'assignedCardsCount', 'estimatedHours', 'status']
      },
      description: 'Rozložení vytížení po jednotlivých členech týmu'
    },
    rebalanceSuggestions: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          cardId: { type: 'STRING', description: 'ID karty k přerozdělení' },
          cardTitle: { type: 'STRING', description: 'Název karty' },
          fromMemberName: { type: 'STRING', description: 'Současný přiřazený člen' },
          toMemberName: { type: 'STRING', description: 'Doporučený nový člen' },
          reason: { type: 'STRING', description: 'Zdůvodnění přerozdělení' }
        },
        required: ['cardId', 'cardTitle', 'fromMemberName', 'toMemberName', 'reason']
      },
      description: 'Návrhy na vyrovnání kapacit přerozdělením karet'
    }
  },
  required: ['totalCapacityHours', 'allocatedHours', 'workloadByMember', 'rebalanceSuggestions']
};

export const aiVoiceActionSchema = {
  type: 'OBJECT',
  properties: {
    intentType: {
      type: 'STRING',
      enum: ['CREATE_CARD', 'MOVE_CARD', 'CHANGE_PRIORITY', 'RENAME_COLUMN', 'ADD_CHECKLIST', 'GENERAL_RESPONSE'],
      description: 'Typ akce rozpoznaný z hlasového/textového příkazu'
    },
    summary: { type: 'STRING', description: 'Stručný srozumitelný popis akce v češtině pro schvalovací tlačítko' },
    actionPayload: {
      type: 'OBJECT',
      properties: {
        cardTitle: { type: 'STRING', description: 'Název karty' },
        columnName: { type: 'STRING', description: 'Cílový nebo zdrojový sloupec' },
        targetColumnName: { type: 'STRING', description: 'Nová název sloupce při přejmenování' },
        priority: { type: 'STRING', enum: ['Low', 'Medium', 'High'], description: 'Priorita' },
        assigneeName: { type: 'STRING', description: 'Jméno přiřazené osoby' },
        details: { type: 'STRING', description: 'Podrobný popis úkolu' },
        checklistItems: {
          type: 'ARRAY',
          items: { type: 'STRING' },
          description: 'Položky pro checklist'
        }
      }
    }
  },
  required: ['intentType', 'summary', 'actionPayload']
};





// --- Meeting Intelligence (ARCHITECTURE §8.2). Model píše snake_case; validátor je jediná hranice důvěry. ---
const evidenceSchema = {
  type: 'ARRAY',
  items: {
    type: 'OBJECT',
    properties: {
      segment_id: { type: 'STRING', description: 'Id segmentu přepisu, např. seg-12' },
      quote: { type: 'STRING', description: 'Doslovná citace z tohoto segmentu (max 200 znaků), původní jazyk' },
    },
    required: ['segment_id', 'quote'],
  },
};
const meetingItemSchema = {
  type: 'OBJECT',
  properties: {
    text: { type: 'STRING', description: 'Stručné znění položky' },
    evidence: evidenceSchema,
    confidence: { type: 'STRING', enum: ['high', 'medium', 'low'] },
  },
  required: ['text', 'evidence'],
};
export const meetingBriefSchema = {
  type: 'OBJECT',
  properties: {
    summary: { type: 'STRING', description: 'Shrnutí porady, max 5 vět' },
    decisions: { type: 'ARRAY', items: meetingItemSchema },
    action_items: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          ...meetingItemSchema.properties,
          owner_text: { type: 'STRING', nullable: true, description: 'Jméno doslova z citace, jinak null' },
          due_text: { type: 'STRING', nullable: true, description: 'Doslovná fráze termínu z citace, jinak null' },
          existing_card_id: { type: 'STRING', nullable: true, description: 'Id otevřené karty, která stejnou práci už řeší' },
        },
        required: ['text', 'evidence'],
      },
    },
    follow_ups: { type: 'ARRAY', items: meetingItemSchema },
    risks: { type: 'ARRAY', items: meetingItemSchema },
    blockers: { type: 'ARRAY', items: meetingItemSchema },
    open_questions: { type: 'ARRAY', items: meetingItemSchema },
    chapters: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          title: { type: 'STRING' },
          first_segment: { type: 'STRING' },
          last_segment: { type: 'STRING' },
        },
        required: ['title', 'first_segment', 'last_segment'],
      },
    },
  },
  required: ['summary', 'decisions', 'action_items', 'follow_ups', 'risks', 'blockers', 'open_questions'],
};

// --- Project Intelligence 2.0: Project Brief (ARCHITECTURE §7.2). Žádná pole pro vlastníka ani termín. ---
const briefRefs = { type: 'ARRAY', items: { type: 'STRING' }, description: 'Ref zdrojů přesně jako v datech, např. card:abc, comment:xyz, item:123' };
const briefClaim = {
  type: 'OBJECT',
  properties: {
    text: { type: 'STRING' },
    refs: briefRefs,
    quote: { type: 'STRING', nullable: true, description: 'Doslovná citace z odkazovaného zdroje' },
  },
  required: ['text', 'refs'],
};
export const projectBriefSchema = {
  type: 'OBJECT',
  properties: {
    summary: { type: 'STRING' },
    health_narrative: { type: 'STRING' },
    risks: { type: 'ARRAY', items: { ...briefClaim, properties: { ...briefClaim.properties, severity: { type: 'STRING', enum: ['low', 'medium', 'high'] } } } },
    blockers: { type: 'ARRAY', items: briefClaim },
    next_actions: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          text: { type: 'STRING' },
          kind: { type: 'STRING', enum: ['create', 'update', 'unblock', 'assign', 'clarify'] },
          refs: briefRefs,
          target_card_id: { type: 'STRING', nullable: true },
        },
        required: ['text', 'kind', 'refs'],
      },
    },
    open_questions: { type: 'ARRAY', items: briefClaim },
    notes_on_data: { type: 'ARRAY', items: { type: 'STRING' } },
  },
  required: ['summary', 'health_narrative', 'risks', 'blockers', 'next_actions', 'open_questions'],
};
