import type { Card, Column, ProjectActivityLog, TeamMember } from '../types/kanban';
import { isDoneColumnName } from './projectIntelligence';

/**
 * Dashboard statistiky -- stejná filozofie jako projectIntelligence.ts:
 * deterministický výpočet z dat boardu a activity_logs, žádné LLM.
 *
 * Velocity a burndown jsou odvozené z activity_logs (Fáze 5), ne z
 * dedikované historické tabulky -- je to aproximace z event logu, ne
 * přesný snímek stavu ke každému dni. Karty vytvořené před zapnutím
 * Aktivity projektu nemají `card_created` událost, takže okraj sledovaného
 * okna může vypadat plošší, než realita byla.
 */

export interface CompletionStats {
  total: number;
  done: number;
  rate: number; // 0-100
}

export function computeCompletionStats(columns: Column[]): CompletionStats {
  const doneColIds = new Set(columns.filter((c) => isDoneColumnName(c.name)).map((c) => c.id));
  let total = 0;
  let done = 0;
  columns.forEach((col) => {
    col.cards.forEach((card) => {
      if (card.archived) return;
      total += 1;
      if (doneColIds.has(col.id)) done += 1;
    });
  });
  return { total, done, rate: total > 0 ? Math.round((done / total) * 100) : 0 };
}

export type WorkloadLevel = 'overloaded' | 'balanced' | 'light';

export interface WorkloadEntry {
  member: TeamMember;
  assignedCount: number;
  highPriorityCount: number;
  dueThisWeekCount: number;
  level: WorkloadLevel;
}

/**
 * Vytížení týmu -- čistě z otevřených (nearchivovaných, mimo Hotovo)
 * karet a jejich řešitelů. Bez AI: "přetížený" je jen ten, kdo má
 * výrazně víc otevřených karet než průměr týmu.
 */
export function computeTeamWorkload(
  columns: Column[],
  teamMembers: TeamMember[],
  now: Date = new Date()
): WorkloadEntry[] {
  const doneColIds = new Set(columns.filter((c) => isDoneColumnName(c.name)).map((c) => c.id));
  const weekFromNow = new Date(now);
  weekFromNow.setDate(weekFromNow.getDate() + 7);

  const openCardsByMember = new Map<string, Card[]>();
  columns.forEach((col) => {
    if (doneColIds.has(col.id)) return;
    col.cards.forEach((card) => {
      if (card.archived) return;
      (card.assignees || []).forEach((a) => {
        const list = openCardsByMember.get(a.id) || [];
        list.push(card);
        openCardsByMember.set(a.id, list);
      });
    });
  });

  const counts = teamMembers.map((m) => (openCardsByMember.get(m.id) || []).length);
  const avg = counts.length > 0 ? counts.reduce((a, b) => a + b, 0) / counts.length : 0;

  return teamMembers
    .map((member) => {
      const cards = openCardsByMember.get(member.id) || [];
      const highPriorityCount = cards.filter((c) => c.priority === 'High').length;
      const dueThisWeekCount = cards.filter(
        (c) => c.dueDate && new Date(c.dueDate) <= weekFromNow && new Date(c.dueDate) >= now
      ).length;

      let level: WorkloadLevel = 'balanced';
      if (cards.length === 0) level = 'light';
      else if (avg > 0 && cards.length >= 3 && cards.length > avg * 1.5) level = 'overloaded';

      return { member, assignedCount: cards.length, highPriorityCount, dueThisWeekCount, level };
    })
    .sort((a, b) => b.assignedCount - a.assignedCount);
}

export interface VelocityPoint {
  weekLabel: string;
  completed: number;
}

/**
 * Kolik karet za týden "vstoupilo" do sloupce Hotovo (card_moved event,
 * kde details.to odpovídá Hotovo sloupci). Karty smazané/archivované bez
 * průchodu Hotovo se nepočítají -- typicky zrušené, ne dokončené.
 */
