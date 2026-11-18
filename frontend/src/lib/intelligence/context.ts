import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Card, Column, ProjectActivityLog } from '../../types/kanban';
import { loadBoard } from '../ai/board';
import { mapActivityRows, mapItemRows } from './mappers';
export { mapActivityRows, mapItemRows };
import { columnRole } from '../projectIntelligence';
import { computeProjectFacts, DEFAULT_TZ, FACTS_VERSION, type ProjectFacts, type ProjectItemLite } from './facts';
import { frameUntrusted, sanitizeDeep } from './frame';
import type { SourceRecord } from './types';

/**
 * Project Context Engine (ARCHITECTURE §6): jediná serverová vrstva, která z DB (pod identitou volajícího,
 * tedy přes RLS) sestaví kontext pro každou AI featuru:
 *   - deterministická fakta (kód, ne model),
 *   - adresovatelné zdroje (`ref`), které smí model citovat,
 *   - omezený, rámovaný text do promptu.
 */

export type ContextPurpose = 'brief' | 'chat' | 'meeting' | 'daily' | 'pm' | 'risk' | 'capacity' | 'improve';

export const CONTEXT_BUDGETS: Record<ContextPurpose, number> = {
  brief: 120_000,
  chat: 60_000,
  meeting: 20_000,
  // R7: existující featury sdílí tentýž engine; rozpočet podle toho, kolik kontextu daná úloha opravdu potřebuje
  daily: 40_000,
  pm: 80_000,
  risk: 80_000,
  capacity: 60_000,
  improve: 40_000,
};

const ACTIVITY_LIMIT = 100;
const ITEM_LIMIT = 200;
const ITEM_STATES = ['proposed', 'accepted', 'applied'];
const DETAILS_CAP = 600;
const COMMENT_CAP = 500;
const COMMENTS_PER_CARD = 3;
const CHECKLIST_PER_CARD = 10;
const RECENT_CARD_DAYS = 14;

export interface ProjectContext {
  project: { id: string; name: string };
  columns: Column[];
  facts: ProjectFacts;
  sources: SourceRecord[];
  /** Omezený text pro prompt (fakta + rámovaná data). */
  rendered: string;
  /** sha256(rendered + FACTS_VERSION): klíč cache a detekce zastaralosti. */
  fingerprint: string;
  truncated: { kind: string; omitted: number }[];
  /** Id všech přijatých/použitých závěrů z porad (ne jen těch, co se vešly do promptu); vstup podpisu čerstvosti. */
  knowledgeItemIds: string[];
}

export interface ContextOptions {
  purpose: ContextPurpose;
  focus?: { cardId?: string };
  budgetChars?: number;
  now?: Date;
  tz?: string;
}

export interface ProjectData {
  project: { id: string; name: string };
  columns: Column[];
  activities: ProjectActivityLog[];
  /** Návrhy a závěry z porad (proposed/accepted/applied); chybí-li tabulka (starší DB), je to prázdné pole. */
  items?: ProjectItemLite[];
}

/** Gramatika ref: typ:id. Id jsou klientem generované TEXT identifikátory, proto jen negativní omezení. */
export const REF_PATTERN = /^(card|comment|check|activity|item):[^\s\]\[#]{1,200}$|^meeting:[^\s\]\[#]{1,200}#[^\s\]\[#]{1,200}$/;

export const cardRef = (id: string) => `card:${id}`;
export const commentRef = (id: string) => `comment:${id}`;
export const checkRef = (id: string) => `check:${id}`;
export const activityRef = (id: string) => `activity:${id}`;
export const meetingRef = (meetingId: string, segmentId: string) => `meeting:${meetingId}#${segmentId}`;
export const itemRef = (id: string) => `item:${id}`;

function clip(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Načte projekt + board + poslední aktivity + závěry z porad pod identitou volajícího (RLS). */
export async function loadProjectData(db: SupabaseClient, projectId: string): Promise<ProjectData> {
  const { project, columns } = await loadBoard(db, projectId);
  const { data } = await db
    .from('activity_logs')
    .select('id, card_id, actor_id, actor_name, action_type, entity_type, details, created_at')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false })
    .limit(ACTIVITY_LIMIT);
  // Závěry z porad: chyba (např. migrace ještě není v DB) kontext nerozbije, jen zůstane bez nich.
  const { data: itemRows, error: itemErr } = await db
    .from('intelligence_items')
    .select('id, meeting_id, kind, text, review_state, decided_at, created_at, applied_card_id')
    .eq('project_id', projectId)
    .in('review_state', ITEM_STATES)
    .order('created_at', { ascending: false })
    .limit(ITEM_LIMIT);
  return { project, columns, activities: mapActivityRows(data, projectId), items: itemErr ? [] : mapItemRows(itemRows) };
}

