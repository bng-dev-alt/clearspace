import type { Card, Column } from '../types/kanban';

/**
 * Project Intelligence -- deterministický "mozek" projektu.
 *
 * Filozofie: VŠECHNY poznatky se počítají čistě z dat boardu (žádné LLM, žádná
 * halucinace, žádná vymyšlená pole). AI vrstva by tyto fakty jen přeformulovala
 * -- sama je nevymýšlí. Díky tomu je celá funkce čistá a testovatelná.
 *
 * Vědomě používáme jen pole, která v modelu opravdu existují (tag 'Blokováno',
 * dueDate, priority, assignees, sloupce). Např. "story points" v modelu nejsou,
 * takže o nich záměrně netvrdíme nic.
 */

export type InsightSeverity = 'danger' | 'warning' | 'neutral';

export interface Insight {
  id: string;
  fact: string; // tvrdý, spočítaný fakt (v UI mono)
  note: string; // lidská/AI formulace důsledku
  severity: InsightSeverity;
}

export type IntelligenceActionId = 'blockers' | 'sprint' | 'generate';

export type HealthLevel = 'healthy' | 'attention' | 'risk';

export interface HealthStatus {
  level: HealthLevel;
  label: string; // stavové slovo (vede před číslem)
  reason: string; // jednořádkové proč
  score: number; // 0-100, odvozené a vysvětlitelné (viz breakdown)
  breakdown: { label: string; delta: number }[]; // z čeho se skóre počítá
}

export interface ProjectIntelligence {
  health: HealthStatus;
  insights: Insight[];
  actions: IntelligenceActionId[];
}

const REVIEW_KEYWORDS = ['reviz', 'review', 'kontrol'];
const DONE_KEYWORDS = ['hotovo', 'done', 'dokon'];
const BACKLOG_KEYWORDS = ['nápad', 'napad', 'backlog', 'ideas'];

function nameMatches(name: string, keywords: string[]): boolean {
  const n = name.trim().toLowerCase();
  return keywords.some((k) => n.includes(k));
}

/** Sdílená konvence "je tenhle sloupec Hotovo?" -- používá i dashboardStats.ts. */
export function isDoneColumnName(name: string): boolean {
  return nameMatches(name, DONE_KEYWORDS);
}

