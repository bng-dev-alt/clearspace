import type { Card, Column, ProjectActivityLog, TeamMember } from '../../types/kanban';
import {
  computeProjectIntelligence,
  dueDateKey,
  isDoneColumnName,
  type HealthStatus,
  type Insight,
} from '../projectIntelligence';
import { computeTeamWorkload, type WorkloadLevel } from '../dashboardStats';

/**
 * Deterministická fakta o projektu. Počítá výhradně kód -- model je smí jen interpretovat,
 * nikdy je nepočítá ani nepřepisuje (ARCHITECTURE §7.1). Skóre a úroveň zdraví jsou beze změny
 * převzaté z computeProjectIntelligence (jediná definice vzorce).
 */

export const FACTS_VERSION = 'facts-1';
export const DEFAULT_TZ = 'Europe/Prague';
const LIST_CAP = 20;
const RECENT_DAYS = 7;
const RECENT_ENTRIES_CAP = 30;

export interface FactsWorkloadEntry {
  memberId: string;
  name: string;
  open: number;
  highPriority: number;
  dueThisWeek: number;
  level: WorkloadLevel;
}

export interface RecentChange {
  activityId: string;
  actionType: string;
  cardId: string | null;
  at: string;
}

export interface ProjectFacts {
  factsVersion: typeof FACTS_VERSION;
  today: string;
  tz: string;
  health: HealthStatus;
  insights: Insight[];
  counts: {
    total: number;
    active: number;
    done: number;
    archived: number;
    blocked: number;
    overdue: number;
    dueThisWeek: number;
    noDueDate: number;
    unassigned: number;
    highPriority: number;
    inReview: number;
  };
  /** Id karet (nejvýše 20 v každém seznamu), aby šlo navigovat a citovat. */
  lists: {
    overdueCardIds: string[];
    blockedCardIds: string[];
    unassignedCardIds: string[];
    dueSoonCardIds: string[];
  };
  recentChanges: {
    windowDays: number;
    created: number;
    movedToDone: number;
    archived: number;
    memberChanges: number;
    entries: RecentChange[];
  };
  workload: FactsWorkloadEntry[];
  dataQuality: { invalidDueDateCardIds: string[] };
}

/** Dnešní kalendářní den (YYYY-MM-DD) v dané časové zóně. */
export function todayInTz(now: Date, tz: string = DEFAULT_TZ): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function addDays(dayKey: string, days: number): string {
  const [y, m, d] = dayKey.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

const isBlocked = (c: Card) => c.tag === 'Blokováno';
const isUnassigned = (c: Card) => (!c.assignees || c.assignees.length === 0) && !c.assignee;

export function computeProjectFacts(
  columns: Column[],
  activities: ProjectActivityLog[],
  now: Date = new Date(),
  tz: string = DEFAULT_TZ
): ProjectFacts {
  const today = todayInTz(now, tz);
  const weekEnd = addDays(today, 7);
  const intel = computeProjectIntelligence(columns, now, today);

  const doneColIds = new Set(columns.filter((c) => isDoneColumnName(c.name)).map((c) => c.id));
  const reviewColIds = new Set(
    columns.filter((c) => /reviz|review|kontrol/i.test(c.name)).map((c) => c.id)
  );

  const all = columns.flatMap((col) => col.cards.map((card) => ({ card, colId: col.id })));
  const live = all.filter(({ card }) => !card.archived);
  const active = live.filter(({ colId }) => !doneColIds.has(colId));

  const overdue: Card[] = [];
  const dueSoon: Card[] = [];
  const invalid: Card[] = [];
  let noDue = 0;
  for (const { card } of active) {
    if (!card.dueDate) {
      noDue += 1;
      continue;
    }
    const k = dueDateKey(card.dueDate);
    if (k === null) {
      invalid.push(card);
      continue;
    }
    if (k < today) overdue.push(card);
    else if (k <= weekEnd) dueSoon.push(card);
  }
  const blocked = live.filter(({ card }) => isBlocked(card)).map(({ card }) => card);
  const unassigned = active.filter(({ card }) => isUnassigned(card)).map(({ card }) => card);

  // Řešitelé = ti, které vidíme na kartách (členy bez karty server nenačítá).
  const members = new Map<string, TeamMember>();
  for (const { card } of live) for (const a of card.assignees ?? []) if (!members.has(a.id)) members.set(a.id, a);
  const wl = computeTeamWorkload(columns, [...members.values()], now);
  const workload: FactsWorkloadEntry[] = wl.map((w) => {
    const dueThisWeek = active.filter(({ card }) => {
      if (!(card.assignees ?? []).some((a) => a.id === w.member.id)) return false;
      const k = dueDateKey(card.dueDate);
      return k !== null && k >= today && k <= weekEnd;
    }).length;
    return {
      memberId: w.member.id,
      name: w.member.fullName,
      open: w.assignedCount,
      highPriority: w.highPriorityCount,
      dueThisWeek,
      level: w.level,
    };
  });

  const cutoff = Date.parse(`${addDays(today, -RECENT_DAYS)}T00:00:00Z`);
  const recent = activities
    .filter((a) => Number.isFinite(Date.parse(a.createdAt)) && Date.parse(a.createdAt) >= cutoff)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const countType = (t: string) => recent.filter((a) => a.actionType === t).length;

  return {
    factsVersion: FACTS_VERSION,
    today,
    tz,
    health: intel.health,
    insights: intel.insights,
    counts: {
      total: live.length,
      active: active.length,
      done: live.length - active.length,
      archived: all.length - live.length,
      blocked: blocked.length,
      overdue: overdue.length,
      dueThisWeek: dueSoon.length,
      noDueDate: noDue,
      unassigned: unassigned.length,
      highPriority: active.filter(({ card }) => card.priority === 'High').length,
      inReview: live.filter(({ colId }) => reviewColIds.has(colId)).length,
    },
    lists: {
      overdueCardIds: overdue.slice(0, LIST_CAP).map((c) => c.id),
      blockedCardIds: blocked.slice(0, LIST_CAP).map((c) => c.id),
      unassignedCardIds: unassigned.slice(0, LIST_CAP).map((c) => c.id),
      dueSoonCardIds: dueSoon.slice(0, LIST_CAP).map((c) => c.id),
    },
    recentChanges: {
      windowDays: RECENT_DAYS,
      created: countType('card_created'),
      movedToDone: recent.filter(
        (a) => a.actionType === 'card_moved' && typeof a.details?.to === 'string' && isDoneColumnName(a.details.to)
      ).length,
      archived: countType('card_archived'),
      memberChanges: countType('member_added') + countType('member_removed'),
      entries: recent.slice(0, RECENT_ENTRIES_CAP).map((a) => ({
        activityId: a.id,
        actionType: a.actionType,
        cardId: a.cardId ?? null,
        at: a.createdAt,
      })),
    },
    workload,
    dataQuality: { invalidDueDateCardIds: invalid.slice(0, LIST_CAP).map((c) => c.id) },
  };
}
