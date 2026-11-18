import { supabase, hasSupabaseConfig } from '../lib/supabase';
import { Column, Card, ChecklistItem, Comment, ActivityLog, TeamMember, ColumnRole } from '../types/kanban';
import { DEFAULT_MEMBERS } from '../data/dummyData';
import { localStore, isDefaultProject } from './storage/localStore';
import { buildSeedBoard } from './storage/seedBoard';
import { persistenceStatus } from './persistence';
import { mapDbCard, boardToRestorePayload } from './boardMapping';
import type { DbCard } from './boardMapping';

// Výchozí členství nového projektu = všichni výchozí členové workspace.
const DEMO_MEMBER_IDS = DEFAULT_MEMBERS.map((m) => m.id);
/**
 * Member ids a NEW project starts with. Demo mode has the demo roster (member-1..4). With a real account those
 * ids do not exist in the user's workspace, so the board showed NO assignable members at all (verified on the
 * hosted project). Left undefined, the board derives "all workspace members" (the owner) and persists that.
 */
const defaultMemberIds = (): string[] | undefined => (hasSupabaseConfig ? undefined : DEMO_MEMBER_IDS);

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
  role?: ColumnRole | null;
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

/** Postgres unique_violation: for seed inserts it means a concurrent run already created the same rows. */
const isDuplicateKey = (error: { code?: string } | null | undefined) => error?.code === '23505';

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
          memberIds: defaultMemberIds(),
        };

        // Idempotent: two concurrent first loads (React strict-mode double mount, two tabs) both reach this
        // point; the loser's INSERT fails with 23505 which means "somebody already created it" -- not an error.
        // (ON CONFLICT DO NOTHING / upsert is NOT usable here: PostgREST's upsert path is refused by RLS.)
        const { error: insertError } = await supabase
          .from('projects')
          .insert(projectToDbRow(defaultProj));

        if (insertError && !isDuplicateKey(insertError)) throw insertError;

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
      memberIds: defaultMemberIds(),
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
            memberIds: defaultMemberIds(),
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
        role: col.role ?? null,
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

    // NOTE: seeding NEVER deletes. It used to wipe the project's columns (and, by cascade, cards) before
    // inserting; with two concurrent first loads the second run deleted the first run's fresh board and the
    // inserts then collided (23505 / RLS 403 on the next card). Seed rows have deterministic, project-scoped
    // ids, so tolerating 23505 makes the operation idempotent and race-safe.
    // Karty seedovat jen u výchozího projektu. ID jsou vždy s prefixem
    // projektu -- columns.id a cards.id jsou globální primární klíče, holé
    // 'column-1' / 'card-1' by kolidovaly mezi uživateli (viz seedBoard.ts).
    const shouldSeedCards = !isEmpty && isDefaultProject(projectId);
    const seeded = buildSeedBoard(projectId, shouldSeedCards);

    const { error: colError } = await supabase.from('columns').insert(
      seeded.map((col, index) => ({
        id: col.id,
        project_id: projectId,
        name: col.name,
        position: index,
      }))
    );
    // 23505: a concurrent seed already inserted the same deterministic rows (all-or-nothing per statement).
    if (colError && !isDuplicateKey(colError)) throw colError;

    if (shouldSeedCards) {
      const now = new Date().toISOString();
      const cardInserts: Array<Record<string, unknown>> = [];
      seeded.forEach((col) => {
        col.cards.forEach((card, cardIndex) => {
          cardInserts.push({
            id: card.id,
            column_id: col.id,
            ...cardToDbFields(card),
            position: cardIndex,
            created_at: now,
            updated_at: now,
          });
        });
      });

      if (cardInserts.length > 0) {
        const { error: cardError } = await supabase.from('cards').insert(cardInserts);
        if (cardError && !isDuplicateKey(cardError)) throw cardError;
      }
    }

    return seeded;
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

  /** Explicitní role sloupce (null = zpět na odvození ze jména). Starší databáze bez sloupce `role` ji prostě neuloží. */
  async updateColumnRole(columnId: string, role: ColumnRole | null, projectId?: string): Promise<void> {
    if (!hasSupabaseConfig) {
      if (projectId) {
        const board = localStore.getBoard(projectId);
        localStore.saveBoard(projectId, board.map((col) => (col.id === columnId ? { ...col, role } : col)));
      }
      return;
    }
    const { error } = await supabase.from('columns').update({ role }).eq('id', columnId);
    if (error) persistenceStatus.report('uložení role sloupce', error);
    else persistenceStatus.clear();
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

  /**
   * Obnova stavu z AI History -- vždy v rozsahu JEDNOHO projektu (`projectId`):
   *  - `boardData` je pole: board tohoto projektu se nahradí zálohou. V Supabase
   *    to dělá RPC restore_project_board v JEDNÉ transakci (při chybě zůstane
   *    původní board), smí jen vlastník projektu a RLS platí dál.
   *  - `boardData` je null: projekt vytvořila AI, vrátit znamená smazat právě
   *    tento projekt (RLS: jen vlastník).
   * Žádné jiné projekty se nečtou, nemění ani nemažou. Seznam projektů ze
   * snapshotu se záměrně IGNORUJE -- dřív se podle něj mazaly všechny ostatní
   * projekty uživatele a přepisovaly jejich názvy/členství.
   */
  async restoreProjectSnapshot(projectId: string, boardData: Column[] | null): Promise<void> {
    if (!projectId) {
      throw new Error('Záznam neobsahuje projekt, který lze obnovit.');
    }

    if (!boardData) {
      await this.deleteProject(projectId);
      return;
    }

    if (!hasSupabaseConfig) {
      localStore.saveBoard(projectId, boardData);
      return;
    }

    const { error } = await supabase.rpc('restore_project_board', {
      p_project_id: projectId,
      p_board: boardToRestorePayload(boardData),
    });
    if (error) {
      persistenceStatus.report('obnovení boardu ze zálohy', error);
      throw new Error(
        error.code === '42501'
          ? 'Board může obnovit jen vlastník projektu.'
          : 'Obnovu se nepodařilo provést. Board zůstal beze změny.'
      );
    }
    persistenceStatus.clear();
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