function todayIso(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function isBlocked(card: Card): boolean {
  return card.tag === 'Blokováno';
}

function isUnassigned(card: Card): boolean {
  return (!card.assignees || card.assignees.length === 0) && !card.assignee;
}

/**
 * Spočítá kompletní "inteligenci" projektu z boardu.
 * @param columns sloupce s kartami
 * @param now injektovatelný čas (kvůli testovatelnosti overdue)
 */
export function computeProjectIntelligence(
  columns: Column[],
  now: Date = new Date()
): ProjectIntelligence {
  const today = todayIso(now);

  const doneColIds = new Set(
    columns.filter((c) => nameMatches(c.name, DONE_KEYWORDS)).map((c) => c.id)
  );
  const reviewCols = columns.filter((c) => nameMatches(c.name, REVIEW_KEYWORDS));
  const backlogCols = columns.filter((c) => nameMatches(c.name, BACKLOG_KEYWORDS));

  const allCards = columns.flatMap((c) =>
    c.cards.filter((card) => !card.archived).map((card) => ({ card, colId: c.id }))
  );
  const activeCards = allCards.filter(({ colId }) => !doneColIds.has(colId));

  const total = allCards.length;

  const blocked = allCards.filter(({ card }) => isBlocked(card)).length;

  const overdue = activeCards.filter(
    ({ card }) => card.dueDate && card.dueDate < today
  ).length;

  const reviewCount = reviewCols.reduce(
    (acc, c) => acc + c.cards.filter((card) => !card.archived).length,
    0
  );

  const unassigned = activeCards.filter(({ card }) => isUnassigned(card)).length;

  const noDueDate = activeCards.filter(({ card }) => !card.dueDate).length;

  const highPriority = activeCards.filter(({ card }) => card.priority === 'High').length;

  const backlogEmpty =
    backlogCols.length > 0 &&
    backlogCols.every((c) => c.cards.filter((card) => !card.archived).length === 0);

  // --- Skóre zdraví: začínáme na 100 a odečítáme (odvozené a vysvětlitelné) ---
  const breakdown: { label: string; delta: number }[] = [];
  const penalty = (label: string, value: number, perUnit: number, cap: number) => {
    if (value <= 0) return;
    const delta = -Math.min(value * perUnit, cap);
    breakdown.push({ label, delta });
  };
  penalty('Blokátory', blocked, 8, 32);
  penalty('Po termínu', overdue, 6, 24);
  penalty('Fronta k revizi', Math.max(reviewCount - 3, 0), 2, 10);
  penalty('Nepřiřazené', unassigned, 1, 10);

  const score = Math.max(0, Math.min(100, 100 + breakdown.reduce((a, b) => a + b.delta, 0)));

  let level: HealthLevel;
  if (score >= 80) {
    level = 'healthy';
  } else if (score >= 55) {
    level = 'attention';
  } else {
    level = 'risk';
  }

  // Tvrdé pravidlo: s otevřeným danger signálem (blokátor / po termínu) projekt
  // NEMŮŽE být "V pořádku" -- i kdyby skóre vyšlo vysoko. Jinak by panel tvrdil
  // "V pořádku" a hned pod tím ukazoval červené blokátory (rozpor = ztráta důvěry).
  const hasDanger = blocked > 0 || overdue > 0;
  if (hasDanger && level === 'healthy') {
    level = 'attention';
  }

  const label =
    level === 'healthy' ? 'V pořádku' : level === 'attention' ? 'Vyžaduje pozornost' : 'V ohrožení';

  // Důvod = nejsilnější faktory (max 3), lidsky.
  const reasonParts: string[] = [];
  if (blocked > 0) reasonParts.push(`${blocked} ${plural(blocked, 'blokátor', 'blokátory', 'blokátorů')}`);
  if (overdue > 0) reasonParts.push(`${overdue} po termínu`);
  if (reviewCount > 3) reasonParts.push(`fronta k revizi (${reviewCount})`);
  if (unassigned > 0 && reasonParts.length < 3) reasonParts.push(`${unassigned} nepřiřazených`);
  const reason =
    reasonParts.length > 0 ? reasonParts.slice(0, 3).join(' · ') : 'Žádné otevřené problémy';

  // --- Insighty (jen ty, které opravdu platí; danger > warning > neutral) ---
  const insights: Insight[] = [];

  if (blocked > 0) {
    insights.push({
      id: 'blocked',
      fact: `${blocked} ${plural(blocked, 'blokovaný úkol', 'blokované úkoly', 'blokovaných úkolů')}`,
      note: 'brání postupu ve sprintu',
      severity: 'danger',
    });
  }
  if (overdue > 0) {
    insights.push({
      id: 'overdue',
      fact: `${overdue} ${plural(overdue, 'úkol po termínu', 'úkoly po termínu', 'úkolů po termínu')}`,
      note: 'termín splnění už uplynul',
      severity: 'danger',
    });
  }
  if (reviewCount > 3) {
    insights.push({
      id: 'review',
      fact: `Fronta k revizi: ${reviewCount}`,
      note: 'kontrola se hromadí',
      severity: 'warning',
    });
  }
  if (unassigned > 0) {
    insights.push({
      id: 'unassigned',
      fact: `${unassigned} ${plural(unassigned, 'úkol bez řešitele', 'úkoly bez řešitele', 'úkolů bez řešitele')}`,
      note: 'nikdo je nemá na starosti',
      severity: 'warning',
    });
  }
  if (noDueDate > 0) {
    insights.push({
      id: 'no-due',
      fact: `${noDueDate} ${plural(noDueDate, 'úkol bez termínu', 'úkoly bez termínu', 'úkolů bez termínu')}`,
      note: 'nelze sledovat skluz',
      severity: 'neutral',
    });
  }
  if (highPriority === 0 && activeCards.length > 0) {
    insights.push({
      id: 'no-high',
      fact: 'Žádná priorita „Vysoká"',
      note: 'zvaž, co je teď nejdůležitější',
      severity: 'neutral',
    });
  }
  if (backlogEmpty) {
    insights.push({
      id: 'backlog-empty',
      fact: 'Backlog je prázdný',
      note: 'došly nápady k rozpracování',
      severity: 'neutral',
    });
  }
  if (total === 0) {
    insights.push({
      id: 'empty',
      fact: 'Projekt je prázdný',
      note: 'začni vygenerováním úvodních úkolů',
      severity: 'neutral',
    });
  }

  // --- Akce jako důsledek stavu, řazené dle relevance ---
  const actions: IntelligenceActionId[] = [];
  if (blocked > 0) actions.push('blockers');
  if (total > 0) actions.push('sprint');
  if (backlogEmpty || total < 5) actions.push('generate');
  if (actions.length === 0) actions.push('generate');

  return {
    health: { level, label, reason, score, breakdown },
    insights: insights.slice(0, 6),
    actions,
  };
}

/** České skloňování 1 / 2-4 / 5+ */
function plural(n: number, one: string, few: string, many: string): string {
  if (n === 1) return one;
  if (n >= 2 && n <= 4) return few;
  return many;
}