interface Item {
  tier: number;
  kind: 'card' | 'comment' | 'check' | 'activity' | 'item';
  key: string; // pro dohledání při vykreslení
  cost: number;
}

function cardLine(card: Card, colName: string): string {
  const who = (card.assignees ?? []).map((a) => a.fullName).filter(Boolean);
  if (who.length === 0 && card.assignee?.name) who.push(card.assignee.name);
  const parts = [
    `sloupec: ${colName}`,
    card.priority ? `priorita: ${card.priority}` : null,
    card.dueDate ? `termín: ${card.dueDate}` : null,
    who.length ? `řešitelé: ${who.join(', ')}` : 'řešitelé: nikdo',
    card.tag ? `tag: ${card.tag}` : null,
  ].filter(Boolean);
  return `[${cardRef(card.id)}] "${clip(card.title, 200)}" | ${parts.join(' | ')}`;
}

function activityText(a: ProjectActivityLog): string {
  const d = a.details ? clip(JSON.stringify(a.details), 160) : '';
  const card = a.cardId ? ` (${cardRef(a.cardId)})` : '';
  return `${a.createdAt.slice(0, 10)} ${a.actorName || 'systém'}: ${a.actionType}${card}${d ? ` ${d}` : ''}`;
}

/**
 * Čistá část: z načtených dat sestaví kontext. Bez IO, deterministická (testovatelná).
 * Pořadí důležitosti při ořezu (ARCHITECTURE §6.4): fakta → fokus → blokované/po termínu →
 * nedávno změněné karty → aktivita → ostatní karty → komentáře a checklisty.
 */
