import { Card, Column, Comment, TeamMember } from '../types/kanban';

/**
 * Mapování řádků DB -> aplikační model karty (čistý modul bez závislosti na
 * Supabase klientovi, použitelný v prohlížeči i na serveru).
 */

export interface DbChecklistItem {
  id: string;
  card_id: string;
  text: string;
  completed: boolean;
}

export interface DbComment {
  id: string;
  card_id: string;
  author_name: string;
  content: string;
  created_at: string;
  author_id?: string | null;
  updated_at?: string | null;
  mentions?: string[] | null;
  origin?: 'app' | 'import' | 'legacy' | null;
}

export interface DbActivity {
  id: string;
  card_id: string;
  text: string;
  created_at: string;
}

export interface DbWorkspaceMemberLite {
  id: string;
  full_name: string;
  initials: string;
  avatar_color: string;
  email: string | null;
  profile_id: string | null;
  workspace_role: 'owner' | 'admin' | 'member' | null;
  created_at: string;
}

export interface DbCardAssignee {
  position: number;
  member: DbWorkspaceMemberLite | null;
}

export interface DbCard {
  id: string;
  column_id: string;
  title: string;
  details: string;
  tag: string | null;
  priority: 'Low' | 'Medium' | 'High' | null;
  assignee_name: string | null;
  assignee_initials: string | null;
  assignee_color: string | null;
  assignees: TeamMember[] | null;
  card_assignees?: DbCardAssignee[];
  due_date: string | null;
  position: number;
  task_checklists?: DbChecklistItem[];
  task_comments?: DbComment[];
  task_activities?: DbActivity[];
  archived: boolean;
  created_at: string;
  updated_at: string;
  project_id?: string | null;
  version?: number | null;
  child_rev?: number | null;
}

function mapDbMemberLite(row: DbWorkspaceMemberLite): TeamMember {
  return {
    id: row.id,
    fullName: row.full_name,
    initials: row.initials,
    avatarColor: row.avatar_color,
    email: row.email ?? undefined,
    profileId: row.profile_id ?? undefined,
    workspaceRole: row.workspace_role ?? 'member',
    createdAt: row.created_at,
  };
}

export function mapDbComment(c: DbComment): Comment {
  return {
    id: c.id,
    authorName: c.author_name,
    content: c.content,
    createdAt: c.created_at,
    authorId: c.author_id ?? undefined,
    updatedAt: c.updated_at ?? undefined,
    mentions: c.mentions ?? undefined,
    origin: c.origin ?? undefined,
  };
}

export function mapDbCard(card: DbCard): Card {
  return {
    id: card.id,
    title: card.title,
    details: card.details || '',
    tag: card.tag || undefined,
    priority: card.priority || undefined,
    assignee: card.assignee_name
      ? {
          name: card.assignee_name,
          initials: card.assignee_initials || '',
          color: card.assignee_color || '#888888',
        }
      : undefined,
    // Release 23: řešitelé z relační tabulky card_assignees (preferováno),
    // fallback na JSONB (před migrací) a nakonec na legacy jednořešitele.
    assignees: (card.card_assignees && card.card_assignees.length > 0)
      ? [...card.card_assignees]
          .sort((a, b) => a.position - b.position)
          .filter((ca) => ca.member)
          .map((ca) => mapDbMemberLite(ca.member!))
      : (card.assignees || (card.assignee_name
        ? [{
            id: 'member-fallback',
            fullName: card.assignee_name,
            initials: card.assignee_initials || '',
            avatarColor: card.assignee_color || '#888888',
            createdAt: new Date().toISOString(),
          }]
        : [])),
    dueDate: card.due_date || undefined,
    checklist: (card.task_checklists || []).map((item) => ({
      id: item.id,
      text: item.text,
      completed: item.completed,
    })),
    comments: (card.task_comments || [])
      .map(mapDbComment)
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()),
    activities: (card.task_activities || [])
      .map((a) => ({
        id: a.id,
        text: a.text,
        createdAt: a.created_at,
      }))
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()),
    archived: card.archived || false,
    createdAt: card.created_at,
    updatedAt: card.updated_at,
    version: card.version ?? undefined,
    childRev: card.child_rev ?? undefined,
  };
}

/**
 * Záloha boardu -> JSON pro RPC restore_project_board (jedna transakce na serveru).
 * Zrcadlí cardToDbFields; děti karty (checklist, komentáře, aktivity) jdou s kartou.
 */
export function boardToRestorePayload(columns: Column[]) {
  return {
    columns: columns.map((col) => ({
      id: col.id,
      name: col.name,
      cards: col.cards.map((card) => ({
        id: card.id,
        title: card.title,
        details: card.details,
        tag: card.tag || null,
        priority: card.priority || null,
        assignee_name: card.assignee?.name || null,
        assignee_initials: card.assignee?.initials || null,
        assignee_color: card.assignee?.color || null,
        assignees: card.assignees && card.assignees.length > 0 ? card.assignees : null,
        assignee_ids: (card.assignees ?? []).map((m) => m.id).filter((id) => id && id !== 'member-fallback'),
        due_date: card.dueDate || null,
        archived: card.archived || false,
        created_at: card.createdAt || null,
        updated_at: card.updatedAt || null,
        checklist: (card.checklist ?? []).map((i) => ({ id: i.id, text: i.text, completed: i.completed })),
        comments: (card.comments ?? []).map((c) => ({
          id: c.id,
          author_name: c.authorName,
          content: c.content,
          created_at: c.createdAt,
        })),
        activities: (card.activities ?? []).map((a) => ({ id: a.id, text: a.text, created_at: a.createdAt })),
      })),
    })),
  };
}
