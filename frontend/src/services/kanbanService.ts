import { supabase, hasSupabaseConfig } from '../lib/supabase';
import { Column, Card, ChecklistItem, Comment, ActivityLog, TeamMember } from '../types/kanban';
import { INITIAL_COLUMNS, DEFAULT_MEMBERS } from '../data/dummyData';
import { localStore, isDefaultProject } from './storage/localStore';
import { persistenceStatus } from './persistence';

// Výchozí členství nového projektu = všichni výchozí členové workspace.
const DEFAULT_MEMBER_IDS = DEFAULT_MEMBERS.map((m) => m.id);

export interface Project {
  id: string;
  name: string;
  created_at?: string;
  user_id?: string;
  // Release 22: členství projektu = odkazy na workspace member ids.
  memberIds?: string[];
  // Legacy (R21): plné objekty členů uložené na projektu. Ponecháno jen
  // pro zpětnou kompatibilitu a jednorázovou migraci na memberIds.
  teamMembers?: TeamMember[];
}

// --- Databázové řádky (snake_case) ---

interface DbProject {
  id: string;
  name: string;
  created_at: string | null;
  user_id: string | null;
  member_ids: string[] | null;
  team_members: TeamMember[] | null;
}

interface DbColumn {
  id: string;
  name: string;
  project_id: string;
  position: number;
}

interface DbChecklistItem {
  id: string;
  card_id: string;
  text: string;
  completed: boolean;
}

interface DbComment {
  id: string;
  card_id: string;
  author_name: string;
  content: string;
  created_at: string;
}

interface DbActivity {
  id: string;
  card_id: string;
  text: string;
  created_at: string;
}

interface DbWorkspaceMemberLite {
  id: string;
  full_name: string;
  initials: string;
  avatar_color: string;
  email: string | null;
  profile_id: string | null;
  workspace_role: 'owner' | 'admin' | 'member' | null;
  created_at: string;
}

interface DbCardAssignee {
  position: number;
  member: DbWorkspaceMemberLite | null;
}

interface DbCard {
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

// --- Mapování DB <-> aplikační model (jediné místo pravdy) ---

function mapDbProject(row: DbProject): Project {
  return {
    id: row.id,
    name: row.name,
    created_at: row.created_at ?? undefined,
    user_id: row.user_id ?? undefined,
    memberIds: row.member_ids ?? undefined,
    teamMembers: row.team_members ?? undefined,
  };
}

function projectToDbRow(project: Project) {
  return {
    id: project.id,
    name: project.name,
    user_id: project.user_id ?? null,
    created_at: project.created_at,
    member_ids: project.memberIds ?? null,
    team_members: project.teamMembers ?? null,
  };
}

function mapDbCard(card: DbCard): Card {
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
      .map((c) => ({
        id: c.id,
        authorName: c.author_name,
        content: c.content,
        createdAt: c.created_at,
      }))
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
  };
}

function cardToDbFields(card: Card) {
  return {
    title: card.title,
    details: card.details,
    tag: card.tag || null,
    priority: card.priority || null,
    assignee_name: card.assignee?.name || null,
    assignee_initials: card.assignee?.initials || null,
    assignee_color: card.assignee?.color || null,
    assignees: card.assignees && card.assignees.length > 0 ? card.assignees : null,
    due_date: card.dueDate || null,
    archived: card.archived || false,
  };
}

/**
 * Uloží členství projektu (Release 23).
 * Kanonicky do relační tabulky project_members (diff: přidat/odebrat),
 * plus denormalizovaný mirror do projects.member_ids kvůli rychlému čtení.
 */
async function setDbProjectMembers(projectId: string, memberIds: string[]): Promise<void> {
  // 1. Denormalizovaný mirror na projektu (+ založení výchozího projektu)
  const { data, error } = await supabase
    .from('projects')
    .update({ member_ids: memberIds })
    .eq('id', projectId)
    .select('id');
  if (error) throw error;

  if ((!data || data.length === 0) && isDefaultProject(projectId)) {
    const { error: upsertError } = await supabase
      .from('projects')
      .upsert({ id: projectId, name: 'Vývoj MVP', member_ids: memberIds });
    if (upsertError) throw upsertError;
  } else if (!data || data.length === 0) {
    throw new Error(`Projekt ${projectId} nebyl v databázi nalezen.`);
  }

  // 2. Relační tabulka project_members -- diff proti aktuálnímu stavu
  const { data: existing, error: exErr } = await supabase
    .from('project_members')
    .select('member_id')
    .eq('project_id', projectId);
  if (exErr) throw exErr;

  const current = new Set((existing ?? []).map((r) => r.member_id as string));
  const next = new Set(memberIds);
  const toAdd = memberIds.filter((id) => !current.has(id));
  const toRemove = [...current].filter((id) => !next.has(id));

  if (toRemove.length > 0) {
    const { error: delErr } = await supabase
      .from('project_members')
      .delete()
      .eq('project_id', projectId)
      .in('member_id', toRemove);
    if (delErr) throw delErr;
  }
  if (toAdd.length > 0) {
    const { error: insErr } = await supabase
      .from('project_members')
      .insert(toAdd.map((member_id) => ({ project_id: projectId, member_id })));
    if (insErr) throw insErr;
  }
}