export function assembleContext(data: ProjectData, opts: ContextOptions): ProjectContext {
  const now = opts.now ?? new Date();
  const tz = opts.tz ?? DEFAULT_TZ;
  const budget = opts.budgetChars ?? CONTEXT_BUDGETS[opts.purpose];
  const facts = computeProjectFacts(data.columns, data.activities, now, tz, data.items ?? []);

  const cards = new Map<string, { card: Card; colName: string; colIdx: number; pos: number }>();
  data.columns.forEach((col, colIdx) =>
    col.cards.forEach((card, pos) => {
      if (!card.archived) cards.set(card.id, { card, colName: col.name, colIdx, pos });
    })
  );

  const recentCut = now.getTime() - RECENT_CARD_DAYS * 86_400_000;
  const prio = new Set<string>([...facts.lists.blockedCardIds, ...facts.lists.overdueCardIds]);
  const tierOf = (id: string, card: Card): number => {
    if (opts.focus?.cardId === id) return 1;
    if (prio.has(id)) return 2;
    const u = Date.parse(card.updatedAt ?? '');
    if (Number.isFinite(u) && u >= recentCut) return 3.5;
    return 5;
  };

  const sources = new Map<string, SourceRecord>();
  const items: Item[] = [];
  const lineOf = new Map<string, string>();
  const detailOf = new Map<string, string>();

  for (const [id, { card, colName }] of cards) {
    const details = clip(card.details || '', DETAILS_CAP);
    detailOf.set(id, details);
    const line = cardLine(card, colName);
    lineOf.set(id, line);
    items.push({ tier: tierOf(id, card), kind: 'card', key: id, cost: line.length + details.length + 12 });
    sources.set(cardRef(id), {
      ref: cardRef(id),
      kind: 'card',
      text: details ? `${clip(card.title, 200)}\n${details}` : clip(card.title, 200),
      label: clip(card.title, 80),
      at: card.updatedAt ?? null,
      meta: {
        column: colName,
        priority: card.priority ?? null,
        dueDate: card.dueDate ?? null,
        tag: card.tag ?? null,
        assignees: (card.assignees ?? []).map((a) => a.fullName),
      },
    });
    const comments = [...(card.comments ?? [])]
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .slice(0, COMMENTS_PER_CARD);
    for (const c of comments) {
      const text = clip(c.content, COMMENT_CAP);
      items.push({ tier: 6, kind: 'comment', key: `${id}\u0000${c.id}`, cost: text.length + c.authorName.length + 40 });
      sources.set(commentRef(c.id), {
        ref: commentRef(c.id),
        kind: 'comment',
        text,
        label: `${c.authorName}`,
        at: c.createdAt,
        meta: { cardId: id, author: c.authorName },
      });
    }
    for (const ch of (card.checklist ?? []).slice(0, CHECKLIST_PER_CARD)) {
      const text = clip(ch.text, 200);
      items.push({ tier: 6, kind: 'check', key: `${id}\u0000${ch.id}`, cost: text.length + 30 });
      sources.set(checkRef(ch.id), {
        ref: checkRef(ch.id),
        kind: 'check',
        text,
        at: null,
        meta: { cardId: id, completed: ch.completed },
      });
    }
  }
  for (const a of data.activities) {
    const text = activityText(a);
    items.push({ tier: 4, kind: 'activity', key: a.id, cost: text.length + 20 });
    sources.set(activityRef(a.id), { ref: activityRef(a.id), kind: 'activity', text, at: a.createdAt, meta: { actionType: a.actionType, cardId: a.cardId ?? null } });
  }

  // Přijaté závěry z porad (accepted/applied) jsou citovatelné; nepřijaté návrhy AI se jako zdroj NIKDY nepoužijí.
  const knowledge = (data.items ?? []).filter((i) => i.reviewState === 'accepted' || i.reviewState === 'applied');
  const itemLineOf = new Map<string, string>();
  for (const it of knowledge) {
    const text = clip(it.text, 400);
    const line = `[${itemRef(it.id)}] ${it.kind}: ${text}`;
    itemLineOf.set(it.id, line);
    items.push({ tier: 3, kind: 'item', key: it.id, cost: line.length + 10 });
    sources.set(itemRef(it.id), {
      ref: itemRef(it.id),
      kind: 'item',
      text,
      label: clip(text, 80),
      at: it.decidedAt ?? it.createdAt,
      meta: { kind: it.kind, reviewState: it.reviewState, meetingId: it.meetingId, appliedCardId: it.appliedCardId },
    });
  }

  // --- výběr podle priority a rozpočtu ---
  const factsBlock = `FACTS (spočítáno aplikací, závazné; verze ${FACTS_VERSION}):\n${JSON.stringify(factsForPrompt(facts))}`;
  let used = factsBlock.length + data.project.name.length + 200; // rezerva na hlavičky
  const included = new Set<string>();
  const omitted = { card: 0, comment: 0, check: 0, activity: 0, item: 0 };
  const includedCards = new Set<string>();

  const ordered = items
    .map((it, i) => ({ it, i }))
    .sort((a, b) => a.it.tier - b.it.tier || a.i - b.i)
    .map((x) => x.it);
  for (const it of ordered) {
    const cardId = it.kind === 'comment' || it.kind === 'check' ? it.key.split('\u0000')[0] : null;
    // komentář/checklist jen k zahrnuté kartě
    if (cardId !== null && !includedCards.has(cardId)) {
      omitted[it.kind] += 1;
      continue;
    }
    if (used + it.cost > budget) {
      omitted[it.kind] += 1;
      continue;
    }
    used += it.cost;
    included.add(`${it.kind}:${it.key}`);
    if (it.kind === 'card') includedCards.add(it.key);
  }

  // --- vykreslení v přirozeném pořadí (sloupce, pozice) ---
  const lines: string[] = [];
  const colOrder = [...cards.values()]
    .filter((c) => included.has(`card:${c.card.id}`))
    .sort((a, b) => a.colIdx - b.colIdx || a.pos - b.pos);
  for (const { card } of colOrder) {
    lines.push(lineOf.get(card.id)!);
    const d = detailOf.get(card.id);
    if (d) lines.push(`  popis: ${d}`);
    for (const c of card.comments ?? []) {
      if (included.has(`comment:${card.id}\u0000${c.id}`)) lines.push(`  [${commentRef(c.id)}] ${c.authorName}: ${clip(c.content, COMMENT_CAP)}`);
    }
    for (const ch of card.checklist ?? []) {
      if (included.has(`check:${card.id}\u0000${ch.id}`)) lines.push(`  [${checkRef(ch.id)}] [${ch.completed ? 'x' : ' '}] ${clip(ch.text, 200)}`);
    }
  }
  const actLines = data.activities
    .filter((a) => included.has(`activity:${a.id}`))
    .map((a) => `[${activityRef(a.id)}] ${activityText(a)}`);

  const itemLines = knowledge.filter((i) => included.has(`item:${i.id}`)).map((i) => itemLineOf.get(i.id)!);

  // zdroje, které model nedostal, z mapy odstraníme (cituje jen to, co viděl)
  for (const [ref] of sources) {
    const [kind, rest] = [ref.slice(0, ref.indexOf(':')), ref.slice(ref.indexOf(':') + 1)];
    if (kind === 'card' && !included.has(`card:${rest}`)) sources.delete(ref);
    else if (kind === 'activity' && !included.has(`activity:${rest}`)) sources.delete(ref);
    else if (kind === 'item' && !included.has(`item:${rest}`)) sources.delete(ref);
  }
  const keptCommentIds = new Set<string>();
  for (const { card } of colOrder)
    for (const c of card.comments ?? []) if (included.has(`comment:${card.id}\u0000${c.id}`)) keptCommentIds.add(c.id);
  const keptCheckIds = new Set<string>();
  for (const { card } of colOrder)
    for (const ch of card.checklist ?? []) if (included.has(`check:${card.id}\u0000${ch.id}`)) keptCheckIds.add(ch.id);
  for (const [ref, s] of sources) {
    if (s.kind === 'comment' && !keptCommentIds.has(ref.slice(8))) sources.delete(ref);
    if (s.kind === 'check' && !keptCheckIds.has(ref.slice(6))) sources.delete(ref);
  }

  const truncated = (Object.entries(omitted) as [string, number][])
    .filter(([, n]) => n > 0)
    .map(([kind, n]) => ({ kind, omitted: n }));

  const body = [
    `PROJEKT: ${data.project.name} (id ${data.project.id})`,
    '',
    '--- Sloupce (id | název | role | aktivních karet); id sloupce použijte, kdy je třeba cílový sloupec ---',
    ...data.columns.map((c) => `column ${c.id} | "${clip(c.name, 80)}" | role: ${columnRole(c) ?? 'neurčena'} | karet: ${c.cards.filter((k) => !k.archived).length}`),
    '',
    '--- Karty (sloupec, termín, řešitelé jsou fakta z databáze) ---',
    ...lines,
    '',
    '--- Nedávná aktivita (nejnovější první) ---',
    ...actLines,
    ...(itemLines.length ? ['', '--- Přijaté závěry z porad (schváleno člověkem) ---', ...itemLines] : []),
  ].join('\n');

  const note = truncated.length
    ? `\nPOZNÁMKA: kontext je ZKRÁCENÝ kvůli limitu velikosti (vynecháno: ${truncated.map((t) => `${t.kind} ${t.omitted}`).join(', ')}). Neříkejte, že něco neexistuje jen proto, že to tu není.`
    : '';
  const rendered = `${factsBlock}\n\n${frameUntrusted('PROJECT', body)}${note}`;
  const fingerprint = createHash('sha256').update(`${rendered}\n${FACTS_VERSION}`).digest('hex');

  return {
    project: data.project,
    columns: data.columns,
    facts,
    sources: [...sources.values()],
    rendered,
    fingerprint,
    truncated,
    knowledgeItemIds: knowledge.map((i) => i.id),
  };
}

/** Fakta bez položek, které jen duplikují text (insights mají lidskou formulaci). */
function factsForPrompt(f: ProjectFacts) {
  return sanitizeDeep({
    today: f.today,
    health: { score: f.health.score, level: f.health.level, reason: f.health.reason },
    counts: f.counts,
    lists: f.lists,
    recentChanges: {
      windowDays: f.recentChanges.windowDays,
      created: f.recentChanges.created,
      movedToDone: f.recentChanges.movedToDone,
      archived: f.recentChanges.archived,
      memberChanges: f.recentChanges.memberChanges,
    },
    meetingDerived: f.meetingDerived,
    workload: f.workload,
    dataQuality: f.dataQuality,
  });
}

export async function buildProjectContext(
  db: SupabaseClient,
  projectId: string,
  opts: ContextOptions
): Promise<ProjectContext> {
  return assembleContext(await loadProjectData(db, projectId), opts);
}