export function computeVelocity(
  activityLogs: ProjectActivityLog[],
  weeks: number = 6,
  now: Date = new Date()
): VelocityPoint[] {
  const buckets = Array.from({ length: weeks }).map((_, i) => {
    const weeksAgo = weeks - 1 - i;
    const end = new Date(now);
    end.setDate(end.getDate() - weeksAgo * 7);
    end.setHours(23, 59, 59, 999);
    const start = new Date(end);
    start.setDate(start.getDate() - 6);
    start.setHours(0, 0, 0, 0);
    return {
      start,
      end,
      weekLabel: `${start.getDate()}.${start.getMonth() + 1}.`,
      completed: 0,
    };
  });

  activityLogs.forEach((log) => {
    if (log.actionType !== 'card_moved') return;
    const to = log.details?.to;
    if (typeof to !== 'string' || !isDoneColumnName(to)) return;
    const logDate = new Date(log.createdAt);
    const bucket = buckets.find((b) => logDate >= b.start && logDate <= b.end);
    if (bucket) bucket.completed += 1;
  });

  return buckets.map(({ weekLabel, completed }) => ({ weekLabel, completed }));
}

export interface BurndownPoint {
  dateLabel: string;
  remaining: number;
}

/**
 * Zpětná rekonstrukce počtu otevřených karet za posledních `days` dní.
 * Vychází z AKTUÁLNÍHO (jistého) počtu a odečítá/přičítá zpět v čase
 * podle událostí z activity_logs (card_created, card_archived,
 * card_moved do/z Hotovo sloupce). Mimo sledované okno se události
 * ignorují -- okraj grafu proto může vypadat plošší než realita.
 */
export function computeBurndown(
  columns: Column[],
  activityLogs: ProjectActivityLog[],
  days: number = 14,
  now: Date = new Date()
): BurndownPoint[] {
  const doneColIds = new Set(columns.filter((c) => isDoneColumnName(c.name)).map((c) => c.id));
  const currentOpenCount = columns.reduce((sum, col) => {
    if (doneColIds.has(col.id)) return sum;
    return sum + col.cards.filter((c) => !c.archived).length;
  }, 0);

  const dayKeys = Array.from({ length: days }).map((_, i) => {
    const d = new Date(now);
    d.setDate(d.getDate() - (days - 1 - i));
    d.setHours(0, 0, 0, 0);
    return d;
  });

  const netChangePerDay = new Array(days).fill(0);
  const dayIndexOf = (iso: string): number => {
    const d = new Date(iso);
    d.setHours(0, 0, 0, 0);
    return dayKeys.findIndex((dk) => dk.getTime() === d.getTime());
  };

  activityLogs.forEach((log) => {
    const idx = dayIndexOf(log.createdAt);
    if (idx === -1) return;
    if (log.actionType === 'card_created') {
      netChangePerDay[idx] += 1;
    } else if (log.actionType === 'card_archived') {
      netChangePerDay[idx] -= 1;
    } else if (log.actionType === 'card_moved') {
      const to = log.details?.to;
      const from = log.details?.from;
      const toIsDone = typeof to === 'string' && isDoneColumnName(to);
      const fromIsDone = typeof from === 'string' && isDoneColumnName(from);
      if (toIsDone && !fromIsDone) netChangePerDay[idx] -= 1;
      else if (!toIsDone && fromIsDone) netChangePerDay[idx] += 1;
    }
  });

  const remaining = new Array(days).fill(0);
  remaining[days - 1] = currentOpenCount;
  for (let i = days - 1; i > 0; i--) {
    remaining[i - 1] = remaining[i] - netChangePerDay[i];
  }

  return dayKeys.map((d, i) => ({
    dateLabel: d.toLocaleDateString('cs-CZ', { day: 'numeric', month: 'numeric' }),
    remaining: Math.max(0, remaining[i]),
  }));
}