/**
 * Synchronizuje řešitele karty do relační tabulky card_assignees (Release 23).
 * Jednoduše smaže a znovu vloží (řešitelů je málo). JSONB mirror na kartě
 * spravuje cardToDbFields kvůli zpětné kompatibilitě a AI promptům.
 */
async function syncDbCardAssignees(cardId: string, assignees?: TeamMember[]): Promise<void> {
  const { error: delErr } = await supabase.from('card_assignees').delete().eq('card_id', cardId);
  if (delErr) throw delErr;

  const valid = (assignees ?? []).filter((m) => m.id && m.id !== 'member-fallback');
  if (valid.length === 0) return;

  const { error: insErr } = await supabase.from('card_assignees').insert(
    valid.map((m, index) => ({ card_id: cardId, member_id: m.id, position: index }))
  );
  if (insErr) throw insErr;
}

export const kanbanService = {
  // --- Project Operations ---
  async fetchProjects(userId?: string): Promise<Project[]> {
    if (!hasSupabaseConfig) {
      return localStore.getProjects(userId);
    }

    try {
      // Žádný ruční filtr na user_id -- RLS (is_project_member, viz
      // supabase_schema.sql sekce 16) sama vrátí sjednocení vlastních
      // i sdílených projektů, na které má uživatel pozvánkou členství.
      const { data, error } = await supabase
        .from('projects')
        .select('*')
        .order('created_at', { ascending: false });

      if (error) throw error;

      if ((!data || data.length === 0) && userId) {
        // První přihlášení: založit výchozí projekt v Supabase
        const defaultProj: Project = {
          id: `project-default-${userId}`,
          name: 'Vývoj MVP',
          user_id: userId,
          memberIds: DEFAULT_MEMBER_IDS,
        };

        const { error: insertError } = await supabase
          .from('projects')
          .insert(projectToDbRow(defaultProj));

        if (insertError) throw insertError;

        await this.seedInitialData(defaultProj.id);
        return [defaultProj];
      }

      return (data as DbProject[]).map(mapDbProject);
    } catch (error) {
      persistenceStatus.report('načtení projektů', error);
      return localStore.getProjects(userId);
    }
  },

  async createProject(name: string, userId?: string): Promise<Project> {
    const newProject: Project = {
      id: `project-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
      name,
      created_at: new Date().toISOString(),
      user_id: userId,
      memberIds: DEFAULT_MEMBER_IDS,
    };

    if (!hasSupabaseConfig) {
      localStore.addProject(newProject);
      localStore.getBoard(newProject.id);
      return newProject;
    }

    try {
      const { error } = await supabase.from('projects').insert(projectToDbRow(newProject));
      if (error) throw error;

      // Inicializace sloupců nového projektu (bez karet)
      await this.seedInitialData(newProject.id, true);

      persistenceStatus.clear();
      return newProject;
    } catch (error) {
      persistenceStatus.report('vytvoření projektu', error);
      throw error;
    }
  },

  async saveProjectColumns(projectId: string, columnNames: string[]): Promise<Column[]> {
    const columns: Column[] = columnNames.map((name, index) => ({
      id: `${projectId}-column-${index}-${Math.random().toString(36).substring(2, 6)}`,
      name,
      cards: [],
    }));

    if (!hasSupabaseConfig) {
      localStore.saveBoard(projectId, columns);
      return columns;
    }

    try {
      const { data: oldCols } = await supabase
        .from('columns')
        .select('id')
        .eq('project_id', projectId);

      if (oldCols && oldCols.length > 0) {
        const oldColIds = oldCols.map((c) => c.id);
        await supabase.from('cards').delete().in('column_id', oldColIds);
        await supabase.from('columns').delete().in('id', oldColIds);
      }

      const colInserts = columns.map((col, index) => ({
        id: col.id,
        project_id: projectId,
        name: col.name,
        position: index,
      }));

      const { error } = await supabase.from('columns').insert(colInserts);
      if (error) throw error;

      persistenceStatus.clear();
      return columns;
    } catch (error) {
      persistenceStatus.report('uložení sloupců projektu', error);
      throw error;
    }
  },

  async fetchProjectById(projectId: string): Promise<Project | null> {
    if (!hasSupabaseConfig) {
      return localStore.findProject(projectId);
    }

    try {
      const { data, error } = await supabase
        .from('projects')
        .select('*')
        .eq('id', projectId)
        .maybeSingle();

      if (error) throw error;

      if (!data) {
        // Výchozí projekt nemusí být v DB ještě naseedovaný
        if (isDefaultProject(projectId)) {
          return {
            id: projectId,
            name: 'Vývoj MVP',
            created_at: new Date().toISOString(),
            memberIds: DEFAULT_MEMBER_IDS,
          };
        }
        return null;
      }

      const project = mapDbProject(data as DbProject);

      // Release 23: členství preferuj z relační tabulky project_members,
      // fallback na denormalizovaný member_ids (před migrací / nový projekt).
      const { data: pmRows } = await supabase
        .from('project_members')
        .select('member_id')
        .eq('project_id', projectId);
      if (pmRows && pmRows.length > 0) {
        project.memberIds = pmRows.map((r) => r.member_id as string);
      }

      return project;
    } catch (error) {
      persistenceStatus.report('načtení projektu', error);
      return localStore.findProject(projectId);
    }
  },

  async deleteProject(projectId: string): Promise<void> {
    if (isDefaultProject(projectId)) {
      throw new Error('Výchozí projekt nelze odstranit.');
    }

    if (!hasSupabaseConfig) {
      localStore.removeProject(projectId);
      return;
    }

    try {
      const { error } = await supabase
        .from('projects')
        .delete()
        .eq('id', projectId);

      if (error) throw error;
      persistenceStatus.clear();
    } catch (error) {
      persistenceStatus.report('smazání projektu', error);
      throw error;
    }
  },

  // --- Board and Card Operations ---
  async fetchBoardData(projectId: string): Promise<Column[]> {
    if (!hasSupabaseConfig) {
      return localStore.getBoard(projectId);
    }

    try {
      // 1. Sloupce projektu
      const { data: dbColumns, error: colError } = await supabase
        .from('columns')
        .select('*')
        .eq('project_id', projectId)
        .order('position', { ascending: true });

      if (colError) throw colError;

      // Naseedovat výchozí sloupce, pokud žádné neexistují
      if (!dbColumns || dbColumns.length === 0) {
        return await this.seedInitialData(projectId);
      }

      // 2. Karty patřící do těchto sloupců
      const colIds = (dbColumns as DbColumn[]).map((col) => col.id);
      const { data: dbCards, error: cardError } = await supabase
        .from('cards')
        .select('*, task_checklists(*), task_comments(*), task_activities(*), card_assignees(position, member:workspace_members(*))')
        .in('column_id', colIds)
        .order('position', { ascending: true });

      if (cardError) throw cardError;

      // 3. Mapování na UI strukturu
      return (dbColumns as DbColumn[]).map((col) => ({
        id: col.id,
        name: col.name,
        cards: ((dbCards as DbCard[]) || [])
          .filter((card) => card.column_id === col.id)
          .map(mapDbCard),
      }));
    } catch (error) {
      persistenceStatus.report('načtení boardu', error);
      return localStore.getBoard(projectId);
    }
  },

  async seedInitialData(projectId: string, isEmpty = false): Promise<Column[]> {
    if (!hasSupabaseConfig) return localStore.getBoard(projectId);

    // Smazat staré sloupce (karty se smažou kaskádou)
    const { data: oldCols } = await supabase
      .from('columns')
      .select('id')
      .eq('project_id', projectId);

    if (oldCols && oldCols.length > 0) {
      const oldColIds = oldCols.map((c) => c.id);
      await supabase.from('cards').delete().in('column_id', oldColIds);
      await supabase.from('columns').delete().in('id', oldColIds);
    }

    const isDefault = isDefaultProject(projectId);
    const colInserts = INITIAL_COLUMNS.map((col, index) => ({
      id: isDefault ? col.id : `${projectId}-${col.id}`,
      project_id: projectId,
      name: col.name,
      position: index,
    }));

    const { error: colError } = await supabase.from('columns').insert(colInserts);
    if (colError) throw colError;

    // Karty seedovat jen u výchozího projektu
    const shouldSeedCards = !isEmpty && isDefault;

    if (shouldSeedCards) {
      const cardInserts: Array<Record<string, unknown>> = [];
      INITIAL_COLUMNS.forEach((col) => {
        col.cards.forEach((card, cardIndex) => {
          cardInserts.push({
            id: card.id,
            column_id: col.id,
            ...cardToDbFields(card),
            position: cardIndex,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          });
        });
      });

      if (cardInserts.length > 0) {
        const { error: cardError } = await supabase.from('cards').insert(cardInserts);
        if (cardError) throw cardError;
      }
    }

    return INITIAL_COLUMNS.map((col) => ({
      id: isDefault ? col.id : `${projectId}-${col.id}`,
      name: col.name,
      cards: shouldSeedCards ? col.cards.map((card) => ({ ...card })) : [],
    }));
  },

  async updateColumnName(columnId: string, name: string, projectId?: string): Promise<void> {
    if (!hasSupabaseConfig) {
      if (projectId) {
        const board = localStore.getBoard(projectId);
        localStore.saveBoard(
          projectId,
          board.map((col) => (col.id === columnId ? { ...col, name } : col))
        );
      }
      return;
    }
    const { error } = await supabase
      .from('columns')
      .update({ name })
      .eq('id', columnId);
    if (error) {
      persistenceStatus.report('přejmenování sloupce', error);
    } else {
      persistenceStatus.clear();
    }
  },

  async createCard(columnId: string, card: Card, position: number, projectId?: string): Promise<void> {
    if (!hasSupabaseConfig) {
      if (projectId) {
        const board = localStore.getBoard(projectId);
        const cardWithMeta = {
          ...card,
          createdAt: card.createdAt || new Date().toISOString(),
          updatedAt: card.updatedAt || new Date().toISOString(),
          archived: card.archived || false,
        };
        localStore.saveBoard(
          projectId,
          board.map((col) =>
            col.id === columnId ? { ...col, cards: [...col.cards, cardWithMeta] } : col
          )
        );
      }
      return;
    }
    const { error } = await supabase.from('cards').insert({
      id: card.id,
      column_id: columnId,
      ...cardToDbFields(card),
      position,
    });
    if (error) {
      persistenceStatus.report('vytvoření karty', error);
      return;
    }
    try {
      await syncDbCardAssignees(card.id, card.assignees);
      persistenceStatus.clear();
    } catch (err) {
      persistenceStatus.report('uložení řešitelů karty', err);
    }
  },

  async updateCard(columnId: string, card: Card, projectId?: string): Promise<void> {
    if (!hasSupabaseConfig) {
      if (projectId) {
        const board = localStore.getBoard(projectId);
        localStore.saveBoard(
          projectId,
          board.map((col) =>
            col.id === columnId
              ? {
                  ...col,
                  cards: col.cards.map((c) =>
                    c.id === card.id ? { ...card, updatedAt: new Date().toISOString() } : c
                  ),
                }
              : col
          )
        );
      }
      return;
    }
    const { error } = await supabase
      .from('cards')
      .update({
        ...cardToDbFields(card),
        updated_at: new Date().toISOString(),
      })
      .eq('id', card.id);
    if (error) {
      persistenceStatus.report('uložení karty', error);
      return;
    }
    try {
      await syncDbCardAssignees(card.id, card.assignees);
      persistenceStatus.clear();
    } catch (err) {
      persistenceStatus.report('uložení řešitelů karty', err);
    }
  },

  async archiveCard(cardId: string, archived: boolean): Promise<void> {
    if (!hasSupabaseConfig) return;
    const { error } = await supabase
      .from('cards')
      .update({ archived, updated_at: new Date().toISOString() })
      .eq('id', cardId);
    if (error) {
      persistenceStatus.report('archivace karty', error);
    } else {
      persistenceStatus.clear();
    }
  },

  async deleteCard(cardId: string, columnId?: string, projectId?: string): Promise<void> {
    if (!hasSupabaseConfig) {
      if (projectId && columnId) {
        const board = localStore.getBoard(projectId);
        localStore.saveBoard(
          projectId,
          board.map((col) =>
            col.id === columnId ? { ...col, cards: col.cards.filter((c) => c.id !== cardId) } : col
          )
        );
      }
      return;
    }
    const { error } = await supabase.from('cards').delete().eq('id', cardId);
    if (error) {
      persistenceStatus.report('smazání karty', error);
    } else {
      persistenceStatus.clear();
    }
  },

  async moveCard(
    cardId: string,
    sourceColumnId: string,
    destinationColumnId: string,
    newPosition: number,
    projectId?: string
  ): Promise<void> {
    if (!hasSupabaseConfig) {
      if (projectId) {
        const board = localStore.getBoard(projectId);
        const sourceCol = board.find((col) => col.id === sourceColumnId);
        const cardToMove = sourceCol?.cards.find((c) => c.id === cardId);
        if (cardToMove) {
          localStore.saveBoard(
            projectId,
            board.map((col) => {
              if (col.id === sourceColumnId) {
                return { ...col, cards: col.cards.filter((c) => c.id !== cardId) };
              }
              if (col.id === destinationColumnId) {
                return { ...col, cards: [...col.cards, cardToMove] };
              }
              return col;
            })
          );
        }
      }
      return;
    }
    const { error } = await supabase
      .from('cards')
      .update({
        column_id: destinationColumnId,
        position: newPosition,
      })
      .eq('id', cardId);

    if (error) {
      persistenceStatus.report('přesun karty', error);
    } else {
      persistenceStatus.clear();
    }
  },

  async addChecklistItem(cardId: string, item: ChecklistItem): Promise<void> {
    if (!hasSupabaseConfig) return;
    const { error } = await supabase.from('task_checklists').insert({
      id: item.id,
      card_id: cardId,
      text: item.text,
      completed: item.completed,
    });
    if (error) persistenceStatus.report('uložení položky checklistu', error);
  },

  async updateChecklistItem(item: ChecklistItem): Promise<void> {
    if (!hasSupabaseConfig) return;
    const { error } = await supabase
      .from('task_checklists')
      .update({
        text: item.text,
        completed: item.completed,
      })
      .eq('id', item.id);
    if (error) persistenceStatus.report('uložení položky checklistu', error);
  },

  async deleteChecklistItem(itemId: string): Promise<void> {
    if (!hasSupabaseConfig) return;
    const { error } = await supabase.from('task_checklists').delete().eq('id', itemId);
    if (error) persistenceStatus.report('smazání položky checklistu', error);
  },

  async addComment(cardId: string, comment: Comment): Promise<void> {
    if (!hasSupabaseConfig) return;
    const { error } = await supabase.from('task_comments').insert({
      id: comment.id,
      card_id: cardId,
      author_name: comment.authorName,
      content: comment.content,
      created_at: comment.createdAt,
    });
    if (error) persistenceStatus.report('uložení komentáře', error);
  },

  async addActivity(cardId: string, activity: ActivityLog): Promise<void> {
    if (!hasSupabaseConfig) return;
    const { error } = await supabase.from('task_activities').insert({
      id: activity.id,
      card_id: cardId,
      text: activity.text,
      created_at: activity.createdAt,
    });
    if (error) persistenceStatus.report('uložení aktivity', error);
  },

  async createColumn(projectId: string, name: string, position: number): Promise<Column> {
    const newCol: Column = {
      id: `${projectId}-column-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
      name,
      cards: [],
    };

    if (!hasSupabaseConfig) {
      const board = localStore.getBoard(projectId);
      localStore.saveBoard(projectId, [...board, newCol]);
      return newCol;
    }

    try {
      const { error } = await supabase.from('columns').insert({
        id: newCol.id,
        project_id: projectId,
        name,
        position,
      });
      if (error) throw error;
      persistenceStatus.clear();
      return newCol;
    } catch (error) {
      persistenceStatus.report('vytvoření sloupce', error);
      throw error;
    }
  },

  async deleteColumn(projectId: string, columnId: string): Promise<void> {
    if (!hasSupabaseConfig) {
      const board = localStore.getBoard(projectId);
      localStore.saveBoard(projectId, board.filter((col) => col.id !== columnId));
      return;
    }

    try {
      await supabase.from('cards').delete().eq('column_id', columnId);
      const { error } = await supabase.from('columns').delete().eq('id', columnId);
      if (error) throw error;
      persistenceStatus.clear();
    } catch (error) {
      persistenceStatus.report('smazání sloupce', error);
      throw error;
    }
  },

  async reorderColumns(projectId: string, columns: Column[]): Promise<void> {
    if (!hasSupabaseConfig) {
      localStore.saveBoard(projectId, columns);
      return;
    }

    try {
      const updates = columns.map((col, index) =>
        supabase
          .from('columns')
          .update({ position: index })
          .eq('id', col.id)
      );
      const results = await Promise.all(updates);
      const failed = results.find((r) => r.error);
      if (failed?.error) throw failed.error;
      persistenceStatus.clear();
    } catch (error) {
      persistenceStatus.report('změna pořadí sloupců', error);
      throw error;
    }
  },

  async restoreProjectSnapshot(
    projectId: string,
    boardData: Column[] | null,
    projectsList: Project[] | null
  ): Promise<void> {
    // 1. Obnovení seznamu projektů
    if (projectsList) {
      if (!hasSupabaseConfig) {
        localStore.saveProjects(projectsList);
      } else {
        try {
          const existingProjIds = projectsList.map((p) => p.id);
          const { data: dbProjs } = await supabase.from('projects').select('id');
          if (dbProjs) {
            const dbProjIds = dbProjs.map((p) => p.id);
            const toDelete = dbProjIds.filter((id) => !existingProjIds.includes(id));
            if (toDelete.length > 0) {
              await supabase.from('projects').delete().in('id', toDelete);
            }
          }
          for (const p of projectsList) {
            const { error } = await supabase.from('projects').upsert(projectToDbRow(p));
            if (error) throw error;
          }
        } catch (error) {
          persistenceStatus.report('obnovení projektů ze zálohy', error);
          throw error;
        }
      }
    }

    // 2. Obnovení boardu (sloupce a karty)
    if (boardData) {
      if (!hasSupabaseConfig) {
        localStore.saveBoard(projectId, boardData);
      } else {
        try {
          const { data: oldCols } = await supabase
            .from('columns')
            .select('id')
            .eq('project_id', projectId);

          if (oldCols && oldCols.length > 0) {
            const oldColIds = oldCols.map((c) => c.id);
            await supabase.from('cards').delete().in('column_id', oldColIds);
            await supabase.from('columns').delete().in('id', oldColIds);
          }

          const colInserts = boardData.map((col, index) => ({
            id: col.id,
            project_id: projectId,
            name: col.name,
            position: index,
          }));
          const { error: colError } = await supabase.from('columns').insert(colInserts);
          if (colError) throw colError;

          for (const col of boardData) {
            for (let cardIndex = 0; cardIndex < col.cards.length; cardIndex++) {
              const card = col.cards[cardIndex];
              const { error: cardError } = await supabase.from('cards').insert({
                id: card.id,
                column_id: col.id,
                ...cardToDbFields(card),
                position: cardIndex,
              });
              if (cardError) throw cardError;

              await syncDbCardAssignees(card.id, card.assignees);

              if (card.checklist && card.checklist.length > 0) {
                await supabase.from('task_checklists').insert(
                  card.checklist.map((item) => ({
                    id: item.id,
                    card_id: card.id,
                    text: item.text,
                    completed: item.completed,
                  }))
                );
              }

              if (card.comments && card.comments.length > 0) {
                await supabase.from('task_comments').insert(
                  card.comments.map((c) => ({
                    id: c.id,
                    card_id: card.id,
                    author_name: c.authorName,
                    content: c.content,
                    created_at: c.createdAt,
                  }))
                );
              }

              if (card.activities && card.activities.length > 0) {
                await supabase.from('task_activities').insert(
                  card.activities.map((a) => ({
                    id: a.id,
                    card_id: card.id,
                    text: a.text,
                    created_at: a.createdAt,
                  }))
                );
              }
            }
          }
          persistenceStatus.clear();
        } catch (error) {
          persistenceStatus.report('obnovení boardu ze zálohy', error);
          throw error;
        }
      }
    } else {
      await this.deleteProject(projectId);
    }
  },

  // --- Project Membership (Release 22) ---
  // Identita členů žije ve workspaceService. Projekt pouze uchovává výběr
  // (member_ids). Řešitelé karet se re-resolvují proti workspace při načtení
  // boardu v useKanbanBoard, takže se úpravy/mazání identit projeví automaticky.

  async setProjectMembers(projectId: string, memberIds: string[]): Promise<void> {
    if (!hasSupabaseConfig) {
      localStore.setProjectMembers(projectId, memberIds);
      return;
    }

    try {
      await setDbProjectMembers(projectId, memberIds);
      persistenceStatus.clear();
    } catch (error) {
      persistenceStatus.report('uložení členů projektu', error);
      throw error;
    }
  },
};
